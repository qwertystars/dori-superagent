import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { detectProviderFailure } from "./provider-failure.ts";
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
 * The one failure that outranks a lane's own WAITING report: when omo cannot reach any account, the lane is not waiting
 * on a blocker it chose, it is stalled, and no nudge can fix it (the incident this recovery exists for).
 */
const RECOVERABLE_WHILE_WAITING = "accounts-blocked";

function stalledScreen(lane: Lane, seen: string | undefined): boolean {
  if (lane.status !== "waiting") return true;
  return seen !== undefined && detectProviderFailure(seen)?.kind === RECOVERABLE_WHILE_WAITING;
}

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
  if (!STALLED.has(st)) return false;
  if (lane.hub === true) return false;
  const ref = lane.sessionRef;
  const screen = await d.runtimes
    .for(ref)
    .read(ref, WATCH_LINES)
    .catch(() => undefined);
  if (!stalledScreen(lane, screen)) return false;
  const outcome = await watchProviderFailure(d, lane, now, screen);
  if (outcome.kind === "recovered" || outcome.kind === "failed") {
    const when = new Date(outcome.next).toISOString();
    const report =
      outcome.kind === "recovered"
        ? `[RECOVER ${lane.key}] interrupted by ${outcome.failure.match} (${outcome.failure.kind}); the agent was restarted in ${refText(ref)} with a kickoff naming ${laneTranscript(lane, d.sessionRoots)}. Attempt ${outcome.attempt}, next retry at ${when} if it fails again.`
        : `[RECOVER ${lane.key}] interrupted by ${outcome.failure.match} (${outcome.failure.kind}); the restart failed (${outcome.reason}). Attempt ${outcome.attempt}, next retry at ${when}.`;
    await tellLead(d, report, "duty");
    events.push({
      lane: lane.key,
      action: outcome.kind === "recovered" ? `recovered-${outcome.attempt}` : "recover-failed",
      detail: `${outcome.failure.kind}: ${outcome.failure.match}`,
    });
  } else if (outcome.kind === "cleared") {
    events.push({ lane: lane.key, action: "recovery-cleared" });
  } else if (outcome.kind === "escalated") {
    // The cap is reached, or the failure is an authentication one: a restart is no longer the answer, so the lead gets
    // the pane's own error verbatim, once, and the lane waits on a person instead of restarting forever. Auth skips the
    // ladder entirely, because a stale copied login cannot be cleared by starting the agent again.
    const shown = outcome.failure.lines.join(" / ");
    const what =
      outcome.reason === "auth"
        ? "authentication failure; restart cannot clear this, so none was tried"
        : `recovery gave up after ${outcome.attempt} attempt${outcome.attempt === 1 ? "" : "s"}; restart cannot clear this`;
    await tellLead(d, `[ESCALATE ${lane.key}] ${what}. Pane shows: ${shown}`, "duty");
    events.push({ lane: lane.key, action: "recover-escalated", detail: `${outcome.failure.kind}: ${shown}` });
  }
  return outcome.kind !== "none" && outcome.kind !== "cleared";
}
