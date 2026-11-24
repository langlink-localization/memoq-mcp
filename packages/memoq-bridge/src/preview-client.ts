import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { type FocusedRange, normalizeLanguageCode } from "./contract.ts";
import { ensureRunnableHelperBinary } from "./helper-path.ts";

export interface PreviewPart {
  previewPartId: string;
  sourceText: string;
  targetText: string;
  order: number;
  sourceFocusedRange?: FocusedRange | null;
  targetFocusedRange?: FocusedRange | null;
}

export interface PreviewDocumentState {
  key: string;
  documentId: string;
  documentName: string;
  importPath: string;
  sourceLanguage: string;
  targetLanguage: string;
  updatedAt: string;
  revision: number;
  activePreviewPartIds: string[];
  parts: Map<string, PreviewPart>;
  partOrder: string[];
  hasExplicitPartOrder: boolean;
}

export interface PreviewStatus {
  platform: string;
  available: boolean;
  running: boolean;
  connected: boolean;
  state: string;
  previewToolId: string;
  revision: number;
  lastError: string;
  lastConnectedAt: string;
  lastUpdatedAt: string;
  activeDocumentId: string;
  activeDocumentName: string;
  activeSourceLanguage: string;
  activeTargetLanguage: string;
  activePreviewPartIds: string[];
  cachedDocuments: number;
}

export interface ActiveSegmentResult {
  available: boolean;
  mappingCertain: boolean;
  reason?: string;
  revision: number;
  document?: {
    documentId: string;
    documentName: string;
    importPath: string;
    sourceLanguage: string;
    targetLanguage: string;
    totalParts: number;
  };
  segment?: {
    previewPartId: string;
    index: number;
    sourceText: string;
    targetText: string;
    sourceFocusedRange?: FocusedRange | null;
    targetFocusedRange?: FocusedRange | null;
  };
  above: Array<{ previewPartId: string; sourceText: string; targetText: string }>;
  below: Array<{ previewPartId: string; sourceText: string; targetText: string }>;
  activePreviewPartIds: string[];
}

export interface DocumentSegmentsResult {
  available: boolean;
  reason?: string;
  document?: {
    documentId: string;
    documentName: string;
    sourceLanguage: string;
    targetLanguage: string;
  };
  total: number;
  filtered: number;
  offset: number;
  limit: number;
  segments: Array<{
    index: number;
    previewPartId: string;
    sourceText: string;
    targetText: string;
    isActive: boolean;
  }>;
}

export interface PreviewSubprocessHandle {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): void;
  once(event: "exit", listener: (code: number | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export type PreviewProcessSpawner = (executablePath: string, args: string[]) => PreviewSubprocessHandle;

export interface PreviewClientOptions {
  platform?: string;
  dataDir?: string;
  packageRoot?: string;
  helperExecutablePath?: string;
  toolId?: string;
  toolName?: string;
  spawner?: PreviewProcessSpawner;
}

export interface CachedPreviewDocumentSummary {
  documentId: string;
  documentName: string;
  importPath: string;
  sourceLanguage: string;
  targetLanguage: string;
  segmentCount: number;
  translatedCount: number;
  untranslatedCount: number;
  isActive: boolean;
  updatedAt: string;
}

export interface PreviewClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): PreviewStatus;
  listDocuments(): CachedPreviewDocumentSummary[];
  refreshParts(): Promise<void>;
  getActiveSegment(options?: {
    contextBefore?: number;
    contextAfter?: number;
    settleMs?: number;
  }): Promise<ActiveSegmentResult>;
  getDocumentSegments(options?: {
    documentId?: string;
    offset?: number;
    limit?: number;
    onlyUntranslated?: boolean;
    query?: string;
  }): DocumentSegmentsResult;
  focusSegment(params: {
    previewPartId: string;
    documentId?: string;
    sourceLangCode?: string;
    targetLangCode?: string;
    sourceText?: string;
    targetText?: string;
    sourceFocusedRange?: FocusedRange;
    targetFocusedRange?: FocusedRange;
  }): Promise<{ ok: boolean; error?: string }>;
  getContextForMt(query: {
    documentId?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    plainText: string;
  }): {
    documentName: string;
    above: Array<{ sourceText: string; targetText: string }>;
    below: Array<{ sourceText: string; targetText: string }>;
  } | null;
  ingestEventForTest?(event: Record<string, unknown>): void;
}

function defaultSpawner(executablePath: string, args: string[]): PreviewSubprocessHandle {
  const child: ChildProcessWithoutNullStreams = spawn(executablePath, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

function buildDocKey(documentId: string, sourceLanguage: string, targetLanguage: string): string {
  return `${documentId}|${sourceLanguage.toLowerCase()}|${targetLanguage.toLowerCase()}`;
}

function normalizeTextForMatch(text: string): string {
  return text.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();
}

const NUMERIC_SUFFIX_RE = /^(.*-)(\d+)$/u;

function normalizeMemoQPartIds(ids: string[]): string[] {
  if (ids.length < 2) return ids;
  const parsed = ids.map((id) => {
    const match = NUMERIC_SUFFIX_RE.exec(id);
    return match ? { prefix: match[1]!, num: Number(match[2]!) } : null;
  });
  if (parsed.some((p) => p === null)) return ids;
  const prefix = parsed[0]!.prefix;
  if (!parsed.every((p) => p!.prefix === prefix)) return ids;

  let isLexAscending = true;
  let isNumAscending = true;
  for (let i = 1; i < ids.length; i += 1) {
    if (ids[i - 1]! > ids[i]!) isLexAscending = false;
    if (parsed[i - 1]!.num > parsed[i]!.num) isNumAscending = false;
  }
  if (!isLexAscending || isNumAscending) {
    return ids;
  }
  return ids
    .map((id, idx) => ({ id, num: parsed[idx]!.num }))
    .sort((a, b) => a.num - b.num)
    .map((entry) => entry.id);
}

function comparePreviewParts(left: PreviewPart, right: PreviewPart): number {
  const leftMatch = NUMERIC_SUFFIX_RE.exec(left.previewPartId);
  const rightMatch = NUMERIC_SUFFIX_RE.exec(right.previewPartId);
  if (leftMatch && rightMatch && leftMatch[1] === rightMatch[1]) {
    const diff = Number(leftMatch[2]) - Number(rightMatch[2]);
    if (diff !== 0) return diff;
  }
  return left.order - right.order;
}

function orderedPartsForDoc(doc: PreviewDocumentState): PreviewPart[] {
  if (!doc.hasExplicitPartOrder) {
    return Array.from(doc.parts.values()).sort(comparePreviewParts);
  }
  const seen = new Set<string>();
  const ordered: PreviewPart[] = [];
  for (const id of doc.partOrder) {
    const part = doc.parts.get(id);
    if (part && !seen.has(id)) {
      seen.add(id);
      ordered.push(part);
    }
  }
  const remaining: PreviewPart[] = [];
  for (const part of doc.parts.values()) {
    if (!seen.has(part.previewPartId)) {
      remaining.push(part);
    }
  }
  remaining.sort(comparePreviewParts);
  return [...ordered, ...remaining];
}

function countPartOverlap(doc: PreviewDocumentState, ids: string[]): number {
  let hits = 0;
  for (const id of ids) {
    if (doc.parts.has(id)) {
      hits += 1;
    }
  }
  return hits;
}

function normalizeFocusedRange(raw: unknown): FocusedRange | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const startIndex = Number(record.startIndex ?? record.StartIndex);
  const length = Number(record.length ?? record.Length ?? 0);
  if (!Number.isFinite(startIndex) || startIndex < 0) return null;
  return {
    startIndex: Math.floor(startIndex),
    length: Number.isFinite(length) && length >= 0 ? Math.floor(length) : 0,
  };
}

export function createPreviewClient(options: PreviewClientOptions = {}): PreviewClient {
  const platform = options.platform ?? process.platform;
  const documents = new Map<string, PreviewDocumentState>();
  const pendingAcks = new Map<string, { resolve: (res: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>();

  let child: PreviewSubprocessHandle | null = null;
  let running = false;
  let connected = false;
  let available = platform === "win32";
  let state = platform === "win32" ? "idle" : "unsupported_platform";
  let previewToolId = options.toolId ?? "7f4e9b21-8c34-4a62-9d51-3b7e2f8a6c14";
  let lastError = "";
  let lastConnectedAt = "";
  let lastUpdatedAt = "";
  let revision = 0;
  let lastEventAtMs = 0;
  let activeDocumentKey = "";
  let latestPartIds: string[] = [];

  function getOrCreateDocument(
    documentId: string,
    documentName: string,
    importPath: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): PreviewDocumentState {
    const key = buildDocKey(documentId, sourceLanguage, targetLanguage);
    let doc = documents.get(key);
    if (!doc && !sourceLanguage && !targetLanguage) {
      const normalizedDocId = documentId.toLowerCase();
      const activeDoc = activeDocumentKey ? documents.get(activeDocumentKey) : undefined;
      if (activeDoc && activeDoc.documentId.toLowerCase() === normalizedDocId) {
        doc = activeDoc;
      } else {
        for (const candidate of documents.values()) {
          if (candidate.documentId.toLowerCase() === normalizedDocId) {
            doc = candidate;
            break;
          }
        }
      }
    }
    if (!doc) {
      doc = {
        key,
        documentId,
        documentName,
        importPath,
        sourceLanguage,
        targetLanguage,
        updatedAt: new Date().toISOString(),
        revision: 0,
        activePreviewPartIds: [],
        parts: new Map(),
        partOrder: latestPartIds.length > 0 ? [...latestPartIds] : [],
        hasExplicitPartOrder: latestPartIds.length > 0,
      };
      documents.set(key, doc);
    } else {
      if (documentName) doc.documentName = documentName;
      if (importPath) doc.importPath = importPath;
      if (sourceLanguage && !doc.sourceLanguage) doc.sourceLanguage = sourceLanguage;
      if (targetLanguage && !doc.targetLanguage) doc.targetLanguage = targetLanguage;
    }
    return doc;
  }

  function handleHelperEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? "");
    const nowIso = new Date().toISOString();
    lastUpdatedAt = nowIso;
    lastEventAtMs = Date.now();

    if (type === "status") {
      state = String(event.state ?? "idle");
      connected = event.connected === true;
      if (typeof event.previewToolId === "string" && event.previewToolId) {
        previewToolId = event.previewToolId;
      }
      lastError = typeof event.lastError === "string" ? event.lastError : "";
      if (connected) {
        lastConnectedAt = nowIso;
      }
      return;
    }

    if (type === "ack") {
      const id = String(event.id ?? "");
      const pending = pendingAcks.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAcks.delete(id);
        const errorText = typeof event.error === "string" && event.error ? event.error : undefined;
        pending.resolve({
          ok: event.ok === true,
          ...(errorText === undefined ? {} : { error: errorText }),
        });
      }
      return;
    }

    if (type === "part_ids") {
      const rawIds = Array.isArray(event.previewPartIds)
        ? event.previewPartIds.map((item) => String(item ?? "")).filter(Boolean)
        : [];
      const ids = normalizeMemoQPartIds(rawIds);
      latestPartIds = ids;
      if (ids.length > 0) {
        let targetDoc: PreviewDocumentState | null = null;
        if (activeDocumentKey && documents.has(activeDocumentKey)) {
          const activeDoc = documents.get(activeDocumentKey)!;
          if (countPartOverlap(activeDoc, ids) > 0) {
            targetDoc = activeDoc;
          }
        }
        if (!targetDoc) {
          let bestOverlap = 0;
          for (const candidate of documents.values()) {
            const overlap = countPartOverlap(candidate, ids);
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              targetDoc = candidate;
            }
          }
        }
        if (targetDoc) {
          targetDoc.partOrder = ids.slice();
          targetDoc.hasExplicitPartOrder = true;
        }
      }
      revision += 1;
      return;
    }

    if (type === "content_update") {
      const parts = Array.isArray(event.parts) ? event.parts : [];
      const touchedDocs = new Set<PreviewDocumentState>();
      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const p = rawPart as Record<string, unknown>;
        const documentId = String(p.documentId ?? "").trim();
        const previewPartId = String(p.previewPartId ?? "").trim();
        if (!documentId || !previewPartId) continue;

        const doc = getOrCreateDocument(
          documentId,
          String(p.documentName ?? ""),
          String(p.importPath ?? ""),
          String(p.sourceLanguage ?? ""),
          String(p.targetLanguage ?? ""),
        );
        touchedDocs.add(doc);
        const existing = doc.parts.get(previewPartId);
        const order = Number.isFinite(Number(p.order)) ? Number(p.order) : (existing?.order ?? doc.parts.size);
        doc.parts.set(previewPartId, {
          previewPartId,
          sourceText: String(p.sourceText ?? ""),
          targetText: String(p.targetText ?? ""),
          order,
          ...(existing?.sourceFocusedRange === undefined ? {} : { sourceFocusedRange: existing.sourceFocusedRange }),
          ...(existing?.targetFocusedRange === undefined ? {} : { targetFocusedRange: existing.targetFocusedRange }),
        });
        if (!doc.partOrder.includes(previewPartId)) {
          doc.partOrder.push(previewPartId);
        }
        doc.updatedAt = nowIso;
        doc.revision = ++revision;
        if (!activeDocumentKey) {
          activeDocumentKey = doc.key;
        }
      }
      if (latestPartIds.length > 0) {
        for (const doc of touchedDocs) {
          if (countPartOverlap(doc, latestPartIds) > 0) {
            doc.partOrder = latestPartIds.slice();
            doc.hasExplicitPartOrder = true;
          }
        }
      }
      return;
    }

    if (type === "highlight_change") {
      const activeParts = Array.isArray(event.activeParts) ? event.activeParts : [];
      if (activeParts.length === 0) return;

      const first = activeParts[0] as Record<string, unknown>;
      const documentId = String(first.documentId ?? "").trim();
      if (!documentId) return;
      const doc = getOrCreateDocument(
        documentId,
        String(first.documentName ?? ""),
        String(first.importPath ?? ""),
        String(first.sourceLanguage ?? ""),
        String(first.targetLanguage ?? ""),
      );

      const nextActiveIds: string[] = [];
      for (const rawPart of activeParts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const p = rawPart as Record<string, unknown>;
        const previewPartId = String(p.previewPartId ?? "").trim();
        if (!previewPartId) continue;
        nextActiveIds.push(previewPartId);

        const existing = doc.parts.get(previewPartId);
        const sourceText = String(p.sourceText ?? "") || existing?.sourceText || "";
        const targetText = String(p.targetText ?? "") || existing?.targetText || "";
        const sourceFocusedRange = normalizeFocusedRange(p.sourceFocusedRange) ?? existing?.sourceFocusedRange ?? null;
        const targetFocusedRange = normalizeFocusedRange(p.targetFocusedRange) ?? existing?.targetFocusedRange ?? null;
        const order = existing?.order ?? doc.parts.size;

        doc.parts.set(previewPartId, {
          previewPartId,
          sourceText,
          targetText,
          order,
          sourceFocusedRange,
          targetFocusedRange,
        });
        if (!doc.partOrder.includes(previewPartId)) {
          doc.partOrder.push(previewPartId);
        }
      }

      doc.activePreviewPartIds = Array.from(new Set(nextActiveIds));
      if (latestPartIds.length > 0 && countPartOverlap(doc, latestPartIds) > 0 && !doc.hasExplicitPartOrder) {
        doc.partOrder = latestPartIds.slice();
        doc.hasExplicitPartOrder = true;
      }
      doc.updatedAt = nowIso;
      doc.revision = ++revision;
      activeDocumentKey = doc.key;
    }
  }

  function sendCommand(payload: Record<string, unknown>, timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
    if (!child || !running) {
      return Promise.resolve({ ok: false, error: "Preview helper process is not running." });
    }
    const id = randomUUID();
    const message = JSON.stringify({ ...payload, id }) + "\n";

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(id);
        resolve({ ok: false, error: `Preview helper command timed out (${String(payload.type ?? "unknown")}).` });
      }, timeoutMs);

      pendingAcks.set(id, { resolve, timer });
      try {
        child!.stdin.write(message, "utf8");
      } catch (error) {
        clearTimeout(timer);
        pendingAcks.delete(id);
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  async function start(): Promise<void> {
    if (running) return;
    if (platform !== "win32") {
      available = false;
      state = "unsupported_platform";
      return;
    }

    let executablePath = options.helperExecutablePath ?? null;
    if (!executablePath) {
      executablePath = ensureRunnableHelperBinary({
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      });
    }

    if (!executablePath) {
      available = false;
      state = "missing_helper";
      lastError = "MemoQ.Bridge.Helper.exe was not found.";
      return;
    }

    available = true;
    const args = ["--stdio"];
    if (options.toolId) args.push("--tool-id", options.toolId);
    if (options.toolName) args.push("--tool-name", options.toolName);

    const spawner = options.spawner ?? defaultSpawner;
    const handle = spawner(executablePath, args);
    child = handle;
    running = true;
    state = "starting";

    const rl = createInterface({ input: handle.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object") {
          handleHelperEvent(parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore malformed stdout lines.
      }
    });

    handle.once("error", (error) => {
      running = false;
      connected = false;
      state = "error";
      lastError = error.message;
      rl.close();
    });

    handle.once("exit", () => {
      running = false;
      connected = false;
      if (state !== "stopped") {
        state = "disconnected";
      }
      for (const [id, pending] of pendingAcks) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: "Preview helper exited." });
        pendingAcks.delete(id);
      }
      rl.close();
      if (child === handle) {
        child = null;
      }
    });
  }

  async function stop(): Promise<void> {
    const active = child;
    if (!active) {
      running = false;
      connected = false;
      state = platform === "win32" ? "stopped" : "unsupported_platform";
      return;
    }

    state = "stopped";
    try {
      await sendCommand({ type: "shutdown" }, 1000);
    } catch {
      // Ignore shutdown send failure.
    }

    try {
      active.kill("SIGTERM");
    } catch {
      // Ignore kill failure.
    }
    child = null;
    running = false;
    connected = false;
  }

  function resolveDocument(documentId?: string): PreviewDocumentState | null {
    if (documentId) {
      const target = documentId.trim().toLowerCase();
      for (const doc of documents.values()) {
        if (doc.documentId.toLowerCase() === target || doc.key.toLowerCase() === target) {
          return doc;
        }
      }
    }
    if (activeDocumentKey && documents.has(activeDocumentKey)) {
      return documents.get(activeDocumentKey)!;
    }
    let newest: PreviewDocumentState | null = null;
    for (const doc of documents.values()) {
      if (!newest || doc.revision > newest.revision) {
        newest = doc;
      }
    }
    return newest;
  }

  function getStatus(): PreviewStatus {
    const activeDoc = resolveDocument();
    return {
      platform,
      available,
      running,
      connected,
      state,
      previewToolId,
      revision,
      lastError,
      lastConnectedAt,
      lastUpdatedAt,
      activeDocumentId: activeDoc?.documentId ?? "",
      activeDocumentName: activeDoc?.documentName ?? "",
      activeSourceLanguage: activeDoc?.sourceLanguage ?? "",
      activeTargetLanguage: activeDoc?.targetLanguage ?? "",
      activePreviewPartIds: activeDoc?.activePreviewPartIds ?? [],
      cachedDocuments: documents.size,
    };
  }

  async function refreshParts(): Promise<void> {
    await sendCommand({ type: "refresh_parts" }, 3000);
  }

  async function getActiveSegment(query: {
    contextBefore?: number;
    contextAfter?: number;
    settleMs?: number;
  } = {}): Promise<ActiveSegmentResult> {
    const settleMs = Math.max(0, Math.min(500, query.settleMs ?? 80));
    if (settleMs > 0 && lastEventAtMs > 0 && Date.now() - lastEventAtMs < settleMs) {
      const firstRev = revision;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      if (revision !== firstRev) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
    }

    const doc = resolveDocument();
    if (!doc) {
      return {
        available: false,
        mappingCertain: false,
        reason: platform !== "win32"
          ? "unsupported_platform"
          : connected
            ? "no_active_document"
            : "memoq_preview_not_connected",
        revision,
        above: [],
        below: [],
        activePreviewPartIds: [],
      };
    }

    const activeIds = doc.activePreviewPartIds;
    const baseDoc = {
      documentId: doc.documentId,
      documentName: doc.documentName,
      importPath: doc.importPath,
      sourceLanguage: doc.sourceLanguage,
      targetLanguage: doc.targetLanguage,
      totalParts: doc.parts.size,
    };

    if (activeIds.length === 0) {
      return {
        available: false,
        mappingCertain: false,
        reason: "no_active_preview_part",
        revision,
        document: baseDoc,
        above: [],
        below: [],
        activePreviewPartIds: [],
      };
    }

    const ordered = orderedPartsForDoc(doc);
    let resolvedId: string | undefined;
    let mappingCertain = false;
    let uncertainReason: string | undefined;

    if (activeIds.length === 1) {
      resolvedId = activeIds[0];
      mappingCertain = Boolean(resolvedId && doc.parts.has(resolvedId));
      if (!mappingCertain) uncertainReason = "active_part_not_cached";
    } else {
      const focusedCandidates = activeIds.filter((id) => {
        const part = doc.parts.get(id);
        return Boolean(part?.sourceFocusedRange || part?.targetFocusedRange);
      });
      if (focusedCandidates.length === 1) {
        resolvedId = focusedCandidates[0];
        mappingCertain = true;
      } else {
        resolvedId = activeIds[0];
        mappingCertain = false;
        uncertainReason = "multiple_active_parts";
      }
    }

    const resolvedIndex = resolvedId ? ordered.findIndex((part) => part.previewPartId === resolvedId) : -1;
    const resolvedPart = resolvedIndex >= 0 ? ordered[resolvedIndex] : undefined;
    if (!resolvedPart) {
      return {
        available: false,
        mappingCertain: false,
        reason: uncertainReason ?? "active_part_not_cached",
        revision,
        document: baseDoc,
        above: [],
        below: [],
        activePreviewPartIds: activeIds,
      };
    }

    const beforeCount = Math.max(0, Math.min(20, query.contextBefore ?? 2));
    const afterCount = Math.max(0, Math.min(20, query.contextAfter ?? 2));

    const above = ordered
      .slice(Math.max(0, resolvedIndex - beforeCount), resolvedIndex)
      .map((part) => ({
        previewPartId: part.previewPartId,
        sourceText: part.sourceText,
        targetText: part.targetText,
      }));
    const below = ordered
      .slice(resolvedIndex + 1, resolvedIndex + 1 + afterCount)
      .map((part) => ({
        previewPartId: part.previewPartId,
        sourceText: part.sourceText,
        targetText: part.targetText,
      }));

    return {
      available: true,
      mappingCertain,
      ...(uncertainReason === undefined ? {} : { reason: uncertainReason }),
      revision,
      document: baseDoc,
      segment: {
        previewPartId: resolvedPart.previewPartId,
        index: resolvedIndex,
        sourceText: resolvedPart.sourceText,
        targetText: resolvedPart.targetText,
        ...(resolvedPart.sourceFocusedRange === undefined ? {} : { sourceFocusedRange: resolvedPart.sourceFocusedRange }),
        ...(resolvedPart.targetFocusedRange === undefined ? {} : { targetFocusedRange: resolvedPart.targetFocusedRange }),
      },
      above,
      below,
      activePreviewPartIds: activeIds,
    };
  }

  function listDocuments(): CachedPreviewDocumentSummary[] {
    const out: CachedPreviewDocumentSummary[] = [];
    for (const doc of documents.values()) {
      let translatedCount = 0;
      for (const part of doc.parts.values()) {
        if (part.targetText.trim().length > 0) translatedCount += 1;
      }
      const segmentCount = doc.parts.size;
      out.push({
        documentId: doc.documentId,
        documentName: doc.documentName,
        importPath: doc.importPath,
        sourceLanguage: doc.sourceLanguage,
        targetLanguage: doc.targetLanguage,
        segmentCount,
        translatedCount,
        untranslatedCount: Math.max(0, segmentCount - translatedCount),
        isActive: doc.key === activeDocumentKey,
        updatedAt: doc.updatedAt,
      });
    }
    out.sort((left, right) => {
      if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    return out;
  }

  function getDocumentSegments(query: {
    documentId?: string;
    offset?: number;
    limit?: number;
    onlyUntranslated?: boolean;
    query?: string;
  } = {}): DocumentSegmentsResult {
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 50)));
    const doc = resolveDocument(query.documentId);

    if (!doc) {
      return {
        available: false,
        reason: platform !== "win32"
          ? "unsupported_platform"
          : connected
            ? "no_active_document"
            : "memoq_preview_not_connected",
        total: 0,
        filtered: 0,
        offset,
        limit,
        segments: [],
      };
    }

    const ordered = orderedPartsForDoc(doc);
    const activeSet = new Set(doc.activePreviewPartIds);
    const search = (query.query ?? "").trim().toLowerCase();

    const mapped = ordered.map((part, index) => ({
      index,
      previewPartId: part.previewPartId,
      sourceText: part.sourceText,
      targetText: part.targetText,
      isActive: activeSet.has(part.previewPartId),
    }));

    const filtered = mapped.filter((item) => {
      if (query.onlyUntranslated && item.targetText.trim().length > 0) {
        return false;
      }
      if (search) {
        const hay = `${item.previewPartId}\n${item.sourceText}\n${item.targetText}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    return {
      available: true,
      document: {
        documentId: doc.documentId,
        documentName: doc.documentName,
        sourceLanguage: doc.sourceLanguage,
        targetLanguage: doc.targetLanguage,
      },
      total: mapped.length,
      filtered: filtered.length,
      offset,
      limit,
      segments: filtered.slice(offset, offset + limit),
    };
  }

  async function focusSegment(params: {
    previewPartId: string;
    documentId?: string;
    sourceLangCode?: string;
    targetLangCode?: string;
    sourceText?: string;
    targetText?: string;
    sourceFocusedRange?: FocusedRange;
    targetFocusedRange?: FocusedRange;
  }): Promise<{ ok: boolean; error?: string }> {
    const previewPartId = params.previewPartId.trim();
    if (!previewPartId) {
      return { ok: false, error: "previewPartId is required." };
    }

    const doc = resolveDocument(params.documentId);
    const part = doc?.parts.get(previewPartId);
    const sourceLangCode = params.sourceLangCode ?? doc?.sourceLanguage ?? "";
    const targetLangCode = params.targetLangCode ?? doc?.targetLanguage ?? "";
    const sourceContent = params.sourceText ?? part?.sourceText;
    const targetContent = params.targetText ?? part?.targetText;

    return sendCommand({
      type: "focus_segment",
      previewPartId,
      ...(sourceLangCode ? { sourceLangCode } : {}),
      ...(targetLangCode ? { targetLangCode } : {}),
      ...(sourceContent === undefined ? {} : { sourceContent }),
      ...(targetContent === undefined ? {} : { targetContent }),
      ...(params.sourceFocusedRange === undefined ? {} : { sourceFocusedRange: params.sourceFocusedRange }),
      ...(params.targetFocusedRange === undefined ? {} : { targetFocusedRange: params.targetFocusedRange }),
    });
  }

  function getContextForMt(query: {
    documentId?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    plainText: string;
  }) {
    const doc = resolveDocument(query.documentId);
    if (!doc) return null;
    if (query.sourceLanguage && doc.sourceLanguage) {
      const left = normalizeLanguageCode(query.sourceLanguage);
      const right = normalizeLanguageCode(doc.sourceLanguage);
      if (left.base && right.base && left.base !== right.base) {
        return null;
      }
    }

    const ordered = orderedPartsForDoc(doc);
    if (ordered.length === 0) return null;

    const targetNorm = normalizeTextForMatch(query.plainText);
    let anchorIndex = ordered.findIndex((part) => normalizeTextForMatch(part.sourceText) === targetNorm);
    if (anchorIndex < 0 && doc.activePreviewPartIds.length > 0) {
      const activeId = doc.activePreviewPartIds[0];
      anchorIndex = ordered.findIndex((part) => part.previewPartId === activeId);
    }
    if (anchorIndex < 0) return null;

    return {
      documentName: doc.documentName,
      above: ordered
        .slice(Math.max(0, anchorIndex - 2), anchorIndex)
        .map((part) => ({ sourceText: part.sourceText, targetText: part.targetText })),
      below: ordered
        .slice(anchorIndex + 1, anchorIndex + 3)
        .map((part) => ({ sourceText: part.sourceText, targetText: part.targetText })),
    };
  }

  return {
    start,
    stop,
    getStatus,
    listDocuments,
    refreshParts,
    getActiveSegment,
    getDocumentSegments,
    focusSegment,
    getContextForMt,
    ingestEventForTest: handleHelperEvent,
  };
}
