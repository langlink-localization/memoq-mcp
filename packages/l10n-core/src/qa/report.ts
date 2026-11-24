/**
 * QA report renderers (Phase 1a).
 *
 * Both renderers are pure and deterministic: same `QaResult` => identical
 * string. Column order is a fixed contract (see docs/spec.md §6.3 and
 * docs/spec.md §6.4 fixed-column convention).
 */

import type { QaIssue, QaResult } from "./types.ts";

/** Keep tool previews bounded while retaining the full report for export. */
export function pageQaIssues(
  issues: readonly QaIssue[],
  issueOffset: number,
  limit: number,
) {
  const firstIssues: Array<QaIssue & { textTruncated?: true }> = [];
  let chars = 0;
  for (const issue of issues.slice(issueOffset, issueOffset + limit)) {
    const item: typeof firstIssues[number] = { ...issue };
    for (const key of ["message", "evidence", "suggestion"] as const) {
      const value = item[key];
      if (value !== undefined && value.length > 400) {
        item[key] = value.slice(0, 399) + "…";
        item.textTruncated = true;
      }
    }
    const length = JSON.stringify(item).length + 1;
    if (firstIssues.length && chars + length > 12_000) break;
    firstIssues.push(item);
    chars += length;
  }
  const next = issueOffset + firstIssues.length;
  return { issueOffset, firstIssues, nextIssueOffset: next < issues.length ? next : null };
}

/** Fixed CSV columns, in order. */
export const QA_CSV_COLUMNS = [
  "rule_id",
  "severity",
  "segment_id",
  "segment_index",
  "message",
  "evidence",
  "suggestion",
  "source_start",
  "source_end",
  "target_start",
  "target_end",
  "term_id",
  "origin",
] as const;

export type QaCsvColumn = (typeof QA_CSV_COLUMNS)[number];

function rangeStart(range: { start: number; end: number } | undefined): string {
  return range === undefined ? "" : String(range.start);
}

function rangeEnd(range: { start: number; end: number } | undefined): string {
  return range === undefined ? "" : String(range.end);
}

function issueToRow(issue: QaIssue): Record<QaCsvColumn, string> {
  return {
    rule_id: issue.ruleId,
    severity: issue.severity,
    segment_id: issue.segmentId,
    segment_index: String(issue.segmentIndex),
    message: issue.message,
    evidence: issue.evidence,
    suggestion: issue.suggestion ?? "",
    source_start: rangeStart(issue.sourceRange),
    source_end: rangeEnd(issue.sourceRange),
    target_start: rangeStart(issue.targetRange),
    target_end: rangeEnd(issue.targetRange),
    term_id: issue.termId ?? "",
    origin: issue.origin,
  };
}

/** RFC 4180 field escaping: quote when the value contains , " CR or LF. */
export function escapeCsvField(value: string): string {
  if (!/[",\r\n]/u.test(value)) return value;
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

/**
 * Render the QA result as CSV with a fixed header row and a trailing newline.
 * One data row per issue; an issue-free result renders only the header.
 */
export function renderCsv(result: QaResult): string {
  const lines: string[] = [QA_CSV_COLUMNS.join(",")];
  for (const issue of result.issues) {
    const row = issueToRow(issue);
    lines.push(QA_CSV_COLUMNS.map((column) => escapeCsvField(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render the QA result as stable, pretty-printed JSON (no trailing newline).
 * Objects are emitted with a fixed key order so diffs across runs are stable.
 */
export function renderJson(result: QaResult, options?: { tool?: { name: string; version: string } }): string {
  const issues = result.issues.map((issue) => ({
    ruleId: issue.ruleId,
    severity: issue.severity,
    segmentId: issue.segmentId,
    segmentIndex: issue.segmentIndex,
    message: issue.message,
    evidence: issue.evidence,
    ...(issue.suggestion === undefined ? {} : { suggestion: issue.suggestion }),
    ...(issue.sourceRange === undefined
      ? {}
      : { sourceRange: { start: issue.sourceRange.start, end: issue.sourceRange.end } }),
    ...(issue.targetRange === undefined
      ? {}
      : { targetRange: { start: issue.targetRange.start, end: issue.targetRange.end } }),
    ...(issue.termId === undefined ? {} : { termId: issue.termId }),
    origin: issue.origin,
  }));
  return JSON.stringify(
    {
      ...(options?.tool ? { tool: options.tool } : {}),
      totalSegments: result.totalSegments,
      checkedSegments: result.checkedSegments,
      coverage: result.coverage,
      issueCount: issues.length,
      issues,
      rules: result.rules.map((rule) => ({
        ruleId: rule.ruleId,
        status: rule.status,
        reason: rule.reason,
        checkedSegments: rule.checkedSegments,
      })),
    },
    null,
    2,
  );
}
