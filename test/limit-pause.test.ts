import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { COMPACT_COMMAND, PAUSE_COMMAND, RESUME_COMMAND, wakeText } from "../src/limit-command.ts";
import { report, startLane } from "../src/lanes.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { opusLead, sessionFile } from "./session-fixtures.ts";

const MIN = 60_000;
const OPUS_RESET = "2026-01-05T00:00:00.000Z";
const resetAt = Date.parse(OPUS_RESET);
const LEAD = "w1:p1";
const wakeFor = (transcript: string) =>
  `Your Opus limit has reset. Re-read your previous session transcript ${transcript}, your work folder /work/lead and the DAG harvest files, recover context, then continue - do not restart.`;

const spent = (usedPercent: number, resetsAt?: string) => ({
  accounts: [
    {
      name: "anthropic-subscription/default",
      windows: [
        { id: "claude:7d_opus", usedPercent, ...(resetsAt === undefined ? {} : { resetsAt: Date.parse(resetsAt) }) },
      ],
    },
  ],
});

/** The lead's own session file is where its model is read from, so a world always writes one with `model`. */
function world(usedPercent = 97, resetsAt: string | null = OPUS_RESET, model = "claude-opus-4-7") {
  const s = setup();
  s.w.limits = spent(usedPercent, resetsAt ?? undefined);
  const file = opusLead(s.w, s.d, [model]);
  return { ...s, file };
}

function noResetWorld(usedPercent = 100) {
  return world(usedPercent, null);
}

type Side = ReturnType<typeof setup>;
const gate = (s: Side) => s.d.store.gate();
const received = (s: Side) => s.w.panes.get(LEAD)!.received;
const queued = (s: Side) => s.d.store.queued(href(LEAD)).map((m) => m.text);

describe("detecting a spent Opus window", () => {
  test("the first tick records paused-for-limit, types /compact, and reports nothing to the paused lead", async () => {
    const s = world();
    const events = await dutyTick(s.d);
    expect(gate(s)[0]).toMatchObject({
      target: "lead",
      ref: LEAD,
      phase: "paused-for-limit",
      model: "claude-opus-4-7",
      windowId: "claude:7d_opus",
      usedPercent: 97,
      resumeAt: resetAt + 60_000,
      next: "pause",
      cwd: "/work/lead",
    });
    expect(received(s)).toEqual([COMPACT_COMMAND]);
    expect(events).toContainEqual({ pane: LEAD, action: "pause-compact" });
    expect(queued(s)).toEqual([]);
  });

  test("the next tick types /goal pause; the report is queued, never delivered into the paused session", async () => {
    const s = world();
    await dutyTick(s.d);
    s.w.clock = resetAt - 10 * MIN;
    const events = await dutyTick(s.d);
    expect(received(s)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
    expect(events).toContainEqual({ pane: LEAD, action: "paused" });
    expect(queued(s)).toHaveLength(1);
    expect(queued(s)[0]).toStartWith("[PAUSE lead]");
    expect(queued(s)[0]).toContain("claude:7d_opus at 97%");
    s.w.clock = resetAt - 9 * MIN;
    await dutyTick(s.d);
    expect(received(s)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
    expect(queued(s)).toHaveLength(1);
  });
});

describe("a paused session while the window stays spent", () => {
  test("no prompt or nudge reaches the pane, and queued messages are held, not delivered", async () => {
    const later = Date.parse("2026-03-01T00:00:00.000Z");
    const s = world(97, "2026-03-01T00:00:00.000Z");
    await dutyTick(s.d);
    await dutyTick(s.d);
    expect(gate(s)[0]!.resumeAt).toBe(later + 60_000);
    s.d.store.enqueue(href(LEAD), { at: s.w.clock, from: "cli", text: "unrelated note" });
    const before = received(s).length;
    for (let i = 0; i < 4; i++) {
      s.w.clock += 30 * MIN;
      const events = await dutyTick(s.d);
      const held = events.find((e) => e.action === "pause-held");
      expect(held?.detail ?? "").toContain("message(s) wait for the reset");
      expect(held?.pane ?? "").toBe(LEAD);
    }
    expect(received(s).length).toBe(before);
    expect(queued(s)).toContain("unrelated note");
    for (const e of s.w.dutyCounts) expect(e.nudges).toBe(0);
  });

  test("a lane reporting while its lead is paused counts as activity for itself, and is not paused", async () => {
    const s = world();
    const lane = await startLane(s.d, "quiet", s.brief, { group: "w1" });
    s.w.clock = lane.createdAt + 12 * MIN;
    await dutyTick(s.d);
    expect(gate(s).map((e) => e.target)).toEqual(["lead"]);
    await report(s.d, "quiet", "still reading");
    expect(s.d.store.lane("quiet")!.status).toBe("working");
    expect(s.d.store.lane("quiet")!.nudges).toBe(0);
  });
});

describe("waking at the reset", () => {
  test("at the reset the lead gets /goal resume, then one wake prompt with the exact text, and the gate is open", async () => {
    const { file, ...s } = world();
    await dutyTick(s.d);
    await dutyTick(s.d);
    s.w.clock = resetAt + 30_000;
    await dutyTick(s.d);
    expect(received(s)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
    s.w.limits = spent(0);
    s.w.clock = resetAt + 60_000;
    const events = await dutyTick(s.d);
    expect(events).toContainEqual({ pane: LEAD, action: "resumed" });
    expect(received(s).slice(0, 3)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND, RESUME_COMMAND]);
    expect(received(s)[3]).toStartWith("Your Opus limit has reset. Re-read your previous session transcript ");
    expect(
      received(s)[3]!.endsWith(
        ", your work folder /work/lead and the DAG harvest files, recover context, then continue - do not restart.",
      ),
    ).toBe(true);
    expect(received(s)[3]).toBe(wakeFor(file));
    expect(gate(s)).toEqual([]);
    await dutyTick(s.d);
    expect(received(s)).toHaveLength(5);
  });

  test("the wake names the lane's transcript when one is on disk, and resets its nudge clock", async () => {
    const s = world();
    const file = sessionFile(s.w.sessionRoots[0]!, "/work/lead", ["claude-opus-4-7"], "2026-02-01T00-00-00-000Z_bbb");
    await dutyTick(s.d);
    await dutyTick(s.d);
    expect(gate(s)[0]!.transcript).toBe(file);
    s.w.limits = spent(0);
    s.w.clock = resetAt + 60_000;
    await dutyTick(s.d);
    expect(received(s)[2]).toBe(RESUME_COMMAND);
    expect(received(s)[3]).toBe(wakeText(file, "/work/lead"));
    expect(received(s)[3]!.endsWith("continue - do not restart.")).toBe(true);
    expect(gate(s)).toEqual([]);
  });
});

describe("a command that may not have landed", () => {
  test("a typed /goal pause is written down and never typed again, and the pause still counts as closed", async () => {
    const s = world();
    await dutyTick(s.d);
    s.w.clock = resetAt - 10 * MIN;
    s.w.promptFails.set(LEAD, '{"error":{"code":"agent_not_ready"}}');
    s.w.keyFails = 6;
    const events = await dutyTick(s.d);
    expect(events).toContainEqual({
      pane: LEAD,
      action: "pause-held",
      detail: expect.stringContaining("key press failed"),
    });
    expect(gate(s)[0]).toMatchObject({ next: "pause" });
    const typed = received(s).slice();
    for (let i = 0; i < 3; i++) {
      s.w.clock += 10 * MIN;
      await dutyTick(s.d);
    }
    expect(received(s)).toEqual(typed);
    expect(gate(s)[0]!.held).toBeDefined();
    expect(queued(s).filter((m) => m.startsWith("[PAUSE lead]"))).toHaveLength(1);
  });

  test("an ambiguous wake prompt is held with its report and the session is not woken twice", async () => {
    const s = world();
    await dutyTick(s.d);
    await dutyTick(s.d);
    s.w.limits = undefined;
    s.w.clock = resetAt + 60_000;
    s.w.promptHook.set(LEAD, (text) => {
      if (text.startsWith("Your Opus limit")) throw new Error("injected wake failure");
    });
    const events = await dutyTick(s.d);
    expect(events).toContainEqual({ pane: LEAD, action: "pause-held", detail: expect.stringContaining("wake: ") });
    expect(gate(s)[0]!.held).toBeDefined();
    expect(received(s)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND, RESUME_COMMAND]);
    s.w.promptHook.delete(LEAD);
    s.w.clock += 10 * MIN;
    await dutyTick(s.d);
    expect(received(s)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND, RESUME_COMMAND]);
  });
});

describe("an unknown reset time", () => {
  test("the pause probes 5, 15, 30 minutes and then every hour while the window has no reset", async () => {
    const s = noResetWorld();
    s.w.clock = Date.parse("2026-01-01T00:00:00.000Z");
    await dutyTick(s.d);
    await dutyTick(s.d);
    expect(gate(s)[0]!.resumeAt).toBe(s.w.clock + 5 * MIN);
    const waits: number[] = [];
    for (const step of [5, 15, 30, 60, 60]) {
      s.w.clock += step * MIN;
      const events = await dutyTick(s.d);
      expect(events).toContainEqual({
        pane: LEAD,
        action: "pause-probe",
        detail: "claude:7d_opus at 100% (anthropic-subscription/default)",
      });
      waits.push((gate(s)[0]!.resumeAt - s.w.clock) / MIN);
    }
    expect(waits).toEqual([15, 30, 60, 60, 60]);
    expect(received(s)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
    for (const e of s.w.dutyCounts) expect(e.nudges).toBe(0);
  });

  test("a known future reset replaces the probe schedule, and the reset ends the pause there", async () => {
    const s = noResetWorld();
    await dutyTick(s.d);
    await dutyTick(s.d);
    expect(gate(s)[0]!.probe).toBe(1);
    s.w.clock += 5 * MIN;
    s.w.limits = spent(100, "2026-02-01T00:00:00.000Z");
    await dutyTick(s.d);
    expect(gate(s)[0]).toMatchObject({ probe: 0, resumeAt: Date.parse("2026-02-01T00:00:00.000Z") + 60_000 });
    s.w.clock = Date.parse("2026-01-20T00:00:00.000Z");
    await dutyTick(s.d);
    expect(received(s)).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
  });
});
