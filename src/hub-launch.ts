// The one launch path a lane takes when the hub is installed (DORI_HUB_BIN): the spec the hub reads from disk, the
// argv it is asked with, and the reply it answers with. A hub failure refuses the start; nothing falls back to typing
// an agent command into a pane.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Refusal } from "./refusal.ts";
import type { Exec, ExecResult } from "./runtime/exec.ts";

export type LaneSpec = {
  key: string;
  briefPath: string;
  role: "lane";
  model: { pin: string };
  engine: { argv: string[]; extensions: string[]; env: Record<string, string> };
  workspace: { kind: "local"; cwd: string };
  budget: Record<string, never>;
  permissionProfile: "inbox";
};

/** `{"ok":true,"key","status"}` on exit 0, or `{"ok":false,"error"}` on exit 1. */
export type HubStart = { key: string; status: string };

export const hubBin = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  const hub = env["DORI_HUB_BIN"]?.trim();
  return hub === undefined || hub === "" ? undefined : hub;
};

export const engineArgv = (agentCmd: string): string[] =>
  agentCmd
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "");

export const laneSpec = (o: {
  key: string;
  briefPath: string;
  model: string;
  cwd: string;
  agentCmd: string;
}): LaneSpec => ({
  key: o.key,
  briefPath: o.briefPath,
  role: "lane",
  model: { pin: o.model },
  engine: { argv: engineArgv(o.agentCmd), extensions: [], env: {} },
  workspace: { kind: "local", cwd: o.cwd },
  budget: {},
  permissionProfile: "inbox",
});

export const writeSpec = (home: string, spec: LaneSpec): string => {
  const path = join(home, "hub-specs", `${spec.key}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
  return path;
};

const replyOf = (result: ExecResult): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The hub's own reason, else its stderr/stdout, else its exit code: a refusal always carries a sentence. */
const reason = (reply: Record<string, unknown> | undefined, result: ExecResult): string => {
  const error = reply?.["error"];
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  const said = (result.stderr || result.stdout).trim();
  return said === "" ? `hub exited ${result.code}` : said;
};

/** `"<hub> lane start --spec <file> --json"` through the injected runner: any reply but an ok one refuses the start. */
export async function hubStart(exec: Exec, hub: string, specFile: string): Promise<HubStart> {
  const result = await exec(hub, ["lane", "start", "--spec", specFile, "--json"]);
  const reply = replyOf(result);
  const key = reply?.["key"];
  const status = reply?.["status"];
  if (result.code === 0 && reply?.["ok"] === true && typeof key === "string" && typeof status === "string")
    return { key, status };
  throw new Refusal(`hub lane start failed: ${reason(reply, result)}`);
}
