import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import type { AgentStatus, SessionRef } from "./runtime/types.ts";

export const COMPACT_COMMAND = "/compact";
export const PAUSE_COMMAND = "/goal pause";
export const RESUME_COMMAND = "/goal resume";

/** The single wake a paused session gets once its limit reset: the exact text the design names. */
export const wakeText = (transcript: string, cwd: string): string =>
  `Your Opus limit has reset. Re-read your previous session transcript ${transcript}, your work folder ${cwd} and the DAG harvest files, recover context, then continue - do not restart.`;

/** Text may be typed under these only: a working agent is never interrupted, and a bare shell would run the command. */
const READY: ReadonlySet<AgentStatus> = new Set(["idle", "done"]);

export type Step = { done: "sent" } | { done: "wait" } | { done: "gone" } | { done: "held"; detail: string };

/**
 * One gate command into one session, typed through its runtime and never through the inbox. A working pane gets
 * nothing, so an in-flight turn is never interrupted; `held` means the text may already be in the pane's input and is
 * never typed again, since a second copy would run the command twice.
 */
export async function gateSend(d: Deps, ref: SessionRef, text: string): Promise<Step> {
  const rt = d.runtimes.for(ref);
  try {
    const { status } = await rt.probe(ref);
    if (status === "gone" || status === "shell") return { done: "gone" };
    if (!READY.has(status)) return { done: "wait" };
    const out = await rt.deliver(ref, text, { when: "idle" });
    if (out.kind === "delivered") return { done: "sent" };
    if (out.kind === "no-agent") return { done: "gone" };
    if (out.kind === "not-ready") return { done: "wait" };
    if (out.kind === "ambiguous") return { done: "held", detail: out.detail };
    const submitted = await rt.submitTyped(ref, out.into);
    return submitted === "submitted" ? { done: "sent" } : { done: "held", detail: "typed, the Enter did not land" };
  } catch (e) {
    return { done: "held", detail: failureDetail(e) };
  }
}
