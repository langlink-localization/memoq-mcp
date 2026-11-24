import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  BRIDGE_PRODUCT_NAME,
  CONTROL_ROUTES,
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultBridgeDataDir,
  type GatewayOwner,
  type LiveMtConfig,
  type StagedReviewStatus,
} from "./contract.ts";
import { getIntegrationStatus, type IntegrationStatus } from "./dll-installer.ts";
import { createMtGateway, type LiveTranslator, type MtGatewayServer, type TagAligner } from "./mt-gateway.ts";
import {
  createPreviewClient,
  type ActiveSegmentResult,
  type CachedPreviewDocumentSummary,
  type DocumentSegmentsResult,
  type PreviewClient,
} from "./preview-client.ts";
import { MAX_MEMOQ_QA_PAGE_SIZE, type MemoqCustomQaRule, type MemoqQaReport, type MemoqQaRuleInfo, type MemoqQaScope } from "./qa-runner.ts";
import {
  atomicWriteTextSync,
  createStagingStore,
  type ConfirmedEntry,
  type MissedMtSummaryItem,
  type RecentMtRequestEntry,
  type StagedCounts,
  type StagedEntry,
  type StageTranslationInput,
  type StagingStore,
} from "./staging-store.ts";

export interface GatewayProbeResult {
  owner: GatewayOwner;
  url: string;
  productName?: string;
  mode?: string;
  desktopVersion?: string;
  error?: string;
}

export interface DaemonRecord {
  pid: number;
  host: string;
  port: number;
  controlToken: string;
  owner: string;
  version?: string;
  mode: "staging" | "dsh-live";
  startedAt: string;
}

function combineTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

export async function probeGatewayPort(
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  timeoutMs = 1500,
  signal?: AbortSignal,
): Promise<GatewayProbeResult> {
  const url = `http://${host}:${port}`;
  try {
    const response = await fetch(`${url}/health`, {
      signal: combineTimeoutSignal(timeoutMs, signal),
    });
    if (!response.ok) {
      return { owner: "other", url, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as Record<string, unknown>;
    const productName = String(data.productName ?? "").trim();
    if (productName === BRIDGE_PRODUCT_NAME) {
      return {
        owner: "langlink-memoq-bridge",
        url,
        productName,
        mode: String(data.mode ?? "staging"),
        desktopVersion: String(data.desktopVersion ?? ""),
      };
    }
    if (productName.toLowerCase() === "memoq ai hub") {
      return {
        owner: "memoq-ai-hub",
        url,
        productName,
        desktopVersion: String(data.desktopVersion ?? ""),
      };
    }
    return { owner: "other", url, ...(productName ? { productName } : {}) };
  } catch (error: unknown) {
    return {
      owner: "free",
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadOrCreateReviewToken(
  dataDir = defaultBridgeDataDir(),
  excludeToken?: string,
): string {
  const tokenPath = join(dataDir, "review-token.json");
  if (existsSync(tokenPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tokenPath, "utf8")) as { token?: unknown };
      const candidate = typeof parsed?.token === "string" ? parsed.token.trim() : "";
      if (/^[0-9a-f]{48,}$/iu.test(candidate) && candidate !== excludeToken) {
        return candidate;
      }
    } catch {
      // Fall through to generate a fresh persisted token.
    }
  }

  let token = randomBytes(24).toString("hex");
  while (token === excludeToken) {
    token = randomBytes(24).toString("hex");
  }
  atomicWriteTextSync(tokenPath, JSON.stringify({ token }, null, 2));
  if (process.platform !== "win32") {
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // Ignore permission errors on restricted filesystems.
    }
  }
  return token;
}

export function getDaemonRecordPath(dataDir = defaultBridgeDataDir()): string {
  return join(dataDir, "daemon.json");
}

export function readDaemonRecord(dataDir = defaultBridgeDataDir()): DaemonRecord | null {
  const path = getDaemonRecordPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonRecord>;
    if (!parsed.port || !parsed.controlToken) return null;
    return {
      pid: Number(parsed.pid ?? 0),
      host: String(parsed.host ?? DEFAULT_HOST),
      port: Number(parsed.port),
      controlToken: String(parsed.controlToken),
      owner: String(parsed.owner ?? "bridge"),
      ...(typeof parsed.version === "string" && parsed.version.trim() ? { version: parsed.version.trim() } : {}),
      mode: parsed.mode === "dsh-live" ? "dsh-live" : "staging",
      startedAt: String(parsed.startedAt ?? ""),
    };
  } catch {
    return null;
  }
}

export function writeDaemonRecord(record: DaemonRecord, dataDir = defaultBridgeDataDir()): void {
  const path = getDaemonRecordPath(dataDir);
  atomicWriteTextSync(path, JSON.stringify(record, null, 2));
}

export function removeDaemonRecord(expectedToken?: string, dataDir = defaultBridgeDataDir()): void {
  const path = getDaemonRecordPath(dataDir);
  if (!existsSync(path)) return;
  if (expectedToken) {
    const current = readDaemonRecord(dataDir);
    if (current && current.controlToken !== expectedToken) return;
  }
  rmSync(path, { force: true });
}

export class BridgeHttpClient {
  readonly baseUrl: string;
  readonly controlToken: string;

  constructor(baseUrl: string, controlToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.controlToken = controlToken;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.controlToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combineTimeoutSignal(10_000, signal),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const errObj = parsed as { error?: string };
      throw new Error(errObj?.error ?? `Bridge control request failed (${response.status})`);
    }
    return parsed as T;
  }

  getStatus(signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("GET", CONTROL_ROUTES.status, undefined, signal);
  }

  getActiveSegment(
    options: { contextBefore?: number; contextAfter?: number; settleMs?: number } = {},
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams();
    if (options.contextBefore !== undefined) params.set("contextBefore", String(options.contextBefore));
    if (options.contextAfter !== undefined) params.set("contextAfter", String(options.contextAfter));
    if (options.settleMs !== undefined) params.set("settleMs", String(options.settleMs));
    const qs = params.toString();
    return this.request<ActiveSegmentResult>("GET", `${CONTROL_ROUTES.previewActive}${qs ? `?${qs}` : ""}`, undefined, signal);
  }

  async getDocumentSegments(
    options: {
      documentId?: string;
      offset?: number;
      limit?: number;
      onlyUntranslated?: boolean;
      query?: string;
    } = {},
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams();
    if (options.documentId !== undefined) params.set("documentId", options.documentId);
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.onlyUntranslated) params.set("onlyUntranslated", "true");
    if (options.query !== undefined) params.set("query", options.query);
    const qs = params.toString();
    const result = await this.request<DocumentSegmentsResult>(
      "GET",
      `${CONTROL_ROUTES.previewSegments}${qs ? `?${qs}` : ""}`,
      undefined,
      signal,
    );
    const next = result.offset + result.segments.length;
    return { ...result, nextOffset: result.segments.length > 0 && next < result.filtered ? next : null };
  }

  refreshPreview(signal?: AbortSignal) {
    return this.request<{ ok: boolean }>("POST", CONTROL_ROUTES.previewRefresh, {}, signal);
  }

  focusSegment(
    params: {
      previewPartId: string;
      documentId?: string;
      sourceLangCode?: string;
      targetLangCode?: string;
      sourceText?: string;
      targetText?: string;
    },
    signal?: AbortSignal,
  ) {
    return this.request<{ ok: boolean; error?: string }>("POST", CONTROL_ROUTES.previewFocus, params, signal);
  }

  stageTranslations(items: StageTranslationInput[], signal?: AbortSignal) {
    return this.request<{ stagedCount: number; entries: StagedEntry[]; warnings: string[] }>(
      "POST",
      CONTROL_ROUTES.stagingStage,
      { items },
      signal,
    );
  }

  async listStaged(
    options: {
      documentId?: string;
      status?: StagedReviewStatus | "all";
      onlyWithComment?: boolean;
      offset?: number;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) {
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = options.limit;
    const params = new URLSearchParams();
    if (options.documentId !== undefined) params.set("documentId", options.documentId);
    if (options.status !== undefined) params.set("status", options.status);
    if (options.onlyWithComment) params.set("onlyWithComment", "true");
    if (options.offset !== undefined) params.set("offset", String(offset));
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    type StagedPage = {
      total: number;
      offset?: number;
      limit?: number;
      nextOffset?: number | null;
      counts: StagedCounts;
      items: StagedEntry[];
    };
    const res = await this.request<StagedPage>(
      "GET",
      `${CONTROL_ROUTES.stagingList}${qs ? `?${qs}` : ""}`,
      undefined,
      signal,
    );
    if (typeof res.offset === "number" && typeof res.limit === "number" && res.nextOffset !== undefined) {
      return {
        total: res.total,
        offset: res.offset,
        limit: res.limit,
        nextOffset: res.nextOffset,
        counts: res.counts,
        items: res.items,
      };
    }
    // Compatibility fallback when sharing a legacy running bridge that ignores `offset`.
    const effectiveLimit = limit ?? 100;
    const items = offset > 0 ? res.items.slice(offset, offset + effectiveLimit) : res.items.slice(0, effectiveLimit);
    const next = offset + items.length;
    return {
      total: res.total,
      offset,
      limit: effectiveLimit,
      nextOffset: items.length > 0 && next < res.total ? next : null,
      counts: res.counts,
      items,
    };
  }

  updateStaged(params: {
    id?: string;
    targetText?: string;
    targetHtml?: string;
    editedBy?: string;
    status?: StagedReviewStatus;
    reviewComment?: string;
    revertToRevision?: number;
    sourceText?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    documentId?: string;
    previewPartId?: string;
  }) {
    return this.request<{ entry: StagedEntry | null }>("POST", CONTROL_ROUTES.stagingUpdate, params);
  }

  setReviewFeedback(params: {
    id?: string;
    comment: string;
    status?: StagedReviewStatus;
    targetText?: string;
    sourceText?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    documentId?: string;
    previewPartId?: string;
  }) {
    return this.request<{ entry: StagedEntry | null }>("POST", CONTROL_ROUTES.stagingFeedback, params);
  }

  approveStaged(options: { ids?: string[]; documentId?: string; status?: "approved" | "draft" } = {}, signal?: AbortSignal) {
    return this.request<{
      updated: number;
      approvedTotal: number;
      draftTotal: number;
      needsRevisionTotal: number;
    }>("POST", CONTROL_ROUTES.stagingApprove, options, signal);
  }

  getQaCatalog(signal?: AbortSignal) {
    return this.request<{ rules: MemoqQaRuleInfo[] }>("GET", CONTROL_ROUTES.qaCatalog, undefined, signal);
  }

  listPreviewDocuments(signal?: AbortSignal) {
    return this.request<{
      documents: Array<
        CachedPreviewDocumentSummary & {
          fromPreview?: boolean;
          stagedCounts?: { approved: number; draft: number; needsRevision: number; total: number };
        }
      >;
      previewConnected: boolean;
    }>("GET", CONTROL_ROUTES.previewDocuments, undefined, signal);
  }

  async runQa(
    options: {
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
    } = {},
    signal?: AbortSignal,
  ) {
    type LegacyReport = Omit<MemoqQaReport, "issueOffset" | "nextIssueOffset" | "segmentsIncluded">;
    type Result = (MemoqQaReport | LegacyReport) & { reviewUrl: string };
    let report = await this.request<Result>("POST", CONTROL_ROUTES.qaRun, options, signal);
    if ("issueOffset" in report) return report;

    // The MCP launcher reuses a running DSH bridge, which may still use the older control API.
    const issueOffset = options.issueOffset ?? 0;
    const issueEnd = issueOffset + Math.max(1, Math.min(MAX_MEMOQ_QA_PAGE_SIZE, options.maxIssues ?? 500));
    const total = report.summary.totalIssues;
    if (issueOffset >= MAX_MEMOQ_QA_PAGE_SIZE && issueOffset < total) {
      throw new Error("The running memoQ bridge only supports the first 2000 QA issues. Update and restart its host to read further.");
    }
    const end = Math.min(issueEnd, total, MAX_MEMOQ_QA_PAGE_SIZE);
    if (issueOffset < end && report.issues.length < end) {
      report = await this.request<LegacyReport & { reviewUrl: string }>(
        "POST",
        CONTROL_ROUTES.qaRun,
        { ...options, maxIssues: end },
        signal,
      );
    }
    const issues = report.issues.slice(issueOffset, end);
    const next = issueOffset + issues.length;
    const segmentsIncluded = options.includeSegments !== false;
    return {
      ...report,
      issues,
      issueOffset,
      nextIssueOffset: issues.length > 0 && next < report.summary.totalIssues ? next : null,
      segmentsIncluded,
      segments: segmentsIncluded ? report.segments : [],
    };
  }

  getReviewUrl(signal?: AbortSignal) {
    return this.request<{ reviewUrl: string }>("GET", CONTROL_ROUTES.reviewUrl, undefined, signal);
  }

  clearStaged(documentId?: string, signal?: AbortSignal) {
    return this.request<{ removed: number; remaining: number }>(
      "POST",
      CONTROL_ROUTES.stagingClear,
      documentId === undefined ? {} : { documentId },
      signal,
    );
  }

  getConfirmed(options: { sourceLanguage?: string; targetLanguage?: string; limit?: number } = {}, signal?: AbortSignal) {
    const params = new URLSearchParams();
    if (options.sourceLanguage !== undefined) params.set("sourceLanguage", options.sourceLanguage);
    if (options.targetLanguage !== undefined) params.set("targetLanguage", options.targetLanguage);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.request<{ items: ConfirmedEntry[] }>(
      "GET",
      `${CONTROL_ROUTES.confirmedList}${qs ? `?${qs}` : ""}`,
      undefined,
      signal,
    );
  }

  getRecentRequests(options: { limit?: number; onlyWithTags?: boolean } = {}, signal?: AbortSignal) {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.onlyWithTags) params.set("onlyWithTags", "true");
    const qs = params.toString();
    return this.request<{
      items: RecentMtRequestEntry[];
      deduplicatedMissed?: MissedMtSummaryItem[];
      unresolvedCount?: number;
      byReason?: Record<string, number>;
    }>("GET", `${CONTROL_ROUTES.recentRequests}${qs ? `?${qs}` : ""}`, undefined, signal);
  }

  clearRecentRequests(documentId?: string) {
    return this.request<{ removed: number; remaining: number }>(
      "POST",
      CONTROL_ROUTES.recentRequestsClear,
      documentId === undefined ? {} : { documentId },
    );
  }

  getLiveConfig() {
    return this.request<{ available: boolean; config: LiveMtConfig | null }>("GET", CONTROL_ROUTES.liveConfig);
  }

  updateLiveConfig(patch: Partial<LiveMtConfig>) {
    return this.request<{ config: LiveMtConfig }>("POST", CONTROL_ROUTES.liveConfig, patch);
  }

  shutdown() {
    return this.request<{ ok: boolean; shuttingDown?: boolean }>("POST", CONTROL_ROUTES.shutdown, {});
  }
}

export interface StartBridgeRuntimeOptions {
  dataDir?: string;
  packageRoot?: string;
  preferredPort?: number;
  host?: string;
  ownerLabel?: string;
  toolName?: string;
  version?: string;
  mode?: "staging" | "dsh-live";
  reviewToken?: string;
  writeDaemonFile?: boolean;
  startPreview?: boolean;
  helperExecutablePath?: string;
  liveTranslator?: LiveTranslator;
  tagAligner?: TagAligner;
  getLiveConfig?: () => LiveMtConfig;
  updateLiveConfig?: (patch: Partial<LiveMtConfig>) => LiveMtConfig;
  getIntegrationStatus?: () => IntegrationStatus;
  onShutdown?: () => void | Promise<void>;
}

export interface BridgeRuntimeHandle {
  gateway: MtGatewayServer;
  previewClient: PreviewClient;
  stagingStore: StagingStore;
  gatewayConflictOwner: GatewayOwner | null;
  preferredPort: number;
  actualPort: number;
  client: BridgeHttpClient;
  close(): Promise<void>;
}

export async function startBridgeRuntime(options: StartBridgeRuntimeOptions = {}): Promise<BridgeRuntimeHandle> {
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const host = options.host ?? DEFAULT_HOST;
  const preferredPort = options.preferredPort ?? Number(process.env.MEMOQ_BRIDGE_PORT || DEFAULT_PORT);

  const probe =
    preferredPort === 0
      ? { owner: "free" as const, url: `http://${host}:0` }
      : await probeGatewayPort(preferredPort, host, 1000);
  const conflictOwner = probe.owner === "free" ? null : probe.owner;
  const bindPort = preferredPort === 0 ? 0 : probe.owner === "free" ? preferredPort : 0;

  const stagingStore = createStagingStore({ dataDir });
  const previewClient = createPreviewClient({
    dataDir,
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.helperExecutablePath === undefined ? {} : { helperExecutablePath: options.helperExecutablePath }),
  });

  if (options.startPreview !== false) {
    await previewClient.start();
  }

  const integrationFn = options.getIntegrationStatus ?? (() =>
    getIntegrationStatus({
      dataDir,
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      ...(options.helperExecutablePath === undefined ? {} : { helperExecutablePath: options.helperExecutablePath }),
    }));

  const shouldWriteDaemon = options.writeDaemonFile !== false;
  const persistedReviewToken =
    options.reviewToken ?? (shouldWriteDaemon ? loadOrCreateReviewToken(dataDir) : undefined);

  const gateway = await createMtGateway({
    host,
    port: bindPort,
    mode: options.mode ?? "staging",
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    ...(options.version === undefined ? {} : { desktopVersion: options.version }),
    ...(persistedReviewToken ? { reviewToken: persistedReviewToken } : {}),
    stagingStore,
    previewClient,
    getIntegrationStatus: integrationFn,
    ...(options.liveTranslator === undefined ? {} : { liveTranslator: options.liveTranslator }),
    ...(options.tagAligner === undefined ? {} : { tagAligner: options.tagAligner }),
    ...(options.getLiveConfig === undefined ? {} : { getLiveConfig: options.getLiveConfig }),
    ...(options.updateLiveConfig === undefined ? {} : { updateLiveConfig: options.updateLiveConfig }),
    ...(options.onShutdown === undefined ? {} : { onShutdown: options.onShutdown }),
  });

  if (shouldWriteDaemon) {
    writeDaemonRecord(
      {
        pid: process.pid,
        host,
        port: gateway.port,
        controlToken: gateway.controlToken,
        owner: options.ownerLabel ?? "memoq-bridge",
        ...(options.version ? { version: options.version } : {}),
        mode: options.mode ?? "staging",
        startedAt: new Date().toISOString(),
      },
      dataDir,
    );
  }

  const client = new BridgeHttpClient(gateway.baseUrl, gateway.controlToken);

  return {
    gateway,
    previewClient,
    stagingStore,
    gatewayConflictOwner: conflictOwner,
    preferredPort,
    actualPort: gateway.port,
    client,
    close: async () => {
      stagingStore.flush?.();
      if (shouldWriteDaemon) {
        removeDaemonRecord(gateway.controlToken, dataDir);
      }
      await previewClient.stop();
      await gateway.close();
    },
  };
}
