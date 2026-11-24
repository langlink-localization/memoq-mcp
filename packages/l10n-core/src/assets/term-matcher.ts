import type {
  GlossaryEntry,
  TermCheckIssue,
  TermHit,
  TermMatchOptions,
  TermMatchResult,
} from "./types.ts";
import { languageMatches } from "./tmx.ts";

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const COMBINING_MARK = /\p{M}/u;
const MAX_TERM_TOKENS = 8;
const FUZZY_THRESHOLD = 0.8;

type CaseMode = "yes" | "no" | "permissive";
type MatchMode = "exact" | "prefix50" | "fuzzy" | "custom";

interface TextToken {
  value: string;
  start: number;
  end: number;
  kind: "word" | "cjk";
}

function readToken(text: string, index: number): TextToken | undefined {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) return undefined;
  const char = String.fromCodePoint(codePoint);
  const end = index + char.length;
  if (CJK_CHAR.test(char)) return { value: char, start: index, end, kind: "cjk" };
  return { value: char, start: index, end, kind: "word" };
}

/** Tokenize NFC text into whole words (Latin/Cyrillic/etc.) and single CJK characters. */
function tokenizeText(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let index = 0;
  while (index < text.length) {
    const first = readToken(text, index);
    if (!first) break;
    if (first.kind === "cjk") {
      tokens.push(first);
      index = first.end;
      continue;
    }
    if (!WORD_CHAR.test(first.value)) {
      index = first.end;
      continue;
    }
    let end = first.end;
    while (end < text.length) {
      const next = readToken(text, end);
      if (!next || next.kind === "cjk") break;
      if (!WORD_CHAR.test(next.value) && !COMBINING_MARK.test(next.value)) break;
      end = next.end;
    }
    tokens.push({ value: text.slice(index, end), start: index, end, kind: "word" });
    index = end;
  }
  return tokens;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function caseModeOf(entry: GlossaryEntry): CaseMode {
  if (entry.caseSensitive === true) return "yes";
  if (entry.caseSensitive === false) return "no";
  return "permissive";
}

/** Character-wise comparison honoring the glossary case mode; both strings have equal length. */
function caseMatches(term: string, text: string, mode: CaseMode): boolean {
  if (term.length !== text.length) return false;
  if (mode === "yes") return term === text;
  if (mode === "no") return term.toLowerCase() === text.toLowerCase();
  for (let index = 0; index < term.length; index += 1) {
    const termChar = term[index]!;
    const textChar = text[index]!;
    if (termChar === textChar) continue;
    if (termChar.toLowerCase() !== textChar.toLowerCase()) return false;
    // Lower-case characters in the term may be capitalized in the text, not vice versa.
    if (termChar !== termChar.toLowerCase()) return false;
  }
  return true;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

function languageAllowed(entryLanguage: string | undefined, wanted: string | undefined): boolean {
  if (wanted === undefined) return true;
  if (entryLanguage === undefined || entryLanguage === "") return true;
  return languageMatches(entryLanguage, wanted);
}

interface CandidateMatch {
  start: number;
  end: number;
  exactCase: boolean;
  kind: TermHit["matchKind"];
}

interface ScanOptions {
  /** Maximum added suffix (code points) on the last token; Infinity for `stem*`. */
  suffixLimit: number;
  kind: TermHit["matchKind"];
}

function scanExactOrPrefix(
  tokens: readonly TextToken[],
  termTokens: readonly string[],
  caseMode: CaseMode,
  options: ScanOptions,
): CandidateMatch[] {
  const matches: CandidateMatch[] = [];
  const lastIndex = termTokens.length - 1;
  for (let start = 0; start + termTokens.length <= tokens.length; start += 1) {
    let matched = true;
    let exactCase = true;
    let extended = false;
    for (let offset = 0; offset <= lastIndex; offset += 1) {
      const termValue = termTokens[offset]!;
      const textToken = tokens[start + offset]!;
      if (offset === lastIndex && options.suffixLimit >= 0) {
        if (textToken.value.length < termValue.length) {
          matched = false;
          break;
        }
        const head = textToken.value.slice(0, termValue.length);
        if (!caseMatches(termValue, head, caseMode)) {
          matched = false;
          break;
        }
        const suffix = textToken.value.slice(termValue.length);
        if (suffix !== "" && codePointLength(suffix) > options.suffixLimit) {
          matched = false;
          break;
        }
        if (head !== termValue) exactCase = false;
        if (suffix !== "") extended = true;
      } else {
        if (!caseMatches(termValue, textToken.value, caseMode)) {
          matched = false;
          break;
        }
        if (textToken.value !== termValue) exactCase = false;
      }
    }
    if (!matched) continue;
    const first = tokens[start]!;
    const last = tokens[start + lastIndex]!;
    matches.push({
      start: first.start,
      end: last.end,
      exactCase,
      kind: extended ? options.kind : "exact",
    });
  }
  return matches;
}

function scanFuzzy(
  tokens: readonly TextToken[],
  term: string,
  caseMode: CaseMode,
): CandidateMatch[] {
  const normalizedTerm = caseMode === "yes" ? term : term.toLowerCase();
  const matches: CandidateMatch[] = [];
  for (const token of tokens) {
    if (token.kind !== "word") continue;
    const normalizedText = caseMode === "yes" ? token.value : token.value.toLowerCase();
    if (similarity(normalizedTerm, normalizedText) >= FUZZY_THRESHOLD) {
      matches.push({
        start: token.start,
        end: token.end,
        exactCase: token.value === term,
        kind: "fuzzy",
      });
    }
  }
  return matches;
}

/**
 * Match glossary terms in `text` (ALG-TB-001/002/003).
 *
 * - Modes: `exact`, `prefix50` (default: term starts the word, added suffix length is at
 *   most the term length), `custom` (only a trailing `*` stem wildcard is supported) and
 *   `fuzzy` (off by default; single-token words, 80 % similarity).
 * - Case: permissive by default (upper-case characters in the term must stay upper-case,
 *   lower-case may be capitalized); `caseSensitive: true` = exact, `false` = insensitive.
 * - Latin terms match whole words only; CJK terms match as character sequences. A term
 *   longer than 8 tokens is skipped with a warning. Forbidden entries are returned as
 *   hits (with `entry.forbidden`) but are never suggested; `evaluateTerms` reports them.
 */
export function matchTerms(
  text: string,
  entries: readonly GlossaryEntry[],
  options: TermMatchOptions = {},
): TermMatchResult {
  const source = text.normalize("NFC");
  const tokens = tokenizeText(source);
  const hits: TermHit[] = [];
  const warnings: string[] = [];
  const seenWarnings = new Set<string>();
  const emittedHits = new Set<string>();
  const warn = (message: string): void => {
    if (seenWarnings.has(message)) return;
    seenWarnings.add(message);
    warnings.push(message);
  };

  for (const entry of entries) {
    if (!languageAllowed(entry.sourceLanguage, options.sourceLanguage)) continue;
    if (!languageAllowed(entry.targetLanguage, options.targetLanguage)) continue;
    const caseMode = caseModeOf(entry);
    const mode: MatchMode = entry.matching ?? "prefix50";
    // Match both sides of the entry so the same glossary can check the target segment
    // (evaluateTerms correlates source/target hits by entry id).
    const forms = new Set<string>();
    for (const form of [entry.source, entry.target]) {
      const normalized = form.normalize("NFC").trim();
      if (normalized !== "") forms.add(normalized);
    }
    for (const form of forms) {
      let termTokens = tokenizeText(form).map((token) => token.value);
      if (termTokens.length === 0) continue;
      if (termTokens.length > MAX_TERM_TOKENS) {
        warn(`glossary: term "${form}" exceeds ${MAX_TERM_TOKENS} tokens; skipped`);
        continue;
      }
      let candidates: CandidateMatch[] = [];
      if (mode === "fuzzy" && options.fuzzy === true) {
        if (termTokens.length === 1) candidates = scanFuzzy(tokens, termTokens[0]!, caseMode);
        else warn(`glossary: fuzzy matching only supports single-token terms; "${form}" skipped`);
      } else if (mode === "custom") {
        if (form.endsWith("*") && !form.slice(0, -1).includes("*")) {
          termTokens = tokenizeText(form.slice(0, -1)).map((token) => token.value);
          if (termTokens.length === 0) continue;
          if (termTokens.length > MAX_TERM_TOKENS) {
            warn(`glossary: custom term "${form}" exceeds ${MAX_TERM_TOKENS} tokens; skipped`);
            continue;
          }
          candidates = scanExactOrPrefix(tokens, termTokens, caseMode, {
            suffixLimit: Number.POSITIVE_INFINITY,
            kind: "custom",
          });
        } else {
          warn(`glossary: unsupported custom pattern "${form}"; matched as exact`);
          candidates = scanExactOrPrefix(tokens, termTokens, caseMode, { suffixLimit: -1, kind: "exact" });
        }
      } else {
        const isPrefix = mode === "prefix50";
        const lastToken = termTokens[termTokens.length - 1]!;
        candidates = scanExactOrPrefix(tokens, termTokens, caseMode, {
          suffixLimit: isPrefix ? codePointLength(lastToken) : -1,
          kind: isPrefix ? "prefix50" : "exact",
        });
      }
      for (const candidate of candidates) {
        const key = `${entry.id}:${candidate.start}:${candidate.end}:${candidate.kind}`;
        if (emittedHits.has(key)) continue;
        emittedHits.add(key);
        hits.push({
          entry,
          start: candidate.start,
          end: candidate.end,
          matchKind: candidate.kind,
          caseMatch: candidate.exactCase ? "exact" : "case_only_diff",
        });
      }
    }
  }

  const deduped: TermHit[] = [];
  for (const hit of hits) {
    const covering = deduped.findIndex(
      (kept) => kept.entry.id === hit.entry.id && kept.start < hit.end && hit.start < kept.end,
    );
    if (covering < 0) {
      deduped.push(hit);
      continue;
    }
    const existing = deduped[covering]!;
    if (hit.end - hit.start > existing.end - existing.start) deduped[covering] = hit;
  }
  hits.length = 0;
  hits.push(...deduped);
  hits.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    if (left.end !== right.end) return right.end - left.end;
    if (left.entry.id !== right.entry.id) return left.entry.id < right.entry.id ? -1 : 1;
    return 0;
  });
  return { hits, issues: [], warnings };
}

function isShortCjkTerm(term: string): boolean {
  const chars = [...term.trim()];
  if (chars.length === 0 || chars.length > 2) return false;
  return chars.every((char) => CJK_CHAR.test(char));
}

/**
 * Turn per-segment term hits into terminology issues.
 *
 * - Forbidden term used in target: `TB_FORBIDDEN_USED` / critical.
 * - Forbidden term used in source: `TB_SOURCE_FORBIDDEN` / major.
 * - Approved (or status-less) source term with no matching target term: `TB_TERM_MISSING`
 *   / major. 1–2 character CJK terms and `rejected`/`tbd` entries are not asserted.
 */
export function evaluateTerms(
  sourceHits: readonly TermHit[],
  targetHits: readonly TermHit[],
  entries: readonly GlossaryEntry[],
): TermCheckIssue[] {
  const known = new Map<string, GlossaryEntry>();
  for (const entry of entries) known.set(entry.id, entry);
  const entryOf = (hit: TermHit): GlossaryEntry => known.get(hit.entry.id) ?? hit.entry;
  const issues: TermCheckIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: TermCheckIssue, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const hit of targetHits) {
    const entry = entryOf(hit);
    if (entry.forbidden !== true) continue;
    push(
      {
        rule: "TB_FORBIDDEN_USED",
        termId: entry.id,
        severity: "critical",
        message: `Target uses forbidden term "${entry.target}" (source "${entry.source}")`,
        start: hit.start,
        end: hit.end,
      },
      `TB_FORBIDDEN_USED:${entry.id}:${hit.start}`,
    );
  }

  for (const hit of sourceHits) {
    const entry = entryOf(hit);
    if (entry.forbidden !== true) continue;
    push(
      {
        rule: "TB_SOURCE_FORBIDDEN",
        termId: entry.id,
        severity: "major",
        message: `Source uses forbidden term "${entry.source}"`,
        start: hit.start,
        end: hit.end,
      },
      `TB_SOURCE_FORBIDDEN:${entry.id}:${hit.start}`,
    );
  }

  const targetTermIds = new Set(targetHits.map((hit) => hit.entry.id));
  for (const hit of sourceHits) {
    const entry = entryOf(hit);
    if (entry.forbidden === true) continue;
    if (entry.status === "rejected" || entry.status === "tbd") continue;
    if (hit.matchKind === "fuzzy") continue;
    if (targetTermIds.has(entry.id)) continue;
    if (isShortCjkTerm(entry.source)) continue;
    push(
      {
        rule: "TB_TERM_MISSING",
        termId: entry.id,
        severity: "major",
        message: `Approved source term "${entry.source}" has no equivalent target term (expected "${entry.target}")`,
        start: hit.start,
        end: hit.end,
      },
      `TB_TERM_MISSING:${entry.id}`,
    );
  }

  issues.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "critical" ? -1 : 1;
    const leftStart = left.start ?? -1;
    const rightStart = right.start ?? -1;
    if (leftStart !== rightStart) return leftStart - rightStart;
    if (left.termId !== right.termId) return left.termId < right.termId ? -1 : 1;
    return left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0;
  });
  return issues;
}
