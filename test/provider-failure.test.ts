import { describe, expect, test } from "bun:test";
import { detectProviderFailure } from "../src/provider-failure.ts";

const wrap = (line: string): string => `Todo\n❯ ${line}\n──────\n❯\n──────\n`;

/** The exact line senpi's anthropic-subscription guidance prints, as omo renders it (`Error: ` is the TUI's error prefix). */
const BLOCKED_RATE =
  "Error: All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).";
const BLOCKED_AUTH =
  "Error: All Claude accounts for anthropic-subscription are currently blocked (authentication error).";
/** The same headline greedy-wrapped by an 80-column terminal: the second line starts at the parenthetical. */
const BLOCKED_WRAPPED_80 = [
  "Error: All Claude accounts for anthropic-subscription are currently blocked",
  "(rate limit or auth errors).",
];
/** A 72-column pane, where the wrap does fall between `currently` and `blocked`. */
const BLOCKED_WRAPPED_72 = [
  "Error: All Claude accounts for anthropic-subscription are currently",
  "blocked (rate limit or auth errors).",
];

describe("provider failure detection", () => {
  test.each([
    ["API Error: usage limit reached for this account", "usage limit"],
    ["Error: Usage Limit exceeded", "usage limit"],
    ["usage limit reached", "usage limit"],
    ["rate limit exceeded, retrying in 60s", "rate limit"],
    ["429 Too Many Requests", "rate limit"],
    ["overloaded_error: upstream is busy", "overloaded"],
    ["Anthropic provider error", "provider error"],
    ["quota exceeded for this workspace", "quota exceeded"],
    ["insufficient credits remaining", "insufficient credits"],
  ])("%s is detected as %s", (line, kind) => {
    const found = detectProviderFailure(wrap(line));
    expect(found?.kind).toBe(kind);
    expect(found?.match.length).toBeGreaterThan(0);
  });

  test("omo's own blocked-accounts sentence is detected from the exact rendered line", () => {
    expect(detectProviderFailure(wrap(BLOCKED_RATE))).toEqual({
      kind: "accounts-blocked",
      match: "all Claude accounts blocked",
      lines: [`❯ ${BLOCKED_RATE}`],
    });
    expect(detectProviderFailure(wrap(BLOCKED_AUTH))?.kind).toBe("accounts-blocked");
  });

  test("the recorded lines are the pane's own text, covering the wrap when the phrase spans one", () => {
    const one = detectProviderFailure(wrap(BLOCKED_RATE))!.lines;
    expect(one).toEqual([`❯ ${BLOCKED_RATE}`]);
    const short = detectProviderFailure(wrap("API Error: usage limit reached for this account"))!.lines;
    expect(short).toEqual(["❯ API Error: usage limit reached for this account"]);
    const wrapped = detectProviderFailure(BLOCKED_WRAPPED_80.join("\n"))!.lines;
    expect(wrapped).toEqual([BLOCKED_WRAPPED_80[0]!]);
    const seventy = detectProviderFailure(BLOCKED_WRAPPED_72.join("\n"))!.lines;
    expect(seventy).toEqual(BLOCKED_WRAPPED_72);
  });

  test("a span's second line is recorded only when the phrase itself wrapped there", () => {
    const screen = [...BLOCKED_WRAPPED_72, "next line"].join("\n");
    expect(detectProviderFailure(screen)!.lines).toEqual(BLOCKED_WRAPPED_72);
    expect(detectProviderFailure([BLOCKED_RATE, "next line"].join("\n"))!.lines).toEqual([BLOCKED_RATE]);
  });

  test("the block is detected when the pane wraps it", () => {
    expect(detectProviderFailure(wrap(BLOCKED_WRAPPED_80.join("\n")))).toEqual({
      kind: "accounts-blocked",
      match: "all Claude accounts blocked",
      lines: [`❯ ${BLOCKED_WRAPPED_80[0]!}`],
    });
    expect(detectProviderFailure(BLOCKED_WRAPPED_80.join("\n"))?.kind).toBe("accounts-blocked");
    expect(detectProviderFailure(BLOCKED_WRAPPED_72.join("\n"))?.kind).toBe("accounts-blocked");
  });

  test("any wrap point survives, including either side of the provider name's hyphen", () => {
    for (const split of ["for", "anthropic-", "subscription", "blocked", "currently"]) {
      const at = BLOCKED_RATE.indexOf(split);
      expect(at).toBeGreaterThan(0);
      const screen = `${BLOCKED_RATE.slice(0, at)}\n${BLOCKED_RATE.slice(at)}`;
      expect(detectProviderFailure(screen)?.kind).toBe("accounts-blocked");
    }
  });

  test("the rate limit in the headline's parenthetical is the block, not a separate rate limit", () => {
    expect(detectProviderFailure(wrap(BLOCKED_RATE) + "429 Too Many Requests\n")?.kind).toBe("accounts-blocked");
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
    expect(
      detectProviderFailure(wrap('we now print "All Claude accounts are currently blocked" ourselves')),
    ).toBeNull();
  });

  test("a bare 429 is a number, not the error", () => {
    expect(detectProviderFailure(wrap("see ticket 4291 in the changelog"))).toBeNull();
    expect(detectProviderFailure(wrap("status: 429 rate limited"))).toMatchObject({ kind: "rate limit" });
  });

  test("`overloaded` in ordinary prose is not a provider error", () => {
    expect(detectProviderFailure(wrap("the queue is overloaded"))).toBeNull();
    expect(detectProviderFailure(wrap("an overloaded test helper makes this slow"))).toBeNull();
    expect(detectProviderFailure(wrap("overloaded names hurt readability"))).toBeNull();
  });

  test("`overloaded` as a provider error line is one", () => {
    expect(detectProviderFailure(wrap("API Error: 529 overloaded"))?.kind).toBe("overloaded");
    expect(detectProviderFailure(wrap("Error: overloaded"))?.kind).toBe("overloaded");
    expect(detectProviderFailure("Overloaded\n")?.kind).toBe("overloaded");
    expect(detectProviderFailure(wrap("the provider is overloaded, retrying"))?.kind).toBe("overloaded");
  });

  test("the first failure on the screen wins, and its record is stably the same text", () => {
    const screen = wrap("overloaded_error: upstream\nquota exceeded");
    expect(detectProviderFailure(screen)).toEqual({
      kind: "overloaded",
      match: "overloaded provider",
      lines: ["❯ overloaded_error: upstream"],
    });
    expect(detectProviderFailure(screen)).toEqual(detectProviderFailure(screen));
  });
});
