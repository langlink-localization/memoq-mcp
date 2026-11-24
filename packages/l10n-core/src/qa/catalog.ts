import type { QaSeverity } from "./types.ts";

interface RuleSpec {
  id: string;
  /** Severity used by this rule when it emits an issue. */
  severity: QaSeverity;
  /** Requires glossary/segmentTermHits; reported skipped when absent. */
  requiresTerms?: boolean;
  /** Advisory rule, disabled by default per spec ("默认关闭/仅提示"). */
  defaultOff?: boolean;
  /** Document-level rule: evaluated once over all segments instead of per segment. */
  scope?: "document";
  /** Disabled unless locale.targetLocale is provided; explicit enable without locale is reported skipped. */
  requiresLocale?: boolean;
}

export const RULES: readonly RuleSpec[] = [
  // structural class
  { id: "EMPTY_TARGET", severity: "critical" },
  { id: "UNTRANSLATED_COPY", severity: "critical" },
  { id: "PLACEHOLDER_MISSING", severity: "critical" },
  { id: "PLACEHOLDER_EXTRA", severity: "critical" },
  { id: "TAG_MISMATCH", severity: "critical" },
  { id: "URL_CHANGED", severity: "critical" },
  { id: "TB_SOURCE_FORBIDDEN", severity: "major", requiresTerms: true },
  { id: "TB_FORBIDDEN_USED", severity: "critical", requiresTerms: true },
  { id: "UNPAIRED_BRACKET", severity: "major" },
  // content class
  { id: "NUMBER_MISMATCH", severity: "major" },
  { id: "DATE_MISMATCH", severity: "major" },
  { id: "DATE_FORMAT", severity: "minor", requiresLocale: true },
  { id: "DUPLICATE_WORD", severity: "major" },
  { id: "TERM_MISSING", severity: "major", requiresTerms: true },
  { id: "TERMINOLOGY_INCONSISTENT", severity: "major", requiresTerms: true, scope: "document" },
  { id: "SOURCE_TARGET_INCONSISTENT", severity: "major", scope: "document" },
  { id: "SOURCE_LEFTOVER", severity: "major" },
  { id: "PUNCT_DUP", severity: "major" },
  { id: "TRAILING_COLON", severity: "minor" },
  // language variant / style class
  { id: "SENTENCE_END_PUNCT", severity: "minor" },
  { id: "WHITESPACE", severity: "minor" },
  { id: "FULLWIDTH_HALFWIDTH", severity: "minor" },
  { id: "LENGTH_RATIO", severity: "neutral", defaultOff: true },
];

/** Append-only codes belong to the engine registry, never to result/UI ordering. */
export const QA_RULE_CATALOG = Object.freeze(RULES.map((rule, index) => Object.freeze({
  ruleId: rule.id,
  code: `QA-${String(index + 1).padStart(3, "0")}`,
  severity: rule.severity,
  defaultEnabled: rule.defaultOff !== true,
  scope: rule.scope ?? "segment",
  requiresTerms: rule.requiresTerms === true,
  requiresLocale: rule.requiresLocale === true,
})));

