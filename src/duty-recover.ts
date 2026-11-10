import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { watchProviderFailure } from "./recovery.ts";
import { refText } from "./refs.ts";
import type { AgentStatus } from "./runtime/types.ts";
import { laneTranscript } from "./session-transcript.ts";
import type { Lane } from "./store-types.ts";

/** Lines read for the provider-failure check: the recent screen, not scrollback the lane printed long ago. */
export const WATCH_LINES = 30;
/** Statuses in which a lane can be stalled: no turn is running. A `working` lane is never restarted on a screen alone. */
const STALLED: ReadonlySet<AgentStatus> = new Set(["idle", "done", "shell"]);

/**
 * The provider-failure half of one duty lane pass: on a pane that is not working, reads the last 30 lines, restarts the
 * agent when the failure is still there on an unchanged screen, and reports every attempt to the lead. True means this
 * pass is done with the lane: a failed pane is not progressing, so it gets no activity stamp and no idle nudge.
 */
export async function recoverLane(
  d: Deps,
  lane: Lane,
  st: AgentStatus,
  now: number,
  events: DutyEvent[],
): Promise<boolean> {
  if (lane.status === "waiting" || !STALLED.has(st)) return false;
  const screen = await d.runtimes
    .for(lane.sessionRef)
    .read(lane.sessionRef, WATCH_LINES)
    .catch(() => undefined);
  const outcome = await watchProviderFailure(d, lane, now, screen);
  if (outcome.kind === "recovered" || outcome.kind === "failed") {
    const when = new Date(outcome.next).toISOString();
    const report =
      outcome.kind === "recovered"
        ? `[RECOVER ${lane.key}] interrupted by ${outcome.failure.match} (${outcome.failure.kind}); the agent was restarted in ${refText(lane.sessionRef)} with a kickoff naming ${laneTranscript(lane, d.sessionRoots)}. Attempt ${outcome.attempt}, next retry at ${when} if it fails again.`
        : `[RECOVER ${lane.key}] interrupted by ${outcome.failure.match} (${outcome.failure.kind}); the restart failed (${outcome.reason}). Attempt ${outcome.attempt}, next retry at ${when}.`;
    await tellLead(d, report, "duty");
    events.push({
      lane: lane.key,
      action: outcome.kind === "recovered" ? `recovered-${outcome.attempt}` : "recover-failed",
      detail: `${outcome.failure.kind}: ${outcome.failure.match}`,
    });
  } else if (outcome.kind === "cleared") {
    events.push({ lane: lane.key, action: "recovery-cleared" });
  }
  return outcome.kind !== "none" && outcome.kind !== "cleared";
}
