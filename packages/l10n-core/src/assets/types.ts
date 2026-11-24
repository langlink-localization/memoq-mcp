/** Shared asset and matching contracts for Phase 1a. */

export interface TmContext {
  previousSource?: string;
  nextSource?: string;
}

export interface TmEntry {
  id: string;
  source: string;
  target: string;
  sourceLanguage: string;
  targetLanguage: string;
  context?: TmContext;
  origin?: "tm" | "alignment" | "livedocs";
  fuzzy?: boolean;
  lastModified?: string;
  properties?: Record<string, string>;
}

export interface TmParseResult {
  entries: TmEntry[];
  warnings: string[];
}

export interface TmMatchOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  /** Minimum matchRate to return; default 50. */
  threshold?: number;
  /** Maximum matches; default 3. */
  maxMatches?: number;
  context?: TmContext;
}

export type TmMatchType =
  | "context"
  | "double_context"
  | "exact"
  | "near_exact"
  | "high_fuzzy"
  | "medium_fuzzy"
  | "low_fuzzy"
  | "no_match";

export type TmPenaltyKind =
  | "number"
  | "tag_id"
  | "tag_count"
  | "punctuation"
  | "fuzzy"
  | "unaligned"
  | "foreign";

export interface TmPenalty {
  kind: TmPenaltyKind;
  points: number;
  detail?: string;
}

export interface TmMatch {
  entry: TmEntry;
  /** Continuous text similarity 0..100 (no penalties). */
  similarity: number;
  /** Industry-style match rate: 0 or 50..102. */
  matchRate: number;
  matchType: TmMatchType;
  penalties: TmPenalty[];
  contextMatched: boolean;
  flags: {
    numberDiff: boolean;
    tagDiff: boolean;
    punctDiff: boolean;
    truncated: boolean;
  };
}

export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  forbidden?: boolean;
  caseSensitive?: boolean;
  matching?: "exact" | "prefix50" | "fuzzy" | "custom";
  priority?: number;
  status?: "approved" | "rejected" | "tbd";
}

export interface GlossaryParseResult {
  entries: GlossaryEntry[];
  warnings: string[];
}

export interface TermMatchOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  /** Enable fuzzy term matching; default false. */
  fuzzy?: boolean;
}

export interface TermHit {
  entry: GlossaryEntry;
  start: number;
  end: number;
  matchKind: "exact" | "prefix50" | "fuzzy" | "custom";
  caseMatch: "exact" | "case_only_diff";
}

export interface TermCheckIssue {
  rule: "TB_FORBIDDEN_USED" | "TB_SOURCE_FORBIDDEN" | "TB_TERM_MISSING";
  termId: string;
  severity: "critical" | "major";
  message: string;
  start?: number;
  end?: number;
}

export interface TermMatchResult {
  hits: TermHit[];
  issues: TermCheckIssue[];
  warnings: string[];
}
