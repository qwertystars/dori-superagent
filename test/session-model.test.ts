import { describe, expect, test } from "bun:test";
import { modelFromRows, isOpus } from "../src/session-model.ts";

const assistant = (model: string, at = 1): string =>
  JSON.stringify({ type: "message", id: `m${at}`, message: { role: "assistant", model, content: [], usage: {} } });
const change = (model: string, at = 1): string =>
  JSON.stringify({ type: "model_change", id: `c${at}`, provider: "anthropic", modelId: model, source: "picker" });

describe("the model a session file names", () => {
  test("the newest assistant row wins, and a model_change entry after it wins over it", () => {
    const rows = [assistant("claude-opus-4-7", 1), change("claude-sonnet-4-5", 2), assistant("deepseek-chat", 3)];
    expect(modelFromRows(rows.join("\n"))).toBe("deepseek-chat");
    expect(modelFromRows([...rows, change("claude-opus-4-7", 4)].join("\n"))).toBe("claude-opus-4-7");
  });

  test("non-assistant rows, custom entries and a torn first line contribute nothing", () => {
    const user = JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });
    const custom = JSON.stringify({ type: "custom", customType: "pi.virtual-model-state", data: { modelId: "x" } });
    const torn = '{"type":"message","message":{"role":"assistant","model":"claude-opus-4-7"';
    expect(modelFromRows(`${torn}\n${user}\n${custom}\n`)).toBeUndefined();
    expect(modelFromRows(`${user}\n${custom}\n${assistant("claude-opus-4-7")}`)).toBe("claude-opus-4-7");
  });
});

describe("which models gate", () => {
  test("any Opus id shape gates; DeepSeek, Sonnet, Haiku and an unknown model do not", () => {
    for (const id of ["claude-opus-4-7", "anthropic/claude-opus-4-20250514", "us.anthropic.claude-opus-4-5-v1:0"]) {
      expect(isOpus(id)).toBe(true);
    }
    for (const id of [
      "deepseek-chat",
      "deepseek/deepseek-chat",
      "claude-sonnet-4-5",
      "claude-haiku-3-5",
      "claude-7d-fable",
      undefined,
    ]) {
      expect(isOpus(id)).toBe(false);
    }
  });
});
