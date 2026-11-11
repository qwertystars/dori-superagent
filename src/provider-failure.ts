/**
 * A provider failure visible on a pane. `kind` names the failure, `match` the phrase the recovery kickoff says
 * interrupted the lane, and `lines` the pane lines the match covers, verbatim, so a report can quote the exact error.
 * Only the last 30 lines count, and a phrase sitting inside a `/regex/`, backticks, quotes or after a `file.ts:` name is
 * a lane quoting code, not the provider's own error.
 *
 * A `spanning` rule is omo's own rendered sentence, which the terminal soft-wraps: it may be split across a newline
 * between any two of its words, but it must start on the line being read, so the first failure on the screen still wins.
 */
export type ProviderFailure = { readonly kind: string; readonly match: string; readonly lines: readonly string[] };

type Rule = {
  readonly kind: string;
  readonly phrase: string;
  readonly re: RegExp;
  readonly context?: RegExp;
  readonly spanning?: boolean;
};

const RATE_CONTEXT = /\b(?:rate|limit(?:ed)?|too many requests)\b/i;
/**
 * The sentence senpi's `anthropic-subscription/guidance.js` prints when every account is blocked: line 34 is the rate
 * limit wording, line 23 the authentication one, both under an `Error: ` prefix the TUI adds. The parenthetical is
 * optional because a narrow pane may wrap or cut it; every gap is whitespace because the wrap point can be any gap,
 * including either side of the hyphen in the provider name.
 */
const ACCOUNTS_BLOCKED = /all\s+claude\s+accounts\s+for\s+anthropic\s*-\s*subscription\s+are\s+currently\s+blocked/i;
const FILE_BEFORE = /\S+\.(?:ts|tsx|js|jsx|mjs|py|md|json|sh|toml|yaml|yml)[:,]?\s*$/;
const SPANS: readonly (readonly [string, string])[] = [
  ["/", "/"],
  ["\u0060", "\u0060"],
  ['"', '"'],
  ["'", "'"],
];
/** Lines a spanning phrase may wrap across: the line it starts on and the next few. */
const SPAN_LINES = 4;

const RULES: readonly Rule[] = [
  // First: the headline is omo's own verdict, and its parenthetical mentions a rate limit, so it outranks that wording.
  { kind: "accounts-blocked", phrase: "all Claude accounts blocked", re: ACCOUNTS_BLOCKED, spanning: true },
  { kind: "usage limit", phrase: "usage limit", re: /usage\s+limit/i },
  { kind: "rate limit", phrase: "rate limit", re: /rate[ -]?limit(?:ed)?/i },
  { kind: "rate limit", phrase: "HTTP 429 rate limit", re: /\b429\b/i, context: RATE_CONTEXT },
  { kind: "overloaded", phrase: "overloaded provider", re: /overloaded_error/i },
  // "overloaded" is ordinary English. Alone on a line it is the error line itself ("Overloaded", "Error: Overloaded").
  { kind: "overloaded", phrase: "overloaded provider", re: /^\s*(?:error\s*:\s*)?overloaded[.!]?\s*$/i },
  // In prose it needs a provider-error marker beside it: 529, "API Error", "Error", or the provider named.
  {
    kind: "overloaded",
    phrase: "overloaded provider",
    re: /\boverloaded\b[^\n]{0,40}\b(?:529|api\s+error|error)\b|\b(?:529|api\s+error|error)\b[^\n]{0,40}\boverloaded\b/i,
  },
  {
    kind: "overloaded",
    phrase: "overloaded provider",
    re: /\b(?:provider|api|anthropic)\b[^\n]{0,40}\boverloaded\b|\boverloaded\b[^\n]{0,40}\b(?:provider|api)\b/i,
  },
  { kind: "provider error", phrase: "provider error", re: /provider\s+error/i },
  { kind: "quota exceeded", phrase: "quota exceeded", re: /quota\s+exceeded/i },
  { kind: "insufficient credits", phrase: "insufficient credits", re: /insufficient\s+credits/i },
];

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

/** The span of a rule's regex hit inside the text searched, in characters. */
type Hit = { readonly from: number; readonly to: number };

/**
 * The span that proves the failure: null when every mention is quoted or follows a file name, and null for a spanning
 * phrase that begins on a later line than `at` (that line reports it).
 */
function unquotedHit(bare: readonly string[], at: number, rule: Rule): Hit | null {
  const first = bare[at] ?? "";
  const text = rule.spanning === true ? bare.slice(at, at + SPAN_LINES).join(" ") : first;
  const hit = rule.re.exec(text);
  if (!hit || hit.index >= first.length) return null;
  if (rule.context !== undefined && !rule.context.test(text)) return null;
  if (FILE_BEFORE.test(first.slice(0, hit.index))) return null;
  return { from: hit.index, to: hit.index + hit[0].length };
}

/** The original screen lines the hit covers: its first line, plus any a spanning phrase wraps onto. */
function hitLines(raw: readonly string[], bare: readonly string[], at: number, rule: Rule, hit: Hit): string[] {
  if (rule.spanning !== true) return [raw[at] ?? ""];
  const out: string[] = [];
  let start = 0;
  for (const [i, line] of bare.slice(at, at + SPAN_LINES).entries()) {
    const end = start + line.length;
    if (start < hit.to && end > hit.from) out.push(raw[at + i] ?? "");
    start = end + 1;
  }
  return out.length > 0 ? out : [raw[at] ?? ""];
}

/** The first provider failure in the last 30 lines of a pane's screen, or null. */
export function detectProviderFailure(screenText: string): ProviderFailure | null {
  const raw = screenText.split("\n").slice(-30);
  const bare = raw.map(withoutQuoted);
  for (let at = 0; at < bare.length; at++) {
    for (const rule of RULES) {
      const hit = unquotedHit(bare, at, rule);
      if (hit !== null) return { kind: rule.kind, match: rule.phrase, lines: hitLines(raw, bare, at, rule, hit) };
    }
  }
  return null;
}
