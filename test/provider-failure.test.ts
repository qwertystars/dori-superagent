import { describe, expect, test } from "bun:test";
import { detectProviderFailure } from "../src/provider-failure.ts";

const wrap = (line: string): string => `Todo\n❯ ${line}\n──────\n❯\n──────\n`;

describe("provider failure detection", () => {
  test.each([
    ["API Error: usage limit reached for this account", "usage limit"],
    ["Error: Usage Limit exceeded", "usage limit"],
    ["usage limit reached", "usage limit"],
    ["rate limit exceeded, retrying in 60s", "rate limit"],
    ["429 Too Many Requests", "rate limit"],
    ["All Claude accounts are blocked", "accounts blocked"],
    ["All accounts blocked until 2026-11-10", "accounts blocked"],
    ["provider is overloaded", "overloaded"],
    ["Anthropic provider error", "provider error"],
    ["quota exceeded for this workspace", "quota exceeded"],
    ["insufficient credits remaining", "insufficient credits"],
  ])("%s is detected as %s", (line, kind) => {
    const found = detectProviderFailure(wrap(line));
    expect(found?.kind).toBe(kind);
    expect(found?.match.length).toBeGreaterThan(0);
  });

  test("only the last 30 lines count: a failure scrolled off is not the pane's error any more", () => {
    const filler = (n: number): string => Array.from({ length: n }, () => "line").join("\n");
    expect(detectProviderFailure(`usage limit reached\n${filler(30)}`)).toBeNull();
    expect(detectProviderFailure(`usage limit reached\n${filler(29)}`)).toMatchObject({ kind: "usage limit" });
  });

  test("a working screen has no failure", () => {
    expect(detectProviderFailure("")).toBeNull();
    expect(detectProviderFailure("❯ fix the lint error\n── Running eval (5s · esc to interrupt) ──\n")).toBeNull();
    expect(detectProviderFailure("Todo\nBrief\n❯\n")).toBeNull();
  });

  test("a lane quoting code does not look failed", () => {
    expect(detectProviderFailure(wrap("read launch.ts: /usage limit|rate limit|quota/"))).toBeNull();
    expect(detectProviderFailure(wrap("src/provider-failure.ts: usage limit"))).toBeNull();
    expect(detectProviderFailure(wrap("the pattern `usage limit` matches the error line"))).toBeNull();
    expect(detectProviderFailure(wrap("429 is the HTTP status for throttling"))).toBeNull();
    expect(detectProviderFailure(wrap("handling 429 in the retry path"))).toBeNull();
    expect(detectProviderFailure(wrap("tests passed, no 429 today"))).toBeNull();
  });

  test("a quoted phrase in prose is still a quoted phrase, not a provider error", () => {
    expect(detectProviderFailure(wrap('it said "usage limit" once, so we retry'))).toBeNull();
    expect(detectProviderFailure(wrap("see the 'rate limit' section of the docs"))).toBeNull();
  });

  test("a bare 429 is a number, not the error", () => {
    expect(detectProviderFailure(wrap("see ticket 4291 in the changelog"))).toBeNull();
    expect(detectProviderFailure(wrap("status: 429 rate limited"))).toMatchObject({ kind: "rate limit" });
  });

  test("the first failure on the screen wins, and its record is stably the same text", () => {
    const screen = wrap("overloaded provider\nquota exceeded");
    expect(detectProviderFailure(screen)).toEqual({ kind: "overloaded", match: "overloaded provider" });
    expect(detectProviderFailure(screen)).toEqual(detectProviderFailure(screen));
  });
});
