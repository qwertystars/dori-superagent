import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDir,
  GATE_WINDOWS,
  probeMs,
  PROBE_MINUTES,
  readGateConfig,
  readUsageCache,
  resetDue,
  trippedWindow,
  usageCachePath,
} from "../src/limit-windows.ts";

const fresh = (name: string): string => mkdtempSync(join(tmpdir(), `dori-limit-${name}-`));

const cacheFile = (dir: string, accounts: Record<string, unknown>): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "subscription-usage.json");
  writeFileSync(path, JSON.stringify({ accounts, fetching: {} }));
  return path;
};

const claude = (windows: unknown[], extra: Record<string, unknown> = {}) => ({ windows, ...extra });
const opus = (usedPercent: number, resetsAt?: string) => ({
  id: "claude:7d_opus",
  label: "7d opus",
  windowMinutes: 10080,
  usedPercent,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

describe("the account windows a pause is read from", () => {
  test("the machine cache is parsed per Claude account, other providers and other slots are ignored", () => {
    const path = cacheFile(fresh("la"), {
      "anthropic-subscription/default": claude([
        { id: "claude:5h", usedPercent: 40, resetsAt: "2026-01-01T00:50:00.000Z" },
        opus(97, "2026-01-03T00:00:00.000Z"),
        { id: "claude:7d_fable", usedPercent: 0, resetsAt: "2026-01-03T00:00:00.000Z" },
      ]),
      "chatgpt-subscription/default": claude([{ id: "codex:primary", usedPercent: 99 }]),
      "anthropic-subscription/next": claude([
        { id: "claude:5h", usedPercent: 100, resetsAt: "2026-01-01T02:00:00.000Z" },
      ]),
    });
    const reading = readUsageCache(path)!;
    expect(reading.accounts.map((a) => a.name)).toEqual([
      "anthropic-subscription/default",
      "anthropic-subscription/next",
    ]);
    expect(reading.accounts[0]!.windows.map((w) => w.id)).toEqual(["claude:5h", "claude:7d_opus", "claude:7d_fable"]);
    expect(reading.accounts[1]!.windows).toEqual([
      { id: "claude:5h", usedPercent: 100, resetsAt: Date.parse("2026-01-01T02:00:00.000Z") },
    ]);
  });

  test("a missing, unreadable or shapeless cache is unknown, and unknown never pauses", () => {
    const dir = fresh("none");
    expect(readUsageCache(join(dir, "nope.json"))).toBeUndefined();
    mkdirSync(dir, { recursive: true });
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    expect(readUsageCache(broken)).toBeUndefined();
    writeFileSync(broken, JSON.stringify({ accounts: { "anthropic-subscription/default": { windows: "x" } } }));
    expect(readUsageCache(broken)!.accounts).toEqual([{ name: "anthropic-subscription/default", windows: [] }]);
    expect(trippedWindow(readUsageCache(broken), 95, 0)).toBeUndefined();
    expect(trippedWindow(undefined, 95, 0)).toBeUndefined();
  });

  test("the highest spent window decides, across accounts, and the Opus window outranks a lower weekly one", () => {
    const path = cacheFile(fresh("best"), {
      "anthropic-subscription/default": claude([
        { id: "claude:7d_opus", usedPercent: 96, resetsAt: "2026-01-05T00:00:00.000Z" },
        { id: "claude:7d", usedPercent: 99, resetsAt: "2026-01-09T00:00:00.000Z" },
      ]),
      "anthropic-subscription/next": claude([
        { id: "claude:7d_opus", usedPercent: 40, resetsAt: "2026-01-05T00:00:00.000Z" },
      ]),
    });
    const hit = trippedWindow(readUsageCache(path), 95, Date.parse("2026-01-02T00:00:00.000Z"))!;
    expect(hit.account).toBe("anthropic-subscription/default");
    expect(hit.window.id).toBe("claude:7d_opus");
    expect(hit.window.usedPercent).toBe(96);
    expect(hit.window.resetsAt).toBe(Date.parse("2026-01-05T00:00:00.000Z"));
  });

  test("without an Opus window the fallback windows gate at a hard 100; the configured percentage is not theirs", () => {
    const path = cacheFile(fresh("fallback"), {
      "anthropic-subscription/default": claude([
        { id: "claude:5h", usedPercent: 97, resetsAt: "2026-01-05T00:00:00.000Z" },
        { id: "claude:7d", usedPercent: 97, resetsAt: "2026-01-09T00:00:00.000Z" },
      ]),
    });
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    expect(trippedWindow(readUsageCache(path), 95, now)).toBeUndefined();
    expect(trippedWindow(readUsageCache(path), 100, now)).toBeUndefined();
    const spent = cacheFile(fresh("fallback2"), {
      "anthropic-subscription/default": claude([
        { id: "claude:5h", usedPercent: 100, resetsAt: "2026-01-05T00:00:00.000Z" },
      ]),
    });
    expect(trippedWindow(readUsageCache(spent), 95, now)?.window.id).toBe("claude:5h");
  });

  test("a window whose reset already passed is not a trip: the poller replaces that reading, and waking must not re-pause", () => {
    const path = cacheFile(fresh("past"), {
      "anthropic-subscription/default": claude([opus(100, "2026-01-02T00:00:00.000Z")]),
    });
    const now = Date.parse("2026-01-02T00:10:00.000Z");
    expect(trippedWindow(readUsageCache(path), 95, now)).toBeUndefined();
    expect(trippedWindow(readUsageCache(path), 95, now - 20 * 60_000)?.window.id).toBe("claude:7d_opus");
  });

  test("a window with no reset time is a trip with unknown timing, never a 0% reading", () => {
    const path = cacheFile(fresh("noreset"), {
      "anthropic-subscription/default": claude([opus(100)]),
    });
    const hit = trippedWindow(readUsageCache(path), 95, 0)!;
    expect(hit.window.resetsAt).toBeUndefined();
    const due = resetDue(hit.window, 1_000, 60_000, 1);
    expect(due).toEqual({ resumeAt: 1_000 + 5 * 60_000, probe: true });
  });

  test("gated window ids are the three D1 names, Opus first", () => {
    expect(GATE_WINDOWS).toEqual(["claude:7d_opus", "claude:5h", "claude:7d"]);
  });
});

describe("the pause clock and its thresholds", () => {
  test("the probe waits 5, 15, 30 minutes, then an hour each time", () => {
    expect(PROBE_MINUTES).toEqual([5, 15, 30, 60]);
    expect([1, 2, 3, 4, 9].map((n) => probeMs(n) / 60_000)).toEqual([5, 15, 30, 60, 60]);
    expect(probeMs(0) / 60_000).toBe(5);
  });

  test("a known reset ends the pause at the reset plus the slack", () => {
    const at = Date.parse("2026-01-02T00:00:00.000Z");
    expect(resetDue({ id: "claude:7d_opus", usedPercent: 99, resetsAt: at }, at - 60_000, 60_000, 1)).toEqual({
      resumeAt: at + 60_000,
      probe: false,
    });
    // A reset exactly at "now" is no future reset: it cannot be waited out, so it is a probe.
    expect(resetDue({ id: "claude:7d_opus", usedPercent: 99, resetsAt: at }, at, 60_000, 1)).toEqual({
      resumeAt: at + 5 * 60_000,
      probe: true,
    });
  });

  test("the percentage and slack come from the environment, and a malformed value falls back to its default", () => {
    expect(readGateConfig({})).toEqual({ percent: 95, slackMs: 60_000 });
    expect(readGateConfig({ DORI_GATE_PERCENT: "80", DORI_GATE_SLACK_S: "5" })).toEqual({
      percent: 80,
      slackMs: 5_000,
    });
    expect(readGateConfig({ DORI_GATE_PERCENT: "abc", DORI_GATE_SLACK_S: "NaN" })).toEqual({
      percent: 95,
      slackMs: 60_000,
    });
    expect(readGateConfig({ DORI_GATE_PERCENT: "0", DORI_GATE_SLACK_S: "-1" })).toEqual({ percent: 1, slackMs: 0 });
    expect(readGateConfig({ DORI_GATE_PERCENT: "1000", DORI_GATE_SLACK_S: "999999" })).toEqual({
      percent: 100,
      slackMs: 86_400_000,
    });
  });

  test("the agent dir is the env override, else ~/.omo/agent with settings, else ~/.omo, else ~/.senpi/agent", () => {
    const home = fresh("home");
    mkdirSync(join(home, ".omo", "agent"), { recursive: true });
    writeFileSync(join(home, ".omo", "agent", "settings.json"), "{}");
    expect(agentDir({ OMO_CODING_AGENT_DIR: "/x/agent" }, home)).toBe("/x/agent");
    expect(agentDir({ SENPI_CODING_AGENT_DIR: "/y/agent" }, home)).toBe("/y/agent");
    expect(agentDir({}, home)).toBe(join(home, ".omo", "agent"));
    expect(usageCachePath({}, home)).toBe(join(home, ".omo", "agent", "subscription-usage.json"));
    const empty = join(fresh("empty"), "h");
    expect(agentDir({}, empty)).toBe(join(empty, ".omo", "agent"));
  });
});
