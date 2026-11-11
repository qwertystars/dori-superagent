import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { sessionDirFor } from "../src/session-transcript.ts";
import type { Lane } from "../src/store-types.ts";
import type { World } from "./fake.ts";

const assistant = (model: string, at = 1): string =>
  JSON.stringify({ type: "message", id: `m${at}`, message: { role: "assistant", model, content: [], usage: {} } });

const change = (model: string, at = 1): string =>
  JSON.stringify({ type: "model_change", id: `c${at}`, provider: "anthropic", modelId: model, source: "picker" });

/** Writes `<root>/--<cwd>--/<id>.jsonl` with one row per model, in order. Returns the path. */
export function sessionFile(
  root: string,
  cwd: string,
  models: readonly string[],
  id = "2026-01-01T00-00-00-000Z_aaa",
): string {
  const dir = sessionDirFor(root, cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const rows = models.map((m, i) => (i % 2 === 0 ? assistant(m, i) : change(m, i)));
  writeFileSync(file, `${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`);
  return file;
}

/** Gives the fake home a sessions root the resolver can search; every fixture below writes into it. */
export function sessionsFor(w: World, d: Deps): string {
  const root = join(d.store.root, "sessions");
  mkdirSync(root, { recursive: true });
  w.sessionRoots = [root];
  return root;
}

/** The lead pane at `/work/lead` with its own session file naming `models` newest last; returns that file. */
export function opusLead(w: World, d: Deps, models: readonly string[] = ["claude-opus-4-7"]): string {
  w.panes.get("w1:p1")!.cwd = "/work/lead";
  return sessionFile(sessionsFor(w, d), "/work/lead", models);
}

/** The lane pane at its own cwd with a session file naming `models`; returns that file. */
export function laneOn(w: World, d: Deps, lane: Lane, models: readonly string[]): string {
  w.panes.get(lane.paneId)!.cwd = lane.cwd;
  return sessionFile(sessionsFor(w, d), lane.cwd, models);
}
