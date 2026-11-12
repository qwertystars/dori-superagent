import { createHash } from "node:crypto";
import { failureDetail, shq } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { composeLaneCommand } from "./lane-model.ts";
import { detectProviderFailure, isAuthFailure, type ProviderFailure } from "./provider-failure.ts";
import type { AgentStatus } from "./runtime/types.ts";
import { kickoffText, laneTranscript } from "./session-transcript.ts";
import { UNPINNED_MODEL, type Lane } from "./store-types.ts";

/** The retry delays after a recovery, in minutes: 5, 10, 20, 40, then 60 for every attempt after that. */
export const BACKOFF_MINUTES = [5, 10, 20, 40, 60] as const;
const LAST_BACKOFF_MINUTES = 60;

/** Restarts before the lane is escalated to the lead instead: beyond this a restart cannot fix the pane. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The attempt cap: `DORI_RECOVER_MAX_ATTEMPTS` when it is a positive integer, else 3. A stale auth login or a blocked
 * account is a failure restarts never clear, so the duty loop gives up and asks the lead instead of restarting forever.
 */
export function maxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env["DORI_RECOVER_MAX_ATTEMPTS"] ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_ATTEMPTS;
  const n = Number(raw);
  return n >= 1 ? n : DEFAULT_MAX_ATTEMPTS;
}

const EXIT_POLLS = 20;
const EXIT_POLL_MS = 500;
const EXIT_TEXT = "/exit";

export const backoffMs = (attempt: number): number =>
  (BACKOFF_MINUTES[Math.min(Math.max(attempt, 1), BACKOFF_MINUTES.length) - 1] ?? LAST_BACKOFF_MINUTES) * 60_000;

export const screenHash = (screen: string): string => createHash("sha256").update(screen).digest("hex").slice(0, 16);

export type RecoveryOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "cleared" }
  | { readonly kind: "watching" }
  | { readonly kind: "moving" }
  | { readonly kind: "waiting"; readonly until: number }
  | { readonly kind: "held" }
  | { readonly kind: "recovered"; readonly attempt: number; readonly next: number; readonly failure: ProviderFailure }
  | {
      readonly kind: "failed";
      readonly attempt: number;
      readonly next: number;
      readonly reason: string;
      readonly failure: ProviderFailure;
    }
  | {
      readonly kind: "escalated";
      readonly attempt: number;
      readonly failure: ProviderFailure;
      /** `auth`: a restart cannot clear it, so none was tried; `cap`: the restart ladder is spent. */
      readonly reason: "auth" | "cap";
    };

/**
 * A lane's provider failure, watched pass by pass: the first sighting is recorded; an unchanged failing screen waits
 * out the lane's retry gate and then restarts the agent, up to `maxAttempts` restarts; a screen that changed since the
 * last pass is progress, which resets the ladder and drops the gate; a screen without the failure clears the record
 * entirely. Once the cap is reached and the last gate has passed, the lane is escalated - recorded, never restarted
 * again - because a pane a restart cannot clear (a stale login, a blocked account) would otherwise restart forever.
 * An authentication failure skips the ladder entirely: the first gate that would restart escalates instead, at 0 attempts,
 * because a stale copied login is not something restarting the agent can fix.
 */
export async function watchProviderFailure(
  d: Deps,
  lane: Lane,
  now: number,
  screen: string | undefined,
  cap: number = maxAttempts(),
): Promise<RecoveryOutcome> {
  if (screen === undefined) return { kind: "none" };
  const hash = screenHash(screen);
  const failure = detectProviderFailure(screen);
  const prev = lane.recovery;
  if (failure === null) {
    if (prev === undefined) return { kind: "none" };
    delete lane.recovery;
    d.store.saveLane(lane);
    return { kind: "cleared" };
  }
  const seen = { kind: failure.kind, match: failure.match };
  if (prev === undefined) {
    lane.recovery = { attempts: 0, screenHash: hash, ...seen, at: now };
    d.store.saveLane(lane);
    return { kind: "watching" };
  }
  if (prev.screenHash !== hash) {
    lane.recovery = { attempts: 0, screenHash: hash, ...seen, at: now };
    d.store.saveLane(lane);
    return { kind: "moving" };
  }
  if (prev.escalatedAt !== undefined) return { kind: "held" };
  if (prev.nextRetryAt !== undefined && now < prev.nextRetryAt) {
    lane.recovery = { ...prev, screenHash: hash, ...seen };
    d.store.saveLane(lane);
    return { kind: "waiting", until: prev.nextRetryAt };
  }
  const auth = isAuthFailure(failure);
  if (prev.attempts >= cap || auth) {
    lane.recovery = { ...prev, escalatedAt: now, screenHash: hash, ...seen };
    lane.log.push({
      at: now,
      kind: "recover",
      text: auth
        ? `escalated: ${failure.kind} at ${prev.attempts} attempts is an authentication failure, which a restart cannot clear`
        : `escalated after ${prev.attempts} attempts: ${failure.kind} never cleared, so no further restart`,
    });
    d.store.saveLane(lane);
    return { kind: "escalated", attempt: prev.attempts, failure, reason: auth ? "auth" : "cap" };
  }
  const attempt = prev.attempts + 1;
  const next = now + backoffMs(attempt);
  const started = await restartLane(
    d,
    lane,
    kickoffText(failure.match, laneTranscript(lane, d.sessionRoots), lane.cwd),
  );
  lane.recovery = { attempts: attempt, nextRetryAt: next, screenHash: hash, ...seen, at: now };
  lane.log.push({
    at: now,
    kind: "recover",
    text: `attempt ${attempt}: ${failure.kind}${started === undefined ? "" : ` (restart failed: ${started})`}`,
  });
  if (started === undefined) {
    lane.status = "working";
    lane.nudges = 0;
    lane.lastActivityAt = now;
  }
  d.store.saveLane(lane);
  return started === undefined
    ? { kind: "recovered", attempt, next, failure }
    : { kind: "failed", attempt, next, reason: started, failure };
}

/**
 * Stops the agent in the lane's pane (Escape for a running turn, then the agent's own `/exit`), waits for its shell,
 * and starts `d.agentCmd` again in the same pane and cwd. Returns undefined when the agent is running again, else the
 * reason it is not.
 */
async function restartLane(d: Deps, lane: Lane, kickoff: string): Promise<string | undefined> {
  const rt = d.runtimes.for(lane.sessionRef);
  const stop = await stopAgent(d, lane.sessionRef);
  if (stop !== "shell") return stop === "gone" ? "the pane is gone" : "the agent did not exit";
  try {
    await rt.start(lane.sessionRef, composeLaneCommand(d.agentCmd, lane.model ?? UNPINNED_MODEL, shq(kickoff)));
    return undefined;
  } catch (e) {
    return `start failed: ${failureDetail(e)}`;
  }
}

async function stopAgent(d: Deps, ref: Lane["sessionRef"]): Promise<AgentStatus> {
  const rt = d.runtimes.for(ref);
  const first = (await rt.probe(ref)).status;
  if (first === "gone" || first === "shell") return first;
  if (first === "working") {
    try {
      await rt.keys(ref, ["escape"]);
    } catch {
      // The exit below still runs; a failed Escape only leaves the turn in flight.
    }
  }
  try {
    await rt.deliver(ref, EXIT_TEXT, { when: first === "working" ? "working" : "idle", force: true });
  } catch {
    // A failed delivery is no proof the agent stayed: the polls below decide.
  }
  for (let poll = 0; poll < EXIT_POLLS; poll++) {
    await d.sleep(EXIT_POLL_MS);
    let status: AgentStatus = "unknown";
    try {
      status = (await rt.probe(ref)).status;
    } catch {
      status = "unknown";
    }
    if (status === "shell" || status === "gone") return status;
  }
  return "unknown";
}
