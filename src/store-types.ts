import type { SessionRef } from "./runtime/types.ts";

export type LaneStatus = "working" | "waiting" | "ready" | "done" | "lost";

/**
 * One lane record. `sessionRef` is the session it runs in, on whichever runtime opened it; `paneId`/`tabId` are written
 * beside it (the ref's id and container) so an older binary still reads the file. `migratedFrom`: the sessions it ran in
 * before a `dori migrate`. `migration`: a handover is in progress, and the duty loop leaves the record alone.
 * `sessionPath`: the agent's own session file, when its command records one; `dori migrate --resume` needs it.
 * `recovery`: a provider failure the duty loop saw on the pane, with the screen hash that proves it is not progressing
 * and the attempt ladder (`nextRetryAt`) before the next restart. Cleared when the pane stops showing the failure.
 * `escalatedAt` marks a lane the restarts could not clear: the lead was told once and the lane is left alone.
 */
export type Lane = {
  key: string;
  sessionRef: SessionRef;
  migratedFrom?: SessionRef[];
  migration?: true;
  sessionPath?: string;
  paneId: string;
  tabId: string;
  brief: string;
  cwd: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  nudges: number;
  final?: { text: string; evidence: string[]; at: number };
  recovery?: LaneRecovery;
  log: { at: number; kind: "start" | "report" | "ready" | "nudge" | "done" | "lost" | "recover"; text: string }[];
};

export type LaneRecovery = {
  attempts: number;
  nextRetryAt?: number;
  screenHash: string;
  kind: string;
  match: string;
  at: number;
  /** Set when the attempt cap was reached on an unchanged failing screen: the lead was told once, and no restart follows. */
  escalatedAt?: number;
};

/** The sessions `dori up` opens; roles.json maps each to a ref string (a bare herdr pane id, or `hc:t7`). */
export type Role = "lead" | "duty" | "duty-loop" | "hourly-loop";

/**
 * A delivery that failed after the message may have reached the pane (#89). `typed`: the text is in the pane's input
 * and only Enter is retried; `agent` and `pgid` record which agent it was typed into (#108, see AgentIdentity).
 * `ambiguous`: it may or may not have arrived; it is held, never resent automatically.
 */
export type DeliveryAttempt = {
  at: number;
  state: "typed" | "ambiguous";
  detail?: string;
  agent?: string;
  pgid?: number;
};

/** A flush lock from another host (or an unreadable one) older than this is taken over; on this host only a dead pid frees it (#108). */
export const INBOX_LOCK_STALE_MS = 60_000;

export type QueuedMessage = { at: number; from: string; text: string; attempt?: DeliveryAttempt };

export type ReviewReceipt = {
  pr: string;
  sha: string;
  verdict: "CLEAR" | "BLOCK";
  model: string;
  at: number;
  summary: string;
};

export type ItemStatus = "open" | "running" | "done" | "dropped";

/** One backlog entry. Its id is the lane key the hourly loop starts it under. */
export type Item = {
  id: string;
  title: string;
  brief: string;
  cwd: string;
  priority: number;
  status: ItemStatus;
  decision?: string;
  askedAt?: number;
  remindedAt?: number;
  attempts: number;
  startFailures?: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
  log: { at: number; kind: "add" | "start" | "reopen" | "done" | "drop" | "ask" | "remind" | "decide"; text: string }[];
};

export type HostLoad = { load1: number; cores: number; memFreePct: number };

/** The command a paused session still owes: `compact` and `pause` open it, `resume` and `wake` close it. Absent once paused. */
export type GateNext = "compact" | "pause" | "resume" | "wake";

/**
 * One session paused because a Claude limit window is spent. `ref` is its refText, `target` the lead or a lane key;
 * `resumeAt` is the reset plus slack, or the next probe's time while no reset is known. `held` records a command that
 * may sit in the pane's input: the entry never types that command again, since a second copy would run it twice.
 */
export type GateEntry = {
  target: string;
  ref: string;
  phase: "paused-for-limit" | "resuming";
  closedAt: number;
  at: number;
  resumeAt: number;
  windowId: string;
  /** The model its own session file named when it was gated, so the record says why this session and not another. */
  model: string;
  usedPercent?: number;
  probe: number;
  next?: GateNext;
  held?: string;
  cwd: string;
  transcript: string;
  log: { at: number; kind: "pause" | "probe" | "resume" | "held"; text: string }[];
};

export type LoopRun = {
  at: number;
  skipped?: string;
  status?: {
    lanes: number;
    maxLanes: number;
    adhoc: string[];
    items: { open: number; decide: number; running: number };
    host: HostLoad;
  };
  synced: string[];
  findings: string[];
  started: string[];
  held: string[];
  asked: string[];
};

export const KEEP_RUNS = 168;
export const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** Role names are send targets, and resolveTarget tries roles first, so a lane with one of these keys could never be reached. */
export const RESERVED_KEYS: readonly Role[] = ["lead", "duty", "duty-loop", "hourly-loop"];
/** Refusal text for a reserved lane key, or undefined. Keys are lowercase-only (KEY_RE), so the exact match is the whole check. */
export const reservedKey = (key: string): string | undefined =>
  (RESERVED_KEYS as readonly string[]).includes(key) ? `lane key "${key}" is reserved for the ${key} role` : undefined;
