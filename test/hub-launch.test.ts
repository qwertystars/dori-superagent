import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startLane } from "../src/lanes.ts";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { href, type World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

const HUB = join(import.meta.dir, "fixtures", "hub-launch", "fake-hub.sh");
const PIN = "anthropic-subscription/claude-sonnet-5-5";

const hubExec =
  (w: World): Exec =>
  async (cmd, argv) => {
    if (cmd !== HUB) return w.exec(cmd, argv);
    const proc = Bun.spawn(["bash", HUB, ...argv], {
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };

const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};

describe("hub launch", () => {
  test("an ok start writes the spec, records hub: true and types nothing into a pane", async () => {
    const { w, d, lead, brief } = setup();
    const log = join(d.store.root, "hub-calls.log");
    const deps: Deps = { ...d, exec: hubExec(w) };
    const lane = await withEnv({ DORI_HUB_BIN: HUB, FAKE_HUB_LOG: log }, async () => {
      const started = await startLane(deps, "ok-one", brief, { model: PIN });
      expect(started.hub).toBe(true);
      expect(started.hubStatus).toBe("starting");
      expect(started.model).toBe(PIN);
    });
    expect(lane).toBeUndefined();

    const saved = deps.store.lane("ok-one")!;
    expect(saved.hub).toBe(true);
    expect(saved.hubStatus).toBe("starting");
    expect(saved.paneId).toBe("ok-one");

    const specFile = join(d.store.root, "hub-specs", "ok-one.json");
    expect(JSON.parse(readFileSync(specFile, "utf8"))).toEqual({
      key: "ok-one",
      briefPath: saved.brief,
      role: "lane",
      model: { pin: PIN },
      engine: { argv: ["omo"], extensions: [], env: {} },
      workspace: { kind: "local", cwd: process.cwd() },
      budget: {},
      permissionProfile: "inbox",
    });

    expect(
      w.calls.filter((c) => c.cmd === "herdr" && ["run", "create", "send-text"].includes(String(c.argv[1]))),
    ).toEqual([]);
    expect(w.panes.size).toBe(1);
    expect(w.panes.get("w1:p1")!.ran).toEqual([]);
    expect(w.panes.get("w1:p1")!.received).toEqual(["[START ok-one] lane started through the hub (status starting)"]);
    expect(lead.received).toEqual(["[START ok-one] lane started through the hub (status starting)"]);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`lane start --spec ${specFile} --json`);
  });

  test("a hub error refuses the start with the hub's reason and never falls back to a pane", async () => {
    const { w, d, lead, brief } = setup();
    const log = join(d.store.root, "hub-calls.log");
    const deps: Deps = { ...d, exec: hubExec(w) };
    await withEnv({ DORI_HUB_BIN: HUB, FAKE_HUB_LOG: log }, async () => {
      await expect(startLane(deps, "bad-one", brief, { model: PIN })).rejects.toThrow(
        "hub lane start failed: hub refused lane bad-one: quota exhausted",
      );
    });
    expect(deps.store.lane("bad-one")).toBeUndefined();
    expect(w.calls.filter((c) => c.cmd === "herdr")).toEqual([]);
    expect(w.panes.size).toBe(1);
    expect(lead.received).toEqual([]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("an unpinned lane is refused before a spec, a call or a brief exists", async () => {
    const { w, d, brief } = setup();
    const log = join(d.store.root, "hub-calls.log");
    const deps: Deps = { ...d, exec: hubExec(w) };
    await withEnv({ DORI_HUB_BIN: HUB, FAKE_HUB_LOG: log }, async () => {
      await expect(startLane(deps, "ok-two", brief)).rejects.toThrow("hub launch needs --model");
    });
    expect(existsSync(join(d.store.root, "hub-specs", "ok-two.json"))).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(deps.store.briefPath("ok-two"))).toBe(false);
    expect(w.calls.filter((c) => c.cmd === "herdr")).toEqual([]);
  });

  test("without DORI_HUB_BIN the pane path is unchanged", async () => {
    const { w, d, brief } = setup();
    const log = join(d.store.root, "hub-calls.log");
    const deps: Deps = { ...d, exec: hubExec(w) };
    await withEnv({ DORI_HUB_BIN: undefined, FAKE_HUB_LOG: log }, async () => {
      const lane = await startLane(deps, "no-hub", brief, { model: PIN, group: "w1" });
      expect(lane.hub).toBeUndefined();
      expect(lane.sessionRef).toMatchObject({ runtime: "herdr", id: lane.paneId });
      expect(w.panes.has(lane.paneId)).toBe(true);
    });
    const lane = deps.store.lane("no-hub")!;
    const ran = w.panes.get(lane.paneId)!.ran[0]!;
    expect(ran).toStartWith(`DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} omo --model ${PIN} 'Read your brief at `);
    expect(existsSync(join(d.store.root, "hub-specs", "no-hub.json"))).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(d.store.roles().lead).toEqual(href("w1:p1"));
  });
});
