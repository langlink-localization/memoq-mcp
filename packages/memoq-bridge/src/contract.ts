import { homedir } from "node:os";
import { join } from "node:path";

export const CONTRACT_VERSION = "1";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 5271;
export const BRIDGE_PRODUCT_NAME = "LangLink memoQ Bridge";
export const BRIDGE_VERSION = "0.1.0";
export const PLUGIN_DLL_NAME = "MemoQ.AI.Hub.Plugin.dll";
export const LEGACY_PLUGIN_DLL_NAME = "MemoQ.AI.Desktop.Plugin.dll";
export const CLIENT_DEV_CONFIG_NAME = "ClientDevConfig.xml";
export const INSTALL_MARKER_NAME = ".langlink-memoq-install.json";

export const ROUTES = {
  health: "/health",
  desktopVersion: "/desktop/version",
  mtTranslate: "/mt/translate",
  mtTranslateAggregate: "/mt/translate-aggregate",
  mtTranslateAggregateResult: "/mt/translate-aggregate/result",
  mtStoreTranslations: "/mt/store-translations",
} as const;

export const CONTROL_ROUTES = {
  status: "/bridge/status",
  previewActive: "/bridge/preview/active",
  previewSegments: "/bridge/preview/segments",
  previewDocuments: "/bridge/preview/documents",
  previewRefresh: "/bridge/preview/refresh",
  desktopEdits: "/bridge/preview/edits",
  previewFocus: "/bridge/preview/focus",
  stagingStage: "/bridge/staging/stage",
  stagingList: "/bridge/staging/list",
  stagingClear: "/bridge/staging/clear",
  stagingUpdate: "/bridge/staging/update",
  stagingApprove: "/bridge/staging/approve",
  stagingFeedback: "/bridge/staging/feedback",
  confirmedList: "/bridge/confirmed",
  recentRequests: "/bridge/recent-requests",
  liveConfig: "/bridge/live-config",
  qaCatalog: "/bridge/qa/catalog",
  qaRun: "/bridge/qa/run",
  reviewUrl: "/bridge/review-url",
  recentRequestsClear: "/bridge/recent-requests/clear",
  shutdown: "/bridge/shutdown",
} as const;

export const ERROR_CODES = {
  contractVersionMismatch: "CONTRACT_VERSION_MISMATCH",
  requestPayloadInvalid: "REQUEST_PAYLOAD_INVALID",
  requestNotEligible: "REQUEST_NOT_ELIGIBLE",
  translationFailed: "TRANSLATION_FAILED",
} as const;

export type TagPolicy = "protect" | "plaintext-fallback";
export type LiveMtMode = "staging_only" | "staging_then_live";
export type TerminologyMode = "advisory" | "strict";
export type GatewayOwner = "free" | "langlink-memoq-bridge" | "memoq-ai-hub" | "other";
export type StagedReviewStatus = "draft" | "approved" | "needs_revision";

export interface StagedRevisionEntry {
  revision: number;
  targetText: string;
  targetHtml: string;
  editedBy: string;
  note?: string;
  updatedAt: string;
}

export interface FocusedRange {
  startIndex: number;
  length: number;
}

export interface MtSegmentRequest {
  index: number;
  text: string;
  plainText?: string;
  tmSource?: string;
  tmTarget?: string;
  tmDiagnostics?: {
    supportFuzzyForwarding?: boolean;
    tmHintsRequested?: boolean;
    tmSourcePresent?: boolean;
    tmTargetPresent?: boolean;
  };
}

export interface MtRequestMetadata {
  client?: string;
  domain?: string;
  subject?: string;
  projectId?: string;
  documentId?: string;
  projectGuid?: string;
  segmentStatus?: number;
  segmentLevelMetadata?: Array<{
    segmentId?: string;
    segmentStatus?: number;
    segmentIndex?: number;
  }>;
}

export interface MtTranslateRequest {
  requestId?: string;
  traceId?: string;
  interface?: string;
  pluginVersion?: string;
  contractVersion?: string;
  sourceLanguage: string;
  targetLanguage: string;
  requestType?: string;
  metadata?: MtRequestMetadata;
  profileResolution?: {
    useCase?: string;
    profileId?: string;
  };
  capabilities?: {
    mtConfidenceInfo?: boolean;
  };
  segments: MtSegmentRequest[];
}

export interface MtSegmentResult {
  index: number;
  text: string;
  confidence: number;
  info: string;
  historyRequestId?: string;
  historySegmentIndex?: number;
}

export interface MtRejectedSegment {
  index: number;
  historyRequestId: string;
  historySegmentIndex: number;
}

export interface MtTranslateResponse {
  success: boolean;
  requestId: string;
  traceId: string;
  jobRequestId?: string;
  aggregationGroupId?: string;
  pending?: boolean;
  providerId?: string;
  model?: string;
  partial?: boolean;
  nonRetryableSegmentIndexes?: number[];
  nonRetryableSegments?: MtRejectedSegment[];
  error?: {
    code: string;
    message: string;
  };
  translations: MtSegmentResult[];
}

export interface MtAggregateSubmitResponse {
  success: boolean;
  requestId: string;
  traceId: string;
  jobRequestId: string;
  aggregationGroupId: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface MtAggregateResultRequest {
  requestId?: string;
  traceId?: string;
  jobRequestId: string;
  aggregationGroupId?: string;
  waitTimeoutMs?: number;
}

export interface MtStoreTranslationsRequest {
  requestId?: string;
  traceId?: string;
  contractVersion?: string;
  sourceLanguage: string;
  targetLanguage: string;
  requestType?: string;
  translations: Array<{
    index: number;
    sourceText: string;
    targetText: string;
  }>;
}

export interface MtStoreTranslationsResponse {
  success: boolean;
  requestId: string;
  traceId: string;
  storedCount?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface LiveMtConfig {
  mode: LiveMtMode;
  provider?: string;
  model?: string;
  projectDir?: string;
  autoAlignTags: boolean;
  usePreviewContext: boolean;
  useConfirmedFeedForward: boolean;
  terminologyMode: TerminologyMode;
  concurrency: number;
}

export function defaultBridgeDataDir(): string {
  const override = process.env.MEMOQ_BRIDGE_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "LangLink", "memoq-bridge");
  }
  return join(homedir(), ".langlink", "memoq-bridge");
}

const MQ_INLINE_TAG_TEST_RE = /<span\b[^>]*\bdata-mqitag=(?:"[^"]*"|'[^']*')[^>]*>/iu;
const FORMATTING_TAG_TEST_RE = /<\/?(?:b|i|u|sup|sub)\b[^>]*>/iu;
const KNOWN_MEMOQ_HTML_TAG_RE = /<\/?(?:b|i|u|sup|sub|br|span|p|div)\b[^>]*>/giu;
const MQ_TAG_OR_BR_GLOBAL_RE = /<span\b[^>]*\bdata-mqitag=(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?<\/span>|<br\s*\/?>/giu;
const MQ_TAG_OR_BR_TEST_RE = /<span\b[^>]*\bdata-mqitag=(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?<\/span>|<br\s*\/?>/iu;
const ATOMIC_SOURCE_TAG_TOKEN_SOURCE =
  "\\{\\{[^{}\\r\\n]+\\}\\}|\\$\\{[^{}\\r\\n]+\\}|\\{[^{}\\r\\n]+\\}|<\\/>|<\\/?[A-Za-z0-9_#][^\\r\\n<>]*>|\\[\\/?(?:[A-Za-z0-9_#-]+(?:=[^\\r\\n\\[\\]]*)?)\\]|%(?:\\d+\\$)?[-+ #0]*(?:\\d+)?(?:\\.\\d+)?[hlL]?[sdifFeEgGxXoucpaA%]|\\r?\\n|\\\\[nrt]";
const ATOMIC_SOURCE_TAG_TEST_RE = new RegExp(ATOMIC_SOURCE_TAG_TOKEN_SOURCE, "u");
const ATOMIC_SOURCE_TAG_GLOBAL_RE = new RegExp(ATOMIC_SOURCE_TAG_TOKEN_SOURCE, "gu");
const HORIZONTAL_WS_CHAR_RE = /[ \t\u00a0\u200b]/u;

export function hasAtomicSourceTagToken(text: string): boolean {
  if (!text) return false;
  return ATOMIC_SOURCE_TAG_TEST_RE.test(text);
}

export function computeSlotSkeletonKey(text: string, isIncomingHtml: boolean): string {
  const base = isIncomingHtml
    ? decodeHtmlEntities(String(text || "").replace(MQ_TAG_OR_BR_GLOBAL_RE, ""))
    : String(text || "");
  return base.replace(ATOMIC_SOURCE_TAG_GLOBAL_RE, "").replace(/[\s\u00a0\u200b]+/gu, "");
}

export interface InlineTagSlotBinding {
  token: string;
  tagHtml: string;
}

export function isHtmlRequestType(requestType: string | undefined): boolean {
  const token = String(requestType ?? "").trim().replace(/[\s_-]+/gu, "").toLowerCase();
  return token === "bothformattingandtags" || token === "onlyformatting" || token === "xml" || token === "html";
}

export function decodeHtmlEntities(text: string): string {
  return String(text ?? "")
    .replace(/&nbsp;/giu, "\u00a0")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#(\d+);/gu, (full, digits: string) => {
      const cp = Number.parseInt(digits, 10);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    })
    .replace(/&#x([0-9a-f]+);/giu, (full, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    })
    .replace(/&amp;/giu, "&");
}

export function escapeHtmlText(text: string): string {
  return String(text ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

export function extractMqInlineTagIds(html: string): string[] {
  const ids: string[] = [];
  const regex = /<span\b[^>]*\bdata-mqitag=(?:"([^"]*)"|'([^']*)')[^>]*>/giu;
  for (const match of html.matchAll(regex)) {
    const value = match[1] ?? match[2] ?? "";
    ids.push(value);
  }
  return ids;
}

export function hasMqInlineTags(text: string): boolean {
  if (!text) return false;
  return MQ_INLINE_TAG_TEST_RE.test(text) || FORMATTING_TAG_TEST_RE.test(text);
}

export function hasInlineTagOrBr(text: string): boolean {
  if (!text) return false;
  return MQ_TAG_OR_BR_TEST_RE.test(text);
}

export function stripHtmlTags(text: string): string {
  const stripped = String(text || "")
    .replace(/<span\b[^>]*\bdata-mqitag=(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?<\/span>/giu, " ")
    .replace(KNOWN_MEMOQ_HTML_TAG_RE, " ");
  return decodeHtmlEntities(stripped)
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeComparableText(text: string): string {
  return stripHtmlTags(text).toLowerCase();
}

function skipHorizontalWs(text: string, pos: number): number {
  let cursor = pos;
  while (cursor < text.length && HORIZONTAL_WS_CHAR_RE.test(text[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

function trimTrailingHorizontalWs(text: string): string {
  let end = text.length;
  while (end > 0 && HORIZONTAL_WS_CHAR_RE.test(text[end - 1]!)) {
    end -= 1;
  }
  return text.slice(0, end);
}

function matchLiteralAt(
  source: string,
  startPos: number,
  literal: string,
  allowBoundaryLeadingTrim: boolean,
  allowBoundaryTrailingTrim: boolean,
): number {
  const exactEnd = matchLiteralStrictAt(source, startPos, literal);
  if (exactEnd >= 0) {
    return exactEnd;
  }

  let trimmed = literal;
  if (allowBoundaryLeadingTrim) {
    const leadIdx = skipHorizontalWs(trimmed, 0);
    if (leadIdx > 0 && leadIdx < trimmed.length) {
      trimmed = trimmed.slice(leadIdx);
    }
  }
  if (trimmed !== literal) {
    const endAfterLeadTrim = matchLiteralStrictAt(source, startPos, trimmed);
    if (endAfterLeadTrim >= 0) {
      return endAfterLeadTrim;
    }
  }

  if (allowBoundaryTrailingTrim) {
    const withoutTrail = trimTrailingHorizontalWs(trimmed);
    if (withoutTrail.length > 0 && withoutTrail !== trimmed) {
      const endAfterTrailTrim = matchLiteralStrictAt(source, startPos, withoutTrail);
      if (endAfterTrailTrim >= 0) {
        return endAfterTrailTrim;
      }
    }
  }

  return -1;
}

function matchLiteralStrictAt(source: string, startPos: number, literal: string): number {
  let s = startPos;
  let l = 0;
  while (l < literal.length) {
    if (HORIZONTAL_WS_CHAR_RE.test(literal[l]!)) {
      const lEnd = skipHorizontalWs(literal, l);
      const sEnd = skipHorizontalWs(source, s);
      if (sEnd === s) {
        return -1;
      }
      s = sEnd;
      l = lEnd;
      continue;
    }
    if (s >= source.length || source[s] !== literal[l]) {
      return -1;
    }
    s += 1;
    l += 1;
  }
  return s;
}

export function matchInlineTagSlots(
  incomingHtml: string,
  stagedSourceText: string,
): InlineTagSlotBinding[] | null {
  if (!incomingHtml || !stagedSourceText) return null;

  const tagRegex = new RegExp(MQ_TAG_OR_BR_GLOBAL_RE.source, "giu");
  const literals: string[] = [];
  const runs: string[][] = [];

  let lastIndex = 0;
  for (const match of incomingHtml.matchAll(tagRegex)) {
    const matchIndex = match.index ?? 0;
    const rawBetween = incomingHtml.slice(lastIndex, matchIndex);
    const decodedBetween = decodeHtmlEntities(rawBetween);
    if (runs.length > 0 && rawBetween === "") {
      runs[runs.length - 1]!.push(match[0]);
    } else {
      literals.push(decodedBetween);
      runs.push([match[0]]);
    }
    lastIndex = matchIndex + match[0].length;
  }
  literals.push(decodeHtmlEntities(incomingHtml.slice(lastIndex)));

  if (runs.length === 0) {
    return null;
  }

  const bindings: InlineTagSlotBinding[] = [];
  const atomicTokenRe = new RegExp(ATOMIC_SOURCE_TAG_TOKEN_SOURCE, "uy");

  let pos = 0;
  const firstLit = literals[0] ?? "";
  let nextPos = matchLiteralAt(stagedSourceText, pos, firstLit, false, runs.length > 0);
  if (nextPos < 0 && firstLit !== "" && !HORIZONTAL_WS_CHAR_RE.test(firstLit[0]!)) {
    const wsPos = skipHorizontalWs(stagedSourceText, pos);
    if (wsPos > pos) {
      nextPos = matchLiteralAt(stagedSourceText, wsPos, firstLit, false, runs.length > 0);
    }
  }
  if (nextPos < 0) {
    return null;
  }
  pos = nextPos;

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!;
    for (const tagHtml of run) {
      atomicTokenRe.lastIndex = pos;
      let tokenMatch = atomicTokenRe.exec(stagedSourceText);
      if (!tokenMatch) {
        const wsPos = skipHorizontalWs(stagedSourceText, pos);
        if (wsPos > pos) {
          atomicTokenRe.lastIndex = wsPos;
          tokenMatch = atomicTokenRe.exec(stagedSourceText);
        }
      }
      if (!tokenMatch) {
        return null;
      }
      bindings.push({
        token: tokenMatch[0],
        tagHtml,
      });
      pos = atomicTokenRe.lastIndex;
    }

    const nextLit = literals[i + 1] ?? "";
    const hasFollowingRun = i + 1 < runs.length;
    let litEnd = matchLiteralAt(stagedSourceText, pos, nextLit, true, hasFollowingRun);
    if (litEnd < 0 && nextLit !== "" && !HORIZONTAL_WS_CHAR_RE.test(nextLit[0]!)) {
      const wsPos = skipHorizontalWs(stagedSourceText, pos);
      if (wsPos > pos) {
        litEnd = matchLiteralAt(stagedSourceText, wsPos, nextLit, false, hasFollowingRun);
      }
    }
    if (litEnd < 0) {
      return null;
    }
    pos = litEnd;
  }

  pos = skipHorizontalWs(stagedSourceText, pos);
  if (pos !== stagedSourceText.length) {
    return null;
  }

  return bindings;
}

export function restoreTargetFromBindings(
  incomingHtml: string,
  stagedTargetText: string,
  bindings: InlineTagSlotBinding[],
  requestType?: string,
): string | null {
  if (!bindings.length) return null;

  const queues = new Map<string, string[]>();
  for (const binding of bindings) {
    const key = binding.token === "\r\n" ? "\n" : binding.token;
    const list = queues.get(key);
    if (list) {
      list.push(binding.tagHtml);
    } else {
      queues.set(key, [binding.tagHtml]);
    }
  }

  const distinctTokens = Array.from(queues.keys()).sort((a, b) => b.length - a.length);
  const escapePlain = isHtmlRequestType(requestType);
  const out: string[] = [];
  let plainBuf = "";

  const flushPlain = () => {
    if (!plainBuf) return;
    out.push(escapePlain ? escapeHtmlText(plainBuf) : plainBuf);
    plainBuf = "";
  };

  let i = 0;
  while (i < stagedTargetText.length) {
    if (stagedTargetText.startsWith("\r\n", i) && queues.has("\n")) {
      const queue = queues.get("\n")!;
      const tagHtml = queue.shift();
      if (!tagHtml) return null;
      flushPlain();
      out.push(tagHtml);
      i += 2;
      continue;
    }

    let matchedToken: string | undefined;
    for (const tok of distinctTokens) {
      if (tok && stagedTargetText.startsWith(tok, i)) {
        matchedToken = tok;
        break;
      }
    }

    if (matchedToken !== undefined) {
      const queue = queues.get(matchedToken)!;
      const tagHtml = queue.shift();
      if (!tagHtml) return null;
      flushPlain();
      out.push(tagHtml);
      i += matchedToken.length;
      continue;
    }

    plainBuf += stagedTargetText[i]!;
    i += 1;
  }

  flushPlain();

  for (const queue of queues.values()) {
    if (queue.length > 0) {
      return null;
    }
  }

  const restored = out.join("");
  if (!verifyInlineTagInventory(incomingHtml, restored).ok) {
    return null;
  }
  return restored;
}

export function restoreInlineTagsFromStaged(
  incomingHtml: string,
  stagedSourceText: string,
  stagedTargetText: string,
  requestType?: string,
): string | null {
  const bindings = matchInlineTagSlots(incomingHtml, stagedSourceText);
  if (!bindings) {
    return null;
  }
  return restoreTargetFromBindings(incomingHtml, stagedTargetText, bindings, requestType);
}

function countFormattingTags(html: string): {
  openCounts: Map<string, number>;
  closeCounts: Map<string, number>;
} {
  const openCounts = new Map<string, number>();
  const closeCounts = new Map<string, number>();
  for (const match of html.matchAll(/<\/?(b|i|u|sup|sub)\b[^>]*>/giu)) {
    const raw = match[0];
    const name = (match[1] ?? "").toLowerCase();
    if (!name) continue;
    const isClose = raw.startsWith("</");
    const targetMap = isClose ? closeCounts : openCounts;
    targetMap.set(name, (targetMap.get(name) ?? 0) + 1);
  }
  return { openCounts, closeCounts };
}

export function verifyInlineTagInventory(
  sourceHtml: string,
  targetHtml: string,
): { ok: boolean; missing: string[]; extra: string[] } {
  const missing: string[] = [];
  const extra: string[] = [];

  const sourceIds = extractMqInlineTagIds(sourceHtml);
  const targetIds = extractMqInlineTagIds(targetHtml);
  const sourceCounts = new Map<string, number>();
  const targetCounts = new Map<string, number>();
  for (const id of sourceIds) sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
  for (const id of targetIds) targetCounts.set(id, (targetCounts.get(id) ?? 0) + 1);

  for (const [id, count] of sourceCounts) {
    const diff = count - (targetCounts.get(id) ?? 0);
    for (let i = 0; i < diff; i += 1) missing.push(`mqitag:${id}`);
  }
  for (const [id, count] of targetCounts) {
    const diff = count - (sourceCounts.get(id) ?? 0);
    for (let i = 0; i < diff; i += 1) extra.push(`mqitag:${id}`);
  }

  const srcFmt = countFormattingTags(sourceHtml);
  const tgtFmt = countFormattingTags(targetHtml);
  const allFmtNames = new Set([
    ...srcFmt.openCounts.keys(),
    ...srcFmt.closeCounts.keys(),
    ...tgtFmt.openCounts.keys(),
    ...tgtFmt.closeCounts.keys(),
  ]);

  for (const name of allFmtNames) {
    const tgtOpen = tgtFmt.openCounts.get(name) ?? 0;
    const tgtClose = tgtFmt.closeCounts.get(name) ?? 0;
    if (tgtOpen > tgtClose) {
      missing.push(`</${name}>`);
    } else if (tgtClose > tgtOpen) {
      extra.push(`</${name}>`);
    }
  }

  const srcHasFormatting = srcFmt.openCounts.size > 0;
  const tgtHasAnyFormatting = tgtFmt.openCounts.size > 0 || tgtFmt.closeCounts.size > 0;
  if (srcHasFormatting && !tgtHasAnyFormatting) {
    for (const name of srcFmt.openCounts.keys()) {
      missing.push(`<${name}>`);
    }
  }

  return {
    ok: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}

const ISO3_TO_ISO2: Record<string, string> = {
  eng: "en",
  zho: "zh",
  chi: "zh",
  chs: "zh-cn",
  cht: "zh-tw",
  deu: "de",
  ger: "de",
  fra: "fr",
  fre: "fr",
  jpn: "ja",
  kor: "ko",
  spa: "es",
  por: "pt",
  rus: "ru",
  ita: "it",
  nld: "nl",
  dut: "nl",
  pol: "pl",
  ara: "ar",
  vie: "vi",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  ind: "id",
  msa: "ms",
  may: "ms",
  ces: "cs",
  cze: "cs",
  hun: "hu",
  ron: "ro",
  rum: "ro",
  swe: "sv",
  dan: "da",
  fin: "fi",
  nor: "no",
  nob: "nb",
  nno: "nn",
  ell: "el",
  gre: "el",
  heb: "he",
  hin: "hi",
};

export interface NormalizedLanguage {
  raw: string;
  base: string;
  region: string;
  canonical: string;
}

export function normalizeLanguageCode(code: string | undefined): NormalizedLanguage {
  const raw = String(code ?? "").trim();
  if (!raw) {
    return { raw: "", base: "", region: "", canonical: "" };
  }
  const parts = raw.toLowerCase().replace(/_/gu, "-").split("-").filter(Boolean);
  const first = parts[0] ?? "";
  const mappedFirst = ISO3_TO_ISO2[first] ?? first;
  const mappedParts = mappedFirst.split("-");
  const base = mappedParts[0] ?? "";
  let region = mappedParts[1] ?? "";
  for (const part of parts.slice(1)) {
    if (part === "hans") {
      region = "cn";
    } else if (part === "hant") {
      region = "tw";
    } else if (!region && part.length === 2) {
      region = part;
    } else if (!region) {
      region = part;
    }
  }
  return {
    raw,
    base,
    region,
    canonical: region ? `${base}-${region}` : base,
  };
}

export function languagesMatch(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeLanguageCode(a);
  const right = normalizeLanguageCode(b);
  if (!left.base || !right.base) return false;
  if (left.base !== right.base) return false;
  if (!left.region || !right.region) return true;
  return left.region === right.region;
}
