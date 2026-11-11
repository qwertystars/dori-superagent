import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { status } from "../src/cli-up.ts";
import { dutyTick } from "../src/duty.ts";
import { COMPACT_COMMAND, PAUSE_COMMAND } from "../src/limit-command.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";
import { laneOn, opusLead } from "./session-fixtures.ts";

const MIN = 60_000;
const LIMIT_SCREEN = "API Error: usage limit reached for this account\n❯\n";
const atLimit = (usedPercent = 99) => ({
  accounts: [
    {
      name: "anthropic-subscription/default",
      windows: [{ id: "claude:7d_opus", usedPercent, resetsAt: Date.parse("2026-03-01T00:00:00.000Z") }],
    },
  ],
});

const out = async (fn: () => Promise<number>): Promise<string[]> => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines;
};

const targets = (s: ReturnType<typeof setup>) => s.d.store.gate().map((e) => e.target);

describe("gating every Opus session dori manages", () => {
  test("the lead and an Opus lane are both paused on one trip, at the same reset", async () => {
    const s = setup();
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "opus-lane", s.brief, { group: "w1" });
    const laneFile = laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    s.w.panes.get(lane.paneId)!.status = "idle";
    await dutyTick(s.d);
    expect(targets(s)).toEqual(["lead", "opus-lane"]);
    expect(s.d.store.gate().map((e) => e.resumeAt)).toEqual([
      Date.parse("2026-03-01T00:00:00.000Z") + 60_000,
      Date.parse("2026-03-01T00:00:00.000Z") + 60_000,
    ]);
    expect(s.d.store.gate()[1]).toMatchObject({
      ref: lane.paneId,
      model: "claude-opus-4-7",
      windowId: "claude:7d_opus",
      transcript: laneFile,
    });
    expect(s.w.panes.get(lane.paneId)!.received).toEqual([COMPACT_COMMAND]);
    expect(s.w.panes.get("w1:p1")!.received.at(-1)).toBe(COMPACT_COMMAND);
  });

  test("a DeepSeek lane is never gated by a spent Claude window, and its pane text does not gate it either", async () => {
    const s = setup();
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "ds-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["deepseek/deepseek-chat"]);
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "idle";
    pane.screen = LIMIT_SCREEN;
    await dutyTick(s.d);
    expect(targets(s)).toEqual(["lead"]);
    expect(pane.received).toEqual([]);
  });

  test("an Opus window under the threshold gates nothing, whatever a pane shows", async () => {
    const s = setup();
    s.w.limits = atLimit(20);
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "opus-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    await dutyTick(s.d);
    expect(targets(s)).toEqual([]);
  });

  test("a session whose transcript names no model is unknown, so it is not gated", async () => {
    const s = setup();
    s.w.limits = atLimit();
    const events = await dutyTick(s.d);
    expect(targets(s)).toEqual([]);
    expect(events.filter((e) => e.action.startsWith("pause"))).toEqual([]);
  });

  test("a READY lane is not gated: it would only be woken into finished work", async () => {
    const s = setup();
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "done-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    const saved = s.d.store.lane("done-lane")!;
    saved.status = "ready";
    saved.final = { text: "finished", evidence: ["x"], at: s.w.clock };
    s.d.store.saveLane(saved);
    await dutyTick(s.d);
    expect(targets(s)).toEqual(["lead"]);
  });
});

describe("dori gate", () => {
  test("status prints each pause with its session, model, window and reset; GATE open when there is none", async () => {
    const s = setup();
    expect(await out(() => main(["gate", "status"], s.d))).toEqual(["GATE open (no pause recorded)"]);
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "opus-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    s.w.panes.get(lane.paneId)!.status = "idle";
    await dutyTick(s.d);
    const lines = await out(() => main(["gate", "status"], s.d));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("lead");
    expect(lines[0]).toContain("paused-for-limit");
    expect(lines[0]).toContain("claude:7d_opus 99%");
    expect(lines[0]).toContain("claude-opus-4-7");
    expect(lines[0]).toContain("until 2026-03-01T00:01:00.000Z");
    expect(lines[0]).toContain("next: pause");
    expect(lines[1]).toStartWith("opus-lane");
    expect(lines[1]).toContain(lane.paneId);
  });

  test("resume releases one session by name and leaves the other paused", async () => {
    const s = setup();
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "opus-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    s.w.panes.get(lane.paneId)!.status = "idle";
    await dutyTick(s.d);
    expect(await out(() => main(["gate", "resume", "opus-lane", "--text", "by hand"], s.d))).toEqual([
      `GATE RELEASED opus-lane (${lane.paneId}): by hand`,
    ]);
    expect(targets(s)).toEqual(["lead"]);
    expect(s.w.panes.get(lane.paneId)!.received).toEqual([COMPACT_COMMAND]);
  });

  test("resume without a target drops every pause; with no pause recorded it is refused", async () => {
    const s = setup();
    await expect(main(["gate", "resume"], s.d)).rejects.toThrow("no pause is recorded: nothing to release");
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    await dutyTick(s.d);
    expect(await out(() => main(["gate", "resume", "--text", "all by hand"], s.d))).toEqual([
      "GATE RELEASED lead (w1:p1): all by hand",
    ]);
    expect(s.d.store.gate()).toEqual([]);
    expect(s.w.panes.get("w1:p1")!.received).toEqual([COMPACT_COMMAND]);
    s.w.limits = undefined;
    s.w.clock += 60 * MIN;
    await dutyTick(s.d);
    expect(s.w.panes.get("w1:p1")!.received).toEqual([COMPACT_COMMAND]);
    await expect(main(["gate", "resume", "nobody"], s.d)).rejects.toThrow("no pause is recorded: nothing to release");
    await expect(main(["gate", "clear"], s.d)).rejects.toThrow("unknown gate command clear");
  });

  test("dori status shows the pause on the lead and on a paused lane", async () => {
    const s = setup();
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "paused-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    s.w.panes.get(lane.paneId)!.status = "idle";
    await dutyTick(s.d);
    const lines = await out(async () => {
      status(s.d);
      return 0;
    });
    expect(lines[1]).toContain("gate=paused-for-limit until 2026-03-01T00:01:00.000Z");
    expect(lines.find((l) => l.startsWith("paused-lane"))).toContain("gate=paused-for-limit");
    expect(lines[1]).toStartWith("lead=w1:p1 duty=- home=");
  });

  test("check runs one gate pass per session and prints what it did", async () => {
    const s = setup();
    s.w.limits = atLimit();
    opusLead(s.w, s.d);
    expect(await out(() => main(["gate", "check"], s.d))).toEqual(["GATE w1:p1 pause-compact"]);
    expect(s.d.store.gate()[0]).toMatchObject({ next: "pause" });
    s.w.clock += MIN;
    expect(await out(() => main(["gate", "check"], s.d))).toEqual(["GATE w1:p1 paused"]);
    expect(s.d.store.gate()[0]!.next).toBeUndefined();
    expect(s.w.panes.get("w1:p1")!.received).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
  });
});
