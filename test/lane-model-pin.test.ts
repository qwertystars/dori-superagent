import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../src/cli.ts";
import { status } from "../src/cli-up.ts";
import { composeLaneCommand, resolveLaneModel } from "../src/lane-model.ts";
import { startLane } from "../src/lanes.ts";
import { Refusal } from "../src/refusal.ts";
import { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const PIN = "anthropic-subscription/claude-sonnet-5-5";
const OTHER = "opendesign-go/deepseek-v4.1-flash-eco";
const ROOT = resolve(import.meta.dir, "..");

const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
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
const NO_PIN_ENV = { DORI_LANE_MODEL: undefined };

describe("resolveLaneModel", () => {
  test("the flag beats the environment, which beats the agent command's --model; nothing pins as unpinned", () => {
    expect(resolveLaneModel(PIN, { DORI_LANE_MODEL: OTHER }, `omo --model ${OTHER}`)).toBe(PIN);
    expect(resolveLaneModel(undefined, { DORI_LANE_MODEL: PIN }, "omo --model foo/bar")).toBe(PIN);
    expect(resolveLaneModel(undefined, {}, `omo --model ${PIN}`)).toBe(PIN);
    expect(resolveLaneModel(undefined, {}, "omo")).toBe("unpinned");
    expect(resolveLaneModel(undefined, { DORI_LANE_MODEL: "  " }, "omo")).toBe("unpinned");
    expect(resolveLaneModel("unpinned", { DORI_LANE_MODEL: PIN }, "omo")).toBe("unpinned");
  });

  test("a value that is not provider/model is refused, naming where it came from", () => {
    for (const bad of ["nope", "OMO/x", "a/", "a/b/c", "a b/c"])
      expect(() => resolveLaneModel(bad, {}, "omo")).toThrow(/--model .*must name provider\/model/);
    expect(() => resolveLaneModel(undefined, { DORI_LANE_MODEL: "nope" }, "omo")).toThrow(
      /DORI_LANE_MODEL .*must name provider\/model/,
    );
    expect(() => resolveLaneModel(undefined, {}, "omo --model nope")).toThrow(/DORI_AGENT_CMD .*provider\/model/);
  });
});

describe("composeLaneCommand", () => {
  const args = "'kickoff'";
  test("omo and omo-deepseek get the env prefix and the --model flag", () => {
    expect(composeLaneCommand("omo", PIN, args)).toBe(
      `DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} omo --model ${PIN} ${args}`,
    );
    expect(composeLaneCommand("/usr/local/bin/omo-deepseek", PIN, args)).toBe(
      `DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} /usr/local/bin/omo-deepseek --model ${PIN} ${args}`,
    );
    expect(composeLaneCommand("senpi", PIN, args)).toBe(
      `DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} senpi --model ${PIN} ${args}`,
    );
  });

  test("omo-boat reads OMO_BOAT_MODEL and is never handed --model", () => {
    const boat = composeLaneCommand("omo-boat", PIN, args);
    expect(boat).toBe(`DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} omo-boat ${args}`);
    expect(boat).not.toContain("--model");
    expect(composeLaneCommand("some-agent", PIN, args)).toBe(
      `DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} some-agent ${args}`,
    );
  });

  test("an unpinned lane launches exactly what it did before", () => {
    expect(composeLaneCommand("omo", "unpinned", args)).toBe(`omo ${args}`);
  });
});

describe("dori start --model", () => {
  test("a valid flag pins the record, the lane JSON and the command typed into the pane", async () => {
    const { w, d, brief } = setup();
    const { out } = await captureIo(() =>
      main(["start", "pinned", "--brief", brief, "--workspace", "w1", "--model", PIN], d),
    );
    expect(out).toStartWith("STARTED pinned pane=");
    const lane = d.store.lane("pinned")!;
    const pane = w.panes.get(lane.paneId)!;
    expect(lane.model).toBe(PIN);
    expect(pane.ran[0]).toStartWith(
      `DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} omo --model ${PIN} 'Read your brief at `,
    );
    expect(JSON.parse(readFileSync(join(d.store.root, "lanes", "pinned.json"), "utf8")).model).toBe(PIN);
  });

  test("an invalid flag is refused before anything is written or opened", async () => {
    const { w, d, brief } = setup();
    await expect(
      main(["start", "bad-pin", "--brief", brief, "--workspace", "w1", "--model", "nope"], d),
    ).rejects.toThrow(Refusal);
    await expect(startLane(d, "bad-pin", brief, { model: "a/b/c" })).rejects.toThrow("must name provider/model");
    expect(d.store.lane("bad-pin")).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  test("the CLI exits non-zero and prints the refusal for an invalid flag", () => {
    const home = mkdtempSync(join(tmpdir(), "dori-pin-"));
    const run = Bun.spawnSync(
      [process.execPath, join(ROOT, "src", "cli.ts"), "start", "bad-pin", "--brief", "b.md", "--model", "nope"],
      {
        cwd: ROOT,
        env: { ...process.env, DORI_HOME: home, DORI_TELEMETRY: "0" },
      },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("must name provider/model");
  });

  test("without a flag the pin comes from DORI_LANE_MODEL when it is set", async () => {
    const { w, d, brief } = setup();
    await withEnv({ DORI_LANE_MODEL: PIN }, async () => {
      const lane = await startLane(d, "from-env", brief, { group: "w1" });
      expect(lane.model).toBe(PIN);
      expect(w.panes.get(lane.paneId)!.ran[0]).toStartWith(
        `DORI_LANE_MODEL=${PIN} OMO_BOAT_MODEL=${PIN} omo --model ${PIN} '`,
      );
    });
  });

  test("without a flag or env the pin comes from the agent command's own --model token", async () => {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "idle");
    d.store.setRole("lead", { runtime: "herdr", id: "w1:p1" });
    const brief = join(d.store.root, "brief.md");
    await Bun.write(brief, "brief");
    const agentCmd = `omo --model ${PIN}`;
    await withEnv(NO_PIN_ENV, async () => {
      const lane = await startLane({ ...d, agentCmd }, "from-cmd", brief, { group: "w1" });
      expect(lane.model).toBe(PIN);
      expect(w.panes.get(lane.paneId)!.ran[0]).toContain(`omo --model ${PIN}`);
    });
    expect(lead.received[0]).toStartWith("[START from-cmd]");
  });

  test("with neither a flag, env nor a command token the lane is unpinned and omo gets no --model", async () => {
    const { w, d, brief } = setup();
    await withEnv(NO_PIN_ENV, async () => {
      const lane = await startLane(d, "no-pin", brief, { group: "w1" });
      expect(lane.model).toBe("unpinned");
      const ran = w.panes.get(lane.paneId)!.ran[0]!;
      expect(ran).toStartWith("omo 'Read your brief at ");
      expect(ran).not.toContain("--model");
    });
  });
});

describe("dori status", () => {
  test("every lane line shows its pin, and a record written before pins reads as unpinned", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "pinned", brief, { group: "w1", model: PIN });
    await startLane(d, "open", brief, { group: "w1" });
    const { model: _dropped, ...beforePins } = d.store.lane("open")!;
    d.store.saveLane(beforePins);
    w.clock += 60_000;
    const { out } = await captureIo(async () => {
      status(d);
      return 0;
    });
    const line = (key: string) => out.split("\n").find((l) => l.startsWith(key))!;
    expect(line("pinned")).toContain(`model=${PIN}`);
    expect(line("open")).toContain("model=unpinned");
    expect(line("pinned")).toMatch(/^pinned\s+working\s+herdr\s+w1:p\d+\s+model=/);
  });
});
