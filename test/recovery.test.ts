import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backoffMs, BACKOFF_MINUTES, screenHash, watchProviderFailure } from "../src/recovery.ts";
import { kickoffText, laneTranscript, sessionDirFor } from "../src/session-transcript.ts";
import { href, World } from "./fake.ts";

describe("recovery backoff", () => {
  test("5, 10, 20, 40 minutes, then 60 for every later attempt", () => {
    expect(BACKOFF_MINUTES).toEqual([5, 10, 20, 40, 60]);
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n) / 60_000)).toEqual([5, 10, 20, 40, 60, 60, 60]);
    expect(backoffMs(0) / 60_000).toBe(5);
    expect(screenHash("a")).not.toBe(screenHash("b"));
  });
});

function lane(w: World, over: Partial<Parameters<World["deps"]>[0]> = {}) {
  const d = w.deps();
  const dir = join(d.store.root, "work");
  d.store.saveLane({
    key: "usage-lane",
    sessionRef: href("w1:p2"),
    paneId: "w1:p2",
    tabId: "",
    brief: "/b.md",
    cwd: dir,
    status: "working",
    createdAt: 0,
    lastActivityAt: 0,
    nudges: 0,
    log: [],
    ...over,
  });
  return d;
}

describe("the provider-failure watch", () => {
  test("the first sighting is recorded, not restarted", async () => {
    const w = new World();
    const d = lane(w);
    const pane = w.addPane("w1:p2", "idle");
    pane.screen = "usage limit reached\n❯\n";
    const out = await watchProviderFailure(d, d.store.lane("usage-lane")!, 0, pane.screen);
    expect(out).toEqual({ kind: "watching" });
    expect(d.store.lane("usage-lane")!.recovery).toMatchObject({
      attempts: 0,
      kind: "usage limit",
      match: "usage limit",
    });
    expect(pane.ran).toEqual([]);
  });

  test("a screen that changed since the last pass is progress: no restart, and the next attempt starts over", async () => {
    const w = new World();
    const d = lane(w);
    const pane = w.addPane("w1:p2", "idle");
    pane.screen = "usage limit reached\nretry attempt 1\n❯\n";
    await watchProviderFailure(d, d.store.lane("usage-lane")!, 0, pane.screen);
    pane.screen = "usage limit reached\nretry attempt 2\n❯\n";
    expect(await watchProviderFailure(d, d.store.lane("usage-lane")!, 1000, pane.screen)).toEqual({ kind: "moving" });
    expect(d.store.lane("usage-lane")!.recovery!.attempts).toBe(0);
    expect(d.store.lane("usage-lane")!.recovery!.nextRetryAt).toBeUndefined();
    expect(pane.ran).toEqual([]);
    const grown = { ...d.store.lane("usage-lane")! };
    grown.recovery = {
      attempts: 2,
      nextRetryAt: 9_000_000,
      screenHash: "x",
      kind: "usage limit",
      match: "usage limit",
      at: 0,
    };
    d.store.saveLane(grown);
    expect(await watchProviderFailure(d, d.store.lane("usage-lane")!, 2000, pane.screen)).toEqual({ kind: "moving" });
    expect(d.store.lane("usage-lane")!.recovery!.attempts).toBe(0);
    expect(d.store.lane("usage-lane")!.recovery!.nextRetryAt).toBeUndefined();
    expect(pane.ran).toEqual([]);
  });

  test("an unchanged screen restarts the agent after the error, in the same pane and cwd", async () => {
    const w = new World();
    const d = lane(w);
    const pane = w.addPane("w1:p2", "idle");
    pane.screen = "Error: rate limit exceeded\n❯\n";
    w.promptHook.set("w1:p2", (text) => {
      if (text === "/exit") pane.status = "shell";
    });
    await watchProviderFailure(d, d.store.lane("usage-lane")!, 0, pane.screen);
    const out = await watchProviderFailure(d, d.store.lane("usage-lane")!, 1000, pane.screen);
    expect(out).toMatchObject({ kind: "recovered", attempt: 1, failure: { kind: "rate limit" } });
    expect(pane.received).toContain("/exit");
    expect(pane.ran).toHaveLength(1);
    expect(pane.ran[0]).toStartWith("omo 'You were interrupted by rate limit.");
    const saved = d.store.lane("usage-lane")!;
    expect(saved.status).toBe("working");
    expect(saved.nudges).toBe(0);
    expect(saved.recovery).toMatchObject({ attempts: 1, nextRetryAt: 1000 + 5 * 60_000 });
    expect(saved.log.at(-1)!.kind).toBe("recover");
  });

  test("the retry gate holds: nothing restarts before nextRetryAt, and the ladder is 5/10/20/40/60", async () => {
    const w = new World();
    const d = lane(w);
    const pane = w.addPane("w1:p2", "idle");
    const screen = "quota exceeded\n❯\n";
    pane.screen = screen;
    w.promptHook.set("w1:p2", (text) => {
      if (text === "/exit") {
        pane.status = "shell";
        pane.screen = screen;
      }
    });
    let now = 0;
    const delays: number[] = [];
    await watchProviderFailure(d, d.store.lane("usage-lane")!, now, screen);
    for (const [wait, expectRestart] of [
      [0, true],
      [4, false],
      [1, true],
      [9, false],
      [1, true],
      [19, false],
      [1, true],
      [39, false],
      [1, true],
      [59, false],
    ] as const) {
      now += wait * 60_000;
      const out = await watchProviderFailure(d, d.store.lane("usage-lane")!, now, screen);
      expect(out.kind === "recovered").toBe(expectRestart);
      if (out.kind === "recovered") delays.push(backoffMs(out.attempt) / 60_000);
    }
    expect(delays).toEqual([5, 10, 20, 40, 60]);
    expect(d.store.lane("usage-lane")!.recovery!.attempts).toBe(5);
  });

  test("a screen without the failure clears the record, resetting the ladder", async () => {
    const w = new World();
    const d = lane(w);
    w.addPane("w1:p2", "idle");
    const saved = { ...d.store.lane("usage-lane")! };
    saved.recovery = { attempts: 3, screenHash: "x", kind: "rate limit", match: "rate limit", at: 0 };
    d.store.saveLane(saved);
    expect(await watchProviderFailure(d, d.store.lane("usage-lane")!, 1000, "❯ working on it\n")).toEqual({
      kind: "cleared",
    });
    expect(d.store.lane("usage-lane")!.recovery).toBeUndefined();
    expect(await watchProviderFailure(d, d.store.lane("usage-lane")!, 2000, "rate limit again\n")).toEqual({
      kind: "watching",
    });
    expect(d.store.lane("usage-lane")!.recovery!.attempts).toBe(0);
  });

  test("an unreadable screen changes nothing", async () => {
    const w = new World();
    const d = lane(w);
    expect(await watchProviderFailure(d, d.store.lane("usage-lane")!, 0, undefined)).toEqual({ kind: "none" });
    expect(d.store.lane("usage-lane")!.recovery).toBeUndefined();
  });
});

describe("the transcript a recovery names", () => {
  test("the session directory is the cwd with every separator turned into a dash", () => {
    expect(sessionDirFor("/s", "/home/user/project")).toBe("/s/--home-user-project--");
    expect(sessionDirFor("/s", "/tmp/")).toBe("/s/--tmp--");
  });

  test("the newest session file under the lane's cwd is named; a recorded path wins; nothing found still reads as a path", () => {
    const w = new World();
    const d = lane(w);
    const cwd = join(d.store.root, "work");
    const dir = sessionDirFor(join(d.store.root, "sessions"), cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), "{}");
    writeFileSync(join(dir, "2026-02-01T00-00-00-000Z_bbb.jsonl"), "{}");
    const roots = [join(d.store.root, "sessions")];
    expect(laneTranscript({ cwd }, roots)).toBe(join(dir, "2026-02-01T00-00-00-000Z_bbb.jsonl"));
    expect(laneTranscript({ cwd, sessionPath: "/recorded/s.jsonl" }, roots)).toBe("/recorded/s.jsonl");
    expect(laneTranscript({ cwd: "/elsewhere" }, roots)).toBe("(no transcript found)");
  });

  test("the kickoff text is the one the brief names", () => {
    expect(kickoffText("usage limit", "/s/a.jsonl", "/home/user/project")).toBe(
      "You were interrupted by usage limit. Read your previous session transcript /s/a.jsonl and your work folder /home/user/project, recover context, then continue - do not restart.",
    );
  });
});
