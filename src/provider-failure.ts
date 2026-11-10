/**
 * A provider failure visible on a pane. `kind` names the failure, `match` the phrase the recovery kickoff says
 * interrupted the lane. Only the last 30 lines count, and a phrase sitting inside a `/regex/`, backticks, quotes or after
 * a `file.ts:` name is a lane quoting code, not the provider's own error.
 */
export type ProviderFailure = { readonly kind: string; readonly match: string };

type Rule = { readonly kind: string; readonly phrase: string; readonly re: RegExp; readonly context?: RegExp };

const RATE_CONTEXT = /\b(?:rate|limit(?:ed)?|too many requests)\b/i;
const ACCOUNTS = /all\s+(?:claude\s+|anthropic\s+)?accounts[^.!?\n]{0,80}blocked/i;
const FILE_BEFORE = /\S+\.(?:ts|tsx|js|jsx|mjs|py|md|json|sh|toml|yaml|yml)[:,]?\s*$/;
const SPANS: readonly (readonly [string, string])[] = [
  ["/", "/"],
  ["\u0060", "\u0060"],
  ['"', '"'],
  ["'", "'"],
];

const RULES: readonly Rule[] = [
  { kind: "usage limit", phrase: "usage limit", re: /usage\s+limit/i },
  { kind: "rate limit", phrase: "rate limit", re: /rate[ -]?limit(?:ed)?/i },
  { kind: "rate limit", phrase: "HTTP 429 rate limit", re: /\b429\b/i, context: RATE_CONTEXT },
  { kind: "accounts blocked", phrase: "all accounts blocked", re: ACCOUNTS },
  { kind: "overloaded", phrase: "overloaded provider", re: /\boverloaded\b/i },
  { kind: "provider error", phrase: "provider error", re: /provider\s+error/i },
  { kind: "quota exceeded", phrase: "quota exceeded", re: /quota\s+exceeded/i },
  { kind: "insufficient credits", phrase: "insufficient credits", re: /insufficient\s+credits/i },
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The line with quoted spans blanked out: text inside them is the lane's own material, never provider output. */
function withoutQuoted(line: string): string {
  let rest = line;
  for (const [open, close] of SPANS) {
    let from = 0;
    while (from < rest.length) {
      const start = rest.indexOf(open, from);
      if (start < 0) break;
      const end = rest.indexOf(close, start + 1);
      if (end < 0) break;
      rest = `${rest.slice(0, start)} ${rest.slice(end + 1)}`;
      from = start + 1;
    }
  }
  return rest;
}

/** The bare phrase that proves the failure: null when every mention on the line is quoted or follows a file name. */
function unquotedHit(line: string, rule: Rule): string | null {
  const bare = withoutQuoted(line);
  const hit = rule.re.exec(bare);
  if (!hit) return null;
  if (rule.context !== undefined && !rule.context.test(bare)) return null;
  const at = bare.search(new RegExp(escapeRe(hit[0]), "i"));
  return at >= 0 && FILE_BEFORE.test(bare.slice(0, at)) ? null : rule.phrase;
}

/** The first provider failure in the last 30 lines of a pane's screen, or null. */
export function detectProviderFailure(screenText: string): ProviderFailure | null {
  for (const line of screenText.split("\n").slice(-30)) {
    for (const rule of RULES) {
      const match = unquotedHit(line, rule);
      if (match !== null) return { kind: rule.kind, match };
    }
  }
  return null;
}
