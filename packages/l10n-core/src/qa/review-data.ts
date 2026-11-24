import { unzipSync } from "fflate";
import corePackage from "../../package.json" with { type: "json" };
import { parseXliff } from "../formats/xliff12.ts";
import type { Document, Segment } from "../model.ts";
import { checkDocument } from "../workflows/check.ts";
import { reviewIssueHighlights } from "./rules.ts";

export interface ReviewToolInfo {
  name: string;
  version: string;
}

export const DEFAULT_REVIEW_TOOL: ReviewToolInfo = {
  name: corePackage.name,
  version: corePackage.version,
};

export function sanitizeReviewTool(value: unknown): ReviewToolInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const version = typeof candidate.version === "string" ? candidate.version.trim() : "";
  if (!name || !version || name.length > 120 || version.length > 120) return undefined;
  if (/[\r\n\u0000-\u001f\u007f]/u.test(name) || /[\r\n\u0000-\u001f\u007f]/u.test(version)) return undefined;
  return { name, version };
}

export function formatReviewTool(tool?: ReviewToolInfo): string {
  return tool?.name && tool?.version ? `${tool.name}@${tool.version}` : "";
}

export const REVIEW_GROUPS = [
  { label: "标点与空格", rules: ["UNPAIRED_BRACKET", "PUNCT_DUP", "WHITESPACE"] },
  { label: "Tag 与变量", rules: ["TAG_MISMATCH", "PLACEHOLDER_MISSING", "PLACEHOLDER_EXTRA"] },
  { label: "数字与日期", rules: ["NUMBER_MISMATCH", "DATE_MISMATCH"] },
  { label: "空译与正文缺失", rules: ["EMPTY_TARGET"] },
  { label: "原译相同", rules: ["UNTRANSLATED_COPY"] },
] as const;

export const REVIEW_FILE_BYTES = 12 * 1024 * 1024;
export const REVIEW_TOTAL_BYTES = 36 * 1024 * 1024;
export const REVIEW_FILE_LIMIT = 20;
const FILE_EXTENSION = /\.(?:xlf|xliff|sdlxliff|mqxliff|mqxlz)$/iu;
const categories = new Map<string, string>(
  REVIEW_GROUPS.flatMap((group) => group.rules.map((rule) => [rule, group.label] as const)),
);

export const REVIEW_COLUMNS = {
  file: "文件",
  segment: "段号",
  source: "原文",
  target: "译文",
  category: "分类",
  severity: "严重程度",
  rule: "检查项",
  message: "问题",
  evidence: "依据",
} as const;

export type ReviewSpan = { start: number; end: number };
export type ReviewRow = Record<keyof typeof REVIEW_COLUMNS, string> & {
  segmentKey?: string;
  aiqaSummary?: string;
  highlights?: { source?: ReviewSpan[]; target?: ReviewSpan[] };
};

export type ReviewSegment = Pick<ReviewRow, "file" | "segment" | "source" | "target"> & { segmentKey: string };

export interface ReviewReport {
  rows: ReviewRow[];
  files: Array<{ name: string; segments: number; incomplete: boolean; error?: string }>;
  segments?: ReviewSegment[];
  configuration?: { checks: string[]; aiqa: boolean };
  tool?: ReviewToolInfo;
  aiqa?: {
    totalSegments: number;
    completedSegments: number;
    autoPass: number;
    humanReview: number;
    unavailable: number;
    pending: number;
  };
}

export interface ReviewDocument {
  document: Document;
  keyPrefix: string;
}

type CustomRule = {
  name: string;
  sourceContains: string;
  kind: "required" | "forbidden" | "maxLength";
  value: string;
};

export interface ReviewOptions {
  rules: string[];
  identicalWhitelist: string[];
  customRules: CustomRule[];
}

export function reviewOptions(value: unknown, allowNoFixedChecks = false): ReviewOptions {
  if (typeof value !== "object" || value === null) throw new Error("检查设置无效。");
  const { rules, identicalWhitelist, customRules } = value as Record<string, unknown>;
  if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string" || !categories.has(rule))) {
    throw new Error("检查设置包含未知规则。");
  }
  if (!Array.isArray(identicalWhitelist) || identicalWhitelist.length > 100 ||
      identicalWhitelist.some((term) => typeof term !== "string" || term.length > 300)) {
    throw new Error("原译相同放行名单最多 100 条，每条不超过 300 字。");
  }
  if (!Array.isArray(customRules) || customRules.length > 20) throw new Error("最多添加 20 条自定义检查。");
  for (const rule of customRules) {
    if (typeof rule !== "object" || rule === null || typeof rule.name !== "string" || !rule.name.trim() ||
        rule.name.length > 80 || typeof rule.sourceContains !== "string" || rule.sourceContains.length > 300 ||
        typeof rule.value !== "string" || !rule.value.trim() || rule.value.length > 300 ||
        !["required", "forbidden", "maxLength"].includes(rule.kind) ||
        (rule.kind === "maxLength" && !/^[1-9]\d{0,4}$/u.test(rule.value))) {
      throw new Error("请检查自定义项的名称、检测类型和匹配值。长度上限须为正整数。");
    }
  }
  if (!allowNoFixedChecks && rules.length === 0 && customRules.length === 0) throw new Error("请选择至少一项检查。");
  return { rules, identicalWhitelist, customRules };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readReviewFile(file: File): Promise<Array<{ label: string; document: Document }>> {
  const name = file.name;
  if (!FILE_EXTENSION.test(name)) throw new Error("请选择 XLIFF、SDLXLIFF、MQXLIFF 或 MQXLZ 文件。");
  if (file.size > REVIEW_FILE_BYTES) throw new Error("文件超过 12 MB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!name.toLowerCase().endsWith(".mqxlz")) {
    return [{ label: name, document: parseXliff(decoder.decode(bytes), { filename: name }) }];
  }
  let size = 0;
  const entries = unzipSync(bytes, {
    filter(entry) {
      if (!entry.name.toLowerCase().endsWith(".mqxliff")) return false;
      size += entry.originalSize;
      if (size > REVIEW_FILE_BYTES) throw new Error("MQXLZ 中的双语内容解压后超过 12 MB。");
      return true;
    },
  });
  if (Object.keys(entries).length === 0) throw new Error("MQXLZ 中未找到 MQXLIFF 文件。");
  return Object.entries(entries).map(([filename, content]) => ({
    label: `${name} / ${filename}`,
    document: parseXliff(decoder.decode(content), { filename }),
  }));
}

export function segmentLocation(file: string, document: Document, segment: Segment, prefix: string): ReviewSegment {
  const { fileIndex, unitId, mid } = segment.location;
  return {
    segmentKey: `${prefix}:${segment.index}`,
    file: document.files.length === 1 ? file : `${file} / 文档 ${fileIndex + 1}`,
    segment: mid === undefined || mid === unitId ? unitId : `${unitId}/${mid}`,
    source: segment.sourceTags.length ? segment.sourceInner : segment.sourceText,
    target: segment.targetTags.length ? segment.targetInner : segment.targetText,
  };
}

export function customFinding(rule: CustomRule, segment: Segment): string | undefined {
  if (!segment.sourceText.trim() || !segment.targetText.trim() ||
      !segment.sourceText.includes(rule.sourceContains)) return undefined;
  const length = Array.from(segment.targetText).length;
  if (rule.kind === "required" && !segment.targetText.includes(rule.value)) return `译文缺少「${rule.value}」。`;
  if (rule.kind === "forbidden" && segment.targetText.includes(rule.value)) return `译文包含禁用内容「${rule.value}」。`;
  if (rule.kind === "maxLength" && length > Number(rule.value)) return `译文长 ${length} 字，超过上限 ${rule.value}。`;
  return undefined;
}

function reviewDocument(file: string, document: Document, options: ReviewOptions, prefix: string) {
  const segments = document.segments.filter((segment) => segment.readOnlyReason !== "translate=no");
  const { qa } = checkDocument({ ...document, segments }, {
    enabledRules: options.rules,
    untranslatedCopy: { shortSegmentMaxLength: 0, ignoreIdentifiers: true, whitelist: options.identicalWhitelist },
  });
  const indexed = new Map(segments.map((segment) => [segment.id, segment]));
  const rows: ReviewRow[] = qa.issues.map((issue) => {
    const candidate = issue.ruleId === "UNTRANSLATED_COPY";
    const segment = indexed.get(issue.segmentId)!;
    const same = segment.sourceText === segment.targetText ? "原译完全相同" : "原译经归一化后相同";
    const highlights = reviewIssueHighlights(segment, issue);
    const spans = (ranges: ReviewSpan[]) => ranges.map(({ start, end }) => ({ start, end }));
    return {
      ...segmentLocation(file, document, segment, prefix),
      ...(highlights.source?.length || highlights.target?.length ? { highlights: {
        ...(highlights.source?.length ? { source: spans(highlights.source) } : {}),
        ...(highlights.target?.length ? { target: spans(highlights.target) } : {}),
      } } : {}),
      category: categories.get(issue.ruleId)!,
      severity: candidate ? "neutral" : issue.severity,
      rule: issue.ruleId,
      message: candidate ? `${same}，请确认是否需要翻译。` : issue.message,
      evidence: issue.evidence,
    };
  });
  for (const segment of segments) {
    for (const rule of options.customRules) {
      const finding = customFinding(rule, segment);
      if (finding !== undefined) {
        rows.push({
          ...segmentLocation(file, document, segment, prefix),
          category: "自定义",
          severity: "major",
          rule: rule.name,
          message: finding,
          evidence: rule.sourceContains ? `原文包含「${rule.sourceContains}」` : "",
        });
      }
    }
  }
  return {
    rows,
    segments: segments.map((segment) => segmentLocation(file, document, segment, prefix)),
    incomplete: qa.rules.some((rule) => rule.status === "failed" || rule.status === "skipped"),
  };
}

export async function runQaReview(
  files: readonly File[], options: ReviewOptions, onDocument?: (entry: ReviewDocument) => void,
  mapDocument?: (entry: ReviewDocument) => Document,
): Promise<ReviewReport & { segments: ReviewSegment[] }> {
  if (files.length === 0 || files.length > REVIEW_FILE_LIMIT) throw new Error("请选择 1–20 个双语文件。");
  const report: ReviewReport & { segments: ReviewSegment[] } = { rows: [], files: [], segments: [] };
  for (const [fileIndex, file] of files.entries()) {
    try {
      const parsed = await readReviewFile(file);
      let segments = 0;
      let incomplete = false;
      for (const [entryIndex, entry] of parsed.entries()) {
        const keyPrefix = `${fileIndex}:${entryIndex}`;
        const document = mapDocument?.({ document: entry.document, keyPrefix }) ?? entry.document;
        const result = reviewDocument(entry.label, document, options, keyPrefix);
        onDocument?.({ document, keyPrefix });
        for (const row of result.rows) report.rows.push(row);
        for (const segment of result.segments) report.segments.push(segment);
        segments += result.segments.length;
        incomplete ||= result.incomplete;
      }
      if (segments === 0) throw new Error("未找到可检查的段落。");
      report.files.push({ name: file.name, segments, incomplete });
    } catch (error) {
      report.files.push({
        name: file.name, segments: 0, incomplete: true,
        error: error instanceof Error ? error.message : "文件处理失败。",
      });
    }
  }
  return report;
}
