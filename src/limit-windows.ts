import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One subscription limit window, as omo's machine-wide cache keeps it (`<agentDir>/subscription-usage.json`, written by
 * `@code-yeongyu/senpi/dist/core/subscription-limits/usage-poller.js`). `usedPercent` is 0-100 and `resetsAt` epoch ms
 * when the provider reported one: it is when the pause ends.
 */
export type LimitWindow = { readonly id: string; readonly usedPercent: number; readonly resetsAt?: number };

/** One Claude account's windows as the cache holds them; the windows are never merged across accounts (see `trippedWindow`). */
export type LimitAccount = { readonly name: string; readonly windows: readonly LimitWindow[] };

export type LimitsReading = { readonly accounts: readonly LimitAccount[] };

/** The threshold and slack the pause is decided with (`DORI_GATE_PERCENT`, `DORI_GATE_SLACK_S`). */
export type GateConfig = { readonly percent: number; readonly slackMs: number };

/** A window at the limit, with the account that reported it, and the time the pause ends. */
export type Due = { readonly resumeAt: number; readonly probe: boolean };

/** Only Claude's subscription accounts gate anything: the pause exists for the Opus allowance. */
const CLAUDE_ACCOUNT = "anthropic-subscription/";
/** Per account, the Opus-only metered window decides when it is reported; else the session (5h) and weekly windows do. */
export const GATE_WINDOWS: readonly string[] = ["claude:7d_opus", "claude:5h", "claude:7d"];
export const GATE_PERCENT_DEFAULT = 95;
export const GATE_SLACK_S_DEFAULT = 60;
/** The probe waits while the reset time is unknown: 5, 15, 30 minutes, then every hour. */
export const PROBE_MINUTES = [5, 15, 30, 60] as const;
const LAST_PROBE_MINUTES = 60;

export const probeMs = (attempt: number): number =>
  (PROBE_MINUTES[Math.min(Math.max(attempt, 1), PROBE_MINUTES.length) - 1] ?? LAST_PROBE_MINUTES) * 60_000;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const when = (value: unknown): number | undefined =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * Where omo keeps its agent state, resolved the way the omo bundle does: a `*_CODING_AGENT_DIR` env var, else
 * `~/.omo/agent` when it holds settings, else `~/.omo`, else `~/.senpi/agent`.
 */
export function agentDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const named = env["OMO_CODING_AGENT_DIR"] ?? env["SENPI_CODING_AGENT_DIR"] ?? env["PI_CODING_AGENT_DIR"];
  if (named !== undefined && named !== "") return named;
  const omo = join(home, ".omo");
  if (existsSync(join(omo, "agent", "settings.json")) || !existsSync(omo)) return join(omo, "agent");
  return omo;
}

export const usageCachePath = (env: NodeJS.ProcessEnv, home: string = homedir()): string =>
  join(agentDir(env, home), "subscription-usage.json");

/** The thresholds from the environment; a malformed value falls back to its default instead of pausing on NaN. */
export function readGateConfig(env: NodeJS.ProcessEnv): GateConfig {
  const percent = Number(env["DORI_GATE_PERCENT"] ?? GATE_PERCENT_DEFAULT);
  const slack = Number(env["DORI_GATE_SLACK_S"] ?? GATE_SLACK_S_DEFAULT);
  return {
    percent: Number.isFinite(percent) ? clamp(percent, 1, 100) : GATE_PERCENT_DEFAULT,
    slackMs: (Number.isFinite(slack) ? clamp(slack, 0, 86_400) : GATE_SLACK_S_DEFAULT) * 1000,
  };
}

const windowsOf = (list: unknown): LimitWindow[] =>
  (Array.isArray(list) ? list : [])
    .map(rec)
    .filter((w): w is Record<string, unknown> => w !== undefined)
    .flatMap((w) => {
      const id = text(w["id"]);
      const used = num(w["usedPercent"]);
      if (id === undefined || used === undefined) return [];
      const at = when(w["resetsAt"]);
      return [{ id, usedPercent: clamp(used, 0, 100), ...(at === undefined ? {} : { resetsAt: at }) }];
    });

/**
 * Reads the machine cache into one account's windows per Claude account. An unreadable or malformed file is unknown,
 * which pauses nothing; a window an account does not report is absent (unknown), never 0%.
 */
export function readUsageCache(path: string): LimitsReading | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const accounts = rec(rec(raw)?.["accounts"]);
  if (accounts === undefined) return undefined;
  return {
    accounts: Object.entries(accounts)
      .filter(([name]) => name.startsWith(CLAUDE_ACCOUNT))
      .map(([name, account]) => ({ name, windows: windowsOf(rec(account)?.["windows"]) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** A window whose reset is already past cannot prove the account is still spent: the poller replaces that reading within
 * 5 minutes, and treating it as a trip would re-pause the session it just woke. */
const spentNow = (w: LimitWindow, now: number): boolean => w.resetsAt === undefined || w.resetsAt > now;

/** A window's threshold: D5's rule is the configured percentage on the Opus-only window, and a hard 100% on the 5h and
 * weekly windows, which the plan reports with or without Opus metering. */
type Limit = { readonly window: LimitWindow; readonly percent: number };

function gateLimits(account: LimitAccount, percent: number): readonly Limit[] {
  const opus = account.windows.filter((w) => w.id === GATE_WINDOWS[0]);
  const rest = account.windows.filter((w) => GATE_WINDOWS.slice(1).includes(w.id));
  return [
    ...opus.slice(0, 1).map((window) => ({ window, percent })),
    ...rest.map((window) => ({ window, percent: 100 })),
  ];
}

/**
 * The window that trips the pause: the highest-usage metered Claude window at or over its threshold that a reset has not
 * already invalidated. The most spent window decides, so the reset the pause waits for is the one furthest away.
 */
export function trippedWindow(
  reading: LimitsReading | undefined,
  percent: number,
  now: number,
): { account: string; window: LimitWindow } | undefined {
  if (reading === undefined) return undefined;
  const spent = reading.accounts.flatMap((a) =>
    gateLimits(a, percent)
      .filter(({ window, percent: at }) => window.usedPercent >= at && spentNow(window, now))
      .map(({ window }) => ({ account: a.name, window })),
  );
  return spent.sort(
    (a, b) =>
      b.window.usedPercent - a.window.usedPercent ||
      (b.window.resetsAt ?? 0) - (a.window.resetsAt ?? 0) ||
      a.window.id.localeCompare(b.window.id),
  )[0];
}

/** When a pause ends: the tripped window's reset plus slack, or the next probe when no future reset is known. */
export function resetDue(window: LimitWindow, now: number, slackMs: number, attempt: number): Due {
  return window.resetsAt !== undefined && window.resetsAt > now
    ? { resumeAt: window.resetsAt + slackMs, probe: false }
    : { resumeAt: now + probeMs(attempt), probe: true };
}
