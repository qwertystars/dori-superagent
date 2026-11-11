import type { Args } from "./cli-args.ts";
import { pauseTick } from "./limit-pause.ts";
import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";

const iso = (at: number): string => new Date(at).toISOString();

function targetRef(d: Deps, target: string): string | undefined {
  const lane = d.store.lane(target);
  if (lane !== undefined) return refText(lane.sessionRef);
  const lead = d.store.roles().lead;
  return target === "lead" && lead !== undefined ? refText(lead) : undefined;
}

export function gateStatus(d: Deps): void {
  const entries = d.store.gate();
  if (entries.length === 0) console.log("GATE open (no pause recorded)");
  for (const e of entries) {
    const usage = e.usedPercent === undefined ? "" : ` ${e.usedPercent}%`;
    const held = e.held === undefined ? "" : ` held: ${e.held}`;
    const next = e.next === undefined ? "" : ` next: ${e.next}`;
    console.log(
      `${e.target.padEnd(20)} ${e.phase.padEnd(17)} ${e.ref.padEnd(14)} ${e.windowId}${usage} until ${iso(e.resumeAt)}${held}${next}`,
    );
  }
}

/** The manual release: every pause, or only those on `target`, dropped without sending anything to the session. */
export function gateRelease(d: Deps, target: string | undefined, why: string): void {
  const entries = d.store.gate();
  if (entries.length === 0) throw new Refusal("no pause is recorded: nothing to release");
  const released =
    target === undefined
      ? entries
      : entries.filter((e) => e.target === target || e.ref === target || e.ref === targetRef(d, target));
  if (released.length === 0) throw new Refusal(`no pause on ${target}`);
  d.store.saveGate(entries.filter((e) => !released.includes(e)));
  for (const e of released) console.log(`GATE RELEASED ${e.target} (${e.ref}): ${why}`);
}

const line = (e: DutyEvent): string =>
  `${e.lane ?? e.pane} ${e.action}${e.detail === undefined ? "" : `: ${e.detail}`}`;

/** One gate pass without the rest of a duty tick: what the duty loop is about to do to paused sessions. */
export async function gateCheck(d: Deps): Promise<void> {
  const events: DutyEvent[] = [];
  await pauseTick(d, events);
  console.log(events.length === 0 ? "GATE no change" : events.map((e) => `GATE ${line(e)}`).join("\n"));
}

export async function runGate(d: Deps, a: Args, x: string | undefined): Promise<number> {
  if (x === undefined || x === "status") {
    gateStatus(d);
    return 0;
  }
  if (x === "resume") {
    gateRelease(d, a.pos[2], a.flags.get("text")?.at(-1) ?? "released by hand");
    return 0;
  }
  if (x === "check") {
    await gateCheck(d);
    return 0;
  }
  throw new Refusal(`unknown gate command ${x}`);
}
