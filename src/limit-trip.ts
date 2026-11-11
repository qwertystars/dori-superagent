import type { Deps } from "./harness.ts";
import { type Due, type GateConfig, type LimitWindow, resetDue, trippedWindow } from "./limit-windows.ts";
import { refText } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import { laneTranscript } from "./session-transcript.ts";
import { isOpus, sessionModel } from "./session-model.ts";
import type { GateEntry, Lane } from "./store-types.ts";

type Managed = { readonly target: string; readonly ref: SessionRef; readonly cwd: string; readonly transcript: string };

const laneContext = (d: Deps, lane: Lane): Managed => ({
  target: lane.key,
  ref: lane.sessionRef,
  cwd: lane.cwd,
  transcript: laneTranscript(lane, d.sessionRoots),
});

const pendingLane = (lane: Lane): boolean =>
  lane.status === "working" || lane.status === "waiting" || lane.migration === true;

function newEntry(d: Deps, session: Managed, model: string, window: LimitWindow, due: Due): GateEntry {
  const now = d.now();
  return {
    target: session.target,
    ref: refText(session.ref),
    phase: "paused-for-limit",
    closedAt: now,
    at: now,
    resumeAt: due.resumeAt,
    windowId: window.id,
    usedPercent: window.usedPercent,
    model,
    probe: due.probe ? 1 : 0,
    next: "compact",
    cwd: session.cwd,
    transcript: session.transcript,
    log: [
      { at: now, kind: "pause", text: `${window.id} ${window.usedPercent}% on ${model} in ${refText(session.ref)}` },
    ],
  };
}

/**
 * Every Opus session dori manages, gated on the account window: the lead, plus each lane still being worked whose own
 * session file names an Opus model. The windows are per Claude account, so one trip gates all of them at the same
 * reset; a lane whose newest row names another provider (a DeepSeek DAG lane) is never gated, and a session whose model
 * cannot be read is unknown, which pauses nothing (the pane-text recovery then handles its own limit).
 */
export async function findTrips(d: Deps, gaps: GateConfig, gated: ReadonlySet<string>): Promise<GateEntry[]> {
  const hit = trippedWindow(d.limits(), gaps.percent, d.now());
  if (hit === undefined) return [];
  const due = resetDue(hit.window, d.now(), gaps.slackMs, 1);
  const found: GateEntry[] = [];
  const lead = d.store.roles().lead;
  if (lead !== undefined && !gated.has(refText(lead))) {
    const probe = await d.runtimes
      .for(lead)
      .probe(lead)
      .catch(() => undefined);
    const cwd = probe?.cwd;
    const session: Managed =
      cwd === undefined || cwd === ""
        ? { target: "lead", ref: lead, cwd: "(unknown cwd)", transcript: "(no transcript found)" }
        : { target: "lead", ref: lead, cwd, transcript: laneTranscript({ cwd }, d.sessionRoots) };
    const model = sessionModel(session.transcript);
    if (isOpus(model)) found.push(newEntry(d, session, model, hit.window, due));
  }
  for (const lane of d.store.lanes()) {
    if (!pendingLane(lane) || gated.has(refText(lane.sessionRef))) continue;
    const session = laneContext(d, lane);
    const model = sessionModel(session.transcript);
    if (!isOpus(model)) continue;
    found.push(newEntry(d, session, model, hit.window, due));
  }
  return found;
}
