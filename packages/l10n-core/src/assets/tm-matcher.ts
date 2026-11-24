import type {
  TmContext,
  TmEntry,
  TmMatch,
  TmMatchOptions,
  TmMatchType,
  TmPenalty,
} from "./types.ts";
import { languageMatches } from "./tmx.ts";

const ZERO_WIDTH = /[\u00ad\u200b-\u200d\u2060\ufeff]/gu;
const QUOTES = /[\u2018\u2019\u201a\u201b\u2032]/gu;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/gu;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu;
const TERMINAL_PUNCTUATION = /[.!?\u2026;:\u3002\uff01\uff1f\uff1b\uff1a]$/u;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const COMBINING_MARK = /\p{M}/u;

const TAG_TOKEN = /^<\/?[A-Za-z_][\w.:-]*(?:\s+[^<>]*?)?\s*\/?>/u;
const PLACEHOLDER_TOKEN =
  /^(?:\$\{[^{}]*\}|%[0-9]+\$[sdifuxX]|%[-+ 0#]*[0-9]*(?:\.[0-9]+)?[sdifuxXc]|\{[^{}]*\})/u;
const URL_TOKEN = /^(?:(?:https?|ftp):\/\/|www\.)[^\s<>"'{}]+/u;
const EMAIL_TOKEN = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
const PATH_TOKEN = /^(?:(?:[A-Za-z]:[\\/]|\\\\|~[\\/])[^\s<>"'{}]+|\/(?:[^\s<>"'{}]*\/)[^\s<>"'{}]*)/u;
const NUMBER_TOKEN = /^\p{Nd}+(?:[.,]\p{Nd}+)?/u;

const SIMILARITY_TRUNCATE = 200;
const TRUNCATION_PENALTY = 7;
const DEFAULT_THRESHOLD = 50;
const DEFAULT_MAX_MATCHES = 3;

type TokenKind = "word" | "number" | "cjk" | "tag" | "placeholder" | "atomic";

interface Token {
  kind: TokenKind;
  /** Normalized token text; structural tokens keep their raw ids. */
  raw: string;
  /** Similarity skeleton: numbers/tags/placeholders are mapped to placeholders. */
  skeleton: string;
}

interface Tokenized {
  tokens: Token[];
  skeleton: string[];
  numbers: string[];
  atoms: string[];
  /** Normalized text with punctuation/whitespace kept (for punctuation diffs). */
  norm: string;
  terminalPunct: boolean;
}

interface Structure {
  skeletonEqual: boolean;
  numbersEqual: boolean;
  atomsEqual: boolean;
  numberDiff: boolean;
  tagDiff: boolean;
  punctDiff: boolean;
  penalties: TmPenalty[];
}

interface ContextState {
  matched: boolean;
  both: boolean;
}

/**
 * Matching-time normalization (ALG-TM-001): NFKC/NFC, zero-width removal, unified
 * quotes/dashes/ellipsis, whitespace folding and case folding. Never written back.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\u2026/gu, "...")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function matchAtomic(rest: string): Token | undefined {
  const tag = TAG_TOKEN.exec(rest);
  if (tag) return { kind: "tag", raw: tag[0], skeleton: "<TAG>" };
  const placeholder = PLACEHOLDER_TOKEN.exec(rest);
  if (placeholder) return { kind: "placeholder", raw: placeholder[0], skeleton: "<PH>" };
  const url = URL_TOKEN.exec(rest);
  if (url) return { kind: "atomic", raw: url[0], skeleton: url[0] };
  const email = EMAIL_TOKEN.exec(rest);
  if (email) return { kind: "atomic", raw: email[0], skeleton: email[0] };
  const path = PATH_TOKEN.exec(rest);
  if (path) return { kind: "atomic", raw: path[0], skeleton: path[0] };
  return undefined;
}

function tokenize(text: string): Tokenized {
  const norm = normalizeText(text);
  const tokens: Token[] = [];
  let index = 0;
  while (index < norm.length) {
    const rest = norm.slice(index);
    const atomic = matchAtomic(rest);
    if (atomic) {
      tokens.push(atomic);
      index += atomic.raw.length;
      continue;
    }
    const char = norm[index]!;
    if (CJK_CHAR.test(char)) {
      tokens.push({ kind: "cjk", raw: char, skeleton: char });
      index += 1;
      continue;
    }
    const number = NUMBER_TOKEN.exec(rest);
    if (number) {
      tokens.push({ kind: "number", raw: number[0], skeleton: "<NUM>" });
      index += number[0].length;
      continue;
    }
    if (WORD_CHAR.test(char)) {
      let end = index + 1;
      while (end < norm.length) {
        const next = norm[end]!;
        if (CJK_CHAR.test(next)) break;
        if (WORD_CHAR.test(next) || COMBINING_MARK.test(next)) {
          end += 1;
          continue;
        }
        break;
      }
      const raw = norm.slice(index, end);
      tokens.push({ kind: "word", raw, skeleton: raw });
      index = end;
      continue;
    }
    // Punctuation/whitespace/symbols are dropped; differences are tracked separately.
    index += 1;
  }
  return {
    tokens,
    skeleton: tokens.map((token) => token.skeleton),
    numbers: tokens.filter((token) => token.kind === "number").map((token) => token.raw),
    atoms: tokens
      .filter((token) => token.kind === "tag" || token.kind === "placeholder")
      .map((token) => `${token.kind}:${token.raw}`),
    norm,
    terminalPunct: TERMINAL_PUNCTUATION.test(norm),
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function tokensEqual(a: readonly Token[], b: readonly Token[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (token, index) => token.kind === b[index]!.kind && token.raw === b[index]!.raw,
  );
}

function firstDifference(a: readonly string[], b: readonly string[]): string {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return `${a[index]} vs ${b[index]}`;
  }
  return `${a.length} vs ${b.length}`;
}

function compareStructure(source: Tokenized, entry: Tokenized, tmEntry: TmEntry): Structure {
  const skeletonEqual = arraysEqual(source.skeleton, entry.skeleton);
  const numbersEqual = arraysEqual(source.numbers, entry.numbers);
  const atomsEqual = arraysEqual(source.atoms, entry.atoms);
  const numberDiff = !numbersEqual;
  const tagDiff = !atomsEqual;
  const punctDiff =
    source.terminalPunct !== entry.terminalPunct ||
    (tokensEqual(source.tokens, entry.tokens) && source.norm !== entry.norm);

  const penalties: TmPenalty[] = [];
  if (numberDiff) {
    penalties.push({
      kind: "number",
      points: 2,
      detail: `${source.numbers.join(", ") || "none"} vs ${entry.numbers.join(", ") || "none"}`,
    });
  }
  if (tagDiff) {
    if (source.atoms.length !== entry.atoms.length) {
      penalties.push({
        kind: "tag_count",
        points: 10,
        detail: `${source.atoms.length} vs ${entry.atoms.length} tags/placeholders`,
      });
    } else {
      penalties.push({
        kind: "tag_id",
        points: 3,
        detail: firstDifference(source.atoms, entry.atoms),
      });
    }
  }
  if (punctDiff) {
    penalties.push({
      kind: "punctuation",
      points: 1,
      detail: "difference is limited to punctuation/whitespace",
    });
  }
  if (tmEntry.fuzzy === true) {
    penalties.push({ kind: "fuzzy", points: 5, detail: "TM entry is flagged as fuzzy" });
  }
  if (tmEntry.origin === "alignment") {
    penalties.push({
      kind: "unaligned",
      points: 2,
      detail: "alignment entry (default unaligned penalty)",
    });
  }
  return { skeletonEqual, numbersEqual, atomsEqual, numberDiff, tagDiff, punctDiff, penalties };
}

function sumPenalties(penalties: readonly TmPenalty[]): number {
  return penalties.reduce((total, penalty) => total + penalty.points, 0);
}

/** Optimal-string-alignment (Damerau-Levenshtein without adjacent repeats) on token arrays. */
function osaDistance(a: readonly string[], b: readonly string[]): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, matrix[i - 2]![j - 2]! + 1);
      }
      matrix[i]![j] = value;
    }
  }
  return matrix[rows - 1]![cols - 1]!;
}

function levenshteinDistance(a: string, b: string): number {
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function similarityOf(source: Tokenized, entry: Tokenized): { similarity: number; truncated: boolean } {
  if (arraysEqual(source.skeleton, entry.skeleton)) return { similarity: 100, truncated: false };
  if (source.skeleton.length >= 2 && entry.skeleton.length >= 2) {
    const distance = osaDistance(source.skeleton, entry.skeleton);
    const denominator = Math.max(source.skeleton.length, entry.skeleton.length, 3);
    return { similarity: round1(100 * (1 - distance / denominator)), truncated: false };
  }
  const truncated = source.norm.length > SIMILARITY_TRUNCATE || entry.norm.length > SIMILARITY_TRUNCATE;
  const a = source.norm.slice(0, SIMILARITY_TRUNCATE);
  const b = entry.norm.slice(0, SIMILARITY_TRUNCATE);
  const denominator = Math.max(a.length, b.length, 3);
  const distance = levenshteinDistance(a, b);
  return { similarity: round1(100 * (1 - distance / denominator)), truncated };
}

function matchTypeFor(rate: number): Exclude<TmMatchType, "no_match"> {
  if (rate >= 95) return "near_exact";
  if (rate >= 85) return "high_fuzzy";
  if (rate >= 75) return "medium_fuzzy";
  return "low_fuzzy";
}

function compareContext(provided: TmContext | undefined, stored: TmContext | undefined): ContextState {
  if (!provided || !stored) return { matched: false, both: false };
  const previousMatches =
    provided.previousSource !== undefined &&
    stored.previousSource !== undefined &&
    normalizeText(provided.previousSource) === normalizeText(stored.previousSource);
  const nextMatches =
    provided.nextSource !== undefined &&
    stored.nextSource !== undefined &&
    normalizeText(provided.nextSource) === normalizeText(stored.nextSource);
  return { matched: previousMatches || nextMatches, both: previousMatches && nextMatches };
}

function compareLastModified(a: TmEntry, b: TmEntry): number {
  const left = a.lastModified ?? "";
  const right = b.lastModified ?? "";
  if (left === right) return 0;
  if (left === "") return 1;
  if (right === "") return -1;
  return left < right ? 1 : -1;
}

function languageAllowed(entryLanguage: string, wanted: string | undefined): boolean {
  if (wanted === undefined) return true;
  if (entryLanguage === "") return true;
  return languageMatches(entryLanguage, wanted);
}

/**
 * Match `sourceText` against a TM (ALG-TM-002/003).
 *
 * - Normalizes NFC/NFKC + case + whitespace; atomizes inline tags, placeholders,
 *   URLs/emails/paths; tokenizes Latin/Cyrillic words, numbers and CJK characters.
 * - `matchRate` is 0 or 50–102; text-exact = 100, context = 101, both-sides context =
 *   102. Structural differences (numbers/tags) are penalized and never exceed 99;
 *   punctuation-only differences produce 99.
 * - `similarity` is the raw similarity (1 decimal), independent of penalties.
 * - Candidates below `threshold` (default 50) are dropped; at most `maxMatches`
 *   (default 3) are returned, sorted by matchRate, similarity, lastModified desc, id.
 */
export function matchTm(
  entries: readonly TmEntry[],
  sourceText: string,
  options: TmMatchOptions = {},
): TmMatch[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  if (maxMatches <= 0) return [];
  const source = tokenize(sourceText);
  const scored: Array<{ match: TmMatch; index: number }> = [];

  entries.forEach((entry, index) => {
    if (!languageAllowed(entry.sourceLanguage, options.sourceLanguage)) return;
    if (!languageAllowed(entry.targetLanguage, options.targetLanguage)) return;
    const target = tokenize(entry.source);
    const structure = compareStructure(source, target, entry);
    const context = compareContext(options.context, entry.context);
    const truncation = structure.skeletonEqual
      ? { similarity: 100, truncated: false }
      : similarityOf(source, target);

    let matchRate: number;
    let matchType: Exclude<TmMatchType, "no_match">;
    if (structure.skeletonEqual && structure.numbersEqual && structure.atomsEqual && !structure.punctDiff) {
      // Structurally identical: context upgrades to 101/102, otherwise a clean 100.
      // The entry-level fuzzy/unaligned markers do not reduce an exact text match.
      structure.penalties.length = 0;
      if (context.both) {
        matchRate = 102;
        matchType = "double_context";
      } else if (context.matched) {
        matchRate = 101;
        matchType = "context";
      } else {
        matchRate = 100;
        matchType = "exact";
      }
    } else if (structure.skeletonEqual) {
      const penalties = sumPenalties(structure.penalties);
      const candidate = Math.min(99, Math.round(100 - penalties));
      if (candidate < 50) return;
      matchRate = candidate;
      matchType = matchTypeFor(candidate);
    } else {
      const truncationPenalty = truncation.truncated ? TRUNCATION_PENALTY : 0;
      const adjusted = truncation.similarity - sumPenalties(structure.penalties) - truncationPenalty;
      if (adjusted < 50) return;
      const candidate = Math.min(99, Math.round(adjusted));
      if (candidate < 50) return;
      matchRate = candidate;
      matchType = matchTypeFor(candidate);
    }
    if (matchRate < threshold) return;

    scored.push({
      index,
      match: {
        entry,
        similarity: truncation.similarity,
        matchRate,
        matchType,
        penalties: structure.penalties,
        contextMatched: context.matched,
        flags: {
          numberDiff: structure.numberDiff,
          tagDiff: structure.tagDiff,
          punctDiff: structure.punctDiff,
          truncated: truncation.truncated,
        },
      },
    });
  });

  scored.sort((left, right) => {
    const a = left.match;
    const b = right.match;
    if (b.matchRate !== a.matchRate) return b.matchRate - a.matchRate;
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    const modified = compareLastModified(a.entry, b.entry);
    if (modified !== 0) return modified;
    if (a.entry.id !== b.entry.id) return a.entry.id < b.entry.id ? -1 : 1;
    return left.index - right.index;
  });
  return scored.slice(0, maxMatches).map((item) => item.match);
}
