import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { COMPACT_COMMAND } from "../src/limit-command.ts";
import { status } from "../src/cli-up.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;
const LIMIT_SCREEN = "API Error: usage limit reached for this account\n❯\n";
const atLimit = {
  accounts: [
    {
      name: "anthropic-subscription/default",
      windows: [{ id: "claude:7d_opus", usedPercent: 99, resetsAt: Date.parse("2026-03-01T00:00:00.000Z") }],
    },
  ],
};

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

describe("a lane that shows the Opus limit", () => {
  test("with the account window at its limit the lane is paused, not restarted", async () => {
    const s = setup();
    s.w.limits = atLimit;
    const lane = await startLane(s.d, "limit-lane", s.brief, { group: "w1" });
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "idle";
    pane.screen = LIMIT_SCREEN;
    s.w.promptHook.set(lane.paneId, (text) => {
      if (text === "/exit") pane.status = "shell";
    });
    const events = await dutyTick(s.d);
    expect(s.d.store.gate().map((e) => e.target)).toEqual(["lead", "limit-lane"]);
    expect(s.d.store.gate()[1]).toMatchObject({ ref: lane.paneId, source: "pane", windowId: "pane:usage limit" });
    expect(pane.ran.slice(1)).toEqual([]);
    expect(pane.received).toEqual([COMPACT_COMMAND]);
    expect(events).toContainEqual({ lane: "limit-lane", action: "pause-compact" });
  });

  test("a pane text alone, with the window unreadable, pauses nothing: that case stays with the provider recovery", async () => {
    const s = setup();
    s.w.limits = undefined;
    const lane = await startLane(s.d, "limit-lane", s.brief, { group: "w1" });
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "idle";
    pane.screen = LIMIT_SCREEN;
    s.w.promptHook.set(lane.paneId, (text) => {
      if (text === "/exit") pane.status = "shell";
    });
    await dutyTick(s.d);
    expect(s.d.store.gate().map((e) => e.target)).toEqual([]);
    expect(s.d.store.lane("limit-lane")!.recovery).toMatchObject({ attempts: 0, kind: "usage limit" });
  });

  test("a lane on another provider showing a generic limit is paused only while the Claude window itself is spent", async () => {
    const s = setup();
    s.w.limits = {
      accounts: [{ name: "anthropic-subscription/default", windows: [{ id: "claude:7d_opus", usedPercent: 20 }] }],
    };
    const lane = await startLane(s.d, "ds-lane", s.brief, { group: "w1" });
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "idle";
    pane.screen = LIMIT_SCREEN;
    await dutyTick(s.d);
    expect(s.d.store.gate()).toEqual([]);
  });
});

describe("dori gate", () => {
  test("status prints each pause with its window and reset, and GATE open when there is none", async () => {
    const s = setup();
    expect(await out(() => main(["gate", "status"], s.d))).toEqual(["GATE open (no pause recorded)"]);
    s.w.limits = atLimit;
    await dutyTick(s.d);
    const lines = await out(() => main(["gate", "status"], s.d));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("lead");
    expect(lines[0]).toContain("paused-for-limit");
    expect(lines[0]).toContain("claude:7d_opus 99%");
    expect(lines[0]).toContain("until 2026-03-01T00:01:00.000Z");
    expect(lines[0]).toContain("next: pause");
  });

  test("resume drops the pause without sending anything to the paused pane", async () => {
    const s = setup();
    s.w.limits = atLimit;
    await dutyTick(s.d);
    const pane = s.w.panes.get("w1:p1")!;
    expect(pane.received).toEqual([COMPACT_COMMAND]);
    expect(await out(() => main(["gate", "resume", "--text", "doing it by hand"], s.d))).toEqual([
      "GATE RELEASED lead (w1:p1): doing it by hand",
    ]);
    expect(s.d.store.gate()).toEqual([]);
    expect(pane.received).toEqual([COMPACT_COMMAND]);
    s.w.limits = undefined;
    s.w.clock += 60 * MIN;
    await dutyTick(s.d);
    expect(pane.received).toEqual([COMPACT_COMMAND]);
    await expect(main(["gate", "resume"], s.d)).rejects.toThrow("no pause is recorded: nothing to release");
  });

  test("a resume of an unknown target is refused, and a bad gate verb is refused before doing anything", async () => {
    const s = setup();
    await expect(main(["gate", "resume", "nobody"], s.d)).rejects.toThrow("no pause is recorded: nothing to release");
    s.w.limits = atLimit;
    await dutyTick(s.d);
    await expect(main(["gate", "resume", "nobody"], s.d)).rejects.toThrow("no pause on nobody");
    await expect(main(["gate", "clear"], s.d)).rejects.toThrow("unknown gate command clear");
    expect(s.d.store.gate()).toHaveLength(1);
  });

  test("dori status shows the pause on the lead and on a paused lane", async () => {
    const s = setup();
    s.w.limits = atLimit;
    const lane = await startLane(s.d, "paused-lane", s.brief, { group: "w1" });
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "idle";
    pane.screen = LIMIT_SCREEN;
    await dutyTick(s.d);
    const lines = await out(async () => {
      status(s.d);
      return 0;
    });
    expect(lines[1]).toContain("gate=paused-for-limit until 2026-03-01T00:01:00.000Z");
    expect(lines.find((l) => l.startsWith("paused-lane"))).toContain("gate=paused-for-limit");
    expect(lines[1]).toStartWith("lead=w1:p1 duty=- home=");
  });

  test("check runs one gate pass and prints what it did", async () => {
    const s = setup();
    s.w.limits = atLimit;
    expect(await out(() => main(["gate", "check"], s.d))).toEqual(["GATE w1:p1 pause-compact"]);
    expect(s.d.store.gate()[0]).toMatchObject({ next: "pause" });
    s.w.clock += MIN;
    expect(await out(() => main(["gate", "check"], s.d))).toEqual(["GATE w1:p1 paused"]);
    expect(s.d.store.gate()[0]!.next).toBeUndefined();
  });
});
