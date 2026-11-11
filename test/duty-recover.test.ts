import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const LIMIT = "API Error: usage limit reached for this account\n❯\n";
/** The exact pane an all-accounts-blocked lane shows, as duty reads it: omo's own sentence under the TUI's prefix. */
const BLOCKED = [
  "Error: All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).",
  "  Soonest automatic retry: 2026-11-10T23:10:00.000Z.",
  "  /claude-account list  - inspect account states",
  "  /login anthropic-subscription  - add another account",
  "No request was sent: the account pool refused it locally.",
  "❯",
].join("\n");

/** Starts "limit-lane"; its pane is idle and shows `screen`. `restarts` are the `pane run`s after the lane's own start. */
async function limitLane(screen: string) {
  const s = setup();
  const lane = await startLane(s.d, "limit-lane", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  pane.screen = screen;
  const restarts = (): readonly string[] => pane.ran.slice(1);
  s.w.promptHook.set(lane.paneId, (text) => {
    if (text === "/exit") pane.status = "shell";
  });
  return { ...s, lane, pane, restarts };
}

describe("recording the first sighting of a provider failure", () => {
  test("the record is written, and nothing is restarted or nudged", async () => {
    const { w, d, lead, lane, pane, restarts } = await limitLane(LIMIT);
    w.clock = lane.createdAt + 25 * 60_000;
    const events = await dutyTick(d);
    expect(events.filter((e) => e.lane === "limit-lane")).toEqual([]);
    expect(d.store.lane("limit-lane")!.recovery).toMatchObject({ attempts: 0, kind: "usage limit" });
    expect(d.store.lane("limit-lane")!.nudges).toBe(0);
    expect(restarts()).toEqual([]);
    expect(pane.received).toEqual([]);
    expect(lead.received.filter((m) => m.includes("RECOVER"))).toEqual([]);
  });

  test("a working pane is never restarted on its screen alone: the failure is looked for only once it stalls", async () => {
    const { w, d, lane, pane, restarts } = await limitLane(LIMIT);
    pane.status = "working";
    w.clock = lane.createdAt + 25 * 60_000;
    await dutyTick(d);
    expect(restarts()).toEqual([]);
    expect(pane.received).toEqual([]);
    expect(d.store.lane("limit-lane")!.recovery).toBeUndefined();
    pane.status = "idle";
    const event = await dutyTick(d);
    expect(event.filter((e) => e.lane === "limit-lane")).toEqual([]);
    expect(pane.received).toEqual([]);
    expect(restarts()).toEqual([]);
  });

  test("a WAITING lane that shows the error keeps its status and is not restarted or nudged", async () => {
    const { w, d, lane, pane, restarts } = await limitLane(LIMIT);
    d.store.saveLane({ ...d.store.lane("limit-lane")!, status: "waiting" });
    w.clock = lane.createdAt + 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(restarts()).toEqual([]);
    expect(pane.received).toEqual([]);
    expect(d.store.lane("limit-lane")!.status).toBe("waiting");
    expect(d.store.lane("limit-lane")!.recovery).toBeUndefined();
  });

  test("a lane under migration is left alone: no record, no restart", async () => {
    const { w, d, lane, restarts } = await limitLane(LIMIT);
    d.store.saveLane({ ...d.store.lane("limit-lane")!, migration: true });
    w.clock = lane.createdAt + 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("limit-lane")!.recovery).toBeUndefined();
    expect(restarts()).toEqual([]);
  });
});

describe("a lane stuck on blocked accounts", () => {
  test("after 40 idle minutes the pane is recovered, not nudged and not escalated as merely idle", async () => {
    const { w, d, lead, lane, pane, restarts } = await limitLane(BLOCKED);
    w.promptHook.set(lane.paneId, (text) => {
      if (text === "/exit") {
        pane.status = "shell";
        pane.screen = BLOCKED;
      }
    });
    w.clock = lane.createdAt + 40 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("limit-lane")!.recovery).toMatchObject({ attempts: 0, kind: "accounts-blocked" });
    w.clock += 60_000;
    const events = await dutyTick(d);
    expect(events.filter((e) => e.lane === "limit-lane")).toEqual([
      { lane: "limit-lane", action: "recovered-1", detail: expect.stringContaining("accounts-blocked") },
    ]);
    expect(events.filter((e) => e.action.startsWith("nudge") || e.action === "escalated")).toEqual([]);
    expect(restarts()).toHaveLength(1);
    expect(restarts()[0]).toStartWith("omo 'You were interrupted by all Claude accounts blocked.");
    expect(lead.received.at(-1)).toStartWith("[RECOVER limit-lane] interrupted by all Claude accounts blocked");
    expect(d.store.lane("limit-lane")!.status).toBe("working");
    expect(d.store.lane("limit-lane")!.nudges).toBe(0);
  });

  test("a wrapped pane is the same failure, so the idle lane is recovered too", async () => {
    const wrapped = [
      "Error: All Claude accounts for anthropic-subscription are currently blocked",
      "(rate limit or auth errors).",
      "  Soonest automatic retry: 2026-11-10T23:10:00.000Z.",
      "❯",
    ].join("\n");
    const { w, d, lane, pane, restarts } = await limitLane(wrapped);
    w.promptHook.set(lane.paneId, (text) => {
      if (text === "/exit") {
        pane.status = "shell";
        pane.screen = wrapped;
      }
    });
    w.clock = lane.createdAt + 41 * 60_000;
    await dutyTick(d);
    w.clock += 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "limit-lane")).toContainEqual({
      lane: "limit-lane",
      action: "recovered-1",
      detail: expect.stringContaining("accounts-blocked"),
    });
    expect(restarts()).toHaveLength(1);
  });

  test("even a lane that reported WAITING is recovered: no nudge can fix blocked accounts", async () => {
    const { w, d, lane, pane, restarts } = await limitLane(BLOCKED);
    d.store.saveLane({ ...d.store.lane("limit-lane")!, status: "waiting" });
    w.promptHook.set(lane.paneId, (text) => {
      if (text === "/exit") {
        pane.status = "shell";
        pane.screen = BLOCKED;
      }
    });
    w.clock = lane.createdAt + 41 * 60_000;
    await dutyTick(d);
    w.clock += 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "limit-lane")[0]?.action).toBe("recovered-1");
    expect(restarts()).toHaveLength(1);
    expect(d.store.lane("limit-lane")!.status).toBe("working");
  });
});

describe("recovering a stalled lane", () => {
  test("an unchanged screen restarts the agent with the recovery kickoff and tells the lead", async () => {
    const { w, d, lead, lane, pane, restarts } = await limitLane(LIMIT);
    w.promptHook.set(lane.paneId, (text) => {
      if (text === "/exit") {
        pane.status = "shell";
        pane.screen = LIMIT;
      }
    });
    const tick = async (min: number) => {
      w.clock = lane.createdAt + min * 60_000;
      return dutyTick(d);
    };
    await tick(5);
    expect((await tick(6)).filter((e) => e.lane === "limit-lane")).toEqual([
      { lane: "limit-lane", action: "recovered-1", detail: expect.stringContaining("usage limit") },
    ]);
    expect(restarts()).toHaveLength(1);
    expect(restarts()[0]).toStartWith("omo 'You were interrupted by usage limit.");
    expect(restarts()[0]).toContain("Read your previous session transcript ");
    expect(restarts()[0]).toContain(`and your work folder ${d.store.lane("limit-lane")!.cwd}`);
    expect(restarts()[0]).toEndWith("recover context, then continue - do not restart.'");
    expect(pane.received).toContain("/exit");
    expect(lead.received.at(-1)).toStartWith("[RECOVER limit-lane] interrupted by usage limit (usage limit)");
    expect(lead.received.at(-1)).toContain("Attempt 1, next retry at ");
    expect(d.store.lane("limit-lane")!.recovery).toMatchObject({ attempts: 1 });
    expect(d.store.lane("limit-lane")!.nudges).toBe(0);
  });

  test("a screen that keeps changing is progress: no restart and no idle nudge", async () => {
    const { w, d, lane, pane, restarts } = await limitLane(`${LIMIT}retrying in 40s\n`);
    const tick = async (min: number, screen: string) => {
      pane.screen = screen;
      w.clock = lane.createdAt + min * 60_000;
      return dutyTick(d);
    };
    await tick(5, `${LIMIT}retrying in 40s\n`);
    await tick(6, `${LIMIT}retrying in 20s\n`);
    await tick(7, `${LIMIT}retrying in 5s\n`);
    expect(restarts()).toEqual([]);
    expect(d.store.lane("limit-lane")!.recovery).toMatchObject({ attempts: 0 });
    expect(d.store.lane("limit-lane")!.nudges).toBe(0);
  });

  test("a failed lane is held back past the whole nudge ladder; once the pane is clean it is nudged again", async () => {
    const { w, d, lane, pane } = await limitLane(LIMIT);
    w.clock = lane.createdAt + 40 * 60_000;
    await dutyTick(d);
    expect(d.store.lane("limit-lane")!.nudges).toBe(0);
    pane.screen = "editing loop.ts, running the tests\n";
    w.clock += 60_000;
    await dutyTick(d);
    expect(d.store.lane("limit-lane")!.recovery).toBeUndefined();
    expect(d.store.lane("limit-lane")!.nudges).toBe(1);
    expect(pane.received.at(-1)).toContain("idle for 41 minutes");
  });

  test("the lead is told when the agent will not exit, and the retry gate still follows the ladder", async () => {
    const { w, d, lead, lane, pane, restarts } = await limitLane(LIMIT);
    w.promptHook.set(lane.paneId, () => {
      // The agent ignores /exit and never leaves the pane, so there is nowhere to start it again.
    });
    await dutyTick(d);
    w.clock = lane.createdAt + 5 * 60_000;
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      lane: "limit-lane",
      action: "recover-failed",
      detail: expect.stringContaining("usage limit"),
    });
    expect(lead.received.at(-1)).toContain("the restart failed (the agent did not exit)");
    expect(restarts()).toEqual([]);
    expect(d.store.lane("limit-lane")!.recovery).toMatchObject({ attempts: 1 });
    expect(d.store.lane("limit-lane")!.nudges).toBe(0);
    expect(pane.received).toContain("/exit");
  });
});
