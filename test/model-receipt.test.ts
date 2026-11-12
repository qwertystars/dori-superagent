import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../src/cli-up.ts";
import type { Deps } from "../src/harness.ts";
import { startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { BOAT_MODEL_SCRIPT, checkLaneModel, receiptTag, type ReceiptDeps } from "../src/model-receipt.ts";
import { assistantModelFromRows } from "../src/session-model.ts";
import type { Lane } from "../src/store-types.ts";
import { captureIo } from "./inbox-setup.ts";
import { setup } from "./harness-setup.ts";
import { setup as loopSetup } from "./loop-setup.ts";

const FIX = join(import.meta.dir, "fixtures", "model-receipt");
const PIN = "anthropic-subscription/claude-sonnet-5-5";
const OTHER = "opendesign-go/deepseek-v4.1-flash-eco";

const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

/** The fake boat CLI: the fixture script given the argv the real runner passes. The real `boat` is never reached. */
const fakeBoat = (sandbox: string) => {
  const run = Bun.spawnSync(["sh", join(FIX, "fake-boat.sh"), "exec", sandbox, "--", "sh", "-c", BOAT_MODEL_SCRIPT], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode ?? 1, stdout: run.stdout.toString() };
};

/** A boat runner that cannot read anything, for deps that must never call a real boat CLI. */
const noBoat = () => ({ code: 1, stdout: "" });

/** Receipt deps over a fixture (or none: an unreadable session). `workDir` names the sandbox files, one dir per test. */
const deps = (name: string | undefined = "match.jsonl", over: Partial<ReceiptDeps> = {}): ReceiptDeps => ({
  roots: [],
  workDir: over.workDir ?? join(FIX, "no-work"),
  readFile: (path) => readFileSync(path, "utf8"),
  // An empty name stands for a session that cannot be read: no rows, so no answer.
  sessionModelOf: () => (name === "" ? undefined : assistantModelFromRows(fixture(name))),
  boatExec: fakeBoat,
  ...over,
});

const lane = (model: string | undefined, over: Partial<Lane> = {}): Lane => ({
  key: "lane-a",
  sessionRef: { runtime: "herdr", id: "w1:p2" },
  paneId: "w1:p2",
  tabId: "w1:t1",
  brief: "/briefs/lane-a.md",
  cwd: "/home/user/project",
  status: "working",
  createdAt: 0,
  lastActivityAt: 0,
  nudges: 0,
  log: [],
  ...(model === undefined ? {} : { model }),
  ...over,
});

/** A session file under `<root>/sessions`, named as omo names it, holding `body`; returns its path. */
function seedSession(root: string, cwd: string, body: string): string {
  const dir = join(root, "sessions", `--${cwd.replace(/^\/+/, "").replace(/\/+/g, "-")}--`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "2026-01-01T00-00-00.jsonl");
  writeFileSync(path, body);
  return path;
}
/** A World deps whose receipt lookup only sees the temp sessions root and the always-failing boat runner. */
const offline = (d: Deps, root: string): Deps => ({ ...d, sessionRoots: [join(root, "sessions")], boatExec: noBoat });

describe("checkLaneModel", () => {
  test("the newest assistant row, provider-qualified, decides match and mismatch", () => {
    expect(checkLaneModel(lane(PIN, { sessionPath: "/s.jsonl" }), deps("match.jsonl"))).toMatchObject({
      pinned: PIN,
      actual: PIN,
      status: "match",
    });
    expect(checkLaneModel(lane(PIN, { sessionPath: "/s.jsonl" }), deps("mismatch.jsonl"))).toMatchObject({
      pinned: PIN,
      actual: OTHER,
      status: "mismatch",
    });
  });

  test("an invalid line is skipped, and a model_change row is not an answer", () => {
    expect(checkLaneModel(lane(PIN, { sessionPath: "/s.jsonl" }), deps("malformed.jsonl"))).toMatchObject({
      actual: PIN,
      status: "match",
    });
    // mismatch.jsonl ends on an assistant row after a model_change naming PIN: reading the change would say match.
    expect(checkLaneModel(lane(PIN, { sessionPath: "/s.jsonl" }), deps("mismatch.jsonl"))).toMatchObject({
      actual: OTHER,
      status: "mismatch",
    });
  });

  test("no pin, no assistant row, no session file or an unreadable one: unpinned and unknown, never mismatch", () => {
    expect(checkLaneModel(lane("unpinned"), deps("mismatch.jsonl"))).toMatchObject({
      pinned: "unpinned",
      status: "unpinned",
    });
    expect(checkLaneModel(lane(undefined), deps("mismatch.jsonl"))).toMatchObject({ status: "unpinned" });
    expect(checkLaneModel(lane(PIN, { sessionPath: "/s.jsonl" }), deps("no-assistant.jsonl"))).toMatchObject({
      pinned: PIN,
      status: "unknown",
    });
    expect(checkLaneModel(lane(PIN, { sessionPath: "/s.jsonl" }), deps(""))).toMatchObject({ status: "unknown" });
    const throwing = deps("match.jsonl", {
      sessionModelOf: () => {
        throw new Error("EACCES");
      },
    });
    expect(checkLaneModel(lane(PIN, { sessionPath: "/s.jsonl" }), throwing)).toMatchObject({ status: "unknown" });
  });

  test("a boat lane reads its sandbox's newest session, not the local file", () => {
    const work = mkdtempSync(join(tmpdir(), "dori-boat-"));
    // The pin matches the LOCAL fixture, so a mismatch proves the sandbox log is what was read.
    const boatLane = lane(PIN, { key: "boat-a", sessionPath: join(FIX, "match.jsonl") });
    writeFileSync(join(work, "boat-a.boat"), "sbx-mismatch\n");
    expect(checkLaneModel(boatLane, deps("match.jsonl", { workDir: work }))).toMatchObject({
      key: "boat-a",
      actual: OTHER,
      status: "mismatch",
    });
    writeFileSync(join(work, "boat-a.boat"), "sbx-match\n");
    expect(checkLaneModel(boatLane, deps("mismatch.jsonl", { workDir: work }))).toMatchObject({ status: "match" });
  });

  test("every boat failure is unknown, never a mismatch: a bad exit, empty output, or a throwing runner", () => {
    const work = mkdtempSync(join(tmpdir(), "dori-boat-"));
    writeFileSync(join(work, "boat-a.boat"), "sbx-nope\n");
    const boatLane = lane(PIN, { key: "boat-a", sessionPath: join(FIX, "mismatch.jsonl") });
    expect(checkLaneModel(boatLane, deps("mismatch.jsonl", { workDir: work }))).toMatchObject({ status: "unknown" });
    writeFileSync(join(work, "boat-a.boat"), "sbx-empty\n");
    expect(checkLaneModel(boatLane, deps("", { workDir: work }))).toMatchObject({ status: "unknown" });
    const throwing = deps("", {
      workDir: work,
      boatExec: () => {
        throw new Error("boat: not logged in");
      },
    });
    expect(checkLaneModel(boatLane, throwing)).toMatchObject({ status: "unknown" });
  });

  test("both tags carry the key, and only a mismatch names the models", () => {
    expect(receiptTag({ key: "k", pinned: PIN, actual: OTHER, status: "mismatch" })).toBe(
      `[MODEL-MISMATCH k] pinned=${PIN} actual=${OTHER}`,
    );
    expect(receiptTag({ key: "k", pinned: "unpinned", actual: undefined, status: "unpinned" })).toBe(
      "[MODEL-UNPINNED k]",
    );
    expect(receiptTag({ key: "k", pinned: PIN, actual: PIN, status: "match" })).toBeUndefined();
    expect(receiptTag({ key: "k", pinned: PIN, actual: undefined, status: "unknown" })).toBeUndefined();
  });
});

describe("dori status", () => {
  test("a mismatched live lane prints [MODEL-MISMATCH key] with both models; an unpinned lane prints [MODEL-UNPINNED key]", async () => {
    const { d } = setup();
    const root = mkdtempSync(join(tmpdir(), "dori-receipt-"));
    const cwd = join(root, "proj");
    const path = seedSession(root, cwd, fixture("mismatch.jsonl"));
    d.store.saveLane(lane(PIN, { key: "off-pin", cwd, sessionPath: path }));
    d.store.saveLane(lane(undefined, { key: "open-lane" }));
    const { out } = await captureIo(async () => {
      status(offline(d, root));
      return 0;
    });
    const line = (key: string) => out.split("\n").find((l) => l.startsWith(key))!;
    expect(line("off-pin")).toContain(`[MODEL-MISMATCH off-pin] pinned=${PIN} actual=${OTHER}`);
    expect(line("open-lane")).toContain("[MODEL-UNPINNED open-lane]");
  });

  test("a matching lane and a closed lane carry no tag", async () => {
    const { d } = setup();
    const root = mkdtempSync(join(tmpdir(), "dori-receipt-"));
    const path = seedSession(root, root, fixture("match.jsonl"));
    d.store.saveLane(lane(PIN, { key: "on-pin", cwd: root, sessionPath: path }));
    d.store.saveLane(lane(PIN, { key: "gone", status: "done", cwd: root, sessionPath: path }));
    const { out } = await captureIo(async () => {
      status(offline(d, root));
      return 0;
    });
    const line = (key: string) => out.split("\n").find((l) => l.startsWith(key))!;
    expect(line("on-pin")).toContain(`model=${PIN}`);
    expect(line("on-pin")).not.toContain("MODEL-");
    expect(line("gone")).not.toContain("MODEL-");
  });
});

describe("the hourly loop", () => {
  test("a mismatched live lane reaches the lead inbox in the [LOOP ...] alert, with the status tag text", async () => {
    const { d, lead, brief } = loopSetup();
    const root = mkdtempSync(join(tmpdir(), "dori-receipt-"));
    const path = seedSession(root, root, fixture("mismatch.jsonl"));
    for (const [key, model] of [
      ["off-pin", PIN],
      ["on-pin", OTHER],
    ] as const) {
      await startLane(d, key, brief, { group: "w1", model });
      const l = d.store.lane(key)!;
      l.cwd = root;
      l.sessionPath = path;
      d.store.saveLane(l);
    }
    lead.received.length = 0;
    const run = await loopTick(offline(d, root), { force: true, maxStarts: 0, maxLanes: 9 });
    expect(run.findings).toContain(`[MODEL-MISMATCH off-pin] pinned=${PIN} actual=${OTHER}`);
    expect(run.findings.some((f) => f.includes("on-pin"))).toBe(false);
    const loopMsg = lead.received.find((m) => m.startsWith("[LOOP"))!;
    expect(loopMsg).toContain(`[MODEL-MISMATCH off-pin] pinned=${PIN} actual=${OTHER}`);
    expect(loopMsg).not.toContain("[MODEL-MISMATCH on-pin]");
    expect(d.store.lastRun()!.findings).toContain(`[MODEL-MISMATCH off-pin] pinned=${PIN} actual=${OTHER}`);
  });

  test("an unpinned lane and a lane whose log cannot be read raise no alert", async () => {
    const { d, lead, brief } = loopSetup();
    await startLane(d, "open-lane", brief, { group: "w1" });
    await startLane(d, "unknown-lane", brief, { group: "w1", model: PIN });
    lead.received.length = 0;
    const run = await loopTick(
      { ...d, sessionRoots: [], boatExec: noBoat },
      { force: true, maxStarts: 0, maxLanes: 9 },
    );
    expect(run.findings).toEqual([]);
    expect(lead.received.some((m) => m.includes("MODEL-MISMATCH"))).toBe(false);
  });

  test("a closed lane is not swept: done and lost lanes never alert", async () => {
    const { d, lead, brief } = loopSetup();
    const root = mkdtempSync(join(tmpdir(), "dori-receipt-"));
    const path = seedSession(root, root, fixture("mismatch.jsonl"));
    await startLane(d, "old-pin", brief, { group: "w1", model: PIN });
    const closed = d.store.lane("old-pin")!;
    closed.status = "lost";
    closed.cwd = root;
    closed.sessionPath = path;
    d.store.saveLane(closed);
    lead.received.length = 0;
    const run = await loopTick(offline(d, root), { force: true, maxStarts: 0, maxLanes: 9 });
    expect(run.findings).toEqual([]);
    expect(lead.received.some((m) => m.includes("MODEL-MISMATCH"))).toBe(false);
  });
});
