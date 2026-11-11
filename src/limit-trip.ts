import type { Deps } from "./harness.ts";
import { type Due, type GateConfig, resetDue, trippedWindow } from "./limit-windows.ts";
import { detectProviderFailure } from "./provider-failure.ts";
import { refText } from "./refs.ts";
import { laneTranscript } from "./session-transcript.ts";
import type { GateEntry } from "./store-types.ts";

/** Pane text that pauses a lane: omo's own limit verdict, and only while an account window is at the limit too. */
const LANE_LIMITS: ReadonlySet<string> = new Set(["usage limit", "quota exceeded"]);

/** What a pause names: the session's cwd and its newest transcript under it, else placeholders that still read as words. */
function contextOf(d: Deps, cwd: string | undefined): { cwd: string; transcript: string } {
  return cwd === undefined || cwd === ""
    ? { cwd: "(unknown cwd)", transcript: "(no transcript found)" }
    : { cwd, transcript: laneTranscript({ cwd }, d.sessionRoots) };
}

function newEntry(
  d: Deps,
  target: string,
  ref: string,
  source: GateEntry["source"],
  windowId: string,
  usedPercent: number | undefined,
  cwd: string | undefined,
  due: Due,
): GateEntry {
  const now = d.now();
  const where = contextOf(d, cwd);
  return {
    target,
    ref,
    phase: "paused-for-limit",
    closedAt: now,
    at: now,
    resumeAt: due.resumeAt,
    source,
    windowId,
    ...(usedPercent === undefined ? {} : { usedPercent }),
    probe: due.probe ? 1 : 0,
    next: "compact",
    cwd: where.cwd,
    transcript: where.transcript,
    log: [
      { at: now, kind: "pause", text: `${windowId}${usedPercent === undefined ? "" : ` ${usedPercent}%`} in ${ref}` },
    ],
  };
}

/**
 * The lead (the Opus session) is paused on the account window alone. A lane is paused only when that window is at the
 * limit AND its own screen shows the limit: a lane on another provider shows a text that cannot name which window it
 * hit, and that case stays with the provider recovery, which restarts rather than pauses.
 */
export async function findTrips(d: Deps, gaps: GateConfig, gated: ReadonlySet<string>): Promise<GateEntry[]> {
  const hit = trippedWindow(d.limits(), gaps.percent, d.now());
  if (hit === undefined) return [];
  const due = resetDue(hit.window, d.now(), gaps.slackMs, 1);
  const found: GateEntry[] = [];
  const lead = d.store.roles().lead;
  if (lead !== undefined && !gated.has(refText(lead))) {
    const probe = await d.runtimes
      .for(lead)
      .probe(lead)
      .catch(() => undefined);
    found.push(
      newEntry(d, "lead", refText(lead), "usage-cache", hit.window.id, hit.window.usedPercent, probe?.cwd, due),
    );
  }
  for (const lane of d.store.lanes()) {
    if (lane.status === "done" || lane.status === "lost" || gated.has(refText(lane.sessionRef))) continue;
    const screen = await d.runtimes
      .for(lane.sessionRef)
      .read(lane.sessionRef, 30)
      .catch(() => undefined);
    const failure = screen === undefined ? null : detectProviderFailure(screen);
    if (failure === null || !LANE_LIMITS.has(failure.kind)) continue;
    found.push(
      newEntry(d, lane.key, refText(lane.sessionRef), "pane", `pane:${failure.kind}`, undefined, lane.cwd, due),
    );
  }
  return found;
}
