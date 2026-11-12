import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { promptsDir, type Deps } from "./harness.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession, type SessionRef } from "./runtime/types.ts";
import { RuntimeChoiceError } from "./runtime/select.ts";
import { laneReceipts, receiptTag } from "./model-receipt.ts";
import { UNPINNED_MODEL } from "./store-types.ts";

function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(join(promptsDir(), name), "utf8").replaceAll("{{dori}}", d.doriCmd);
  const out = join(dir, name);
  writeFileSync(out, src);
  return out;
}

/**
 * Opens lead, duty, the duty loop and the hourly loop on the selected runtime and registers all four roles. herdr: the
 * lead is a new workspace's root pane, duty a tab in it, the loops splits below duty. hc: four terminals labelled with
 * this home's group.
 */
export async function up(d: Deps, cwd: string): Promise<void> {
  const rt = d.runtimes.default;
  const env = { DORI_HOME: d.store.root };
  const agent = (name: string) => `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, name))}`;
  // herdr ignores the group of a workspace-root session and reports the new workspace as the lead ref's group.
  const lead = await openSession(
    rt,
    { name: "dori", role: "lead", container: "workspace-root", cwd, env: {}, group: groupId(d.store.root) },
    agent("lead.md"),
  );
  d.store.setRole("lead", lead);
  const group = lead.group;
  const inGroup = group === undefined ? {} : { group };
  const duty = await openSession(
    rt,
    { name: "duty", role: "duty", container: "tab", cwd, env, ...inGroup },
    agent("duty.md"),
  );
  d.store.setRole("duty", duty);
  const loop = await openSession(
    rt,
    { name: "duty-loop", role: "duty-loop", container: "split-below", near: duty, cwd, env, ...inGroup },
    `${d.doriCmd} duty --interval 60`,
  );
  d.store.setRole("duty-loop", loop);
  const hourlyEnv = rt.kind === "herdr" && group !== undefined ? { ...env, HERDR_WORKSPACE_ID: group } : env;
  const hourly = await openSession(
    rt,
    { name: "hourly-loop", role: "hourly-loop", container: "split-below", near: loop, cwd, env: hourlyEnv, ...inGroup },
    `${d.doriCmd} loop`,
  );
  d.store.setRole("hourly-loop", hourly);
  console.log(
    `UP runtime=${rt.kind} lead=${refText(lead)} duty=${refText(duty)} loop=${refText(loop)} hourly=${refText(hourly)} home=${d.store.root}`,
  );
}

/** The runtime line first (a runtime that cannot be chosen is shown, not thrown; a bad setting still throws). */
function runtimeLine(d: Deps): string {
  try {
    const c = d.choice();
    return `RUNTIME ${c.kind} (from ${c.source})`;
  } catch (e) {
    if (e instanceof RuntimeChoiceError) return `RUNTIME unset: ${e.message}`;
    throw e;
  }
}

export function status(d: Deps): void {
  console.log(runtimeLine(d));
  const roles = d.store.roles();
  const show = (ref: SessionRef | undefined) => (ref ? refText(ref) : "-");
  const pauses = new Map(d.store.gate().map((e) => [e.ref, e]));
  const gate = (ref: SessionRef): string => {
    const entry = pauses.get(refText(ref));
    return entry ? ` gate=${entry.phase} until ${new Date(entry.resumeAt).toISOString()}` : "";
  };
  console.log(
    `lead=${show(roles.lead)} duty=${show(roles.duty)} home=${d.store.root}${roles.lead ? gate(roles.lead) : ""}`,
  );
  const lanes = d.store.lanes();
  // One receipt per live lane, read once: the tag is the proof that the model the lane runs is the model it was pinned to.
  const tags = new Map(laneReceipts(d, lanes).map((r) => [r.key, receiptTag(r)]));
  for (const l of lanes) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    const tag = tags.get(l.key);
    console.log(
      `${l.key.padEnd(24)} ${l.status.padEnd(8)} ${l.sessionRef.runtime.padEnd(5)} ${refText(l.sessionRef).padEnd(14)} model=${l.model ?? UNPINNED_MODEL} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}${gate(l.sessionRef)}${tag ? ` ${tag}` : ""}`,
    );
  }
}
