import { basename } from "node:path";
import { Refusal } from "./refusal.ts";
import { UNPINNED_MODEL } from "./store-types.ts";

/** A pin names the provider and the model in it: `anthropic-subscription/claude-sonnet-5-5`. */
export const MODEL_RE = /^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

/** The agents that take the model as a flag. `omo-boat` reads the environment instead and must not see `--model`. */
const MODEL_FLAG_AGENTS: ReadonlySet<string> = new Set(["omo", "senpi", "omo-deepseek"]);

/** The `--model` value inside an agent command (`DORI_AGENT_CMD="omo --model a/b"`), when it names one. */
const commandModel = (agentCmd: string): string | undefined => {
  const tokens = agentCmd.trim().split(/\s+/);
  const at = tokens.indexOf("--model");
  const value = at < 0 ? undefined : tokens[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
};

/** The pin a command names, or a refusal naming where the bad value came from: a bad pin would launch the wrong model. */
const checkedModel = (value: string, source: string): string => {
  if (value === UNPINNED_MODEL || MODEL_RE.test(value)) return value;
  throw new Refusal(`${source} ${JSON.stringify(value)} must name provider/model, matching ${MODEL_RE}`);
};

/**
 * The lane's pin: `--model` when the caller gave one, else `DORI_LANE_MODEL`, else the `--model` token in the agent
 * command, else "unpinned". The order is fixed so a caller's explicit choice always beats the environment.
 */
export function resolveLaneModel(flag: string | undefined, env: NodeJS.ProcessEnv, agentCmd: string): string {
  if (flag !== undefined) return checkedModel(flag, "--model");
  const fromEnv = env["DORI_LANE_MODEL"]?.trim();
  if (fromEnv) return checkedModel(fromEnv, "DORI_LANE_MODEL");
  const fromCmd = commandModel(agentCmd);
  if (fromCmd !== undefined) return checkedModel(fromCmd, "the --model in DORI_AGENT_CMD");
  return UNPINNED_MODEL;
}

/**
 * The command typed into the lane's pane: a pinned lane gets the model in the environment (so `omo-boat`, which reads
 * `OMO_BOAT_MODEL`, is pinned too) and the agents that take a flag get `--model` as well. `args` is already quoted.
 */
export function composeLaneCommand(agentCmd: string, model: string, args: string): string {
  if (model === UNPINNED_MODEL) return `${agentCmd} ${args}`;
  const env = `DORI_LANE_MODEL=${model} OMO_BOAT_MODEL=${model}`;
  const prog = basename(agentCmd.trim().split(/\s+/)[0] ?? "");
  const flag = MODEL_FLAG_AGENTS.has(prog) ? ` --model ${model}` : "";
  return `${env} ${agentCmd}${flag} ${args}`;
}
