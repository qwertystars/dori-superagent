import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { COMPACT_COMMAND, gateSend, PAUSE_COMMAND, RESUME_COMMAND, wakeText } from "./limit-command.ts";
import { findTrips } from "./limit-trip.ts";
import { type Due, type GateConfig, resetDue, trippedWindow } from "./limit-windows.ts";
import { refFromText } from "./refs.ts";
import type { GateEntry, GateNext } from "./store-types.ts";

const iso = (at: number): string => new Date(at).toISOString();

export const gatedRefs = (entries: readonly GateEntry[]): ReadonlySet<string> => new Set(entries.map((e) => e.ref));

const said = (entry: GateEntry, action: string, detail?: string): DutyEvent => ({
  ...(entry.target === "lead" ? { pane: entry.ref } : { lane: entry.target }),
  action,
  ...(detail === undefined ? {} : { detail }),
});

/** Every pause report goes to the lead's inbox, which the duty loop flushes on a pass where the lead is not paused. */
function report(d: Deps, text: string): void {
  const lead = d.store.roles().lead;
  if (lead !== undefined) d.store.enqueue(lead, { at: d.now(), from: "duty", text });
}

const pauseReport = (entry: GateEntry): string =>
  `[PAUSE ${entry.target}] Opus limit (${entry.model}): ${entry.windowId}${entry.usedPercent === undefined ? "" : ` at ${entry.usedPercent}%`}; ${COMPACT_COMMAND} and ${PAUSE_COMMAND} sent to ${entry.ref}. No prompt or nudge goes to it until ${iso(entry.resumeAt)}.`;

const resumeReport = (entry: GateEntry): string =>
  `[RESUME ${entry.target}] Opus limit reset (${entry.model}) in ${entry.ref}: ${RESUME_COMMAND} sent, then one wake prompt naming ${entry.transcript}.`;

/** The lane's nudge clock restarts at the wake, so its first nudge is 10 minutes after the wake, not before it. */
function resetNudgeClock(d: Deps, entry: GateEntry): void {
  const lane = d.store.lane(entry.target);
  if (lane === undefined) return;
  lane.lastActivityAt = d.now();
  lane.nudges = 0;
  d.store.saveLane(lane);
}

type Ctx = { d: Deps; entry: GateEntry; events: DutyEvent[] };

const COMMANDS: Readonly<Record<GateNext, string>> = {
  compact: COMPACT_COMMAND,
  pause: PAUSE_COMMAND,
  resume: RESUME_COMMAND,
  wake: "",
};

/** Types one command and stamps `at` when it landed. Nothing here decides what an uncertain outcome means. */
async function sendCommand(ctx: Ctx, next: GateNext): Promise<ReturnType<typeof gateSend>> {
  const { d, entry } = ctx;
  const text = next === "wake" ? wakeText(entry.transcript, entry.cwd) : COMMANDS[next];
  const step = await gateSend(d, refFromText(entry.ref), text);
  if (step.done === "sent") entry.at = d.now();
  return step;
}

/** An uncertain command is written down once, so `dori gate status` shows what may sit in the pane's input. */
function noteHeld(ctx: Ctx, what: string, detail: string): void {
  const { entry, events } = ctx;
  entry.log.push({ at: entry.at, kind: "held", text: `${what}: ${detail}` });
  events.push(said(entry, "pause-held", `${what}: ${detail}`));
}

/**
 * `/compact`, then `/goal pause` a pass later: a compaction typed after the gate closed is the turn the gate prevents.
 * An uncertain compaction is never typed again (a second copy would compact twice), but the pause still goes ahead,
 * because stopping the session's turns matters more than the compaction did.
 */
async function startGate(ctx: Ctx): Promise<GateEntry | undefined> {
  const { d, entry, events } = ctx;
  if (entry.next !== "pause") {
    const first = await sendCommand(ctx, "compact");
    if (first.done === "gone") return drop(ctx);
    if (first.done === "wait") return entry;
    if (first.done === "held") noteHeld(ctx, COMPACT_COMMAND, first.detail);
    else events.push(said(entry, "pause-compact"));
    entry.next = "pause";
    return entry;
  }
  const second = await sendCommand(ctx, "pause");
  if (second.done === "gone") return drop(ctx);
  if (second.done === "wait") return entry;
  if (second.done === "held") {
    noteHeld(ctx, PAUSE_COMMAND, second.detail);
    entry.held = second.detail;
    report(
      d,
      `[PAUSE ${entry.target}] ${PAUSE_COMMAND} may sit unsent in ${entry.ref}; it is not typed again. Check the pane, then dori gate resume ${entry.target}.`,
    );
    return entry;
  }
  delete entry.next;
  report(d, pauseReport(entry));
  events.push(said(entry, "paused"));
  return entry;
}

/** `/goal resume` and the one wake prompt: two deliveries in one pass. A busy pane leaves the owed command for the next
 * one, so the resumed goal is never handed a turn it did not ask for. */
async function wakeGate(ctx: Ctx): Promise<GateEntry | undefined> {
  const { d, entry, events } = ctx;
  if (entry.next === "resume") {
    const step = await sendCommand(ctx, "resume");
    if (step.done === "gone") return drop(ctx);
    if (step.done === "wait") return entry;
    if (step.done === "held") {
      noteHeld(ctx, RESUME_COMMAND, step.detail);
      entry.held = step.detail;
      return entry;
    }
    entry.phase = "resuming";
    delete entry.next;
  }
  const step = await sendCommand(ctx, "wake");
  if (step.done === "gone") return drop(ctx);
  if (step.done === "wait") return entry;
  if (step.done === "held") {
    noteHeld(ctx, "wake", step.detail);
    report(
      d,
      `[PAUSE ${entry.target}] the wake prompt for ${entry.ref} may sit unsent in its input; it is not typed again. Check the pane, then dori gate resume ${entry.target}.`,
    );
    entry.held = step.detail;
    return entry;
  }
  resetNudgeClock(d, entry);
  report(d, resumeReport(entry));
  events.push(said(entry, "resumed"));
  return undefined;
}

function drop(ctx: Ctx): undefined {
  const { d, entry, events } = ctx;
  report(d, `[PAUSE ${entry.target}] the session is no longer in ${entry.ref}; the pause is dropped.`);
  events.push(said(entry, "pause-gone", entry.ref));
  return undefined;
}

/** A window still at its limit at the due time pushes the pause out: to its reset if one is known, else the next probe. */
function reprobe(ctx: Ctx, gaps: GateConfig): GateEntry | undefined {
  const { d, entry, events } = ctx;
  const hit = trippedWindow(d.limits(), gaps.percent, d.now());
  if (hit === undefined) return undefined;
  const due: Due = resetDue(hit.window, d.now(), gaps.slackMs, entry.probe + 1);
  entry.probe = due.probe ? entry.probe + 1 : 0;
  entry.resumeAt = due.resumeAt;
  entry.windowId = hit.window.id;
  entry.usedPercent = hit.window.usedPercent;
  entry.at = d.now();
  const line = `${hit.window.id} at ${hit.window.usedPercent}% (${hit.account})`;
  entry.log.push({ at: d.now(), kind: "probe", text: `${line}, next ${iso(due.resumeAt)}` });
  report(d, `[PAUSE ${entry.target}] ${line} is still at its limit; next check ${iso(due.resumeAt)}.`);
  events.push(said(entry, "pause-probe", line));
  return entry;
}

/**
 * One entry's next step. A paused entry (`next` unset) sends nothing at all until its due time; at the due time the
 * account windows are read again, so a still-spent window can never be woken into a refusal.
 */
async function advance(
  d: Deps,
  entry: GateEntry,
  gaps: GateConfig,
  events: DutyEvent[],
): Promise<GateEntry | undefined> {
  const ctx: Ctx = { d, entry, events };
  if (entry.held !== undefined) return entry;
  if (entry.next === "compact" || entry.next === "pause") return startGate(ctx);
  if (entry.next === "resume" || entry.next === "wake") return wakeGate(ctx);
  if (d.now() < entry.resumeAt) return entry;
  const stillSpent = reprobe(ctx, gaps);
  if (stillSpent !== undefined) return stillSpent;
  entry.log.push({ at: d.now(), kind: "resume", text: "limit reset" });
  entry.next = "resume";
  return wakeGate(ctx);
}

/** The gate half of one duty pass: advances every pause, then opens the new ones and types their first command. */
export async function pauseTick(d: Deps, events: DutyEvent[]): Promise<void> {
  const gaps = d.gateConfig();
  const before = d.store.gate();
  const snapshot = JSON.stringify(before);
  const kept: GateEntry[] = [];
  for (const entry of before) {
    const next = await advance(d, entry, gaps, events);
    if (next !== undefined) kept.push(next);
  }
  for (const fresh of await findTrips(d, gaps, gatedRefs(kept))) {
    const next = await advance(d, fresh, gaps, events);
    if (next !== undefined) kept.push(next);
  }
  if (JSON.stringify(kept) !== snapshot) d.store.saveGate(kept);
}
