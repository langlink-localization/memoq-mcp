import type { GlossaryEntry, TermHit } from "../assets/types.ts";

export type QaSeverity = "critical" | "major" | "minor" | "neutral";

export interface QaIssue {
  ruleId: string;
  severity: QaSeverity;
  segmentId: string;
  segmentIndex: number;
  message: string;
  evidence: string;
  suggestion?: string;
  sourceRange?: { start: number; end: number };
  targetRange?: { start: number; end: number };
  origin: "deterministic" | "semantic";
  termId?: string;
}

export interface QaRuleExecution {
  ruleId: string;
  status: "executed" | "skipped" | "not_applicable" | "failed";
  reason: string;
  checkedSegments: number;
}

export interface QaTermHits {
  source: TermHit[];
  target: TermHit[];
}

export interface QaUntranslatedCopyOptions {
  /** Source texts treated as intentionally identical (normalized compare), e.g. brand or product names. */
  whitelist?: readonly string[];
  /** Source length at or below which a single-token segment is exempt; default 4 (spec Phase 1a). */
  shortSegmentMaxLength?: number;
  /** Extra single tokens treated as exempt (normalized compare), e.g. units or codes. */
  singleTokenExemptions?: readonly string[];
  /** Exempt numeric values and identifier-shaped tokens with digits. */
  ignoreIdentifiers?: boolean;
}

export interface QaLocaleOptions {
  /** Target locale hint (e.g. "zh-CN", "ja-JP"); callers can record locale context alongside the rule options. */
  targetLocale?: string;
  /** Force the fullwidth-punctuation expectation instead of inferring it from target script. */
  fullwidthPunctuation?: boolean;
  /** Characters exempt from FULLWIDTH_HALFWIDTH, e.g. intentionally fullwidth brand glyphs. */
  fullwidthExemptChars?: readonly string[];
}

export interface QaCheckOptions {
  glossary?: readonly GlossaryEntry[];
  /** Term hits keyed by segment id; workflows build this once per document. */
  segmentTermHits?: ReadonlyMap<string, QaTermHits>;
  enabledRules?: readonly string[];
  /** UNTRANSLATED_COPY whitelist and short-segment policy (spec Phase 1a 余项). */
  untranslatedCopy?: QaUntranslatedCopyOptions;
  /** Locale-aware refinements for language-variant rules (spec Phase 1a 余项). */
  locale?: QaLocaleOptions;
}

export interface QaResult {
  issues: QaIssue[];
  totalSegments: number;
  checkedSegments: number;
  coverage: "complete" | "incomplete";
  rules: QaRuleExecution[];
}
