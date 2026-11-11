import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { COMPACT_COMMAND, PAUSE_COMMAND } from "../src/limit-command.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

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

describe("a paused session never interrupts a running turn", () => {
  test("a lead mid-turn gets nothing typed into it: no compact, no pause, no keys, and no restart", async () => {
    const s = setup();
    s.w.limits = spent();
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
  test("the lane's pane is left alone while it works, and its child session keeps running untouched", async () => {
    const s = setup();
    s.w.limits = spent();
    const lane = await startLane(s.d, "dag-lane", s.brief, { group: "w1" });
    const parent = s.w.panes.get(lane.paneId)!;
    parent.status = "working";
    parent.screen = "API Error: usage limit reached for this account\n❯\n";
    // The node the DAG runs is its own session, never a dori lane: dori cannot address it, so nothing here touches it.
    const child = s.w.addPane("w1:p9", "working");
    for (let i = 0; i < 5; i++) {
      s.w.clock += 20 * MIN;
      await dutyTick(s.d);
      expect(parent.received).toEqual([]);
      expect(parent.ran.slice(1)).toEqual([]);
      expect(child.received).toEqual([]);
      expect(child.ran).toEqual([]);
      expect(child.status).toBe("working");
    }
  });

  test("when the lane goes idle its pause is typed, but the child pane still gets nothing", async () => {
    const s = setup();
    s.w.limits = spent();
    const lane = await startLane(s.d, "dag-lane", s.brief, { group: "w1" });
    const parent = s.w.panes.get(lane.paneId)!;
    parent.status = "working";
    parent.screen = "API Error: usage limit reached for this account\n❯\n";
    const child = s.w.addPane("w1:p9", "working");
    await dutyTick(s.d);
    parent.status = "idle";
    s.w.clock += MIN;
    await dutyTick(s.d);
    expect(parent.received).toEqual([COMPACT_COMMAND]);
    expect(s.d.store.gate().map((e) => e.target)).toContain("dag-lane");
    s.w.clock += MIN;
    await dutyTick(s.d);
    expect(parent.received).toEqual([COMPACT_COMMAND, PAUSE_COMMAND]);
    expect(parent.ran.slice(1)).toEqual([]);
    expect(child.received).toEqual([]);
    expect(child.ran).toEqual([]);
  });

  test("the paused lane takes no nudge and no recovery restart while it is paused", async () => {
    const s = setup();
    s.w.limits = spent();
    const lane = await startLane(s.d, "dag-lane", s.brief, { group: "w1" });
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
    expect(s.d.store.lane("dag-lane")!.nudges).toBe(0);
  });
});
