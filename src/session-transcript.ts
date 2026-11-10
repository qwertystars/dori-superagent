import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Lane } from "./store-types.ts";

/**
 * omo's session directory for one working directory (`sessions/--home-user-project--`, the path with every separator
 * turned into `-`). The skill's `session-id` module computes the same name; a recovery kickoff names the transcript
 * through it.
 */
export const sessionDirFor = (sessionsDir: string, cwd: string): string =>
  join(sessionsDir, `--${cwd.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "-")}--`);

/** Where omo keeps its session files: the native agent and the deepseek build, side by side under `~/.omo`. */
export const defaultSessionRoots = (home: string = homedir()): string[] => [
  join(home, ".omo", "agent", "sessions"),
  join(home, ".omo", "deepseek", "agent", "sessions"),
];

/**
 * The lane's own session file: the path a record already holds, else the newest `*.jsonl` under any root's directory
 * for its cwd, else that directory itself (the agent can find the file in it), else "(no transcript found)" so the
 * kickoff still reads as a sentence. Session file names start with an ISO timestamp, so the name order is the time order.
 */
export function laneTranscript(lane: Pick<Lane, "cwd" | "sessionPath">, roots: readonly string[]): string {
  if (lane.sessionPath !== undefined) return lane.sessionPath;
  let newest: string | undefined;
  let dir: string | undefined;
  for (const root of roots) {
    const at = sessionDirFor(root, lane.cwd);
    let names: readonly string[];
    try {
      names = readdirSync(at);
    } catch {
      continue;
    }
    dir ??= at;
    const last = names
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .at(-1);
    if (last !== undefined && (newest === undefined || basename(last) > basename(newest))) newest = join(at, last);
  }
  return newest ?? dir ?? "(no transcript found)";
}

/** The exact kickoff text a recovered lane is started with: `<match>` and `<path>` are substituted. */
export const kickoffText = (match: string, transcript: string, cwd: string): string =>
  `You were interrupted by ${match}. Read your previous session transcript ${transcript} and your work folder ${cwd}, recover context, then continue - do not restart.`;
