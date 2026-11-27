import { desktopEditSchema } from "./desktop-edits.ts";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BRIDGE_PRODUCT_NAME,
  BRIDGE_VERSION,
  CONTRACT_VERSION,
  CONTROL_ROUTES,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ERROR_CODES,
  ROUTES,
  escapeHtmlText,
  hasInlineTagOrBr,
  hasMqInlineTags,
  isHtmlRequestType,
  restoreInlineTagsFromStaged,
  verifyInlineTagInventory,
  type LiveMtConfig,
  type MtAggregateResultRequest,
  type MtAggregateSubmitResponse,
  type MtSegmentRequest,
  type MtSegmentResult,
  type MtStoreTranslationsRequest,
  type MtTranslateRequest,
  type MtTranslateResponse,
  type StagedReviewStatus,
} from "./contract.ts";
import {
  buildReviewExportArtifact,
  validateReviewExportReport,
  type ReviewToolInfo,
} from "@langlink/l10n-core/qa-review";
import type { IntegrationStatus } from "./dll-installer.ts";
import type { PreviewClient } from "./preview-client.ts";
import {
  MEMOQ_QA_RULE_CATALOG,
  MEMOQ_QA_RULE_GROUPS,
  collectAllPreviewSegments,
  runMemoqQa,
  validateMemoqCustomRules,
  type MemoqQaScope,
} from "./qa-runner.ts";
import { renderReviewWorkbenchHtml } from "./review-page.ts";
import {
  DEFAULT_MAX_STAGED,
  summarizeMissedRequests,
  type MissedMtSummaryItem,
  type StagingStore,
  type StageTranslationInput,
} from "./staging-store.ts";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_AGGREGATE_JOBS = 128;

export interface LiveTranslatorInput {
  request: MtTranslateRequest;
  segments: MtSegmentRequest[];
}

export interface LiveTranslatorResult {
  providerId?: string;
  model?: string;
  translations: MtSegmentResult[];
  rejectedIndexes?: number[];
  errorMessage?: string;
}

export type LiveTranslator = (input: LiveTranslatorInput) => Promise<LiveTranslatorResult>;

export type TagAligner = (input: {
  sourceHtml: string;
  stagedTarget: string;
  sourceLanguage: string;
  targetLanguage: string;
}) => Promise<string | null>;

export interface MtGatewayOptions {
  host?: string;
  port?: number;
  productName?: string;
  toolName?: string;
  desktopVersion?: string;
  mode?: "staging" | "dsh-live";
  controlToken?: string;
  reviewToken?: string;
  stagingStore: StagingStore;
  previewClient?: PreviewClient;
  getIntegrationStatus?: () => IntegrationStatus;
  liveTranslator?: LiveTranslator;
  tagAligner?: TagAligner;
  getLiveConfig?: () => LiveMtConfig;
  updateLiveConfig?: (patch: Partial<LiveMtConfig>) => LiveMtConfig;
  onShutdown?: () => void | Promise<void>;
}

export interface MtGatewayServer {
  port: number;
  host: string;
  baseUrl: string;
  controlToken: string;
  reviewToken: string;
  reviewUrl: string;
  close(): Promise<void>;
  handleTranslateForTest(payload: MtTranslateRequest): Promise<{ statusCode: number; body: MtTranslateResponse }>;
}

class BodyError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new BodyError(413, "REQUEST_BODY_TOO_LARGE", "The request body exceeds the 10 MB limit.");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks, total).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BodyError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function safeTokenEquals(actualValue: string | undefined, expectedToken: string): boolean {
  if (!actualValue) return false;
  const actual = Buffer.from(actualValue, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function safeBearerEquals(headerValue: string | undefined, expectedToken: string): boolean {
  if (!headerValue || !headerValue.startsWith("Bearer ")) return false;
  return safeTokenEquals(headerValue.slice("Bearer ".length), expectedToken);
}

const REVIEW_COOKIE_NAME = "memoq_review_token";
const REVIEW_COOKIE_MAX_AGE_SECONDS = 31_536_000;

function readCookieValue(cookieHeader: string | undefined, cookieName: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = part.slice(0, eqIndex).trim();
    if (name !== cookieName) continue;
    const value = part.slice(eqIndex + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function renderReviewUnauthorizedHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LangLink memoQ 工作台需要授权链接</title>
  <style>
    body { margin: 0; padding: 36px 20px; font: 14px/1.6 "Segoe UI", "Microsoft YaHei UI", sans-serif; background: #f8fafc; color: #0f172a; }
    .card { max-width: 560px; margin: 40px auto; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 10px; padding: 24px; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06); }
    h1 { margin: 0 0 10px; font-size: 18px; }
    p { margin: 8px 0; color: #334155; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>需要有效的 memoQ 审校工作台授权链接</h1>
    <p>出于本地安全隔离要求，打开审校工作台需要先通过 <code>memoq_open_review</code> 获取的持久化令牌链接（<code>/review?token=...</code>）。</p>
    <p>在同一浏览器中通过有效链接打开一次后，浏览器会自动保留受限 Cookie 授权；此后刷新页面、使用书签或重启后台服务后再次打开均可继续使用。</p>
    <p style="color:#64748b;font-size:12px;">Unauthorized: present a valid persisted review token link via <code>memoq_open_review</code>.</p>
  </main>
</body>
</html>`;
}

function sendHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
  csp: string,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": csp,
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(html);
}

function isAllowedLoopbackHost(hostHeader: string | undefined, boundHost: string, boundPort: number): boolean {
  if (!hostHeader) return false;
  const normalized = hostHeader.toLowerCase();
  return (
    normalized === `${boundHost}:${boundPort}`.toLowerCase()
    || normalized === `localhost:${boundPort}`
    || normalized === `127.0.0.1:${boundPort}`
  );
}

function isAllowedOrigin(originHeader: string | undefined, boundHost: string, boundPort: number): boolean {
  if (!originHeader) return true;
  const normalized = originHeader.toLowerCase();
  return (
    normalized === `http://${boundHost}:${boundPort}`.toLowerCase()
    || normalized === `http://localhost:${boundPort}`
    || normalized === `http://127.0.0.1:${boundPort}`
  );
}

function isAllowedFetchSite(headerValue: string | string[] | undefined): boolean {
  if (headerValue === undefined) return false;
  const raw = (Array.isArray(headerValue) ? headerValue[0] : headerValue) ?? "";
  return raw.trim().toLowerCase() === "same-origin";
}

function isAllowedReviewNavigation(request: IncomingMessage): boolean {
  const fetchMode = request.headers["sec-fetch-mode"];
  const mode = (Array.isArray(fetchMode) ? fetchMode[0] : fetchMode)?.trim().toLowerCase() ?? "";
  if (mode === "no-cors") {
    return false;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  const site = (Array.isArray(fetchSite) ? fetchSite[0] : fetchSite)?.trim().toLowerCase() ?? "";
  if (site === "cross-site" && mode !== "navigate") {
    return false;
  }
  if (mode && mode !== "navigate" && mode !== "same-origin" && mode !== "cors") {
    return false;
  }
  return true;
}

export async function createMtGateway(options: MtGatewayOptions): Promise<MtGatewayServer> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const productName = options.productName ?? BRIDGE_PRODUCT_NAME;
  const desktopVersion = options.desktopVersion ?? BRIDGE_VERSION;
  const toolName = options.toolName?.trim() || "@langlink/memoq-bridge";
  const toolInfo: ReviewToolInfo = { name: toolName, version: desktopVersion };
  const controlToken = options.controlToken ?? randomUUID().replace(/-/gu, "");
  const candidateReviewToken = typeof options.reviewToken === "string" ? options.reviewToken.trim() : "";
  const reviewToken =
    candidateReviewToken.length >= 24 && candidateReviewToken !== controlToken
      ? candidateReviewToken
      : randomBytes(24).toString("hex");
  const aggregateJobs = new Map<string, Promise<MtTranslateResponse>>();

  function getReviewUrl(): string {
    return `http://${host}:${actualPort}/review?token=${reviewToken}`;
  }

  function effectiveMode(): "staging" | "dsh-live" {
    if (options.mode) return options.mode;
    const cfg = options.getLiveConfig?.();
    return cfg?.mode === "staging_then_live" && options.liveTranslator ? "dsh-live" : "staging";
  }

  async function processTranslate(payload: MtTranslateRequest): Promise<{ statusCode: number; body: MtTranslateResponse }> {
    const requestId = payload.requestId || randomUUID().replace(/-/gu, "");
    const traceId = payload.traceId || randomUUID().replace(/-/gu, "");

    if (payload.contractVersion !== undefined && String(payload.contractVersion) !== CONTRACT_VERSION) {
      return {
        statusCode: 409,
        body: {
          success: false,
          requestId,
          traceId,
          nonRetryableSegmentIndexes: payload.segments.map((s) => s.index),
          error: {
            code: ERROR_CODES.contractVersionMismatch,
            message: `Desktop contract version ${CONTRACT_VERSION} is required.`,
          },
          translations: [],
        },
      };
    }

    const sourceLanguage = String(payload.sourceLanguage ?? "").trim();
    const targetLanguage = String(payload.targetLanguage ?? "").trim();
    if (!sourceLanguage || !targetLanguage || !Array.isArray(payload.segments)) {
      return {
        statusCode: 400,
        body: {
          success: false,
          requestId,
          traceId,
          error: {
            code: ERROR_CODES.requestPayloadInvalid,
            message: "sourceLanguage, targetLanguage, and segments are required.",
          },
          translations: [],
        },
      };
    }

    const documentId = String(payload.metadata?.documentId ?? "").trim();
    const segmentMetaList = payload.metadata?.segmentLevelMetadata ?? [];
    const translations: MtSegmentResult[] = [];
    const missedSegments: MtSegmentRequest[] = [];
    const nonRetryableIndexes = new Set<number>();
    const rejectionNotes: string[] = [];

    const liveConfig = options.getLiveConfig?.();
    const autoAlignTags = liveConfig?.autoAlignTags === true && typeof options.tagAligner === "function";

    const recordRecent = (seg: MtSegmentRequest, reason: string): void => {
      const segMeta = segmentMetaList.find((m) => m.segmentIndex === seg.index);
      options.stagingStore.recordRecentRequest({
        requestId,
        receivedAt: new Date().toISOString(),
        documentId,
        projectId: String(payload.metadata?.projectId ?? ""),
        client: String(payload.metadata?.client ?? ""),
        domain: String(payload.metadata?.domain ?? ""),
        subject: String(payload.metadata?.subject ?? ""),
        sourceLanguage,
        targetLanguage,
        requestType: String(payload.requestType ?? "Plaintext"),
        index: seg.index,
        ...(segMeta?.segmentIndex === undefined ? {} : { segmentIndex: segMeta.segmentIndex }),
        text: seg.text,
        plainText: seg.plainText ?? seg.text,
        hasInlineTags: hasMqInlineTags(seg.text),
        tmSource: seg.tmSource ?? "",
        tmTarget: seg.tmTarget ?? "",
        reason,
      });
    };

    for (const seg of payload.segments) {
      const staged = options.stagingStore.findStaged({
        ...(documentId ? { documentId } : {}),
        sourceLanguage,
        targetLanguage,
        text: seg.text,
        ...(seg.plainText === undefined ? {} : { plainText: seg.plainText }),
      });

      if (!staged) {
        const pendingDraft = options.stagingStore.findPendingDraft({
          ...(documentId ? { documentId } : {}),
          sourceLanguage,
          targetLanguage,
          text: seg.text,
          ...(seg.plainText === undefined ? {} : { plainText: seg.plainText }),
        });
        if (pendingDraft) {
          nonRetryableIndexes.add(seg.index);
          rejectionNotes.push(
            `Segment ${seg.index} has a pending ${pendingDraft.status} translation awaiting approval. Approve it in the Review Workbench or via memoq_approve_staged before running Pre-translate.`,
          );
          recordRecent(seg, "staged_draft_pending_approval");
          continue;
        }
        missedSegments.push(seg);
        continue;
      }

      const incomingHasTags = hasMqInlineTags(seg.text);
      const incomingHasBr = !incomingHasTags && hasInlineTagOrBr(seg.text);
      const incomingIsHtml = isHtmlRequestType(payload.requestType);
      const preferredTarget = staged.targetHtml || staged.targetText;
      if (!incomingHasTags) {
        let resolvedText = preferredTarget;
        if (incomingHasBr && !staged.targetHtml) {
          const brRestored =
            restoreInlineTagsFromStaged(seg.text, staged.sourceText, staged.targetText, payload.requestType)
            ?? (staged.sourceHtml
              ? restoreInlineTagsFromStaged(seg.text, staged.sourceHtml, staged.targetText, payload.requestType)
              : null);
          if (brRestored !== null) {
            resolvedText = brRestored;
          }
        } else if (
          !staged.targetHtml
          && incomingIsHtml
          && !hasMqInlineTags(staged.targetText)
          && !hasInlineTagOrBr(staged.targetText)
          && /[<>&]/u.test(staged.targetText)
        ) {
          resolvedText = escapeHtmlText(staged.targetText);
        }

        translations.push({
          index: seg.index,
          text: resolvedText,
          confidence: 0,
          info: staged.info,
          historyRequestId: requestId,
          historySegmentIndex: seg.index,
        });
        options.stagingStore.resolveRecentRequest({
          ...(documentId ? { documentId } : {}),
          sourceLanguage,
          targetLanguage,
          text: seg.text,
          ...(seg.plainText === undefined ? {} : { plainText: seg.plainText }),
        });
        continue;
      }

      const tagCheck = verifyInlineTagInventory(seg.text, preferredTarget);
      if (tagCheck.ok) {
        translations.push({
          index: seg.index,
          text: preferredTarget,
          confidence: 0,
          info: staged.info,
          historyRequestId: requestId,
          historySegmentIndex: seg.index,
        });
        options.stagingStore.resolveRecentRequest({
          ...(documentId ? { documentId } : {}),
          sourceLanguage,
          targetLanguage,
          text: seg.text,
          ...(seg.plainText === undefined ? {} : { plainText: seg.plainText }),
        });
        continue;
      }

      const deterministic =
        restoreInlineTagsFromStaged(seg.text, staged.sourceText, staged.targetText, payload.requestType)
        ?? (staged.sourceHtml
          ? restoreInlineTagsFromStaged(seg.text, staged.sourceHtml, staged.targetText, payload.requestType)
          : null);
      if (deterministic !== null) {
        translations.push({
          index: seg.index,
          text: deterministic,
          confidence: 0,
          info: `${staged.info} | Tags restored`,
          historyRequestId: requestId,
          historySegmentIndex: seg.index,
        });
        options.stagingStore.resolveRecentRequest({
          ...(documentId ? { documentId } : {}),
          sourceLanguage,
          targetLanguage,
          text: seg.text,
          ...(seg.plainText === undefined ? {} : { plainText: seg.plainText }),
        });
        continue;
      }

      if (autoAlignTags && options.tagAligner) {
        const aligned = await options.tagAligner({
          sourceHtml: seg.text,
          stagedTarget: preferredTarget,
          sourceLanguage,
          targetLanguage,
        });
        if (aligned && verifyInlineTagInventory(seg.text, aligned).ok) {
          translations.push({
            index: seg.index,
            text: aligned,
            confidence: 0,
            info: `${staged.info} | Tags aligned by DSH`,
            historyRequestId: requestId,
            historySegmentIndex: seg.index,
          });
          options.stagingStore.resolveRecentRequest({
            ...(documentId ? { documentId } : {}),
            sourceLanguage,
            targetLanguage,
            text: seg.text,
            ...(seg.plainText === undefined ? {} : { plainText: seg.plainText }),
          });
          continue;
        }
      }

      if (staged.tagPolicy === "plaintext-fallback") {
        translations.push({
          index: seg.index,
          text: staged.targetText,
          confidence: 0,
          info: `${staged.info} | Plaintext fallback (restore inline tags)`,
          historyRequestId: requestId,
          historySegmentIndex: seg.index,
        });
        options.stagingStore.resolveRecentRequest({
          ...(documentId ? { documentId } : {}),
          sourceLanguage,
          targetLanguage,
          text: seg.text,
          ...(seg.plainText === undefined ? {} : { plainText: seg.plainText }),
        });
        continue;
      }

      nonRetryableIndexes.add(seg.index);
      rejectionNotes.push(`Segment ${seg.index}: inline tags required (${tagCheck.missing.join(", ")})`);
      recordRecent(seg, "inline_tags_required");
    }

    let liveProviderId = "langlink-staging";
    let liveModel = "agent-staged";

    if (missedSegments.length > 0) {
      const canUseLive = Boolean(options.liveTranslator) && (liveConfig?.mode ?? "staging_only") === "staging_then_live";
      if (canUseLive && options.liveTranslator) {
        try {
          const liveResult = await options.liveTranslator({
            request: payload,
            segments: missedSegments,
          });
          if (liveResult.providerId) liveProviderId = liveResult.providerId;
          if (liveResult.model) liveModel = liveResult.model;

          const returnedIndexes = new Set<number>();
          for (const item of liveResult.translations) {
            returnedIndexes.add(item.index);
            translations.push({
              ...item,
              confidence: 0,
              historyRequestId: item.historyRequestId ?? requestId,
              historySegmentIndex: item.historySegmentIndex ?? item.index,
            });
          }
          for (const idx of liveResult.rejectedIndexes ?? []) {
            nonRetryableIndexes.add(idx);
          }
          for (const missed of missedSegments) {
            const succeeded = returnedIndexes.has(missed.index);
            if (!succeeded) {
              nonRetryableIndexes.add(missed.index);
            } else {
              options.stagingStore.resolveRecentRequest({
                ...(documentId ? { documentId } : {}),
                sourceLanguage,
                targetLanguage,
                text: missed.text,
                ...(missed.plainText === undefined ? {} : { plainText: missed.plainText }),
              });
            }
            recordRecent(missed, succeeded ? "live_fallback" : "live_fallback_failed");
          }
          if (liveResult.errorMessage) {
            rejectionNotes.push(liveResult.errorMessage);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          rejectionNotes.push(`DSH live MT error: ${message}`);
          for (const missed of missedSegments) {
            nonRetryableIndexes.add(missed.index);
            recordRecent(missed, "live_fallback_error");
          }
        }
      } else {
        for (const missed of missedSegments) {
          nonRetryableIndexes.add(missed.index);
          recordRecent(missed, "not_staged");
        }
        const snippet = (missedSegments[0]?.plainText || missedSegments[0]?.text || "")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 60);
        rejectionNotes.push(
          `Segment not staged yet (${snippet ? `"${snippet}"` : "empty"}). Open LangLink Review Workbench or ask your agent to call memoq_get_recent_mt_requests to translate & stage missed segments.`,
        );
      }
    }

    translations.sort((left, right) => left.index - right.index);
    const nonRetryableList = Array.from(nonRetryableIndexes).sort((a, b) => a - b);

    if (translations.length === 0) {
      return {
        statusCode: 200,
        body: {
          success: false,
          requestId,
          traceId,
          providerId: liveProviderId,
          model: liveModel,
          nonRetryableSegmentIndexes: nonRetryableList,
          nonRetryableSegments: nonRetryableList.map((idx) => ({
            index: idx,
            historyRequestId: requestId,
            historySegmentIndex: idx,
          })),
          error: {
            code: ERROR_CODES.translationFailed,
            message: rejectionNotes[0] ?? "No staged or live translation available for this segment.",
          },
          translations: [],
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        success: true,
        requestId,
        traceId,
        providerId: liveProviderId,
        model: liveModel,
        partial: nonRetryableList.length > 0,
        ...(nonRetryableList.length > 0
          ? {
              nonRetryableSegmentIndexes: nonRetryableList,
              nonRetryableSegments: nonRetryableList.map((idx) => ({
                index: idx,
                historyRequestId: requestId,
                historySegmentIndex: idx,
              })),
            }
          : {}),
        translations,
      },
    };
  }

  let actualPort = requestedPort;
  const server = createServer((request, response) => {
    void (async () => {
      if (!isAllowedLoopbackHost(request.headers.host, host, actualPort)) {
        sendJson(response, 403, {
          success: false,
          error: { code: "GATEWAY_HOST_REJECTED", message: "Rejected request host." },
        });
        return;
      }
      if (!isAllowedOrigin(request.headers.origin, host, actualPort)) {
        sendJson(response, 403, {
          success: false,
          error: { code: "GATEWAY_ORIGIN_REJECTED", message: "Rejected request origin." },
        });
        return;
      }

      const url = new URL(request.url ?? "/", `http://${host}:${actualPort}`);
      const pathname = url.pathname;
      const method = (request.method ?? "GET").toUpperCase();

      if (pathname === "/review" || pathname.startsWith("/review/")) {
        await handleReviewRoute(method, pathname, url, request, response);
        return;
      }

      if (pathname.startsWith("/bridge/")) {
        if (!safeBearerEquals(request.headers.authorization, controlToken)) {
          sendJson(response, 401, { success: false, error: { code: "UNAUTHORIZED", message: "Valid control token is required." } });
          return;
        }
        await handleControlRoute(method, pathname, url, request, response);
        return;
      }

      if (method === "GET" && pathname === ROUTES.health) {
        sendJson(response, 200, {
          ok: true,
          productName,
          toolName,
          mode: effectiveMode(),
          contractVersion: CONTRACT_VERSION,
          desktopVersion,
        });
        return;
      }

      if (method === "GET" && pathname === ROUTES.desktopVersion) {
        sendJson(response, 200, {
          productName,
          toolName,
          desktopVersion,
          contractVersion: CONTRACT_VERSION,
        });
        return;
      }

      if (method === "POST" && pathname === ROUTES.mtTranslate) {
        const body = (await readJsonBody(request)) as MtTranslateRequest;
        const result = await processTranslate(body);
        sendJson(response, result.statusCode, result.body);
        return;
      }

      if (method === "POST" && pathname === ROUTES.mtTranslateAggregate) {
        const body = (await readJsonBody(request)) as MtTranslateRequest;
        const requestId = body.requestId || randomUUID().replace(/-/gu, "");
        const traceId = body.traceId || randomUUID().replace(/-/gu, "");
        const jobRequestId = randomUUID();
        const aggregationGroupId = String(body.metadata?.documentId || body.metadata?.projectGuid || "default");

        const jobPromise = processTranslate({ ...body, requestId, traceId }).then((res) => ({
          ...res.body,
          jobRequestId,
          aggregationGroupId,
          pending: false,
        }));
        aggregateJobs.set(jobRequestId, jobPromise);
        if (aggregateJobs.size > MAX_AGGREGATE_JOBS) {
          const oldest = aggregateJobs.keys().next().value;
          if (oldest) aggregateJobs.delete(oldest);
        }

        const submitResponse: MtAggregateSubmitResponse = {
          success: true,
          requestId,
          traceId,
          jobRequestId,
          aggregationGroupId,
        };
        sendJson(response, 200, submitResponse);
        return;
      }

      if (method === "POST" && pathname === ROUTES.mtTranslateAggregateResult) {
        const body = (await readJsonBody(request)) as MtAggregateResultRequest;
        const job = aggregateJobs.get(String(body.jobRequestId ?? ""));
        if (!job) {
          sendJson(response, 404, {
            success: false,
            requestId: body.requestId ?? "",
            traceId: body.traceId ?? "",
            error: { code: "AGGREGATE_JOB_NOT_FOUND", message: "Aggregate translation job was not found." },
            translations: [],
          });
          return;
        }
        const result = await job;
        aggregateJobs.delete(String(body.jobRequestId ?? ""));
        sendJson(response, 200, result);
        return;
      }

      if (method === "POST" && pathname === ROUTES.mtStoreTranslations) {
        const body = (await readJsonBody(request)) as MtStoreTranslationsRequest;
        const requestId = body.requestId || randomUUID().replace(/-/gu, "");
        const traceId = body.traceId || randomUUID().replace(/-/gu, "");

        if (body.contractVersion !== undefined && String(body.contractVersion) !== CONTRACT_VERSION) {
          sendJson(response, 409, {
            success: false,
            requestId,
            traceId,
            error: {
              code: ERROR_CODES.contractVersionMismatch,
              message: `Desktop contract version ${CONTRACT_VERSION} is required.`,
            },
          });
          return;
        }

        const sourceLanguage = String(body.sourceLanguage ?? "").trim();
        const targetLanguage = String(body.targetLanguage ?? "").trim();
        if (!sourceLanguage || !targetLanguage) {
          sendJson(response, 400, {
            success: false,
            requestId,
            traceId,
            error: {
              code: ERROR_CODES.requestNotEligible,
              message: "Translation writeback requires both sourceLanguage and targetLanguage.",
            },
          });
          return;
        }

        const storedCount = options.stagingStore.recordConfirmed(
          (Array.isArray(body.translations) ? body.translations : []).map((item) => ({
            sourceLanguage,
            targetLanguage,
            requestType: String(body.requestType ?? "Plaintext"),
            sourceText: String(item?.sourceText ?? ""),
            targetText: String(item?.targetText ?? ""),
          })),
        );
        sendJson(response, 200, {
          success: true,
          requestId,
          traceId,
          storedCount,
        });
        return;
      }

      sendJson(response, 404, { success: false, error: { code: "NOT_FOUND", message: `Unknown route: ${pathname}` } });
    })().catch((error: unknown) => {
      if (error instanceof BodyError) {
        sendJson(response, error.statusCode, { success: false, error: { code: error.code, message: error.message } });
        return;
      }
      sendJson(response, 500, {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });

  function handleStagedUpdatePayload(body: Record<string, unknown>): {
    statusCode: number;
    payload: Record<string, unknown>;
  } {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id) {
      const updated = options.stagingStore.updateStaged({
        id,
        ...(typeof body.targetText === "string" ? { targetText: body.targetText } : {}),
        ...(typeof body.targetHtml === "string" ? { targetHtml: body.targetHtml } : {}),
        ...(typeof body.editedBy === "string" ? { editedBy: body.editedBy } : {}),
        ...(body.status === "draft" || body.status === "approved" || body.status === "needs_revision"
          ? { status: body.status }
          : {}),
        ...(typeof body.reviewComment === "string" ? { reviewComment: body.reviewComment } : {}),
        ...(typeof body.revertToRevision === "number" && Number.isInteger(body.revertToRevision)
          ? { revertToRevision: body.revertToRevision }
          : {}),
      });
      if (!updated) {
        return { statusCode: 404, payload: { error: "Staged entry or target revision was not found." } };
      }
      return { statusCode: 200, payload: { entry: updated } };
    }

    const sourceText = typeof body.sourceText === "string" ? body.sourceText : "";
    const targetText = typeof body.targetText === "string" ? body.targetText : "";
    if (!sourceText.trim() || !targetText.trim()) {
      return { statusCode: 400, payload: { error: "id or non-empty sourceText + targetText are required." } };
    }

    const created = options.stagingStore.stageMany([
      {
        sourceText,
        targetText,
        ...(hasMqInlineTags(sourceText) ? { sourceHtml: sourceText } : {}),
        ...(hasMqInlineTags(targetText) ? { targetHtml: targetText } : {}),
        sourceLanguage: typeof body.sourceLanguage === "string" ? body.sourceLanguage : "eng",
        targetLanguage: typeof body.targetLanguage === "string" ? body.targetLanguage : "zho-CN",
        ...(typeof body.documentId === "string" ? { documentId: body.documentId } : {}),
        ...(typeof body.previewPartId === "string" ? { previewPartId: body.previewPartId } : {}),
        stagedBy: typeof body.editedBy === "string" ? body.editedBy : "translator",
        status:
          body.status === "approved" || body.status === "needs_revision" || body.status === "draft"
            ? body.status
            : "draft",
      },
    ]);
    return { statusCode: 200, payload: { entry: created.entries[0] ?? null } };
  }

  function handleStagedFeedbackPayload(body: Record<string, unknown>): {
    statusCode: number;
    payload: Record<string, unknown>;
  } {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const comment = typeof body.comment === "string" ? body.comment : "";
    const explicitStatus =
      body.status === "draft" || body.status === "approved" || body.status === "needs_revision"
        ? body.status
        : undefined;

    if (id) {
      const updated = options.stagingStore.setReviewFeedback({
        id,
        comment,
        ...(explicitStatus ? { status: explicitStatus } : {}),
      });
      if (!updated) {
        return { statusCode: 404, payload: { error: "Staged entry was not found." } };
      }
      return { statusCode: 200, payload: { entry: updated } };
    }

    const sourceText = typeof body.sourceText === "string" ? body.sourceText : "";
    if (!sourceText.trim()) {
      return { statusCode: 400, payload: { error: "id or sourceText is required for feedback." } };
    }
    const targetText =
      (typeof body.targetText === "string" && body.targetText.trim() ? body.targetText : "") || "(待翻译)";
    const created = options.stagingStore.stageMany([
      {
        sourceText,
        targetText,
        sourceLanguage: typeof body.sourceLanguage === "string" ? body.sourceLanguage : "eng",
        targetLanguage: typeof body.targetLanguage === "string" ? body.targetLanguage : "zho-CN",
        ...(typeof body.documentId === "string" ? { documentId: body.documentId } : {}),
        ...(typeof body.previewPartId === "string" ? { previewPartId: body.previewPartId } : {}),
        stagedBy: "translator",
        status: explicitStatus ?? "needs_revision",
        reviewComment: comment,
      },
    ]);
    return { statusCode: 200, payload: { entry: created.entries[0] ?? null } };
  }

  function runQaFromBody(body: Record<string, unknown>) {
    const scope: MemoqQaScope =
      body.scope === "memoq" || body.scope === "staged" || body.scope === "merged"
        ? body.scope
        : "merged";
    const enabledRules = Array.isArray(body.enabledRules)
      ? body.enabledRules.filter((value): value is string => typeof value === "string")
      : undefined;
    const whitelist = Array.isArray(body.whitelist)
      ? body.whitelist.filter((value): value is string => typeof value === "string")
      : undefined;
    const projectDir =
      typeof body.projectDir === "string"
        ? body.projectDir
        : options.getLiveConfig?.().projectDir;
    const rawDocId = typeof body.documentId === "string" ? body.documentId.trim() : "";
    const allDocuments = body.allDocuments === true || rawDocId === "__all__" || rawDocId === "*";
    let customRules;
    try {
      customRules = body.customRules !== undefined ? validateMemoqCustomRules(body.customRules) : undefined;
    } catch (error) {
      throw new BodyError(400, "INVALID_CUSTOM_RULES", error instanceof Error ? error.message : String(error));
    }

    return runMemoqQa({
      scope,
      ...(allDocuments ? { allDocuments: true } : {}),
      ...(!allDocuments && rawDocId ? { documentId: rawDocId } : {}),
      ...(enabledRules ? { enabledRules } : {}),
      ...(customRules ? { customRules } : {}),
      ...(typeof body.glossaryPath === "string" && body.glossaryPath.trim()
        ? { glossaryPath: body.glossaryPath.trim() }
        : {}),
      ...(projectDir?.trim() ? { projectDir: projectDir.trim() } : {}),
      ...(whitelist ? { whitelist } : {}),
      ...(typeof body.targetLocale === "string" && body.targetLocale.trim()
        ? { targetLocale: body.targetLocale.trim() }
        : {}),
      ...(typeof body.maxIssues === "number" && Number.isFinite(body.maxIssues)
        ? { maxIssues: body.maxIssues }
        : {}),
      ...(typeof body.issueOffset === "number" && Number.isSafeInteger(body.issueOffset) && body.issueOffset >= 0
        ? { issueOffset: body.issueOffset }
        : {}),
      ...(body.includeSegments === false ? { includeSegments: false } : {}),
      ...(options.previewClient ? { previewClient: options.previewClient } : {}),
      stagingStore: options.stagingStore,
    });
  }

  function buildUnifiedDocumentsSummary() {
    const previewDocs = options.previewClient?.listDocuments() ?? [];
    const allStaged = options.stagingStore.listStaged({ status: "all", limit: DEFAULT_MAX_STAGED });
    const countsByDoc = new Map<string, { approved: number; draft: number; needsRevision: number; total: number }>();
    const metaByDoc = new Map<string, { sourceLanguage: string; targetLanguage: string }>();

    for (const item of allStaged.items) {
      const key = item.documentId.trim().toLowerCase();
      let bucket = countsByDoc.get(key);
      if (!bucket) {
        bucket = { approved: 0, draft: 0, needsRevision: 0, total: 0 };
        countsByDoc.set(key, bucket);
      }
      bucket.total += 1;
      if (item.status === "approved") bucket.approved += 1;
      else if (item.status === "needs_revision") bucket.needsRevision += 1;
      else bucket.draft += 1;

      if (!metaByDoc.has(key)) {
        metaByDoc.set(key, { sourceLanguage: item.sourceLanguage, targetLanguage: item.targetLanguage });
      }
    }

    const seenKeys = new Set<string>();
    const unified = previewDocs.map((doc) => {
      const key = doc.documentId.toLowerCase();
      seenKeys.add(key);
      const docSpecific = countsByDoc.get(key) ?? { approved: 0, draft: 0, needsRevision: 0, total: 0 };
      const sharedGlobal = key ? (countsByDoc.get("") ?? { approved: 0, draft: 0, needsRevision: 0, total: 0 }) : { approved: 0, draft: 0, needsRevision: 0, total: 0 };
      return {
        ...doc,
        fromPreview: true,
        stagedCounts: {
          approved: docSpecific.approved + sharedGlobal.approved,
          draft: docSpecific.draft + sharedGlobal.draft,
          needsRevision: docSpecific.needsRevision + sharedGlobal.needsRevision,
          total: docSpecific.total + sharedGlobal.total,
        },
      };
    });

    for (const [key, bucket] of countsByDoc) {
      if (!key || seenKeys.has(key)) continue;
      const sample = allStaged.items.find((e) => e.documentId.toLowerCase() === key);
      const langs = metaByDoc.get(key);
      unified.push({
        documentId: sample?.documentId ?? key,
        documentName: sample?.documentId ?? key,
        importPath: "",
        sourceLanguage: langs?.sourceLanguage ?? "",
        targetLanguage: langs?.targetLanguage ?? "",
        segmentCount: 0,
        translatedCount: 0,
        untranslatedCount: 0,
        isActive: false,
        updatedAt: sample?.updatedAt ?? "",
        fromPreview: false,
        stagedCounts: bucket,
      });
    }

    return { unified, allStaged };
  }

  function buildCoverageSummary(scopedDocumentId?: string) {
    const rawDocId = (scopedDocumentId ?? "").trim();
    const isAllMode = rawDocId === "__all__" || rawDocId === "*";
    const resolvedDocId = !isAllMode && rawDocId ? rawDocId : undefined;
    const missedPretranslate = summarizeMissedRequests(options.stagingStore, {
      ...(resolvedDocId ? { documentId: resolvedDocId } : {}),
      limit: 50,
    });

    const previewDocs = options.previewClient?.listDocuments() ?? [];
    const targetDocs = isAllMode
      ? previewDocs
      : resolvedDocId
        ? previewDocs.filter((d) => d.documentId.toLowerCase() === resolvedDocId.toLowerCase())
        : previewDocs.filter((d) => d.isActive);
    const inspectDocs =
      targetDocs.length > 0 ? targetDocs : (!resolvedDocId && !isAllMode ? previewDocs.slice(0, 1) : []);

    const uncoveredSamples: Array<{
      documentId: string;
      documentName: string;
      previewPartId: string;
      docSegmentNumber: number;
      sourceText: string;
    }> = [];
    let uncoveredPreviewCount = 0;

    for (const d of inspectDocs) {
      const collected = collectAllPreviewSegments(options.previewClient, d.documentId);
      for (const seg of collected.segments) {
        if (seg.targetText.trim()) continue;
        const hit = options.stagingStore.peekStaged({
          documentId: d.documentId,
          sourceLanguage: d.sourceLanguage,
          targetLanguage: d.targetLanguage,
          text: seg.sourceText,
          plainText: seg.sourceText,
        });
        if (hit) continue;
        const pending = options.stagingStore.findPendingDraft({
          documentId: d.documentId,
          sourceLanguage: d.sourceLanguage,
          targetLanguage: d.targetLanguage,
          text: seg.sourceText,
          plainText: seg.sourceText,
        });
        if (pending) continue;
        uncoveredPreviewCount += 1;
        if (uncoveredSamples.length < 15) {
          uncoveredSamples.push({
            documentId: d.documentId,
            documentName: d.documentName || d.documentId,
            previewPartId: seg.previewPartId,
            docSegmentNumber: seg.index + 1,
            sourceText: seg.sourceText,
          });
        }
      }
    }

    const stagedScope = options.stagingStore.listStaged({
      ...(resolvedDocId ? { documentId: resolvedDocId } : {}),
      status: "all",
      limit: 1,
    });
    const pendingDraftCount = stagedScope.counts.draft + stagedScope.counts.needsRevision;

    const notes: string[] = [];
    if (missedPretranslate.count > 0) {
      notes.push(
        `memoQ Pre-translate 有 ${missedPretranslate.count} 条句段未命中，请调用 memoq_get_recent_mt_requests 补全或在审校工作台处理。`,
      );
    }
    if (uncoveredPreviewCount > 0) {
      notes.push(`Preview 当前文档仍有 ${uncoveredPreviewCount} 条空译句段尚未暂存。`);
    }
    if (pendingDraftCount > 0) {
      notes.push(`仍有 ${stagedScope.counts.draft} 条草稿与 ${stagedScope.counts.needsRevision} 条需修订暂存未放行。`);
    }

    return {
      missedPretranslate,
      uncoveredPreviewCount,
      uncoveredSamples,
      pendingDraftCount,
      missedPretranslateCount: missedPretranslate.count,
      attentionMessage: notes.join(" "),
    };
  }

  async function handleReviewRoute(
    method: string,
    pathname: string,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");

    if (method === "GET" && pathname === "/review") {
      if (!isAllowedReviewNavigation(request)) {
        sendJson(response, 403, { success: false, error: "Rejected non-navigation review page fetch." });
        return;
      }

      const hasQueryTokenParam = url.searchParams.has("token");
      const queryToken = url.searchParams.get("token") ?? undefined;
      const cookieToken = readCookieValue(request.headers.cookie, REVIEW_COOKIE_NAME);
      const authenticatedByQuery = hasQueryTokenParam && safeTokenEquals(queryToken, reviewToken);
      const authenticatedByCookie = !hasQueryTokenParam && safeTokenEquals(cookieToken, reviewToken);

      if (!authenticatedByQuery && !authenticatedByCookie) {
        sendHtml(
          response,
          401,
          renderReviewUnauthorizedHtml(),
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        );
        return;
      }

      const nonce = randomBytes(16).toString("base64");
      const csp =
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
      const initialDocName = options.previewClient?.getStatus().activeDocumentName;
      sendHtml(
        response,
        200,
        renderReviewWorkbenchHtml({
          nonce,
          reviewToken,
          tool: toolInfo,
          ...(initialDocName ? { initialDocumentName: initialDocName } : {}),
        }),
        csp,
        authenticatedByQuery
          ? {
              "Set-Cookie": `${REVIEW_COOKIE_NAME}=${reviewToken}; HttpOnly; SameSite=Strict; Path=/review; Max-Age=${REVIEW_COOKIE_MAX_AGE_SECONDS}`,
            }
          : undefined,
      );
      return;
    }

    if (!isAllowedFetchSite(request.headers["sec-fetch-site"])) {
      sendJson(response, 403, { success: false, error: "Cross-site or missing Sec-Fetch-Site review API requests are not allowed." });
      return;
    }

    const headerToken = request.headers["x-review-token"];
    const providedHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!safeTokenEquals(providedHeader, reviewToken)) {
      sendJson(response, 401, {
        success: false,
        code: "REVIEW_TOKEN_REQUIRED",
        error: "Valid review token is required.",
      });
      return;
    }

    if (method === "GET" && pathname === "/review/api/state") {
      const previewStatus = options.previewClient?.getStatus() ?? null;
      const requestedDocId = (url.searchParams.get("documentId") ?? "").trim();
      const isAllMode = requestedDocId === "__all__" || requestedDocId === "*";
      const { unified, allStaged } = buildUnifiedDocumentsSummary();

      let selectedDocumentId = "";
      let activeDocument: {
        documentId: string;
        documentName: string;
        sourceLanguage: string;
        targetLanguage: string;
      };
      let previewSegments: Array<{
        index: number;
        docSegmentNumber?: number;
        previewPartId: string;
        sourceText: string;
        targetText: string;
        isActive: boolean;
        documentId?: string;
        documentName?: string;
        sourceLanguage?: string;
        targetLanguage?: string;
      }> = [];
      let filteredItems = allStaged.items;

      if (isAllMode) {
        selectedDocumentId = "__all__";
        const previewDocs = options.previewClient?.listDocuments() ?? [];
        for (const d of previewDocs) {
          const collected = collectAllPreviewSegments(options.previewClient, d.documentId);
          for (const seg of collected.segments) {
            previewSegments.push({
              ...seg,
              index: previewSegments.length,
              docSegmentNumber: seg.index + 1,
              documentId: d.documentId,
              documentName: d.documentName || d.documentId,
              sourceLanguage: d.sourceLanguage,
              targetLanguage: d.targetLanguage,
            });
          }
        }
        activeDocument = {
          documentId: "__all__",
          documentName: `全部已打开文档 (${unified.length})`,
          sourceLanguage: previewDocs[0]?.sourceLanguage ?? allStaged.items[0]?.sourceLanguage ?? "",
          targetLanguage: previewDocs[0]?.targetLanguage ?? allStaged.items[0]?.targetLanguage ?? "",
        };
      } else {
        const previewSegRes = collectAllPreviewSegments(
          options.previewClient,
          requestedDocId || undefined,
        );
        const resolvedId = (
          requestedDocId
          || previewSegRes.document?.documentId
          || previewStatus?.activeDocumentId
          || ""
        ).trim();
        selectedDocumentId = resolvedId;
        const matchedDocMeta = unified.find((d) => d.documentId.toLowerCase() === resolvedId.toLowerCase());
        const docName =
          previewSegRes.document?.documentName
          || matchedDocMeta?.documentName
          || previewStatus?.activeDocumentName
          || "";
        const srcLang =
          previewSegRes.document?.sourceLanguage
          || matchedDocMeta?.sourceLanguage
          || previewStatus?.activeSourceLanguage
          || "";
        const tgtLang =
          previewSegRes.document?.targetLanguage
          || matchedDocMeta?.targetLanguage
          || previewStatus?.activeTargetLanguage
          || "";
        previewSegments = previewSegRes.segments.map((seg) => ({
          ...seg,
          docSegmentNumber: seg.index + 1,
          ...(resolvedId ? { documentId: resolvedId } : {}),
          ...(docName ? { documentName: docName } : {}),
          ...(srcLang ? { sourceLanguage: srcLang } : {}),
          ...(tgtLang ? { targetLanguage: tgtLang } : {}),
        }));
        filteredItems = resolvedId
          ? allStaged.items.filter(
              (entry) => !entry.documentId || entry.documentId.toLowerCase() === resolvedId.toLowerCase(),
            )
          : allStaged.items;
        activeDocument = {
          documentId: resolvedId || filteredItems[0]?.documentId || "",
          documentName: docName,
          sourceLanguage: srcLang || filteredItems[0]?.sourceLanguage || "",
          targetLanguage: tgtLang || filteredItems[0]?.targetLanguage || "",
        };
      }

      const counts = { approved: 0, draft: 0, needsRevision: 0 };
      for (const item of filteredItems) {
        if (item.status === "approved") counts.approved += 1;
        else if (item.status === "needs_revision") counts.needsRevision += 1;
        else counts.draft += 1;
      }

      const coverageSummary = buildCoverageSummary(selectedDocumentId || undefined);

      sendJson(response, 200, {
        preview: previewStatus,
        selectedDocumentId,
        documents: unified,
        document: activeDocument,
        previewSegments,
        staged: {
          total: filteredItems.length,
          counts,
          items: filteredItems,
        },
        missedMt: coverageSummary.missedPretranslate,
        coverage: {
          uncoveredPreviewCount: coverageSummary.uncoveredPreviewCount,
          uncoveredSamples: coverageSummary.uncoveredSamples,
          pendingDraftCount: coverageSummary.pendingDraftCount,
          missedPretranslateCount: coverageSummary.missedPretranslateCount,
          attentionMessage: coverageSummary.attentionMessage,
        },
        qaCatalog: MEMOQ_QA_RULE_CATALOG,
        qaRuleGroups: MEMOQ_QA_RULE_GROUPS,
        tool: toolInfo,
        projectDir: options.getLiveConfig?.().projectDir ?? "",
        maxStaged: DEFAULT_MAX_STAGED,
      });
      return;
    }

    if (method === "POST" && pathname === "/review/api/update") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const res = handleStagedUpdatePayload(body);
      sendJson(response, res.statusCode, res.payload);
      return;
    }

    if (method === "POST" && pathname === "/review/api/feedback") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const res = handleStagedFeedbackPayload(body);
      sendJson(response, res.statusCode, res.payload);
      return;
    }

    if (method === "POST" && pathname === "/review/api/approve") {
      const body = (await readJsonBody(request)) as {
        ids?: string[];
        documentId?: string;
        status?: "approved" | "draft";
      };
      const rawDocId = typeof body.documentId === "string" ? body.documentId.trim() : "";
      const scopedDocId = rawDocId && rawDocId !== "__all__" && rawDocId !== "*" ? rawDocId : undefined;
      sendJson(
        response,
        200,
        options.stagingStore.approveStaged({
          ...(Array.isArray(body.ids) ? { ids: body.ids } : {}),
          ...(scopedDocId ? { documentId: scopedDocId } : {}),
          ...(body.status === "draft" || body.status === "approved" ? { status: body.status } : {}),
        }),
      );
      return;
    }

    if (method === "POST" && pathname === "/review/api/clear-missed") {
      const body = (await readJsonBody(request)) as { documentId?: string };
      const rawDocId = typeof body.documentId === "string" ? body.documentId.trim() : "";
      const scopedDocId = rawDocId && rawDocId !== "__all__" && rawDocId !== "*" ? rawDocId : undefined;
      sendJson(
        response,
        200,
        options.stagingStore.clearRecentRequests(scopedDocId ? { documentId: scopedDocId } : {}),
      );
      return;
    }

    if (method === "POST" && pathname === "/review/api/focus") {
      if (!options.previewClient) {
        sendJson(response, 400, { ok: false, error: "Preview client is not enabled." });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const result = await options.previewClient.focusSegment({
        previewPartId: String(body.previewPartId ?? ""),
        ...(typeof body.documentId === "string" ? { documentId: body.documentId } : {}),
        ...(typeof body.sourceText === "string" ? { sourceText: body.sourceText } : {}),
        ...(typeof body.targetText === "string" ? { targetText: body.targetText } : {}),
      });
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (method === "POST" && pathname === "/review/api/qa") {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      sendJson(response, 200, { ...runQaFromBody(body), tool: toolInfo });
      return;
    }

    const exportFormat = /^\/review\/api\/qa\/export\/(xlsx|csv|html)$/u.exec(pathname)?.[1] as
      | "xlsx"
      | "csv"
      | "html"
      | undefined;
    if (method === "POST" && exportFormat !== undefined) {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) {
          throw new BodyError(413, "REQUEST_BODY_TOO_LARGE", "The request body exceeds the 10 MB limit.");
        }
        chunks.push(chunk);
      }
      let reportPayload;
      try {
        reportPayload = validateReviewExportReport(new Uint8Array(Buffer.concat(chunks, total)));
      } catch (error) {
        throw new BodyError(400, "INVALID_EXPORT_REPORT", error instanceof Error ? error.message : String(error));
      }
      const artifact = await buildReviewExportArtifact(exportFormat, { ...reportPayload, tool: toolInfo });
      response.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="langlink-memoq-qa.${exportFormat}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(artifact.body);
      return;
    }

    sendJson(response, 404, { error: `Unknown review route: ${pathname}` });
  }

  async function handleControlRoute(
    method: string,
    pathname: string,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (method === "GET" && pathname === CONTROL_ROUTES.status) {
      const stagedOverview = options.stagingStore.listStaged({ limit: 1 });
      const { unified } = buildUnifiedDocumentsSummary();
      const coverageSummary = buildCoverageSummary();
      sendJson(response, 200, {
        gateway: {
          running: true,
          owner: "langlink-memoq-bridge",
          toolName,
          version: desktopVersion,
          mode: effectiveMode(),
          url: `http://${host}:${actualPort}`,
          contractVersion: CONTRACT_VERSION,
        },
        tool: toolInfo,
        reviewUrl: getReviewUrl(),
        preview: options.previewClient?.getStatus() ?? null,
        documents: unified,
        integration: options.getIntegrationStatus?.() ?? null,
        staging: { count: stagedOverview.total, counts: stagedOverview.counts, maxStaged: DEFAULT_MAX_STAGED },
        confirmed: { count: options.stagingStore.listConfirmed({ limit: 200 }).length },
        recentRequests: { count: options.stagingStore.listRecentRequests({ limit: 200 }).length },
        missedPretranslate: {
          count: coverageSummary.missedPretranslate.count,
          byReason: coverageSummary.missedPretranslate.byReason,
          items: coverageSummary.missedPretranslate.items.slice(0, 20),
        },
        coverage: {
          uncoveredPreviewCount: coverageSummary.uncoveredPreviewCount,
          uncoveredSamples: coverageSummary.uncoveredSamples,
          pendingDraftCount: coverageSummary.pendingDraftCount,
          missedPretranslateCount: coverageSummary.missedPretranslateCount,
          attentionMessage: coverageSummary.attentionMessage,
        },
        ...(options.getLiveConfig ? { liveConfig: options.getLiveConfig() } : {}),
      });
      return;
    }

    const previewRead = method === "GET" && (
      pathname === CONTROL_ROUTES.previewDocuments || pathname === CONTROL_ROUTES.previewActive || pathname === CONTROL_ROUTES.previewSegments
    );
    const desktopEditing = previewRead ? await options.previewClient?.preparePreview?.() : undefined;
    if (method === "GET" && pathname === CONTROL_ROUTES.previewDocuments) {
      const { unified } = buildUnifiedDocumentsSummary();
      sendJson(response, 200, {
        documents: unified,
        desktopEditing,
        previewConnected: Boolean(options.previewClient?.getStatus().connected),
      });
      return;
    }

    if (method === "GET" && pathname === CONTROL_ROUTES.previewActive) {
      if (!options.previewClient) {
        sendJson(response, 200, { available: false, mappingCertain: false, reason: "preview_disabled", above: [], below: [], activePreviewPartIds: [], revision: 0 });
        return;
      }
      const contextBefore = url.searchParams.get("contextBefore");
      const contextAfter = url.searchParams.get("contextAfter");
      const settleMs = url.searchParams.get("settleMs");
      const result = await options.previewClient.getActiveSegment({
        ...(contextBefore === null ? {} : { contextBefore: Number(contextBefore) }),
        ...(contextAfter === null ? {} : { contextAfter: Number(contextAfter) }),
        ...(settleMs === null ? {} : { settleMs: Number(settleMs) }),
      });
      sendJson(response, 200, { ...result, desktopEditing });
      return;
    }

    if (method === "GET" && pathname === CONTROL_ROUTES.previewSegments) {
      if (!options.previewClient) {
        sendJson(response, 200, { available: false, reason: "preview_disabled", total: 0, filtered: 0, offset: 0, limit: 50, segments: [] });
        return;
      }
      const documentId = url.searchParams.get("documentId") ?? undefined;
      const offset = url.searchParams.get("offset");
      const limit = url.searchParams.get("limit");
      const onlyUntranslated = url.searchParams.get("onlyUntranslated") === "true";
      const query = url.searchParams.get("query") ?? undefined;
      sendJson(
        response,
        200,
        { desktopEditing, ...options.previewClient.getDocumentSegments({
          ...(documentId === undefined ? {} : { documentId }),
          ...(offset === null ? {} : { offset: Number(offset) }),
          ...(limit === null ? {} : { limit: Number(limit) }),
          onlyUntranslated,
          ...(query === undefined ? {} : { query }),
        }) },
      );
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.previewRefresh) {
      await options.previewClient?.refreshParts();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.desktopEdits) {
      const parsed = desktopEditSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new BodyError(400, "INVALID_EDITS", parsed.error.message);
      const controller = new AbortController();
      response.once("close", () => controller.abort());
      if (!options.previewClient?.applyEdits) {
        sendJson(response, 200, { results: parsed.data.edits.map(({ previewPartId }) => ({
          previewPartId, status: "blocked", reason: "desktop_writer_unavailable",
        })) });
        return;
      }
      const result = await options.previewClient.applyEdits(parsed.data, controller.signal);
      if (!response.destroyed) sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.previewFocus) {
      if (!options.previewClient) {
        sendJson(response, 400, { ok: false, error: "Preview client is not enabled." });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const result = await options.previewClient.focusSegment({
        previewPartId: String(body.previewPartId ?? ""),
        ...(typeof body.documentId === "string" ? { documentId: body.documentId } : {}),
        ...(typeof body.sourceLangCode === "string" ? { sourceLangCode: body.sourceLangCode } : {}),
        ...(typeof body.targetLangCode === "string" ? { targetLangCode: body.targetLangCode } : {}),
        ...(typeof body.sourceText === "string" ? { sourceText: body.sourceText } : {}),
        ...(typeof body.targetText === "string" ? { targetText: body.targetText } : {}),
      });
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.stagingStage) {
      const body = (await readJsonBody(request)) as { items?: StageTranslationInput[] };
      const items = Array.isArray(body.items) ? body.items : [];
      const result = options.stagingStore.stageMany(items);
      sendJson(response, 200, result);
      return;
    }

    if (method === "GET" && pathname === CONTROL_ROUTES.stagingList) {
      const documentId = url.searchParams.get("documentId") ?? undefined;
      const offset = url.searchParams.get("offset");
      const limit = url.searchParams.get("limit");
      const statusParam = url.searchParams.get("status");
      const status: StagedReviewStatus | "all" | undefined =
        statusParam === "all" || statusParam === "draft" || statusParam === "approved" || statusParam === "needs_revision"
          ? statusParam
          : undefined;
      const onlyWithComment = url.searchParams.get("onlyWithComment") === "true";
      sendJson(
        response,
        200,
        options.stagingStore.listStaged({
          ...(documentId === undefined ? {} : { documentId }),
          ...(status === undefined ? {} : { status }),
          ...(onlyWithComment ? { onlyWithComment } : {}),
          ...(offset === null ? {} : { offset: Number(offset) }),
          ...(limit === null ? {} : { limit: Number(limit) }),
        }),
      );
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.stagingUpdate) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const res = handleStagedUpdatePayload(body);
      sendJson(response, res.statusCode, res.payload);
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.stagingFeedback) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const res = handleStagedFeedbackPayload(body);
      sendJson(response, res.statusCode, res.payload);
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.stagingApprove) {
      const body = (await readJsonBody(request)) as {
        ids?: string[];
        documentId?: string;
        status?: "approved" | "draft";
      };
      const rawDocId = typeof body.documentId === "string" ? body.documentId.trim() : "";
      const scopedDocId = rawDocId && rawDocId !== "__all__" && rawDocId !== "*" ? rawDocId : undefined;
      sendJson(
        response,
        200,
        options.stagingStore.approveStaged({
          ...(Array.isArray(body.ids) ? { ids: body.ids } : {}),
          ...(scopedDocId ? { documentId: scopedDocId } : {}),
          ...(body.status === "draft" || body.status === "approved" ? { status: body.status } : {}),
        }),
      );
      return;
    }

    if (method === "GET" && pathname === CONTROL_ROUTES.qaCatalog) {
      sendJson(response, 200, { rules: MEMOQ_QA_RULE_CATALOG });
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.qaRun) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      sendJson(response, 200, {
        ...runQaFromBody(body),
        reviewUrl: getReviewUrl(),
        tool: toolInfo,
      });
      return;
    }

    if (method === "GET" && pathname === CONTROL_ROUTES.reviewUrl) {
      sendJson(response, 200, { reviewUrl: getReviewUrl() });
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.stagingClear) {
      const body = (await readJsonBody(request)) as { documentId?: string };
      sendJson(
        response,
        200,
        options.stagingStore.clearStaged(body.documentId === undefined ? {} : { documentId: body.documentId }),
      );
      return;
    }

    if (method === "GET" && pathname === CONTROL_ROUTES.confirmedList) {
      const sourceLanguage = url.searchParams.get("sourceLanguage") ?? undefined;
      const targetLanguage = url.searchParams.get("targetLanguage") ?? undefined;
      const limit = url.searchParams.get("limit");
      sendJson(
        response,
        200,
        {
          items: options.stagingStore.listConfirmed({
            ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
            ...(targetLanguage === undefined ? {} : { targetLanguage }),
            ...(limit === null ? {} : { limit: Number(limit) }),
          }),
        },
      );
      return;
    }

    if (method === "GET" && pathname === CONTROL_ROUTES.recentRequests) {
      const limit = url.searchParams.get("limit");
      const onlyWithTags = url.searchParams.get("onlyWithTags") === "true";
      const items = options.stagingStore.listRecentRequests({
        ...(limit === null ? {} : { limit: Number(limit) }),
        onlyWithTags,
      });
      const summary = summarizeMissedRequests(options.stagingStore, { limit: 200 });
      const filteredMissed: MissedMtSummaryItem[] = onlyWithTags
        ? summary.items.filter((item) => item.hasInlineTags)
        : summary.items;
      sendJson(
        response,
        200,
        {
          items,
          deduplicatedMissed: filteredMissed,
          unresolvedCount: filteredMissed.length,
          byReason: summary.byReason,
        },
      );
      return;
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.recentRequestsClear) {
      const body = (await readJsonBody(request)) as { documentId?: string };
      const rawDocId = typeof body.documentId === "string" ? body.documentId.trim() : "";
      const scopedDocId = rawDocId && rawDocId !== "__all__" && rawDocId !== "*" ? rawDocId : undefined;
      sendJson(
        response,
        200,
        options.stagingStore.clearRecentRequests(scopedDocId ? { documentId: scopedDocId } : {}),
      );
      return;
    }

    if (pathname === CONTROL_ROUTES.liveConfig) {
      if (method === "GET") {
        sendJson(response, 200, { available: Boolean(options.getLiveConfig), config: options.getLiveConfig?.() ?? null });
        return;
      }
      if (method === "POST") {
        if (!options.updateLiveConfig) {
          sendJson(response, 400, { error: "Live MT configuration is only available in DSH." });
          return;
        }
        const patch = (await readJsonBody(request)) as Partial<LiveMtConfig>;
        sendJson(response, 200, { config: options.updateLiveConfig(patch) });
        return;
      }
    }

    if (method === "POST" && pathname === CONTROL_ROUTES.shutdown) {
      const triggerShutdown = options.onShutdown;
      if (!triggerShutdown) {
        sendJson(response, 400, { ok: false, error: "Graceful shutdown is not enabled for this host." });
        return;
      }
      response.setHeader("Connection", "close");
      response.once("finish", () => {
        setImmediate(() => {
          void Promise.resolve(triggerShutdown()).catch(() => {});
        });
      });
      sendJson(response, 200, { ok: true, shuttingDown: true });
      return;
    }

    sendJson(response, 404, { error: `Unknown control route: ${pathname}` });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind MT gateway socket.");
  }
  actualPort = addr.port;

  return {
    port: actualPort,
    host,
    baseUrl: `http://${host}:${actualPort}`,
    controlToken,
    reviewToken,
    reviewUrl: getReviewUrl(),
    close: () => {
      options.stagingStore.flush?.();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
    },
    handleTranslateForTest: processTranslate,
  };
}
