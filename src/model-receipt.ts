// A lane's model receipt: the pin the lane was started with, and the model its own session log says answered.
// The session file comes from the existing search (laneTranscript, src/session-transcript.ts), its rows from
// session-model.ts's own progressive tail reader (readModel over assistantModelFromRows), so no second file search
// or tail scan exists here. A boat lane is asked through `boat exec`; the runner is injectable, so tests never reach
// the real CLI. Any boat failure is `unknown`, never a mismatch: a receipt may not accuse a lane whose log it could
// not read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { assistantModelFromRows, readModel } from "./session-model.ts";
import { laneTranscript } from "./session-transcript.ts";
import { UNPINNED_MODEL, type Lane } from "./store-types.ts";

type LaneView = Pick<Lane, "key" | "cwd" | "sessionPath" | "model">;
export type ModelStatus = "match" | "mismatch" | "unpinned" | "unknown";
/** `actual` is undefined exactly when nothing named a model to compare: status `unknown`, or nothing pinned. */
export type ModelReceipt = { key: string; pinned: string; actual: string | undefined; status: ModelStatus };

/** `boat exec <sandbox> -- sh -c <script>`: a failure is a result, never a throw. Sync: `dori status` is a report. */
export type BoatExec = (sandbox: string) => { readonly code: number; readonly stdout: string };

/** The inputs a receipt needs, injected whole: a test serves fixtures and a fake boat CLI. */
export type ReceiptDeps = {
  /** Session roots the existing lane transcript search walks (src/session-transcript.ts). */
  readonly roots: readonly string[];
  /** `~/.dori/work`: a `<key>.boat` file here names the lane's sandbox. */
  readonly workDir: string;
  /** A small file's text (the `.boat` marker), or undefined when it cannot be read. */
  readonly readFile: (path: string) => string | undefined;
  /** A session file's newest answering model, or undefined when it cannot be read or names none. */
  readonly sessionModelOf: (path: string) => string | undefined;
  readonly boatExec: BoatExec;
};

/** The newest session under ~/.omo/agent/sessions, its last 400 rows: the boat lane's own log. */
export const BOAT_MODEL_SCRIPT = 'f=$(ls -t ~/.omo/agent/sessions/*/*.jsonl | head -1); tail -n 400 "$f"';

/**
 * The default boat runner. The timeout keeps a slow sandbox from hanging the report; a missing CLI or any exit is a
 * failed read (`unknown`), never a throw and never a mismatch.
 */
export const spawnBoatExec: BoatExec = (sandbox) => {
  try {
    const run = Bun.spawnSync(
      ["boat", "exec", "--timeout", "20", "--no-update", sandbox, "--", "sh", "-c", BOAT_MODEL_SCRIPT],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    return { code: run.exitCode ?? 1, stdout: run.stdout.toString() };
  } catch {
    return { code: 1, stdout: "" };
  }
};

/** Every read on this path answers a receipt, never throws one: a missing file is `unknown`, not a crash. */
const attempt = <T>(run: () => T): T | undefined => {
  try {
    return run();
  } catch {
    return undefined;
  }
};

/** The sandbox id `~/.dori/work/<key>.boat` holds, when the lane is a boat lane. */
const boatSandbox = (lane: LaneView, deps: ReceiptDeps): string | undefined => {
  const id = attempt(() => deps.readFile(join(deps.workDir, `${lane.key}.boat`)))?.trim();
  return id === undefined || id === "" ? undefined : id;
};

/** The model the lane answered with; undefined when no readable row, no session file or a failed boat run names one. */
function laneActualModel(lane: LaneView, deps: ReceiptDeps): string | undefined {
  const sandbox = boatSandbox(lane, deps);
  if (sandbox !== undefined) {
    const run = attempt(() => deps.boatExec(sandbox));
    return run === undefined || run.code !== 0 ? undefined : attempt(() => assistantModelFromRows(run.stdout));
  }
  return attempt(() => deps.sessionModelOf(laneTranscript(lane, deps.roots)));
}

/**
 * The lane's receipt: `match` when its session log's newest assistant model equals the pin, `mismatch` when it does
 * not, `unpinned` when nothing was pinned (a pre-pin record has no field, which reads the same), `unknown` when no
 * readable log names a model or a boat run failed.
 */
export function checkLaneModel(lane: LaneView, deps: ReceiptDeps): ModelReceipt {
  const pinned = lane.model ?? UNPINNED_MODEL;
  if (pinned === UNPINNED_MODEL) return { key: lane.key, pinned, actual: undefined, status: "unpinned" };
  const actual = laneActualModel(lane, deps);
  if (actual === undefined) return { key: lane.key, pinned, actual, status: "unknown" };
  return actual === pinned
    ? { key: lane.key, pinned, actual, status: "match" }
    : { key: lane.key, pinned, actual, status: "mismatch" };
}

/** The tag both surfaces print: a mismatch carries the two models, an unpinned lane carries only its key. */
export function receiptTag(receipt: ModelReceipt): string | undefined {
  if (receipt.status === "mismatch")
    return `[MODEL-MISMATCH ${receipt.key}] pinned=${receipt.pinned} actual=${receipt.actual}`;
  if (receipt.status === "unpinned") return `[MODEL-UNPINNED ${receipt.key}]`;
  return undefined;
}

/** True for a lane the harness still runs (working, waiting or ready): the split the hourly loop already uses. */
export const isLiveLane = (lane: Pick<Lane, "status">): boolean => lane.status !== "done" && lane.status !== "lost";

/** The live lanes' receipts over one set of deps: the sweep `dori status` and the hourly loop both need. */
export function laneReceipts(d: Deps, lanes: readonly Lane[]): ModelReceipt[] {
  const deps = receiptDeps(d);
  return lanes.filter(isLiveLane).map((lane) => checkLaneModel(lane, deps));
}

/** The hourly loop's alert lines: the tag per mismatched live lane, nothing for unpinned or unreadable ones. */
export const mismatchTags = (d: Deps, lanes: readonly Lane[]): string[] =>
  laneReceipts(d, lanes).flatMap((r) => (r.status === "mismatch" ? [receiptTag(r)!] : []));

/** The deps of a real run: roots and home from the process, the session reader and the boat runner from Deps. */
export const receiptDeps = (d: Deps): ReceiptDeps => ({
  roots: d.sessionRoots,
  workDir: join(d.store.root, "work"),
  readFile: (path) => attempt(() => readFileSync(path, "utf8")),
  sessionModelOf: (path) => readModel(path, assistantModelFromRows),
  boatExec: d.boatExec ?? spawnBoatExec,
});
