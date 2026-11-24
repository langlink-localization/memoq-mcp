import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  matchTerms,
  parseGlossaryCsv,
  parseTbx,
  type GlossaryEntry,
} from "@langlink/l10n-core/assets";
import {
  QA_RULE_CATALOG,
  reviewIssueHighlights,
  runDeterministicChecks,
  scoreMqm,
  type MqmScore,
  type QaIssue,
  type QaRuleExecution,
  type QaSeverity,
  type QaTermHits,
  type Segment,
} from "@langlink/l10n-core/qa";
import {
  customFinding,
  type ReviewSpan,
  type ReviewToolInfo,
} from "@langlink/l10n-core/qa-review";
import { languagesMatch, normalizeComparableText, normalizeLanguageCode } from "./contract.ts";
import type { PreviewClient, PreviewStatus } from "./preview-client.ts";
import type { StagedEntry, StagingStore } from "./staging-store.ts";

export type MemoqQaScope = "memoq" | "staged" | "merged";
export const DEFAULT_AGENT_QA_PAGE_SIZE = 25;
export const MAX_MEMOQ_QA_PAGE_SIZE = 2000;
export type MemoqQaRuleCategory = "structural" | "content" | "style";

export interface MemoqQaRuleInfo {
  ruleId: string;
  code: string;
  severity: QaSeverity;
  defaultEnabled: boolean;
  scope: "segment" | "document";
  requiresTerms: boolean;
  requiresLocale: boolean;
  category: MemoqQaRuleCategory;
  label: string;
  description: string;
}

const RULE_META: Record<string, { category: MemoqQaRuleCategory; label: string; description: string }> = {
  EMPTY_TARGET: { category: "structural", label: "空译或正文缺失", description: "源文非空但译文为空，或只剩占位符无正文" },
  UNTRANSLATED_COPY: { category: "structural", label: "原译相同", description: "译文与源文完全一致，疑似漏译" },
  PLACEHOLDER_MISSING: { category: "structural", label: "缺少占位符", description: "译文漏掉了源文中的 {var} / %s 等变量" },
  PLACEHOLDER_EXTRA: { category: "structural", label: "多出占位符", description: "译文出现了源文中不存在的占位符" },
  TAG_MISMATCH: { category: "structural", label: "标签不一致", description: "内联标签或游戏伪标签（如 <CN-Medium>、</>）数量或顺序不匹配" },
  URL_CHANGED: { category: "structural", label: "网址或邮箱变更", description: "URL、邮箱或路径与源文不一致" },
  TB_SOURCE_FORBIDDEN: { category: "structural", label: "原文命中禁用术语", description: "源文命中术语表标记为禁用的词条" },
  TB_FORBIDDEN_USED: { category: "structural", label: "译文使用禁用词", description: "译文使用了术语表中标记为禁用的译名" },
  UNPAIRED_BRACKET: { category: "structural", label: "括号或引号不配对", description: "圆括号、方括号、花括号或引号未成对闭合" },
  NUMBER_MISMATCH: { category: "content", label: "数字不一致", description: "译文中的数字与源文数量或数值不一致" },
  DATE_MISMATCH: { category: "content", label: "日期不一致", description: "译文中的日期与源文不一致" },
  DATE_FORMAT: { category: "content", label: "日期格式异常", description: "译文日期格式不符合目标语本地习惯（需目标语言）" },
  DUPLICATE_WORD: { category: "content", label: "重复词", description: "译文中出现连续重复单词" },
  TERM_MISSING: { category: "content", label: "漏用术语表译名", description: "源文命中已批准术语，但译文未使用对应术语译法" },
  TERMINOLOGY_INCONSISTENT: { category: "content", label: "术语译法前后不一致", description: "同一术语在全文档中的译名不统一" },
  SOURCE_TARGET_INCONSISTENT: { category: "content", label: "同原文不同译文", description: "相同源文在文档中存在多个不一致的译文" },
  SOURCE_LEFTOVER: { category: "content", label: "残留源语言片段", description: "译文中混入未翻译的源语言连续词段或字符" },
  PUNCT_DUP: { category: "content", label: "标点重复", description: "译文中出现连续重复的标点符号" },
  TRAILING_COLON: { category: "content", label: "句末冒号不一致", description: "源文与译文末尾冒号有无不一致" },
  SENTENCE_END_PUNCT: { category: "style", label: "句末标点不一致", description: "源文与译文的句末标点缺失或类型不匹配" },
  WHITESPACE: { category: "style", label: "空格异常", description: "首尾多余空格、双空格或制表符不一致" },
  FULLWIDTH_HALFWIDTH: { category: "style", label: "全角半角标点混用", description: "中日韩或西文标点全半角形态与目标语言习惯不符" },
  LENGTH_RATIO: { category: "style", label: "长度比例异常（默认关闭）", description: "译文长度相对源文过长或过短" },
};

export const MEMOQ_QA_RULE_CATALOG: readonly MemoqQaRuleInfo[] = QA_RULE_CATALOG.map((rule) => {
  const meta = RULE_META[rule.ruleId] ?? {
    category: "content" as const,
    label: rule.ruleId,
    description: rule.ruleId,
  };
  return {
    ruleId: rule.ruleId,
    code: rule.code,
    severity: rule.severity,
    defaultEnabled: rule.defaultEnabled,
    scope: rule.scope,
    requiresTerms: rule.requiresTerms,
    requiresLocale: rule.requiresLocale,
    category: meta.category,
    label: meta.label,
    description: meta.description,
  };
});

export const MEMOQ_QA_RULE_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  rules: readonly string[];
}> = [
  { id: "punct_space", label: "标点与空格", rules: ["UNPAIRED_BRACKET", "PUNCT_DUP", "WHITESPACE"] },
  { id: "tag_var", label: "Tag 与变量", rules: ["TAG_MISMATCH", "PLACEHOLDER_MISSING", "PLACEHOLDER_EXTRA"] },
  { id: "num_date", label: "数字与日期", rules: ["NUMBER_MISMATCH", "DATE_MISMATCH"] },
  { id: "empty_target", label: "空译与正文缺失", rules: ["EMPTY_TARGET"] },
  { id: "untranslated_copy", label: "原译相同", rules: ["UNTRANSLATED_COPY"] },
  {
    id: "terminology_consistency",
    label: "术语表与一致性",
    rules: ["TERM_MISSING", "TB_SOURCE_FORBIDDEN", "TB_FORBIDDEN_USED", "TERMINOLOGY_INCONSISTENT", "SOURCE_TARGET_INCONSISTENT"],
  },
  {
    id: "style_locale",
    label: "语言与风格扩展",
    rules: ["URL_CHANGED", "DATE_FORMAT", "DUPLICATE_WORD", "SOURCE_LEFTOVER", "TRAILING_COLON", "SENTENCE_END_PUNCT", "FULLWIDTH_HALFWIDTH", "LENGTH_RATIO"],
  },
];

const RULE_INFO_BY_ID = new Map(MEMOQ_QA_RULE_CATALOG.map((rule) => [rule.ruleId, rule]));
const RULE_GROUP_LABEL_BY_ID = new Map(
  MEMOQ_QA_RULE_GROUPS.flatMap((group) => group.rules.map((ruleId) => [ruleId, group.label] as const)),
);

export interface MemoqCustomQaRule {
  name: string;
  sourceContains: string;
  kind: "required" | "forbidden" | "maxLength";
  value: string;
}

export function validateMemoqCustomRules(raw: unknown): MemoqCustomQaRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("customRules 必须为数组。");
  }
  if (raw.length > 20) {
    throw new Error("最多添加 20 条自定义检查。");
  }
  const out: MemoqCustomQaRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new Error("请检查自定义项的名称、检测类型和匹配值。");
    }
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const sourceContains = rec.sourceContains === undefined ? "" : rec.sourceContains;
    const kind = rec.kind;
    const value = typeof rec.value === "string" ? rec.value.trim() : "";
    if (
      !name
      || name.length > 80
      || typeof sourceContains !== "string"
      || sourceContains.length > 300
      || !value
      || value.length > 300
      || (kind !== "required" && kind !== "forbidden" && kind !== "maxLength")
      || (kind === "maxLength" && !/^[1-9]\d{0,4}$/u.test(value))
    ) {
      throw new Error("请检查自定义项的名称、检测类型和匹配值。长度上限须为正整数。");
    }
    out.push({ name, sourceContains, kind, value });
  }
  return out;
}

export interface MemoqQaInput {
  scope?: MemoqQaScope;
  documentId?: string;
  allDocuments?: boolean;
  enabledRules?: string[];
  customRules?: MemoqCustomQaRule[];
  glossaryPath?: string;
  projectDir?: string;
  whitelist?: string[];
  targetLocale?: string;
  maxIssues?: number;
  issueOffset?: number;
  includeSegments?: boolean;
  previewClient?: PreviewClient;
  stagingStore: StagingStore;
}

export interface MemoqQaSegmentSnapshot {
  segmentKey: string;
  segmentIndex: number;
  segmentNumber: number;
  docSegmentNumber?: number;
  documentId?: string;
  documentName?: string;
  previewPartId?: string;
  stagedId?: string;
  stagedStatus?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  sourceText: string;
  targetText: string;
}

export interface MemoqQaIssue {
  ruleId: string;
  ruleLabel: string;
  category: string;
  severity: QaSeverity;
  origin: "deterministic" | "custom";
  segmentIndex: number;
  segmentNumber: number;
  docSegmentNumber?: number;
  segmentId: string;
  documentId?: string;
  documentName?: string;
  previewPartId?: string;
  stagedId?: string;
  stagedStatus?: string;
  message: string;
  evidence: string;
  suggestion?: string;
  highlights?: { source?: ReviewSpan[]; target?: ReviewSpan[] };
  sourceText: string;
  targetText: string;
  memoqTargetText?: string;
}

export interface MemoqQaReport {
  available: boolean;
  reason?: string;
  scope: MemoqQaScope;
  allDocuments: boolean;
  checkedAt: string;
  tool?: ReviewToolInfo;
  document: {
    documentId: string;
    documentName: string;
    sourceLanguage: string;
    targetLanguage: string;
    targetLocale: string;
    previewConnected: boolean;
  };
  documents: Array<{
    documentId: string;
    documentName: string;
    segmentCount: number;
  }>;
  summary: {
    totalSegments: number;
    checkedSegments: number;
    translatedSegments: number;
    emptyTargetSegments: number;
    issueCount: number;
    totalIssues: number;
    bySeverity: Record<QaSeverity, number>;
    mqm: MqmScore;
    coverage: "complete" | "incomplete";
  };
  glossary: {
    entriesCount: number;
    sources: string[];
    warnings: string[];
  };
  rules: QaRuleExecution[];
  issues: MemoqQaIssue[];
  issueOffset: number;
  nextIssueOffset: number | null;
  segmentsIncluded: boolean;
  segments: MemoqQaSegmentSnapshot[];
}

interface RawManifestSpec {
  sourceLang?: string;
  targetLang?: string;
  assets?: Array<{
    kind?: string;
    format?: string;
    path?: string;
    enabled?: boolean;
    sourceLang?: string;
    targetLang?: string;
    mapping?: {
      sourceColumn?: string;
      targetColumn?: string;
      forbiddenColumn?: string;
    };
  }>;
}

interface QaCandidateRow {
  rowId: string;
  segmentIndex: number;
  docSegmentNumber?: number;
  documentId?: string;
  documentName?: string;
  previewPartId?: string;
  stagedId?: string;
  stagedStatus?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  sourceText: string;
  targetText: string;
  memoqTargetText?: string;
}

const INLINE_TAG_EXTRACT_RE = /<span\b[^>]*\bdata-mqitag=(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?<\/span>|<\/>|<\/?[A-Za-z0-9_#][^\r\n<>]*>/gu;

function extractTagTokens(text: string): string[] {
  if (!text) return [];
  return Array.from(text.matchAll(INLINE_TAG_EXTRACT_RE), (match) => match[0]);
}

function countEvaluationWords(texts: readonly string[]): number {
  let words = 0;
  for (const text of texts) {
    const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
    const latinWords = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu)?.length ?? 0;
    words += cjk + latinWords;
  }
  return Math.max(1, words);
}

function findManifestPath(startDir?: string): string | null {
  if (!startDir?.trim()) return null;
  let cursor = resolve(startDir.trim());
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(cursor, ".langlink", "manifest.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function loadGlossaryFromFile(
  filePath: string,
  defaults: {
    sourceLang?: string;
    targetLang?: string;
    sourceColumn?: string;
    targetColumn?: string;
    forbiddenColumn?: string;
  } = {},
): { entries: GlossaryEntry[]; warnings: string[] } {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { entries: [], warnings: [`Glossary file not found: ${abs}`] };
  }
  try {
    const content = readFileSync(abs, "utf8");
    if (/\.tbx$/iu.test(abs)) {
      return parseTbx(content, {
        ...(defaults.sourceLang ? { sourceLanguage: defaults.sourceLang } : {}),
        ...(defaults.targetLang ? { targetLanguage: defaults.targetLang } : {}),
      });
    }
    return parseGlossaryCsv(content, {
      ...(defaults.sourceLang ? { sourceLanguage: defaults.sourceLang } : {}),
      ...(defaults.targetLang ? { targetLanguage: defaults.targetLang } : {}),
      ...(defaults.sourceColumn ? { sourceColumn: defaults.sourceColumn } : {}),
      ...(defaults.targetColumn ? { targetColumn: defaults.targetColumn } : {}),
      ...(defaults.forbiddenColumn ? { forbiddenColumn: defaults.forbiddenColumn } : {}),
    });
  } catch (error) {
    return {
      entries: [],
      warnings: [`Failed to load glossary "${abs}": ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function loadMemoqGlossary(options: {
  glossaryPath?: string;
  projectDir?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}): { entries: GlossaryEntry[]; sources: string[]; warnings: string[] } {
  const entries: GlossaryEntry[] = [];
  const sources: string[] = [];
  const warnings: string[] = [];

  if (options.glossaryPath?.trim()) {
    const abs = resolve(options.glossaryPath.trim());
    const parsed = loadGlossaryFromFile(abs, {
      ...(options.sourceLanguage ? { sourceLang: options.sourceLanguage } : {}),
      ...(options.targetLanguage ? { targetLang: options.targetLanguage } : {}),
    });
    entries.push(...parsed.entries);
    warnings.push(...parsed.warnings);
    if (parsed.entries.length > 0) sources.push(abs);
  }

  const manifestPath = findManifestPath(options.projectDir);
  if (manifestPath) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RawManifestSpec;
      const root = dirname(dirname(manifestPath));
      for (const asset of manifest.assets ?? []) {
        if (!asset || asset.enabled === false || typeof asset.path !== "string" || !asset.path.trim()) continue;
        if (String(asset.kind ?? "").toLowerCase() !== "tb") continue;
        const format = String(asset.format ?? "").toLowerCase();
        if (!["tbx", "csv", "tsv", "txt"].includes(format)) continue;
        const abs = isAbsolute(asset.path.trim()) ? asset.path.trim() : resolve(root, asset.path.trim());
        const parsed = loadGlossaryFromFile(abs, {
          sourceLang: asset.sourceLang ?? manifest.sourceLang ?? options.sourceLanguage ?? "",
          targetLang: asset.targetLang ?? manifest.targetLang ?? options.targetLanguage ?? "",
          ...(asset.mapping?.sourceColumn ? { sourceColumn: asset.mapping.sourceColumn } : {}),
          ...(asset.mapping?.targetColumn ? { targetColumn: asset.mapping.targetColumn } : {}),
          ...(asset.mapping?.forbiddenColumn ? { forbiddenColumn: asset.mapping.forbiddenColumn } : {}),
        });
        entries.push(...parsed.entries);
        warnings.push(...parsed.warnings);
        if (parsed.entries.length > 0) sources.push(abs);
      }
    } catch (error) {
      warnings.push(`Failed to read manifest "${manifestPath}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { entries, sources, warnings };
}

export function collectAllPreviewSegments(
  previewClient: PreviewClient | undefined,
  documentId?: string,
): ReturnType<PreviewClient["getDocumentSegments"]> {
  if (!previewClient) {
    return {
      available: false,
      reason: "preview_disabled",
      total: 0,
      filtered: 0,
      offset: 0,
      limit: 500,
      segments: [],
    };
  }

  const first = previewClient.getDocumentSegments({
    ...(documentId ? { documentId } : {}),
    offset: 0,
    limit: 500,
  });
  if (!first.available || first.segments.length >= first.total) {
    return first;
  }

  const all = [...first.segments];
  const cap = Math.min(first.total, 100_000);
  while (all.length < cap) {
    const page = previewClient.getDocumentSegments({
      ...(documentId ? { documentId } : {}),
      offset: all.length,
      limit: 500,
    });
    if (!page.available || page.segments.length === 0) break;
    all.push(...page.segments);
  }

  return {
    ...first,
    filtered: all.length,
    limit: all.length,
    segments: all,
  };
}

function createStagedLookup(stagedEntries: readonly StagedEntry[]) {
  const byPart = new Map<string, StagedEntry>();
  const byDocExact = new Map<string, StagedEntry>();
  const byGlobalExact = new Map<string, StagedEntry>();
  const byDocNorm = new Map<string, StagedEntry>();
  const byGlobalNorm = new Map<string, StagedEntry>();

  for (const entry of stagedEntries) {
    const docKey = entry.documentId.toLowerCase();
    if (entry.previewPartId && !byPart.has(entry.previewPartId)) {
      byPart.set(entry.previewPartId, entry);
    }
    if (docKey) {
      const k = `${docKey}\0${entry.sourceText}`;
      if (!byDocExact.has(k)) byDocExact.set(k, entry);
    }
    if (!byGlobalExact.has(entry.sourceText)) {
      byGlobalExact.set(entry.sourceText, entry);
    }
    const normSrc = normalizeComparableText(entry.sourceText);
    if (normSrc) {
      if (docKey) {
        const k = `${docKey}\0${normSrc}`;
        if (!byDocNorm.has(k)) byDocNorm.set(k, entry);
      }
      if (!byGlobalNorm.has(normSrc)) {
        byGlobalNorm.set(normSrc, entry);
      }
    }
  }

  return (previewSeg: { previewPartId: string; sourceText: string }, docId?: string): StagedEntry | undefined => {
    const byPartHit = byPart.get(previewSeg.previewPartId);
    if (byPartHit) return byPartHit;
    const docKey = (docId ?? "").trim().toLowerCase();
    if (docKey) {
      const hit = byDocExact.get(`${docKey}\0${previewSeg.sourceText}`);
      if (hit) return hit;
    }
    const exactHit = byGlobalExact.get(previewSeg.sourceText);
    if (exactHit) return exactHit;
    const normSrc = normalizeComparableText(previewSeg.sourceText);
    if (!normSrc) return undefined;
    if (docKey) {
      const hit = byDocNorm.get(`${docKey}\0${normSrc}`);
      if (hit) return hit;
    }
    return byGlobalNorm.get(normSrc);
  };
}

function findSubstringSpans(haystack: string, needle: string): ReviewSpan[] {
  if (!haystack || !needle) return [];
  const spans: ReviewSpan[] = [];
  let cursor = 0;
  while (cursor < haystack.length) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx < 0) break;
    spans.push({ start: idx, end: idx + needle.length });
    cursor = idx + needle.length;
  }
  return spans;
}

function prepareMemoqQaContext(input: MemoqQaInput) {
  const scope: MemoqQaScope =
    input.scope === "memoq" || input.scope === "staged" || input.scope === "merged"
      ? input.scope
      : "merged";

  const rawDocId = (input.documentId ?? "").trim();
  const allDocuments = Boolean(input.allDocuments || rawDocId === "__all__" || rawDocId === "*");
  const explicitDocId = !allDocuments && rawDocId ? rawDocId : undefined;

  const previewStatus: PreviewStatus | null = input.previewClient?.getStatus() ?? null;
  const cachedDocs = input.previewClient?.listDocuments() ?? [];
  const primaryPreview = allDocuments
    ? null
    : collectAllPreviewSegments(input.previewClient, explicitDocId);

  const resolvedDocId = allDocuments
    ? "__all__"
    : (
        explicitDocId
        || primaryPreview?.document?.documentId
        || previewStatus?.activeDocumentId
        || ""
      ).trim();

  const stagedAll = input.stagingStore.listStaged({ limit: 100_000, status: "all" }).items;
  const stagedPool = allDocuments
    ? stagedAll
    : explicitDocId
      ? stagedAll.filter((entry) => entry.documentId.toLowerCase() === explicitDocId.toLowerCase())
      : resolvedDocId
        ? stagedAll.filter((entry) => !entry.documentId || entry.documentId.toLowerCase() === resolvedDocId.toLowerCase())
        : stagedAll;

  const docMetaById = new Map<string, { documentName: string; sourceLanguage: string; targetLanguage: string }>();
  for (const d of cachedDocs) {
    if (d.documentId) {
      docMetaById.set(d.documentId.toLowerCase(), {
        documentName: d.documentName || d.documentId,
        sourceLanguage: d.sourceLanguage,
        targetLanguage: d.targetLanguage,
      });
    }
  }

  const documentName = allDocuments
    ? `全部已打开文档 (${cachedDocs.length})`
    : (primaryPreview?.document?.documentName || previewStatus?.activeDocumentName || "");
  const sourceLanguage =
    primaryPreview?.document?.sourceLanguage
    || cachedDocs[0]?.sourceLanguage
    || previewStatus?.activeSourceLanguage
    || stagedPool[0]?.sourceLanguage
    || "";
  const targetLanguage =
    primaryPreview?.document?.targetLanguage
    || cachedDocs[0]?.targetLanguage
    || previewStatus?.activeTargetLanguage
    || stagedPool[0]?.targetLanguage
    || "";

  const previewBatches: Array<{
    documentId: string;
    documentName: string;
    sourceLanguage: string;
    targetLanguage: string;
    segments: ReturnType<PreviewClient["getDocumentSegments"]>["segments"];
  }> = [];

  if (allDocuments) {
    for (const d of cachedDocs) {
      const collected = collectAllPreviewSegments(input.previewClient, d.documentId);
      previewBatches.push({
        documentId: d.documentId,
        documentName: d.documentName || d.documentId,
        sourceLanguage: d.sourceLanguage,
        targetLanguage: d.targetLanguage,
        segments: collected.segments,
      });
    }
  } else if (primaryPreview && primaryPreview.segments.length > 0) {
    previewBatches.push({
      documentId: primaryPreview.document?.documentId || resolvedDocId,
      documentName: primaryPreview.document?.documentName || documentName,
      sourceLanguage: primaryPreview.document?.sourceLanguage || sourceLanguage,
      targetLanguage: primaryPreview.document?.targetLanguage || targetLanguage,
      segments: primaryPreview.segments,
    });
  }

  const lookupStaged = createStagedLookup(stagedPool);
  const seenRowIds = new Set<string>();
  const allocRowId = (preferredId: string, docId: string): string => {
    const candidate = !seenRowIds.has(preferredId) ? preferredId : `${docId}::${preferredId}`;
    let unique = candidate;
    let suffix = 1;
    while (seenRowIds.has(unique)) {
      unique = `${candidate}#${suffix++}`;
    }
    seenRowIds.add(unique);
    return unique;
  };

  const rows: QaCandidateRow[] = [];
  if (scope === "memoq") {
    for (const batch of previewBatches) {
      for (const seg of batch.segments) {
        rows.push({
          rowId: allocRowId(seg.previewPartId, batch.documentId),
          segmentIndex: rows.length,
          docSegmentNumber: seg.index + 1,
          documentId: batch.documentId,
          documentName: batch.documentName,
          previewPartId: seg.previewPartId,
          sourceLanguage: batch.sourceLanguage || sourceLanguage,
          targetLanguage: batch.targetLanguage || targetLanguage,
          sourceText: seg.sourceText,
          targetText: seg.targetText,
          memoqTargetText: seg.targetText,
        });
      }
    }
  } else if (scope === "staged") {
    stagedPool.forEach((entry, index) => {
      const meta = entry.documentId ? docMetaById.get(entry.documentId.toLowerCase()) : undefined;
      rows.push({
        rowId: entry.id,
        segmentIndex: index,
        docSegmentNumber: index + 1,
        ...(entry.documentId ? { documentId: entry.documentId } : {}),
        ...(meta?.documentName ? { documentName: meta.documentName } : {}),
        ...(entry.previewPartId ? { previewPartId: entry.previewPartId } : {}),
        stagedId: entry.id,
        stagedStatus: entry.status,
        sourceLanguage: entry.sourceLanguage || meta?.sourceLanguage || sourceLanguage,
        targetLanguage: entry.targetLanguage || meta?.targetLanguage || targetLanguage,
        sourceText: entry.sourceText,
        targetText: entry.targetText,
      });
    });
  } else {
    const matchedIds = new Set<string>();
    for (const batch of previewBatches) {
      for (const seg of batch.segments) {
        const staged = lookupStaged(seg, batch.documentId);
        if (staged) matchedIds.add(staged.id);
        rows.push({
          rowId: allocRowId(seg.previewPartId, batch.documentId),
          segmentIndex: rows.length,
          docSegmentNumber: seg.index + 1,
          documentId: batch.documentId,
          documentName: batch.documentName,
          previewPartId: seg.previewPartId,
          ...(staged ? { stagedId: staged.id, stagedStatus: staged.status } : {}),
          sourceLanguage: batch.sourceLanguage || staged?.sourceLanguage || sourceLanguage,
          targetLanguage: batch.targetLanguage || staged?.targetLanguage || targetLanguage,
          sourceText: seg.sourceText,
          targetText: staged ? staged.targetText : seg.targetText,
          memoqTargetText: seg.targetText,
        });
      }
    }
    for (const entry of stagedPool) {
      if (matchedIds.has(entry.id)) continue;
      const meta = entry.documentId ? docMetaById.get(entry.documentId.toLowerCase()) : undefined;
      rows.push({
        rowId: entry.id,
        segmentIndex: rows.length,
        docSegmentNumber: rows.length + 1,
        ...(entry.documentId ? { documentId: entry.documentId } : {}),
        ...(meta?.documentName ? { documentName: meta.documentName } : {}),
        ...(entry.previewPartId ? { previewPartId: entry.previewPartId } : {}),
        stagedId: entry.id,
        stagedStatus: entry.status,
        sourceLanguage: entry.sourceLanguage || meta?.sourceLanguage || sourceLanguage,
        targetLanguage: entry.targetLanguage || meta?.targetLanguage || targetLanguage,
        sourceText: entry.sourceText,
        targetText: entry.targetText,
      });
    }
  }

  const targetLocale = (input.targetLocale?.trim() || normalizeLanguageCode(targetLanguage).canonical).trim();
  const glossaryLoaded = loadMemoqGlossary({
    ...(input.glossaryPath ? { glossaryPath: input.glossaryPath } : {}),
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
    ...(sourceLanguage ? { sourceLanguage } : {}),
    ...(targetLanguage ? { targetLanguage } : {}),
  });

  const eligibleGlossary = glossaryLoaded.entries.filter(
    (entry) =>
      (!sourceLanguage || !entry.sourceLanguage || languagesMatch(entry.sourceLanguage, sourceLanguage))
      && (!targetLanguage || !entry.targetLanguage || languagesMatch(entry.targetLanguage, targetLanguage)),
  );

  const segments: Segment[] = rows.map((row) => ({
    id: row.rowId,
    index: row.segmentIndex,
    location: { fileIndex: 0, unitId: row.rowId, segmentIndex: row.segmentIndex },
    sourceInner: row.sourceText,
    targetInner: row.targetText,
    sourceText: row.sourceText,
    targetText: row.targetText,
    sourceTags: extractTagTokens(row.sourceText),
    targetTags: extractTagTokens(row.targetText),
    targetRange: { start: 0, end: row.targetText.length },
  }));

  const segmentTermHits = new Map<string, QaTermHits>();
  if (eligibleGlossary.length > 0) {
    const termOptions = {
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(targetLanguage ? { targetLanguage } : {}),
    };
    for (const seg of segments) {
      const srcHits = matchTerms(seg.sourceText, eligibleGlossary, termOptions);
      const tgtHits = matchTerms(seg.targetText, eligibleGlossary, termOptions);
      segmentTermHits.set(seg.id, { source: srcHits.hits, target: tgtHits.hits });
    }
  }

  const qaResult = runDeterministicChecks(segments, {
    ...(eligibleGlossary.length > 0 ? { glossary: eligibleGlossary, segmentTermHits } : {}),
    ...(input.enabledRules ? { enabledRules: input.enabledRules } : {}),
    ...(input.whitelist?.length ? { untranslatedCopy: { whitelist: input.whitelist } } : {}),
    ...(targetLocale ? { locale: { targetLocale } } : {}),
  });

  const customRules = validateMemoqCustomRules(input.customRules);
  const customFindings: Array<{ issue: QaIssue; rule: MemoqCustomQaRule }> = [];
  if (customRules.length > 0) {
    for (const seg of segments) {
      for (const rule of customRules) {
        const message = customFinding(rule, seg);
        if (message !== undefined) {
          customFindings.push({
            rule,
            issue: {
              ruleId: "PROJECT_REQUIREMENT",
              severity: "major",
              origin: "deterministic",
              segmentId: seg.id,
              segmentIndex: seg.index,
              message,
              evidence: rule.sourceContains ? `原文包含「${rule.sourceContains}」` : `${rule.name}（${rule.value}）`,
            },
          });
        }
      }
    }
  }

  return {
    scope,
    allDocuments,
    previewStatus,
    primaryPreview,
    resolvedDocId,
    documentName,
    sourceLanguage,
    targetLanguage,
    targetLocale,
    previewBatches,
    rows,
    segments,
    segmentById: new Map(segments.map((s) => [s.id, s])),
    segmentTermHits,
    glossaryLoaded,
    eligibleGlossary,
    qaResult,
    customFindings,
  };
}

export function runMemoqQa(input: MemoqQaInput): MemoqQaReport {
  const ctx = prepareMemoqQaContext(input);
  const allScoreIssues: QaIssue[] = [
    ...ctx.qaResult.issues,
    ...ctx.customFindings.map((item) => item.issue),
  ];

  const ewc = countEvaluationWords(ctx.rows.map((r) => r.sourceText));
  const mqm = scoreMqm(allScoreIssues, { ewc });

  const rowById = new Map(ctx.rows.map((row) => [row.rowId, row]));
  const translatedSegments = ctx.rows.filter((r) => r.targetText.trim().length > 0).length;
  const emptyTargetSegments = ctx.rows.length - translatedSegments;

  const bySeverity: Record<QaSeverity, number> = {
    critical: 0,
    major: 0,
    minor: 0,
    neutral: 0,
  };
  for (const issue of allScoreIssues) {
    bySeverity[issue.severity] += 1;
  }

  const maxIssues = Math.max(1, Math.min(MAX_MEMOQ_QA_PAGE_SIZE, input.maxIssues ?? 500));
  const issueOffset = input.issueOffset ?? 0;
  const issueEnd = issueOffset + maxIssues;
  const deterministicCount = ctx.qaResult.issues.length;
  const mappedDeterministic: MemoqQaIssue[] = ctx.qaResult.issues.slice(issueOffset, issueEnd).map((issue) => {
    const row = rowById.get(issue.segmentId);
    const seg = ctx.segmentById.get(issue.segmentId);
    const meta = RULE_INFO_BY_ID.get(issue.ruleId);
    const hl = seg ? reviewIssueHighlights(seg, issue) : {};
    const hasHl = Boolean(hl.source?.length || hl.target?.length);
    return {
      ruleId: issue.ruleId,
      ruleLabel: meta?.label ?? issue.ruleId,
      category: RULE_GROUP_LABEL_BY_ID.get(issue.ruleId) ?? "语言与风格扩展",
      severity: issue.severity,
      origin: "deterministic",
      segmentIndex: issue.segmentIndex,
      segmentNumber: issue.segmentIndex + 1,
      ...(row?.docSegmentNumber !== undefined ? { docSegmentNumber: row.docSegmentNumber } : {}),
      segmentId: issue.segmentId,
      ...(row?.documentId ? { documentId: row.documentId } : {}),
      ...(row?.documentName ? { documentName: row.documentName } : {}),
      ...(row?.previewPartId ? { previewPartId: row.previewPartId } : {}),
      ...(row?.stagedId ? { stagedId: row.stagedId } : {}),
      ...(row?.stagedStatus ? { stagedStatus: row.stagedStatus } : {}),
      message: issue.message,
      evidence: issue.evidence,
      ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
      ...(hasHl ? {
        highlights: {
          ...(hl.source?.length ? { source: hl.source.map(({ start, end }) => ({ start, end })) } : {}),
          ...(hl.target?.length ? { target: hl.target.map(({ start, end }) => ({ start, end })) } : {}),
        },
      } : {}),
      sourceText: row?.sourceText ?? "",
      targetText: row?.targetText ?? "",
      ...(row?.memoqTargetText !== undefined ? { memoqTargetText: row.memoqTargetText } : {}),
    };
  });

  const mappedCustom: MemoqQaIssue[] = ctx.customFindings.slice(
    Math.max(0, issueOffset - deterministicCount),
    Math.max(0, issueEnd - deterministicCount),
  ).map(({ issue, rule }) => {
    const row = rowById.get(issue.segmentId);
    const seg = ctx.segmentById.get(issue.segmentId);
    const srcHl = seg && rule.sourceContains ? findSubstringSpans(seg.sourceText, rule.sourceContains) : [];
    const tgtHl = seg && rule.kind === "forbidden" ? findSubstringSpans(seg.targetText, rule.value) : [];
    const hasHl = srcHl.length > 0 || tgtHl.length > 0;
    return {
      ruleId: rule.name,
      ruleLabel: rule.name,
      category: "自定义",
      severity: issue.severity,
      origin: "custom",
      segmentIndex: issue.segmentIndex,
      segmentNumber: issue.segmentIndex + 1,
      ...(row?.docSegmentNumber !== undefined ? { docSegmentNumber: row.docSegmentNumber } : {}),
      segmentId: issue.segmentId,
      ...(row?.documentId ? { documentId: row.documentId } : {}),
      ...(row?.documentName ? { documentName: row.documentName } : {}),
      ...(row?.previewPartId ? { previewPartId: row.previewPartId } : {}),
      ...(row?.stagedId ? { stagedId: row.stagedId } : {}),
      ...(row?.stagedStatus ? { stagedStatus: row.stagedStatus } : {}),
      message: issue.message,
      evidence: issue.evidence,
      ...(hasHl ? {
        highlights: {
          ...(srcHl.length ? { source: srcHl } : {}),
          ...(tgtHl.length ? { target: tgtHl } : {}),
        },
      } : {}),
      sourceText: row?.sourceText ?? "",
      targetText: row?.targetText ?? "",
      ...(row?.memoqTargetText !== undefined ? { memoqTargetText: row.memoqTargetText } : {}),
    };
  });

  const mappedIssues = [...mappedDeterministic, ...mappedCustom];
  const next = issueOffset + mappedIssues.length;
  const segmentsIncluded = input.includeSegments !== false;
  const snapshots: MemoqQaSegmentSnapshot[] = segmentsIncluded ? ctx.rows.map((row) => ({
    segmentKey: row.rowId,
    segmentIndex: row.segmentIndex,
    segmentNumber: row.segmentIndex + 1,
    ...(row.docSegmentNumber !== undefined ? { docSegmentNumber: row.docSegmentNumber } : {}),
    ...(row.documentId ? { documentId: row.documentId } : {}),
    ...(row.documentName ? { documentName: row.documentName } : {}),
    ...(row.previewPartId ? { previewPartId: row.previewPartId } : {}),
    ...(row.stagedId ? { stagedId: row.stagedId } : {}),
    ...(row.stagedStatus ? { stagedStatus: row.stagedStatus } : {}),
    ...(row.sourceLanguage ? { sourceLanguage: row.sourceLanguage } : {}),
    ...(row.targetLanguage ? { targetLanguage: row.targetLanguage } : {}),
    sourceText: row.sourceText,
    targetText: row.targetText,
  })) : [];

  return {
    available: ctx.rows.length > 0,
    ...(ctx.rows.length === 0 ? { reason: ctx.primaryPreview?.reason ?? "no_segments_in_scope" } : {}),
    scope: ctx.scope,
    allDocuments: ctx.allDocuments,
    checkedAt: new Date().toISOString(),
    document: {
      documentId: ctx.resolvedDocId,
      documentName: ctx.documentName,
      sourceLanguage: ctx.sourceLanguage,
      targetLanguage: ctx.targetLanguage,
      targetLocale: ctx.targetLocale,
      previewConnected: Boolean(ctx.previewStatus?.connected),
    },
    documents: ctx.previewBatches.map((batch) => ({
      documentId: batch.documentId,
      documentName: batch.documentName,
      segmentCount: batch.segments.length,
    })),
    summary: {
      totalSegments: ctx.rows.length,
      checkedSegments: ctx.qaResult.checkedSegments,
      translatedSegments,
      emptyTargetSegments,
      issueCount: allScoreIssues.length,
      totalIssues: allScoreIssues.length,
      bySeverity,
      mqm,
      coverage: ctx.qaResult.coverage,
    },
    glossary: {
      entriesCount: ctx.eligibleGlossary.length,
      sources: ctx.glossaryLoaded.sources,
      warnings: ctx.glossaryLoaded.warnings,
    },
    rules: ctx.qaResult.rules,
    issues: mappedIssues,
    issueOffset,
    nextIssueOffset: next < allScoreIssues.length ? next : null,
    segmentsIncluded,
    segments: snapshots,
  };
}
