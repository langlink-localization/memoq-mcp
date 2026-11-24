/**
 * Deterministic QA rules for @langlink/l10n-core (Phase 1a).
 *
 * Design constraints (docs/spec.md §5.6):
 * - Every rule is a pure function of the segment plus read-only context; no I/O.
 * - Deterministic and stably sorted output: same input => identical result.
 * - Coverage is honest: rules that could not run are reported as
 *   `skipped`/`failed` and flip `coverage` to "incomplete"; they are never
 *   silently treated as "0 issues".
 * - Rule ids are UPPER_SNAKE_CASE and match docs/spec.md §5.6.
 *
 * Ranges: `sourceRange`/`targetRange` are UTF-16 code-unit offsets into
 * `segment.sourceText` / `segment.targetText` (decoded text, not inner XML).
 */

import type { GlossaryEntry, TermHit } from "../assets/types.ts";
import type { Segment } from "../model.ts";
import { decodeXmlEntities } from "../xml.ts";
import { inlineCodeLocations, inlineCodeOrderError, inlineCodeSignatures, inlineText } from "../formats/inline.ts";
import type {
  QaCheckOptions,
  QaIssue,
  QaResult,
  QaRuleExecution,
  QaSeverity,
  QaTermHits,
  QaUntranslatedCopyOptions,
  QaLocaleOptions,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Rule registry (order = aggregation order from docs/spec.md §5.6)
// ---------------------------------------------------------------------------

import { RULES } from "./catalog.ts";
export { QA_RULE_CATALOG } from "./catalog.ts";

const RULE_INDEX = new Map<string, number>(RULES.map((rule, index) => [rule.id, index]));
const RULE_SEVERITY = new Map<string, QaSeverity>(RULES.map((rule) => [rule.id, rule.severity]));
const TERM_RULE_IDS = RULES.filter((rule) => rule.requiresTerms).map((rule) => rule.id);
const LOCALE_RULE_IDS = RULES.filter((rule) => rule.requiresLocale).map((rule) => rule.id);
const DOCUMENT_RULE_IDS = new Set(
  RULES.filter((rule) => rule.scope === "document").map((rule) => rule.id),
);
const DEFAULT_ENABLED = RULES.filter((rule) => rule.defaultOff !== true).map((rule) => rule.id);

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

function normalizeForCompare(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function cjkFraction(value: string): number {
  let cjk = 0;
  let visible = 0;
  for (const char of value) {
    if (/\s/u.test(char)) continue;
    visible += 1;
    if (CJK_RE.test(char)) cjk += 1;
  }
  return visible === 0 ? 0 : cjk / visible;
}

function isCjkHeavy(value: string): boolean {
  return cjkFraction(value) >= 0.3;
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function wordTokens(value: string): string[] {
  const matches = value.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return matches ?? [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function truncate(value: string, max = 120): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function multiset(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function multisetDelta(
  expected: readonly string[],
  actual: readonly string[],
): { missing: string[]; extra: string[] } {
  const expectedCounts = multiset(expected);
  const actualCounts = multiset(actual);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [value, count] of expectedCounts) {
    for (let index = actualCounts.get(value) ?? 0; index < count; index += 1) missing.push(value);
  }
  for (const [value, count] of actualCounts) {
    for (let index = expectedCounts.get(value) ?? 0; index < count; index += 1) extra.push(value);
  }
  missing.sort();
  extra.sort();
  return { missing, extra };
}

// ---------------------------------------------------------------------------
// Issue drafts / segment context
// ---------------------------------------------------------------------------

interface IssueDraft {
  ruleId: string;
  message: string;
  evidence: string;
  suggestion?: string;
  sourceRange?: { start: number; end: number };
  targetRange?: { start: number; end: number };
  termId?: string;
}

interface SegmentContext {
  segment: Segment;
  source: string;
  target: string;
  sourceInner: string;
  targetInner: string;
  /** Target script inferred from the target text (model carries no locale). */
  targetIsCjk: boolean;
  /** Optional locale-aware overrides for language-variant rules. */
  locale?: QaLocaleOptions;
  /** Optional whitelist/short-segment policy for UNTRANSLATED_COPY. */
  untranslatedCopy?: QaUntranslatedCopyOptions;
  termHits?: QaTermHits;
  glossary: Map<string, GlossaryEntry>;
  drafts: IssueDraft[];
}

interface CheckGroup {
  /** Rule ids this check can emit; used for applicability + coverage accounting. */
  ids: readonly string[];
  run: (context: SegmentContext) => void;
}

function draft(context: SegmentContext, issue: IssueDraft): void {
  context.drafts.push(issue);
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /%(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[sdfuxXoc]/gu,
  /\{\{[^{}\n]{1,64}\}\}/gu,
  /\$\{[^{}\n]{1,64}\}/gu,
  /\{[A-Za-z_][A-Za-z0-9_.:-]{0,63}\}/gu,
  /\{\d{1,6}\}/gu,
];

interface PlaceholderToken {
  text: string;
  start: number;
  end: number;
}

function collectPlaceholders(value: string): PlaceholderToken[] {
  const matches: PlaceholderToken[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of value.matchAll(regex)) {
      if (match.index === undefined) continue;
      matches.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  const result: PlaceholderToken[] = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start < lastEnd) continue;
    result.push(match);
    lastEnd = match.end;
  }
  return result;
}

function checkPlaceholders(context: SegmentContext): void {
  const sourcePlaceholders = collectPlaceholders(context.sourceInner);
  const targetPlaceholders = collectPlaceholders(context.targetInner);
  if (sourcePlaceholders.length === 0 && targetPlaceholders.length === 0) return;
  const delta = multisetDelta(
    sourcePlaceholders.map((token) => token.text),
    targetPlaceholders.map((token) => token.text),
  );
  if (delta.missing.length > 0) {
    const first = sourcePlaceholders.find((token) => token.text === delta.missing[0]);
    draft(context, {
      ruleId: "PLACEHOLDER_MISSING",
      message: `译文缺少占位符: ${delta.missing.join(", ")}`,
      evidence: `source placeholders: [${sourcePlaceholders.map((token) => token.text).join(", ")}]`,
      suggestion: `保留占位符: ${delta.missing.join(", ")}`,
      ...(first === undefined ? {} : { sourceRange: { start: first.start, end: first.end } }),
    });
  }
  if (delta.extra.length > 0) {
    const first = targetPlaceholders.find((token) => token.text === delta.extra[0]);
    draft(context, {
      ruleId: "PLACEHOLDER_EXTRA",
      message: `译文多出占位符: ${delta.extra.join(", ")}`,
      evidence: `target placeholders: [${targetPlaceholders.map((token) => token.text).join(", ")}]`,
      ...(first === undefined ? {} : { targetRange: { start: first.start, end: first.end } }),
    });
  }
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function checkTags(context: SegmentContext): void {
  const sourceTags = context.segment.sourceTags;
  const targetTags = context.segment.targetTags;
  if (sourceTags.length === 0 && targetTags.length === 0) return;
  const source = context.segment.sourceNode ? inlineCodeSignatures(context.segment.sourceNode) : sourceTags;
  const target = context.segment.targetNode ? inlineCodeSignatures(context.segment.targetNode) : targetTags;
  const sameInventory = JSON.stringify([...source].sort()) === JSON.stringify([...target].sort());
  const orderError = sameInventory && context.segment.sourceNode && context.segment.targetNode
    ? inlineCodeOrderError(context.segment.sourceNode, context.segment.targetNode) : undefined;
  if (sameInventory && !orderError) return;
  draft(context, {
    ruleId: "TAG_MISMATCH",
    message: orderError ? "标签的配对或顺序与源文约束不一致" : "标签的数量、标识或原生代码与源文不一致",
    evidence: JSON.stringify({ source, target, ...(orderError ? { orderError } : {}) }),
    suggestion: "核对标签的 ID、配对引用和原生代码，保留源文中的标签",
  });
}

// ---------------------------------------------------------------------------
// URLs / emails / file paths
// ---------------------------------------------------------------------------

const URL_PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\/[^\s<>"']+/giu,
  /\bwww\.[^\s<>"']+/giu,
  /\bmailto:[^\s<>"']+/giu,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gu,
  /\b[A-Za-z]:\\[^\s<>"']+/gu,
  /\\\\[^\s<>"']+/gu,
  /(?:^|[\s("'[，。；：])(\/(?:[\w.-]+\/)+[\w.-]+\.(?:json|yaml|yml|xml|txt|csv|tsv|png|jpe?g|gif|svg|pdf|docx?|xlsx?|pptx?|zip|log|md|html?|js|ts|css|ini|conf|config|exe|dll|sh|bat|py))\b/giu,
];

function extractUrls(value: string): string[] {
  const found: string[] = [];
  for (const pattern of URL_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of value.matchAll(regex)) {
      let text = pattern.source.includes("(?:^|[\\s(") ? (match[1] ?? "") : match[0];
      text = text.replace(/[),.;:!?'"\]】。，；：]+$/u, "");
      if (text.length > 0) found.push(text);
    }
  }
  const unique = new Map<string, string>();
  for (const item of found) {
    const key = item.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, item);
  }
  return Array.from(unique.values()).sort();
}

function checkUrls(context: SegmentContext): void {
  const sourceUrls = extractUrls(context.sourceInner.length > 0 ? context.sourceInner : context.source);
  const targetUrls = extractUrls(context.targetInner.length > 0 ? context.targetInner : context.target);
  if (sourceUrls.length === 0) return;
  const targetSet = new Set(targetUrls.map((url) => url.toLocaleLowerCase()));
  const sourceSet = new Set(sourceUrls.map((url) => url.toLocaleLowerCase()));
  const missing = sourceUrls.filter((url) => !targetSet.has(url.toLocaleLowerCase()));
  const extra = targetUrls.filter((url) => !sourceSet.has(url.toLocaleLowerCase()));
  if (missing.length === 0 && extra.length === 0) return;
  const firstMissing = missing[0];
  const index = firstMissing === undefined ? -1 : context.source.indexOf(firstMissing);
  draft(context, {
    ruleId: "URL_CHANGED",
    message:
      missing.length > 0
        ? `译文缺少/改动了 URL、邮箱或路径: ${missing.join(", ")}`
        : `译文多出源文没有的 URL、邮箱或路径: ${extra.join(", ")}`,
    evidence: `source: [${sourceUrls.join(", ")}] target: [${targetUrls.join(", ")}]`,
    ...(firstMissing === undefined ? {} : { suggestion: `保留原文: ${firstMissing}` }),
    ...(index < 0 || firstMissing === undefined
      ? {}
      : { sourceRange: { start: index, end: index + firstMissing.length } }),
  });
}

// ---------------------------------------------------------------------------
// Numbers and dates
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

const MONTHS: ReadonlyMap<string, number> = new Map(
  [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ].map((month, index) => [month, index + 1]),
);

const MONTH_ALIASES: ReadonlyMap<string, number> = new Map([
  ...MONTHS,
  ...Array.from(MONTHS, ([month, number]) => [month.slice(0, 3), number] as const),
  ["sept", 9] as const,
]);

const CJK_DIGITS: ReadonlyMap<string, string> = new Map([
  ["〇", "0"], ["零", "0"], ["一", "1"], ["二", "2"], ["三", "3"], ["四", "4"],
  ["五", "5"], ["六", "6"], ["七", "7"], ["八", "8"], ["九", "9"],
]);

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

const DATE_PATTERNS: readonly RegExp[] = [
  /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/gu,
  /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/gu,
  /(\d{4}|[〇零一二三四五六七八九]{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/gu,
];

interface DateToken {
  /** Normalized key, e.g. "2024-01-02", "?-01-02", "2024-01". */
  key: string;
  text: string;
  span: Span;
}

function extractDates(value: string): DateToken[] {
  value = normalizeNumericText(value);
  const tokens: DateToken[] = [];
  const push = (key: string, text: string, start: number): void => {
    tokens.push({ key, text, span: { start, end: start + text.length } });
  };

  for (const match of value.matchAll(DATE_PATTERNS[0] ?? /$^/gu)) {
    const [text = "", year = "", month = "", day = ""] = match;
    if (match.index === undefined) continue;
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    if (!validMonthDay(monthNumber, dayNumber)) continue;
    push(`${year}-${pad2(monthNumber)}-${pad2(dayNumber)}`, text, match.index);
  }

  for (const match of value.matchAll(DATE_PATTERNS[1] ?? /$^/gu)) {
    const [text = "", first = "", second = "", yearRaw = ""] = match;
    if (match.index === undefined) continue;
    let day = Number(first);
    let month = Number(second);
    if (month > 12 && day <= 12) {
      const swap = day;
      day = month;
      month = swap;
    }
    if (!validMonthDay(month, day)) continue;
    if (yearRaw.length === 2) {
      push(`${yearRaw}-${pad2(month)}-${pad2(day)}`, text, match.index);
      continue;
    }
    const year = Number(yearRaw);
    if (year < 1000 || year > 2999) continue;
    push(`${year}-${pad2(month)}-${pad2(day)}`, text, match.index);
  }

  for (const match of value.matchAll(DATE_PATTERNS[2] ?? /$^/gu)) {
    const [text = "", yearRaw = "", month = "", day] = match;
    if (match.index === undefined) continue;
    let year: string;
    if (/^\d{4}$/u.test(yearRaw)) {
      year = yearRaw;
    } else {
      let converted = "";
      for (const char of yearRaw) converted += CJK_DIGITS.get(char) ?? "";
      if (converted.length !== 4) continue;
      year = converted;
    }
    const monthNumber = Number(month);
    if (!validMonthDay(monthNumber, 1)) continue;
    if (day === undefined) {
      push(`${year}-${pad2(monthNumber)}`, text, match.index);
    } else {
      const dayNumber = Number(day);
      if (!validMonthDay(monthNumber, dayNumber)) continue;
      push(`${year}-${pad2(monthNumber)}-${pad2(dayNumber)}`, text, match.index);
    }
  }

  const monthNames = Array.from(MONTH_ALIASES.keys())
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  const mdy = new RegExp(
    `\\b(${monthNames})[ .]+(\\d{1,2})(?:st|nd|rd|th)?(?:[, ]+(\\d{4}))?\\b`,
    "giu",
  );
  for (const match of value.matchAll(mdy)) {
    const [text = "", monthRaw = "", day = "", year] = match;
    if (match.index === undefined) continue;
    const month = MONTH_ALIASES.get(monthRaw.toLowerCase());
    if (month === undefined) continue;
    const dayNumber = Number(day);
    if (!validMonthDay(month, dayNumber)) continue;
    push(
      year === undefined ? `?-${pad2(month)}-${pad2(dayNumber)}` : `${year}-${pad2(month)}-${pad2(dayNumber)}`,
      text,
      match.index,
    );
  }
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[ .]+(${monthNames})[ .]*(\\d{4})?\\b`, "giu");
  for (const match of value.matchAll(dmy)) {
    const [text = "", day = "", monthRaw = "", year] = match;
    if (match.index === undefined) continue;
    const month = MONTH_ALIASES.get(monthRaw.toLowerCase());
    if (month === undefined) continue;
    const dayNumber = Number(day);
    if (!validMonthDay(month, dayNumber)) continue;
    push(
      year === undefined ? `?-${pad2(month)}-${pad2(dayNumber)}` : `${year}-${pad2(month)}-${pad2(dayNumber)}`,
      text,
      match.index,
    );
  }

  tokens.sort((left, right) => left.span.start - right.span.start);
  const result: DateToken[] = [];
  let lastEnd = -1;
  for (const token of tokens) {
    if (token.span.start < lastEnd) continue;
    result.push(token);
    lastEnd = token.span.end;
  }
  return result;
}

function maskSpans(value: string, spans: readonly Span[]): string {
  if (spans.length === 0) return value;
  const chars = value.split("");
  for (const span of spans) {
    for (let index = span.start; index < span.end && index < chars.length; index += 1) chars[index] = " ";
  }
  return chars.join("");
}

const NUMBER_RE = /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?(?![\p{L}\p{N}_])/gu;

function normalizeNumber(raw: string): string {
  let value = raw;
  const sign = value.startsWith("-") ? "-" : "";
  value = value.replace(/^[+-]/u, "");
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(value)) {
    value = value.replaceAll(",", "");
  } else if (/^\d{1,3}(?:\.\d{3}){2,}$/u.test(value)) {
    // 1.000.000 — grouping dots only when unambiguous (2+ groups)
    value = value.replaceAll(".", "");
  }
  if (!/^\d/u.test(value)) return raw.normalize("NFKC");
  if (/^\d+\.0+$/u.test(value)) value = value.replace(/\.0+$/u, "");
  return `${sign}${value}`;
}

function normalizeNumericText(value: string): string {
  return value.replace(/[０-９．，＋－]/gu, (character) => character.normalize("NFKC"));
}

function extractNumbers(value: string): Array<Span & { key: string }> {
  const normalized = normalizeNumericText(value);
  const masked = maskSpans(
    normalized,
    [...extractDates(normalized).map((token) => token.span), ...collectPlaceholders(normalized)],
  );
  const results: Array<Span & { key: string }> = [];
  for (const match of masked.matchAll(NUMBER_RE)) {
    results.push({ key: normalizeNumber(match[0]), start: match.index, end: match.index + match[0].length });
  }
  return results;
}

function checkNumbers(context: SegmentContext): void {
  const sourceNumbers = extractNumbers(context.source).map((token) => token.key);
  const targetNumbers = extractNumbers(context.target).map((token) => token.key);
  if (sourceNumbers.length === 0 && targetNumbers.length === 0) return;
  const delta = multisetDelta(sourceNumbers, targetNumbers);
  if (delta.missing.length === 0 && delta.extra.length === 0) return;
  const firstMissing = delta.missing[0];
  const index = firstMissing === undefined ? -1 : context.target.indexOf(firstMissing);
  draft(context, {
    ruleId: "NUMBER_MISMATCH",
    message:
      delta.missing.length > 0
        ? `译文缺少/改动了数字: ${delta.missing.join(", ")}`
        : `译文多出数字: ${delta.extra.join(", ")}`,
    evidence: `source numbers: [${sourceNumbers.join(", ")}] target numbers: [${targetNumbers.join(", ")}]`,
    ...(firstMissing === undefined ? {} : { suggestion: `核对数字: ${firstMissing}` }),
    ...(index < 0 || firstMissing === undefined
      ? {}
      : { targetRange: { start: index, end: index + firstMissing.length } }),
  });
}

function checkDates(context: SegmentContext): void {
  const sourceDates = extractDates(context.source);
  const targetDates = extractDates(context.target);
  if (sourceDates.length === 0 && targetDates.length === 0) return;
  const delta = multisetDelta(
    sourceDates.map((token) => token.key),
    targetDates.map((token) => token.key),
  );
  if (delta.missing.length === 0 && delta.extra.length === 0) return;
  const firstMissing = sourceDates.find((token) => delta.missing.includes(token.key));
  draft(context, {
    ruleId: "DATE_MISMATCH",
    message:
      delta.missing.length > 0
        ? `译文缺少/改动了日期: ${delta.missing.join(", ")}`
        : `译文多出日期: ${delta.extra.join(", ")}`,
    evidence: `source dates: [${sourceDates.map((token) => token.text).join(", ")}] target dates: [${targetDates.map((token) => token.text).join(", ")}]`,
    ...(firstMissing === undefined
      ? {}
      : { sourceRange: { start: firstMissing.span.start, end: firstMissing.span.end } }),
  });
}

// ---------------------------------------------------------------------------
// Date format (locale-aware)
// ---------------------------------------------------------------------------

type DateOrder = "ymd" | "mdy" | "dmy";

function localeDateOrder(locale: string): DateOrder | undefined {
  const normalized = locale.trim().toLowerCase().replace(/_/gu, "-");
  if (/^(?:zh|ja|ko)(?:-|$)/u.test(normalized)) return "ymd";
  if (/^en-us(?:-|$)/u.test(normalized)) return "mdy";
  if (
    /^(?:en-gb|en-au|en-nz|en-ie|de|fr|es|it|pt|nl|ru|pl|tr|sv|da|fi|nb|cs|hu|ro|bg|hr|sk|sl|uk|el)(?:-|$)/u.test(
      normalized,
    )
  ) {
    return "dmy";
  }
  return undefined;
}

function numericDateOrder(text: string): DateOrder | undefined {
  if (/^(?:\d{4}|[〇零一二三四五六七八九]{4})年/u.test(text)) return "ymd";
  if (/^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/u.test(text)) return "ymd";
  const match = /^(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}$/u.exec(text);
  if (!match) return undefined;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first > 12 && second <= 12) return "dmy";
  if (second > 12 && first <= 12) return "mdy";
  return undefined;
}

function checkDateFormat(context: SegmentContext): void {
  const targetLocale = context.locale?.targetLocale;
  if (targetLocale === undefined) return;
  const expected = localeDateOrder(targetLocale);
  if (expected === undefined) return;
  const dates = extractDates(context.target);
  if (dates.length === 0) return;
  for (const token of dates) {
    const actual = numericDateOrder(token.text);
    if (actual === undefined || actual === expected) continue;
    draft(context, {
      ruleId: "DATE_FORMAT",
      message: `日期格式与目标语言习惯不一致: '${token.text}' 为 ${actual.toUpperCase()}，${targetLocale} 期望 ${expected.toUpperCase()}`,
      evidence: `target date: "${token.text}"`,
      suggestion:
        expected === "ymd"
          ? "改为 年-月-日 顺序"
          : expected === "dmy"
            ? "改为 日/月/年 顺序"
            : "改为 月/日/年 顺序",
      targetRange: { start: token.span.start, end: token.span.end },
    });
  }
}

// ---------------------------------------------------------------------------
// Brackets and quotes
// ---------------------------------------------------------------------------

const BRACKET_PAIRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["(", new Set([")", "）"])],
  ["（", new Set(["）", ")"])],
  ["[", new Set(["]", "】"])],
  ["【", new Set(["]", "】"])],
  ["{", new Set(["}", "｝"])],
  ["｛", new Set(["}", "｝"])],
  ["〈", new Set(["〉", ">"])],
  ["《", new Set(["》"])],
  ["「", new Set(["」"])],
  ["『", new Set(["』"])],
  ["<", new Set([">"])],
]);

const CLOSE_TO_OPEN = new Map<string, string>([
  [")", "("], ["）", "（"], ["]", "["], ["】", "【"], ["}", "{"], ["｝", "｛"],
  ["〉", "〈"], ["》", "《"], ["」", "「"], ["』", "『"], [">", "<"],
]);

interface UnpairedToken {
  char: string;
  index: number;
  kind: "bracket" | "quote";
}

function unpairedTokens(value: string): UnpairedToken[] {
  const result: UnpairedToken[] = [];
  const stack: Array<{ open: string; index: number }> = [];
  let offset = 0;
  for (const char of value) {
    const closes = BRACKET_PAIRS.get(char);
    if (closes) {
      stack.push({ open: char, index: offset });
      offset += 1;
      continue;
    }
    const expectedOpen = CLOSE_TO_OPEN.get(char);
    if (expectedOpen) {
      const top = stack[stack.length - 1];
      const topCloses = top === undefined ? undefined : BRACKET_PAIRS.get(top.open);
      if (top !== undefined && topCloses?.has(char) === true) {
        stack.pop();
      } else {
        result.push({ char, index: offset, kind: "bracket" });
      }
    }
    offset += 1;
  }
  for (const entry of stack) result.push({ char: entry.open, index: entry.index, kind: "bracket" });

  // Curly quotes: count open/close pairs (CJK and Western typographic quotes).
  const quotePairs: Array<[string, string]> = [["“", "”"], ["‘", "’"]];
  for (const [open, close] of quotePairs) {
    const openCount = Array.from(value).filter((char) => char === open).length;
    const closeCount = Array.from(value).filter((char) => char === close).length;
    if (openCount !== closeCount) {
      const index = value.indexOf(openCount > closeCount ? open : close);
      result.push({ char: openCount > closeCount ? open : close, index: index < 0 ? 0 : index, kind: "quote" });
    }
  }
  // Straight double quote: odd count is suspicious (apostrophes are ignored).
  const straightQuotes = Array.from(value).filter((char) => char === "\"").length;
  if (straightQuotes % 2 === 1) {
    const index = value.indexOf("\"");
    result.push({ char: "\"", index: index < 0 ? 0 : index, kind: "quote" });
  }
  result.sort((left, right) => left.index - right.index);
  return result;
}

function checkUnpairedBrackets(context: SegmentContext): void {
  if (context.target.trim().length === 0) return;
  const unpaired = unpairedTokens(context.target);
  if (unpaired.length === 0) return;
  const first = unpaired[0];
  draft(context, {
    ruleId: "UNPAIRED_BRACKET",
    message: `译文括号/引号不配对: ${unpaired
      .slice(0, 5)
      .map((entry) => `'${entry.char}'`)
      .join(", ")}`,
    evidence: `text: ${truncate(context.target)}`,
    suggestion: "检查括号、引号是否成对（全角/半角需对应）",
    ...(first === undefined ? {} : { targetRange: { start: first.index, end: first.index + 1 } }),
  });
}

// ---------------------------------------------------------------------------
// Duplicate words / punctuation
// ---------------------------------------------------------------------------

const CJK_REDUPLICATION_OK = new Set<string>([
  "谢谢", "看看", "慢慢", "刚刚", "妈妈", "爸爸", "哥哥", "姐姐", "弟弟", "妹妹",
  "星星", "天天", "年年", "人人", "处处", "时时", "好好", "多多", "常常", "往往",
  "渐渐", "默默", "悄悄", "轻轻", "深深", "远远", "高高", "大大", "小小", "红红",
  "白白", "一一", "个个", "件件", "条条", "种种", "层层", "步步", "次次", "夜夜",
  "声声", "字字", "句句", "朵朵", "片片", "点点", "滴滴", "丝丝", "阵阵", "群群",
  "队队", "本本", "台台", "家家", "户户", "村村", "镇镇", "仅仅", "偏偏", "恰恰",
  "统统", "通通", "历历", "耿耿", "栩栩", "津津", "跃跃", "愤愤", "悻悻", "窃窃",
  "姗姗", "徐徐", "缓缓", "冉冉", "滔滔", "滚滚", "茫茫", "苍苍", "郁郁", "葱葱",
  "哗哗", "沙沙", "隆隆", "咚咚", "呜呜", "汪汪", "喵喵", "咩咩",
]);

function checkDuplicateWords(context: SegmentContext): void {
  const target = context.target;
  if (target.trim().length === 0) return;
  let emitted = 0;

  const latin = /(?<![\p{L}\p{N}])([\p{L}][\p{L}'’_-]{1,})(\s+)\1(?![\p{L}\p{N}])/giu;
  for (const match of target.matchAll(latin)) {
    if (match.index === undefined) continue;
    draft(context, {
      ruleId: "DUPLICATE_WORD",
      message: `相邻重复词: '${match[1]} ${match[1]}'`,
      evidence: truncate(match[0]),
      targetRange: { start: match.index, end: match.index + match[0].length },
    });
    emitted += 1;
    if (emitted >= 3) return;
  }

  const chars = Array.from(target);
  let cjkOffset = 0;
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const first = chars[index];
    const second = chars[index + 1];
    if (first === undefined || second === undefined || first !== second || !CJK_RE.test(first)) {
      cjkOffset += first === undefined ? 0 : charCount(first);
      continue;
    }
    const pair = first + second;
    if (!CJK_REDUPLICATION_OK.has(pair)) {
      draft(context, {
        ruleId: "DUPLICATE_WORD",
        message: `CJK 重复字: '${pair}'`,
        evidence: `text: ${truncate(target)}`,
        targetRange: { start: cjkOffset, end: cjkOffset + 2 },
      });
      emitted += 1;
      if (emitted >= 3) return;
    }
    cjkOffset += 2;
    index += 1;
  }
}

const PUNCT_DUP_EXEMPT = new Set(["…", "—", "－", "*", "=", "-", "~", "～", "/"]);

function checkPunctDup(context: SegmentContext): void {
  if (context.target.trim().length === 0) return;
  const regex = /([!?.,;:。？！，、；：])\1+/gu;
  let emitted = 0;
  for (const match of context.target.matchAll(regex)) {
    if (match.index === undefined) continue;
    if (PUNCT_DUP_EXEMPT.has(match[1] ?? "")) continue;
    draft(context, {
      ruleId: "PUNCT_DUP",
      message: `连续重复标点: '${match[0]}'`,
      evidence: match[0],
      targetRange: { start: match.index, end: match.index + match[0].length },
    });
    emitted += 1;
    if (emitted >= 3) return;
  }
}

// ---------------------------------------------------------------------------
// Source leftover
// ---------------------------------------------------------------------------

function checkSourceLeftover(context: SegmentContext): void {
  const { source, target } = context;
  if (source.trim().length === 0 || target.trim().length === 0) return;
  if (normalizeForCompare(source) === normalizeForCompare(target)) return;
  const normalizedTarget = normalizeForCompare(target);

  for (const match of source.normalize("NFKC").matchAll(/[\u4e00-\u9fff]{4,}/gu)) {
    const run = match[0];
    const index = normalizedTarget.indexOf(run);
    if (index < 0) continue;
    draft(context, {
      ruleId: "SOURCE_LEFTOVER",
      message: `译文残留源文片段: '${truncate(run)}'`,
      evidence: `source run: ${truncate(run)}`,
      targetRange: { start: index, end: index + run.length },
    });
    return;
  }

  const tokens = wordTokens(source);
  if (tokens.length < 3) return;
  for (let start = 0; start + 3 <= tokens.length; start += 1) {
    const window = tokens.slice(start, start + 3);
    if (window.some((token) => token.length < 2)) continue;
    const pattern = new RegExp(`\\b${window.map(escapeRegExp).join("\\s+")}\\b`, "iu");
    const match = pattern.exec(target);
    if (!match || match.index === undefined) continue;
    draft(context, {
      ruleId: "SOURCE_LEFTOVER",
      message: `译文残留源文片段: '${window.join(" ")}'`,
      evidence: `source window: ${window.join(" ")}`,
      targetRange: { start: match.index, end: match.index + match[0].length },
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// Punctuation / style
// ---------------------------------------------------------------------------

function checkTrailingColon(context: SegmentContext): void {
  const source = context.source.trimEnd();
  const target = context.target.trimEnd();
  if (target.length === 0) return;
  if (!source.endsWith(":") && !source.endsWith("：")) return;
  if (target.endsWith(":") || target.endsWith("：")) return;
  draft(context, {
    ruleId: "TRAILING_COLON",
    message: "源文以冒号结尾，译文未以冒号结尾",
    evidence: `source tail: '${truncate(source.slice(-30))}' target tail: '${truncate(target.slice(-30))}'`,
    suggestion: "保持列表引导冒号一致",
  });
}

const TERMINAL_CLASS: ReadonlyMap<string, "period" | "question" | "exclamation"> = new Map([
  [".", "period"], ["。", "period"], ["．", "period"],
  ["?", "question"], ["？", "question"],
  ["!", "exclamation"], ["！", "exclamation"],
]);

const TRAILING_CLOSERS = new Set([")", "）", "]", "】", "」", "』", "”", "’", "\"", "'", "》", "〉"]);

interface Terminal {
  char: string;
  index: number;
  className: "period" | "question" | "exclamation";
}

function terminalPunctuation(value: string): Terminal | undefined {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index];
    if (char === undefined) return undefined;
    if (/\s/u.test(char)) continue;
    if (TRAILING_CLOSERS.has(char)) continue;
    const className = TERMINAL_CLASS.get(char);
    if (className === undefined) return undefined;
    return { char, index, className };
  }
  return undefined;
}

function checkSentenceEndPunct(context: SegmentContext): void {
  const source = context.source.trimEnd();
  const target = context.target.trimEnd();
  if (source.length === 0 || target.length === 0) return;
  if (source.endsWith("...") || source.endsWith("…")) return;
  const sourceTerminal = terminalPunctuation(source);
  if (sourceTerminal === undefined) return;
  // Titles/labels usually have no sentence-final punctuation on the target side.
  if (sourceTerminal.className === "period" && wordTokens(source).length <= 2) return;
  const targetTerminal = terminalPunctuation(target);
  if (targetTerminal === undefined) {
    draft(context, {
      ruleId: "SENTENCE_END_PUNCT",
      message: "译文缺少句末标点",
      evidence: `source ends with '${sourceTerminal.char}', target has no sentence-final punctuation`,
      suggestion: context.targetIsCjk ? "补全全角句末标点" : "补全句末标点",
    });
    return;
  }
  if (targetTerminal.className === sourceTerminal.className) return;
  draft(context, {
    ruleId: "SENTENCE_END_PUNCT",
    message: `句末标点类型不匹配: 源文 '${sourceTerminal.char}' / 译文 '${targetTerminal.char}'`,
    evidence: `source tail: '${truncate(source.slice(-20))}' target tail: '${truncate(target.slice(-20))}'`,
    targetRange: { start: targetTerminal.index, end: targetTerminal.index + 1 },
  });
}

function checkWhitespace(context: SegmentContext): void {
  const raw = context.targetInner;
  if (raw.length === 0) return;
  if (raw !== raw.trim()) {
    draft(context, {
      ruleId: "WHITESPACE",
      message: "译文存在首尾空白",
      evidence: "target inner starts/ends with whitespace",
      suggestion: "删除首尾空白",
    });
  }
  const doubleSpace = /[ \t]{2,}/u.exec(raw);
  if (doubleSpace && doubleSpace.index !== undefined) {
    draft(context, {
      ruleId: "WHITESPACE",
      message: "译文存在连续空格",
      evidence: "target contains 2+ consecutive spaces/tabs",
      targetRange: { start: doubleSpace.index, end: doubleSpace.index + doubleSpace[0].length },
    });
  }
  const ideographic = raw.indexOf("\u3000");
  if (ideographic >= 0) {
    draft(context, {
      ruleId: "WHITESPACE",
      message: "译文含全角空格（U+3000）",
      evidence: "target contains ideographic space",
      targetRange: { start: ideographic, end: ideographic + 1 },
    });
  }
  const nbsp = raw.indexOf("\u00a0");
  if (nbsp >= 0) {
    draft(context, {
      ruleId: "WHITESPACE",
      message: "译文含不换行空格（U+00A0）",
      evidence: "target contains non-breaking space",
      targetRange: { start: nbsp, end: nbsp + 1 },
    });
  }
}

function checkFullwidthHalfwidth(context: SegmentContext): void {
  const target = context.target;
  if (target.trim().length === 0) return;
  const exempt = new Set(context.locale?.fullwidthExemptChars ?? []);
  const fullwidthPattern = /[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/gu;
  for (const match of target.matchAll(fullwidthPattern)) {
    const char = match[0];
    if (exempt.has(char)) continue;
    const index = match.index ?? 0;
    draft(context, {
      ruleId: "FULLWIDTH_HALFWIDTH",
      message: "译文中字母/数字使用全角形式",
      evidence: `found '${char}'`,
      suggestion: "字母与数字通常使用半角形式",
      targetRange: { start: index, end: index + 1 },
    });
    return;
  }
  const expectFullwidthPunctuation = context.locale?.fullwidthPunctuation ?? context.targetIsCjk;
  if (!expectFullwidthPunctuation) return;
  const mixed = /[\u4e00-\u9fff][,;:!?]|[,;:!?][\u4e00-\u9fff]/u.exec(target);
  if (mixed === null || mixed.index === undefined) return;
  draft(context, {
    ruleId: "FULLWIDTH_HALFWIDTH",
    message: "中文与半角标点混排",
    evidence: `found '${mixed[0]}'`,
    suggestion: "中文语境使用全角标点",
    targetRange: { start: mixed.index, end: mixed.index + mixed[0].length },
  });
}

function checkLengthRatio(context: SegmentContext): void {
  const sourceLength = charCount(context.source.trim());
  const targetLength = charCount(context.target.trim());
  if (sourceLength === 0 || targetLength === 0) return;
  const sourceIsCjk = isCjkHeavy(context.source);
  const targetIsCjk = context.targetIsCjk;
  let min = 0.4;
  let max = 2.5;
  if (targetIsCjk && !sourceIsCjk) {
    min = 0.15;
    max = 1.2;
  } else if (sourceIsCjk && !targetIsCjk) {
    min = 0.5;
    max = 3.0;
  } else if (sourceIsCjk && targetIsCjk) {
    min = 0.5;
    max = 2.0;
  }
  const ratio = targetLength / sourceLength;
  if (ratio >= min && ratio <= max) return;
  draft(context, {
    ruleId: "LENGTH_RATIO",
    message: `译文/源文长度比 ${ratio.toFixed(2)} 超出建议区间 [${min}, ${max}]`,
    evidence: `source length: ${sourceLength}, target length: ${targetLength}`,
    suggestion: "确认是否存在漏译或冗余（仅提示）",
  });
}

// ---------------------------------------------------------------------------
// Term rules (from options.segmentTermHits)
// ---------------------------------------------------------------------------

function isApproved(entry: GlossaryEntry): boolean {
  return entry.status === undefined || entry.status === "approved";
}

/** Longest source hits only: drop shorter hits fully covered by a longer hit. */
function longestHits(hits: readonly TermHit[]): TermHit[] {
  return hits.filter(
    (hit) =>
      !hits.some(
        (other) =>
          other !== hit &&
          other.start <= hit.start &&
          other.end >= hit.end &&
          other.end - other.start > hit.end - hit.start,
      ),
  );
}

function targetMentionsTerm(
  entry: GlossaryEntry,
  targetText: string,
  targetHits: readonly TermHit[],
): boolean {
  if (targetHits.some((hit) => hit.entry.id === entry.id)) return true;
  const expected = (entry.target ?? "").trim();
  if (expected.length === 0) return true;
  if (entry.caseSensitive === true) return targetText.includes(expected);
  return normalizeForCompare(targetText).includes(normalizeForCompare(expected));
}

function checkTermRules(context: SegmentContext): void {
  const termHits = context.termHits;
  if (termHits === undefined) return;
  const sourceHits = longestHits(termHits.source);
  const targetHits = termHits.target;
  const emittedTermIds = new Set<string>();

  for (const hit of sourceHits) {
    const entry = hit.entry;
    if (entry.forbidden === true) {
      draft(context, {
        ruleId: "TB_SOURCE_FORBIDDEN",
        message: `源文出现禁用术语: '${entry.source}'`,
        evidence: `source term: ${truncate(entry.source)}`,
        suggestion: "替换源文或确认术语库状态",
        sourceRange: { start: hit.start, end: hit.end },
        termId: entry.id,
      });
      emittedTermIds.add(`src:${entry.id}`);
      continue;
    }
    if (!isApproved(entry)) continue;
    if ((entry.target ?? "").trim().length === 0) continue;
    if (targetMentionsTerm(entry, context.target, targetHits)) continue;
    draft(context, {
      ruleId: "TERM_MISSING",
      message: `译文未使用 approved 术语 '${entry.source}' → '${entry.target}'`,
      evidence: `source term hit: ${truncate(entry.source)}`,
      suggestion: entry.target,
      sourceRange: { start: hit.start, end: hit.end },
      termId: entry.id,
    });
  }

  for (const entry of context.glossary.values()) {
    if (entry.forbidden !== true) continue;
    const expected = (entry.target ?? "").trim();
    if (expected.length === 0) continue;
    const targetHit = targetHits.find((hit) => hit.entry.id === entry.id);
    const mentioned =
      targetHit !== undefined ||
      (entry.caseSensitive === true
        ? context.target.includes(expected)
        : normalizeForCompare(context.target).includes(normalizeForCompare(expected)));
    if (!mentioned) continue;
    if (emittedTermIds.has(`tgt:${entry.id}`)) continue;
    draft(context, {
      ruleId: "TB_FORBIDDEN_USED",
      message: `译文使用了禁用术语: '${entry.source}' → '${entry.target}'`,
      evidence: `target term: ${truncate(entry.target)}`,
      ...(targetHit === undefined
        ? {}
        : { targetRange: { start: targetHit.start, end: targetHit.end } }),
      termId: entry.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Document-level rules (14 TERMINOLOGY_INCONSISTENT, 15 SOURCE_TARGET_INCONSISTENT)
// ---------------------------------------------------------------------------

interface DocDraft {
  segment: Segment;
  draft: IssueDraft;
}

function sourceKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Rule 15: identical source strings translated differently within one document.
 * The first target seen in document order is the reference; later divergences
 * are reported so reviewers can decide which variant wins.
 */
function sourceTargetInconsistencies(contexts: readonly SegmentContext[]): {
  drafts: DocDraft[];
  checkedSegments: number;
} {
  const groups = new Map<string, SegmentContext[]>();
  for (const context of contexts) {
    if (context.source.trim().length === 0 || context.target.trim().length === 0) continue;
    const key = sourceKey(context.source);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [context]);
    else group.push(context);
  }
  const drafts: DocDraft[] = [];
  let checkedSegments = 0;
  let emitted = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    checkedSegments += group.length;
    const targets = group.map((context) => normalizeForCompare(context.target));
    const variants = Array.from(new Set(targets));
    if (variants.length < 2) continue;
    const reference = variants[0];
    for (let index = 1; index < group.length && emitted < 50; index += 1) {
      if (targets[index] === reference) continue;
      const context = group[index];
      const segment = context?.segment;
      if (context === undefined || segment === undefined) continue;
      drafts.push({
        segment,
        draft: {
          ruleId: "SOURCE_TARGET_INCONSISTENT",
          message: `同一源文存在不同译法: '${truncate(context.source)}'`,
          evidence: `variants: [${variants.slice(0, 3).map((value) => truncate(value, 40)).join(" | ")}]`,
          suggestion: "统一该句段的译法",
        },
      });
      emitted += 1;
    }
  }
  return { drafts, checkedSegments };
}

/**
 * Rule 14: an approved glossary term is used consistently in some segments but
 * missing from others, i.e. the document mixes compliant and non-compliant use.
 */
function terminologyInconsistencies(contexts: readonly SegmentContext[]): {
  drafts: DocDraft[];
  checkedSegments: number;
} {
  const perTerm = new Map<string, { entry: GlossaryEntry; items: Array<{ context: SegmentContext; mentioned: boolean }> }>();
  let checkedSegments = 0;
  for (const context of contexts) {
    if (context.termHits === undefined || context.target.trim().length === 0) continue;
    const sourceHits = longestHits(context.termHits.source);
    if (sourceHits.length === 0) continue;
    checkedSegments += 1;
    for (const hit of sourceHits) {
      const entry = hit.entry;
      if (entry.forbidden === true || !isApproved(entry) || (entry.target ?? "").trim().length === 0) continue;
      const bucket = perTerm.get(entry.id) ?? { entry, items: [] };
      if (!bucket.items.some((item) => item.context === context)) {
        bucket.items.push({
          context,
          mentioned: targetMentionsTerm(entry, context.target, context.termHits.target),
        });
      }
      perTerm.set(entry.id, bucket);
    }
  }
  const drafts: DocDraft[] = [];
  let emitted = 0;
  for (const { entry, items } of perTerm.values()) {
    const mentioned = items.filter((item) => item.mentioned);
    const missing = items.filter((item) => !item.mentioned);
    if (mentioned.length === 0 || missing.length === 0) continue;
    for (const item of missing) {
      if (emitted >= 25) break;
      drafts.push({
        segment: item.context.segment,
        draft: {
          ruleId: "TERMINOLOGY_INCONSISTENT",
          message: `术语 '${entry.source}' → '${entry.target}' 在部分句段已使用、部分未使用（不一致）`,
          evidence: `used in ${mentioned.length} segment(s), missing in ${missing.length}`,
          suggestion: entry.target,
          termId: entry.id,
        },
      });
      emitted += 1;
    }
  }
  return { drafts, checkedSegments };
}

// ---------------------------------------------------------------------------
// Check groups (one check may emit several rule ids)
// ---------------------------------------------------------------------------

const CHECK_GROUPS: readonly CheckGroup[] = [
  { ids: ["EMPTY_TARGET"], run: checkEmptyTargetGroup },
  { ids: ["UNTRANSLATED_COPY"], run: checkUntranslatedCopyGroup },
  { ids: ["PLACEHOLDER_MISSING", "PLACEHOLDER_EXTRA"], run: checkPlaceholders },
  { ids: ["TAG_MISMATCH"], run: checkTags },
  { ids: ["URL_CHANGED"], run: checkUrls },
  { ids: ["TB_SOURCE_FORBIDDEN", "TB_FORBIDDEN_USED", "TERM_MISSING"], run: checkTermRules },
  { ids: ["UNPAIRED_BRACKET"], run: checkUnpairedBrackets },
  { ids: ["NUMBER_MISMATCH"], run: checkNumbers },
  { ids: ["DATE_MISMATCH"], run: checkDates },
  { ids: ["DATE_FORMAT"], run: checkDateFormat },
  { ids: ["DUPLICATE_WORD"], run: checkDuplicateWords },
  { ids: ["SOURCE_LEFTOVER"], run: checkSourceLeftover },
  { ids: ["PUNCT_DUP"], run: checkPunctDup },
  { ids: ["TRAILING_COLON"], run: checkTrailingColon },
  { ids: ["SENTENCE_END_PUNCT"], run: checkSentenceEndPunct },
  { ids: ["WHITESPACE"], run: checkWhitespace },
  { ids: ["FULLWIDTH_HALFWIDTH"], run: checkFullwidthHalfwidth },
  { ids: ["LENGTH_RATIO"], run: checkLengthRatio },
];

function checkEmptyTargetGroup(context: SegmentContext): void {
  const source = context.source;
  if (source.trim().length === 0) return;
  const targetMissing =
    context.segment.targetRange === null &&
    context.target.trim().length === 0 &&
    context.targetInner.trim().length === 0;
  const empty = context.target.trim().length === 0 && context.targetInner.trim().length === 0;
  const targetPlaceholders = collectPlaceholders(context.target);
  const hasVisibleBody = /[\p{L}\p{N}]/u.test(maskSpans(source, collectPlaceholders(source)));
  const missingBody = hasVisibleBody && (context.target.trim() === "" ||
    (targetPlaceholders.length > 0 && !/[\p{L}\p{N}]/u.test(maskSpans(context.target, targetPlaceholders))));
  if (!targetMissing && !empty && !missingBody) return;
  draft(context, {
    ruleId: "EMPTY_TARGET",
    message: targetMissing ? "目标缺失（target 元素不存在）"
      : empty ? "译文为空（源文非空）" : "译文缺少正文",
    evidence: `source: ${truncate(source)}`,
  });
}

function checkUntranslatedCopyGroup(context: SegmentContext): void {
  const { source, target } = context;
  if (source.trim().length === 0 || target.trim().length === 0) return;
  const normalizedSource = normalizeForCompare(source);
  if (normalizedSource !== normalizeForCompare(target)) return;
  const policy = context.untranslatedCopy;
  if (policy?.whitelist?.some((entry) => normalizeForCompare(entry) === normalizedSource)) return;
  if (policy?.ignoreIdentifiers && /^(?=.*[0-9])[a-z0-9][a-z0-9._/+:%-]*$/u.test(normalizedSource)) return;
  const tokens = wordTokens(source);
  const cjkChars = Array.from(source).filter((char) => CJK_RE.test(char)).length;
  const maxShort = policy?.shortSegmentMaxLength ?? 4;
  if (tokens.length <= 1 && cjkChars < 2 && source.trim().length <= maxShort) return;
  if (
    tokens.length <= 1 &&
    policy?.singleTokenExemptions?.some((entry) => normalizeForCompare(entry) === normalizedSource)
  ) {
    return;
  }
  draft(context, {
    ruleId: "UNTRANSLATED_COPY",
    message: "译文与源文完全相同（未翻译）",
    evidence: `text: ${truncate(source)}`,
    targetRange: { start: 0, end: charCount(target) },
  });
}

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

function isApplicable(ruleId: string, segment: Segment): boolean {
  const hasSource = segment.sourceText.trim().length > 0;
  const hasTargetText = segment.targetText.trim().length > 0;
  const hasTargetContainer = segment.targetRange !== null;
  switch (ruleId) {
    case "EMPTY_TARGET":
      return hasSource;
    case "TAG_MISMATCH":
      return hasSource && (hasTargetText || hasTargetContainer);
    case "WHITESPACE":
      return hasTargetContainer || segment.targetInner.length > 0;
    case "UNTRANSLATED_COPY":
    case "PLACEHOLDER_MISSING":
    case "PLACEHOLDER_EXTRA":
    case "URL_CHANGED":
    case "TB_SOURCE_FORBIDDEN":
    case "TB_FORBIDDEN_USED":
    case "UNPAIRED_BRACKET":
    case "NUMBER_MISMATCH":
    case "DATE_MISMATCH":
    case "DATE_FORMAT":
    case "DUPLICATE_WORD":
    case "TERM_MISSING":
    case "SOURCE_LEFTOVER":
    case "PUNCT_DUP":
    case "TRAILING_COLON":
    case "SENTENCE_END_PUNCT":
    case "FULLWIDTH_HALFWIDTH":
    case "LENGTH_RATIO":
      return hasSource && hasTargetText;
    default:
      return hasSource && hasTargetText;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function termAssetAvailable(options: QaCheckOptions): boolean {
  if (options.segmentTermHits !== undefined && options.segmentTermHits.size > 0) return true;
  return options.glossary !== undefined && options.glossary.length > 0;
}

function resolveEnabledRules(options: QaCheckOptions): Set<string> {
  if (options.enabledRules !== undefined) {
    const enabled = new Set<string>();
    for (const ruleId of options.enabledRules) {
      if (RULE_INDEX.has(ruleId)) enabled.add(ruleId);
    }
    return enabled;
  }
  const enabled = new Set(DEFAULT_ENABLED);
  if (options.locale?.targetLocale === undefined) for (const ruleId of LOCALE_RULE_IDS) enabled.delete(ruleId);
  if (!termAssetAvailable(options)) for (const ruleId of TERM_RULE_IDS) enabled.delete(ruleId);
  return enabled;
}

function termGlossary(options: QaCheckOptions): Map<string, GlossaryEntry> {
  const entries = new Map<string, GlossaryEntry>();
  for (const entry of options.glossary ?? []) entries.set(entry.id, entry);
  for (const hits of options.segmentTermHits?.values() ?? []) {
    for (const hit of [...hits.source, ...hits.target]) {
      if (!entries.has(hit.entry.id)) entries.set(hit.entry.id, hit.entry);
    }
  }
  return entries;
}

function buildContext(
  segment: Segment,
  options: QaCheckOptions,
  glossary: Map<string, GlossaryEntry>,
): SegmentContext {
  const termHits = options.segmentTermHits?.get(segment.id);
  return {
    segment,
    source: segment.sourceText,
    target: segment.targetText,
    sourceInner: segment.sourceInner,
    targetInner: segment.targetInner,
    targetIsCjk: isCjkHeavy(segment.targetText),
    glossary,
    drafts: [],
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.untranslatedCopy === undefined ? {} : { untranslatedCopy: options.untranslatedCopy }),
    ...(termHits === undefined ? {} : { termHits }),
  };
}

function toIssue(draft: IssueDraft, segment: Segment, ruleId: string): QaIssue {
  return {
    ruleId,
    severity: RULE_SEVERITY.get(ruleId) ?? "major",
    segmentId: segment.id,
    segmentIndex: segment.index,
    message: draft.message,
    evidence: draft.evidence,
    ...(draft.suggestion === undefined ? {} : { suggestion: draft.suggestion }),
    ...(draft.sourceRange === undefined ? {} : { sourceRange: draft.sourceRange }),
    ...(draft.targetRange === undefined ? {} : { targetRange: draft.targetRange }),
    origin: "deterministic",
    ...(draft.termId === undefined ? {} : { termId: draft.termId }),
  };
}

function compareIssues(left: QaIssue, right: QaIssue): number {
  const leftRule = RULE_INDEX.get(left.ruleId) ?? Number.MAX_SAFE_INTEGER;
  const rightRule = RULE_INDEX.get(right.ruleId) ?? Number.MAX_SAFE_INTEGER;
  if (leftRule !== rightRule) return leftRule - rightRule;
  if (left.segmentIndex !== right.segmentIndex) return left.segmentIndex - right.segmentIndex;
  if (left.segmentId !== right.segmentId) return left.segmentId < right.segmentId ? -1 : 1;
  const leftStart = left.targetRange?.start ?? left.sourceRange?.start ?? 0;
  const rightStart = right.targetRange?.start ?? right.sourceRange?.start ?? 0;
  return leftStart - rightStart;
}

interface RuleExecutionState {
  status: QaRuleExecution["status"];
  reason: string;
  checkedSegments: number;
}

/**
 * Run every enabled deterministic rule over the segments.
 */
export function runDeterministicChecks(
  segments: readonly Segment[],
  options: QaCheckOptions = {},
): QaResult {
  const enabled = resolveEnabledRules(options);
  const termAvailable = termAssetAvailable(options);
  const glossary = termGlossary(options);

  const state = new Map<string, RuleExecutionState>();
  for (const rule of RULES) {
    if (!enabled.has(rule.id)) continue;
    if (rule.requiresLocale === true && options.locale?.targetLocale === undefined) {
      state.set(rule.id, {
        status: "skipped",
        reason: "no locale.targetLocale provided; locale rule was not executed",
        checkedSegments: 0,
      });
      continue;
    }
    if (rule.requiresTerms === true && !termAvailable) {
      state.set(rule.id, {
        status: "skipped",
        reason: "no glossary/segmentTermHits provided; term rules were not executed",
        checkedSegments: 0,
      });
      continue;
    }
    state.set(rule.id, { status: "executed", reason: "", checkedSegments: 0 });
  }

  const issues: QaIssue[] = [];

  for (const segment of segments) {
    const context = buildContext(segment, options, glossary);
    const applicable = new Set<string>();
    for (const ruleId of enabled) {
      if (state.get(ruleId)?.status !== "executed") continue;
      if (DOCUMENT_RULE_IDS.has(ruleId)) continue;
      if (isApplicable(ruleId, segment)) applicable.add(ruleId);
    }
    if (applicable.size === 0) continue;

    const groupsRun = new Set<string>();
    const failedRules = new Set<string>();
    for (const group of CHECK_GROUPS) {
      const groupRules = group.ids.filter((ruleId) => applicable.has(ruleId));
      if (groupRules.length === 0) continue;
      // A check can appear in several groups (term rules); run once per segment.
      const key = group.ids.join("|");
      if (groupsRun.has(key)) continue;
      groupsRun.add(key);
      try {
        group.run(context);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        for (const ruleId of groupRules) failedRules.add(`${ruleId}\u0000${message}`);
      }
    }

    for (const ruleId of applicable) {
      const execution = state.get(ruleId);
      if (execution === undefined) continue;
      const failed = Array.from(failedRules).some((entry) => entry.startsWith(`${ruleId}\u0000`));
      if (failed) {
        const message = Array.from(failedRules)
          .find((entry) => entry.startsWith(`${ruleId}\u0000`))
          ?.split("\u0000")[1] ?? "rule threw";
        state.set(ruleId, {
          status: "failed",
          reason: `rule threw: ${message}`,
          checkedSegments: execution.checkedSegments,
        });
        continue;
      }
      execution.checkedSegments += 1;
    }

    for (const draft of context.drafts) {
      if (!applicable.has(draft.ruleId)) continue;
      issues.push(toIssue(draft, segment, draft.ruleId));
    }
  }

  const documentRules = RULES.filter(
    (rule) => rule.scope === "document" && state.get(rule.id)?.status === "executed",
  );
  if (documentRules.length > 0) {
    const contexts = segments.map((segment) => buildContext(segment, options, glossary));
    for (const rule of documentRules) {
      const result =
        rule.id === "TERMINOLOGY_INCONSISTENT"
          ? terminologyInconsistencies(contexts)
          : sourceTargetInconsistencies(contexts);
      for (const item of result.drafts) issues.push(toIssue(item.draft, item.segment, rule.id));
      const execution = state.get(rule.id);
      if (execution !== undefined) execution.checkedSegments = result.checkedSegments;
    }
  }

  const rules: QaRuleExecution[] = [];
  for (const rule of RULES) {
    const execution = state.get(rule.id);
    if (execution === undefined) continue;
    const status: QaRuleExecution["status"] =
      execution.status === "executed" && execution.checkedSegments === 0
        ? "not_applicable"
        : execution.status;
    rules.push({
      ruleId: rule.id,
      status,
      reason: status === "not_applicable" ? "no applicable segments" : execution.reason,
      checkedSegments: execution.checkedSegments,
    });
  }

  issues.sort(compareIssues);

  const coverageIncomplete = rules.some((rule) => rule.status === "skipped" || rule.status === "failed");
  const anyExecuted = rules.some(
    (rule) => rule.status === "executed" || rule.status === "not_applicable",
  );
  const checkedSegments = anyExecuted ? segments.length : 0;

  return {
    issues,
    totalSegments: segments.length,
    checkedSegments,
    coverage: coverageIncomplete ? "incomplete" : "complete",
    rules,
  };
}


function unmatched<T>(own: T[], other: T[], key: (token: T) => string): T[] {
  const available = multiset(other.map(key));
  return own.filter((token) => {
    const id = key(token);
    const count = available.get(id) ?? 0;
    if (count === 0) return true;
    available.set(id, count - 1);
    return false;
  });
}

/** Translate a QA text range to the raw XML displayed in a tagged segment. */
function displayedTextSpans(segment: Segment, side: "source" | "target", spans: readonly Span[]): Span[] {
  const node = side === "source" ? segment.sourceNode : segment.targetNode;
  const tags = side === "source" ? segment.sourceTags : segment.targetTags;
  if (!node || tags.length === 0 || spans.length === 0) return [...spans];
  const result: Span[] = [];
  let textOffset = 0;
  inlineText(node, (text, part) => {
    const partEnd = textOffset + text.length;
    for (const span of spans) {
      const start = Math.max(span.start, textOffset) - textOffset;
      const end = Math.min(span.end, partEnd) - textOffset;
      if (start >= end) continue;
      const base = part.start - node.innerStart;
      if (part.type === "element") {
        result.push({ start: base, end: part.end - node.innerStart });
      } else {
        let delta = 0;
        let rawStart = start;
        let rawEnd = end;
        if (!part.cdata) {
          for (const entity of part.text.matchAll(/&(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gu)) {
            const entityStart = entity.index - delta;
            const length = decodeXmlEntities(entity[0]).length;
            const extra = entity[0].length - length;
            if (entityStart + length <= start) rawStart += extra;
            else if (entityStart < start) rawStart = entity.index;
            if (entityStart < end) rawEnd = Math.max(rawEnd + extra, entity.index + entity[0].length);
            delta += extra;
          }
        }
        result.push({ start: base + rawStart, end: base + rawEnd });
      }
    }
    textOffset = partEnd;
  });
  return result;
}

/** Report-only positions for confirmed rule hits, in the text shown to the reviewer. */
export function reviewIssueHighlights(segment: Segment, issue: QaIssue): { source?: Span[]; target?: Span[] } {
  switch (issue.ruleId) {
    case "TAG_MISMATCH": {
      const source = segment.sourceNode ? inlineCodeLocations(segment.sourceNode) : [];
      const target = segment.targetNode ? inlineCodeLocations(segment.targetNode) : [];
      const sourceOnly = unmatched(source, target, (token) => token.key);
      const targetOnly = unmatched(target, source, (token) => token.key);
      if (sourceOnly.length || targetOnly.length) return { source: sourceOnly, target: targetOnly };
      return {
        source: source.filter((token, index) => token.key !== target[index]?.key),
        target: target.filter((token, index) => token.key !== source[index]?.key),
      };
    }
    case "PLACEHOLDER_MISSING":
    case "PLACEHOLDER_EXTRA": {
      const source = collectPlaceholders(segment.sourceInner);
      const target = collectPlaceholders(segment.targetInner);
      const side = issue.ruleId === "PLACEHOLDER_MISSING" ? "source" : "target";
      const tokens = side === "source" ? unmatched(source, target, (token) => token.text)
        : unmatched(target, source, (token) => token.text);
      const display = side === "source"
        ? segment.sourceTags.length ? segment.sourceInner : segment.sourceText
        : segment.targetTags.length ? segment.targetInner : segment.targetText;
      const inner = side === "source" ? segment.sourceInner : segment.targetInner;
      if (display === inner) return { [side]: tokens };
      // Match decoded tokens when an entity before the placeholder changed its display offset.
      const remaining = multiset(tokens.map((token) => decodeXmlEntities(token.text)));
      return { [side]: collectPlaceholders(display).reverse().filter(({ text }) => {
        const count = remaining.get(text) ?? 0;
        if (!count) return false;
        remaining.set(text, count - 1);
        return true;
      }) };
    }
    case "NUMBER_MISMATCH": {
      const source = extractNumbers(segment.sourceText);
      const target = extractNumbers(segment.targetText);
      return {
        source: displayedTextSpans(segment, "source", unmatched(source, target, (token) => token.key)),
        target: displayedTextSpans(segment, "target", unmatched(target, source, (token) => token.key)),
      };
    }
    case "DATE_MISMATCH": {
      const source = extractDates(segment.sourceText);
      const target = extractDates(segment.targetText);
      return {
        source: displayedTextSpans(segment, "source", unmatched(source, target, (token) => token.key).map((token) => token.span)),
        target: displayedTextSpans(segment, "target", unmatched(target, source, (token) => token.key).map((token) => token.span)),
      };
    }
    case "UNPAIRED_BRACKET":
      return { target: displayedTextSpans(segment, "target", unpairedTokens(segment.targetText)
        .slice(0, 5).map(({ index }) => ({ start: index, end: index + 1 }))) };
    case "PUNCT_DUP":
      return issue.targetRange ? { target: displayedTextSpans(segment, "target", [issue.targetRange]) } : {};
    default:
      return {};
  }
}
