import { afterEach, describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const LIMIT = "API Error: usage limit reached for this account\n❯\n";
/** The auth variant of omo's blocked-accounts sentence: the one the copied OAuth login went stale on. */
const AUTH = "Error: All Claude accounts for anthropic-subscription are currently blocked (authentication error).\n❯";

/** Starts "limit-lane" on `screen`; the agent leaves for its shell on /exit and the failure stays on the screen. */
async function limitLane(screen: string) {
  const s = setup();
  const lane = await startLane(s.d, "limit-lane", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  pane.screen = screen;
  s.w.promptHook.set(lane.paneId, (text) => {
    if (text === "/exit") {
      pane.status = "shell";
      pane.screen = screen;
    }
  });
  const restarts = (): readonly string[] => pane.ran.slice(1);
  const tick = async (min: number, shown: string = screen) => {
    s.w.clock = lane.createdAt + min * 60_000;
    pane.screen = shown;
    return dutyTick(s.d);
  };
  return { ...s, lane, pane, restarts, tick };
}

/** The lead's escalation messages, exactly as the report path wrote them. */
const escalations = (lead: { received: string[] }): string[] =>
  lead.received.filter((m) => m.startsWith("[ESCALATE limit-lane] recovery gave up"));

/** One sighting, then three restarts at their gates (1, 6, 16 min), so a fourth is due at 36. */
async function threeRestarts(tick: (min: number, shown?: string) => Promise<unknown[]>) {
  await tick(0);
  await tick(1);
  await tick(5);
  await tick(6);
  await tick(15);
  await tick(16);
  await tick(35);
}

afterEach(() => {
  delete process.env["DORI_RECOVER_MAX_ATTEMPTS"];
});

describe("the recovery attempt cap", () => {
  test("three restarts, then one escalation quoting the pane's own error line verbatim", async () => {
    const { lead, restarts, tick } = await limitLane(LIMIT);
    await threeRestarts(tick);
    expect(restarts()).toHaveLength(3);
    expect(escalations(lead)).toEqual([]);
    await tick(36);
    expect(restarts()).toHaveLength(3);
    expect(escalations(lead)).toEqual([
      "[ESCALATE limit-lane] recovery gave up after 3 attempts; restart cannot clear this. Pane shows: API Error: usage limit reached for this account",
    ]);
  });

  test("one escalation across hours of further ticks, and never another restart", async () => {
    const { lead, restarts, tick } = await limitLane(LIMIT);
    await threeRestarts(tick);
    let escalated = (await tick(36)).filter((e) => e.action === "recover-escalated").length;
    for (let min = 37; min <= 240; min += 20) {
      escalated += (await tick(min)).filter((e) => e.action === "recover-escalated").length;
    }
    expect(escalated).toBe(1);
    expect(escalations(lead)).toHaveLength(1);
    expect(restarts()).toHaveLength(3);
  });

  test("an escalated lane gets no idle nudge; a clean screen clears the record and puts it back on that ladder", async () => {
    const { d, lane, restarts, tick } = await limitLane(LIMIT);
    await threeRestarts(tick);
    await tick(36);
    expect(d.store.lane("limit-lane")!.recovery).toMatchObject({
      attempts: 3,
      escalatedAt: lane.createdAt + 36 * 60_000,
    });
    await tick(60);
    expect(d.store.lane("limit-lane")!.nudges).toBe(0);
    await tick(61, "editing loop.ts, running the tests\n");
    expect(d.store.lane("limit-lane")!.recovery).toBeUndefined();
    expect(d.store.lane("limit-lane")!.nudges).toBe(1);
    expect(restarts()).toHaveLength(3);
  });

  test("the auth-variant blocked-accounts sentence escalates after 3 attempts with its exact text", async () => {
    const { lead, restarts, tick } = await limitLane(AUTH);
    await threeRestarts(tick);
    expect(restarts()).toHaveLength(3);
    await tick(36);
    expect(restarts()).toHaveLength(3);
    expect(escalations(lead)).toEqual([
      "[ESCALATE limit-lane] recovery gave up after 3 attempts; restart cannot clear this. Pane shows: Error: All Claude accounts for anthropic-subscription are currently blocked (authentication error).",
    ]);
  });

  test("DORI_RECOVER_MAX_ATTEMPTS moves the cap for the duty loop", async () => {
    process.env["DORI_RECOVER_MAX_ATTEMPTS"] = "1";
    const { lead, restarts, tick } = await limitLane(LIMIT);
    await tick(0);
    await tick(1);
    expect(restarts()).toHaveLength(1);
    await tick(6);
    expect(restarts()).toHaveLength(1);
    expect(escalations(lead)).toEqual([
      "[ESCALATE limit-lane] recovery gave up after 1 attempt; restart cannot clear this. Pane shows: API Error: usage limit reached for this account",
    ]);
  });
});
