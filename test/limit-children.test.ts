import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { COMPACT_COMMAND, PAUSE_COMMAND } from "../src/limit-command.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";
import { laneOn, opusLead } from "./session-fixtures.ts";

const MIN = 60_000;
const LEAD = "w1:p1";
const spent = (resetsAt = "2026-03-01T00:00:00.000Z") => ({
  accounts: [
    {
      name: "anthropic-subscription/default",
      windows: [{ id: "claude:7d_opus", usedPercent: 98, resetsAt: Date.parse(resetsAt) }],
    },
  ],
});

/** A DAG node is its own session, never a dori lane, so the only handles here are inputs and restarts. */
const untouched = (pane: { received: string[]; ran: string[]; status: string }, restarts = 0): boolean =>
  pane.received.length === 0 && pane.ran.length === restarts && pane.status === "working";

describe("a paused session never interrupts a running turn", () => {
  test("a lead mid-turn gets nothing typed into it: no compact, no pause, and no restart", async () => {
    const s = setup();
    s.w.limits = spent();
    opusLead(s.w, s.d);
    const lead = s.w.panes.get(LEAD)!;
    lead.status = "working";
    const events = await dutyTick(s.d);
    expect(s.d.store.gate()[0]).toMatchObject({ target: "lead", next: "compact" });
    expect(lead.received).toEqual([]);
    expect(lead.ran).toEqual([]);
    expect(events.filter((e) => e.pane === LEAD)).toEqual([]);
    s.w.clock += 30 * MIN;
    await dutyTick(s.d);
    expect(lead.received).toEqual([]);
    expect(lead.ran).toEqual([]);
  });

  test("once the turn ends the pause commands land, and the lead is still never restarted", async () => {
    const s = setup();
    s.w.limits = spent();
    opusLead(s.w, s.d);
    const lead = s.w.panes.get(LEAD)!;
    lead.status = "working";
    await dutyTick(s.d);
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    s.w.clock += MIN;
    await dutyTick(s.d);
    s.w.clock += MIN;
    await dutyTick(s.d);
    expect(lead.received).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
    expect(lead.ran).toEqual([]);
  });
});

describe("a paused lane with DAG children", () => {
  test("an Opus lane mid-run gets nothing, and the child session dori cannot address keeps working", async () => {
    const s = setup();
    s.w.limits = spent();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "opus-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    const parent = s.w.panes.get(lane.paneId)!;
    parent.status = "working";
    const child = s.w.addPane("w1:p9", "working");
    for (let i = 0; i < 5; i++) {
      s.w.clock += 20 * MIN;
      await dutyTick(s.d);
      expect(s.d.store.gate().map((e) => e.target)).toContain("opus-lane");
      expect(parent.received).toEqual([]);
      expect(parent.ran.slice(1)).toEqual([]);
      expect(untouched(child)).toBe(true);
    }
  });

  test("when the lane goes idle its pause is typed, but the child pane still gets nothing", async () => {
    const s = setup();
    s.w.limits = spent();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "opus-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    const parent = s.w.panes.get(lane.paneId)!;
    parent.status = "working";
    const child = s.w.addPane("w1:p9", "working");
    await dutyTick(s.d);
    parent.status = "idle";
    s.w.clock += MIN;
    await dutyTick(s.d);
    expect(parent.received).toEqual([COMPACT_COMMAND]);
    s.w.clock += MIN;
    await dutyTick(s.d);
    expect(parent.received).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
    expect(parent.ran.slice(1)).toEqual([]);
    expect(untouched(child)).toBe(true);
  });

  test("a DeepSeek lane's DAG keeps running under a spent Opus window with nothing gated on it", async () => {
    const s = setup();
    s.w.limits = spent();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "ds-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["deepseek/deepseek-chat"]);
    const parent = s.w.panes.get(lane.paneId)!;
    parent.status = "working";
    for (let i = 0; i < 3; i++) {
      s.w.clock += 20 * MIN;
      await dutyTick(s.d);
      expect(s.d.store.gate().map((e) => e.target)).not.toContain("ds-lane");
      expect(parent.received).toEqual([]);
      expect(parent.ran.slice(1)).toEqual([]);
    }
  });

  test("the paused lane takes no nudge and no recovery restart while it is paused", async () => {
    const s = setup();
    s.w.limits = spent();
    opusLead(s.w, s.d);
    const lane = await startLane(s.d, "opus-lane", s.brief, { group: "w1" });
    laneOn(s.w, s.d, lane, ["claude-opus-4-7"]);
    const parent = s.w.panes.get(lane.paneId)!;
    parent.status = "idle";
    parent.screen = "API Error: usage limit reached for this account\n❯\n";
    s.w.promptHook.set(lane.paneId, (text) => {
      if (text === "/exit") parent.status = "shell";
    });
    await dutyTick(s.d);
    await dutyTick(s.d);
    const typed = parent.received.slice();
    for (let i = 0; i < 4; i++) {
      s.w.clock += 30 * MIN;
      await dutyTick(s.d);
    }
    expect(parent.received).toEqual(typed);
    expect(parent.ran.slice(1)).toEqual([]);
    expect(s.d.store.lane("opus-lane")!.nudges).toBe(0);
  });
});
