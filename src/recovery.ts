import { createHash } from "node:crypto";
import { failureDetail, shq } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { detectProviderFailure, type ProviderFailure } from "./provider-failure.ts";
import type { AgentStatus } from "./runtime/types.ts";
import { kickoffText, laneTranscript } from "./session-transcript.ts";
import type { Lane } from "./store-types.ts";

/** The retry delays after a recovery, in minutes: 5, 10, 20, 40, then 60 for every attempt after that. */
export const BACKOFF_MINUTES = [5, 10, 20, 40, 60] as const;
const LAST_BACKOFF_MINUTES = 60;

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
  | { readonly kind: "recovered"; readonly attempt: number; readonly next: number; readonly failure: ProviderFailure }
  | {
      readonly kind: "failed";
      readonly attempt: number;
      readonly next: number;
      readonly reason: string;
      readonly failure: ProviderFailure;
    };

/**
 * A lane's provider failure, watched pass by pass: the first sighting is recorded; an unchanged failing screen waits
 * out the lane's retry gate and then restarts the agent; a screen that changed since the last pass is progress, which
 * resets the ladder and drops the gate; a screen without the failure clears the record entirely.
 */
export async function watchProviderFailure(
  d: Deps,
  lane: Lane,
  now: number,
  screen: string | undefined,
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
  if (prev.nextRetryAt !== undefined && now < prev.nextRetryAt) {
    lane.recovery = { ...prev, screenHash: hash, ...seen };
    d.store.saveLane(lane);
    return { kind: "waiting", until: prev.nextRetryAt };
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
    await rt.start(lane.sessionRef, `${d.agentCmd} ${shq(kickoff)}`);
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
