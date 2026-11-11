import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * The newest model a session recorded. omo writes it twice: on every assistant row (`message.model`, the physical model
 * that answered, so a virtual-model picker still names the real one) and on a `model_change` entry when the picker moves
 * (`session-format.md:102`, `:266`, `:272`). Both are read here, newest first, because a session file can be megabytes
 * and the answer is always near its end.
 */
const CHUNK = 256 * 1024;
/** The scan stops here: past it, the row is older than any switch dori could still be waiting on. */
const MAX_SCAN = 4 * 1024 * 1024;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The newest `message.model` / `model_change.modelId` in one chunk of JSONL, scanning from its end. */
export function modelFromRows(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("model")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A tail read starts mid-line: the truncated first row is not an answer.
      continue;
    }
    const message = rec(row["message"]);
    const fromRow = row["type"] === "message" && message?.["role"] === "assistant" ? text(message["model"]) : undefined;
    const fromChange = row["type"] === "model_change" ? text(row["modelId"]) : undefined;
    if ((fromRow ?? fromChange) !== undefined) return fromRow ?? fromChange;
  }
  return undefined;
}

/** The last `width` bytes of `path`, or undefined when the file cannot be read (missing, a directory, permissions). */
function tail(path: string, width: number): { readonly bytes: string; readonly whole: boolean } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - width);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return { bytes: buffer.subarray(0, read).toString("utf8"), whole: start === 0 };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * The session's current model, or undefined when no transcript resolves or no row names one. Reads progressively larger
 * tails, so a session whose newest assistant row sits behind one huge tool result is still read correctly.
 */
export function sessionModel(path: string): string | undefined {
  let width = CHUNK;
  for (;;) {
    const seen = tail(path, width);
    if (seen === undefined) return undefined;
    const model = modelFromRows(seen.bytes);
    if (model !== undefined) return model;
    if (seen.whole || width >= MAX_SCAN) return undefined;
    width = Math.min(width * 2, MAX_SCAN);
  }
}

/**
 * True for a session on an Anthropic Opus model, in any id shape (`claude-opus-4-7`, `anthropic/claude-opus-4-20250514`,
 * a Bedrock `us.anthropic.claude-opus-...`). Anything else - DeepSeek, Sonnet, an unknown model - is not gated.
 */
export const isOpus = (model: string | undefined): model is string =>
  model !== undefined && /opus/i.test(model) && !/sonnet|haiku|fable/i.test(model);
