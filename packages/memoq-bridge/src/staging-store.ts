import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  computeSlotSkeletonKey,
  defaultBridgeDataDir,
  hasAtomicSourceTagToken,
  hasInlineTagOrBr,
  hasMqInlineTags,
  languagesMatch,
  matchInlineTagSlots,
  normalizeComparableText,
  normalizeLanguageCode,
  restoreInlineTagsFromStaged,
  restoreTargetFromBindings,
  verifyInlineTagInventory,
  type StagedReviewStatus,
  type StagedRevisionEntry,
  type TagPolicy,
} from "./contract.ts";

export interface StageTranslationInput {
  sourceText: string;
  targetText: string;
  sourceHtml?: string;
  targetHtml?: string;
  documentId?: string;
  sourceLanguage: string;
  targetLanguage: string;
  confidence?: number;
  info?: string;
  stagedBy?: string;
  tagPolicy?: TagPolicy;
  status?: StagedReviewStatus;
  reviewComment?: string;
  reviewNote?: string;
  previewPartId?: string;
}

export interface StagedEntry {
  id: string;
  documentId: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  sourceHtml: string;
  targetText: string;
  targetHtml: string;
  hasInlineTags: boolean;
  confidence: number;
  info: string;
  stagedBy: string;
  tagPolicy: TagPolicy;
  status: StagedReviewStatus;
  revision: number;
  history: StagedRevisionEntry[];
  reviewComment: string;
  previewPartId: string;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConfirmedEntry {
  sourceLanguage: string;
  targetLanguage: string;
  requestType: string;
  sourceText: string;
  targetText: string;
  storedAt: string;
}

export interface RecentMtRequestEntry {
  requestId: string;
  receivedAt: string;
  documentId: string;
  projectId: string;
  client: string;
  domain: string;
  subject: string;
  sourceLanguage: string;
  targetLanguage: string;
  requestType: string;
  index: number;
  segmentIndex?: number;
  text: string;
  plainText: string;
  hasInlineTags: boolean;
  tmSource: string;
  tmTarget: string;
  reason: string;
}

interface PersistedBridgeState {
  version: number;
  staged: StagedEntry[];
  confirmed: ConfirmedEntry[];
  recentRequests: RecentMtRequestEntry[];
}

export interface StagingStoreOptions {
  statePath?: string;
  dataDir?: string;
  persist?: boolean;
  ttlMs?: number;
  maxStaged?: number;
  maxConfirmed?: number;
  maxRecentRequests?: number;
  now?: () => number;
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_STAGED = 100_000;
const DEFAULT_MAX_CONFIRMED = 500;
const DEFAULT_MAX_RECENT_REQUESTS = 200;

interface BucketIndex {
  byExactRaw: Map<string, StagedEntry[]>;
  byNormPlain: Map<string, StagedEntry[]>;
  bySlotSkeleton: Map<string, StagedEntry[]>;
}

function createEmptyBucketIndex(): BucketIndex {
  return {
    byExactRaw: new Map(),
    byNormPlain: new Map(),
    bySlotSkeleton: new Map(),
  };
}

function pushBucket(map: Map<string, StagedEntry[]>, key: string, entry: StagedEntry): void {
  const existing = map.get(key);
  if (existing) {
    if (existing[existing.length - 1] !== entry) {
      existing.push(entry);
    }
  } else {
    map.set(key, [entry]);
  }
}

export interface StagedCounts {
  approved: number;
  draft: number;
  needsRevision: number;
}

export interface MissedMtSummaryItem {
  key: string;
  documentId: string;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  plainText: string;
  hasInlineTags: boolean;
  requestType: string;
  reason: string;
  reasonLabel: string;
  attempts: number;
  receivedAt: string;
  tmSource: string;
  tmTarget: string;
}

export interface StagingStore {
  stageMany(
    items: StageTranslationInput[],
  ): {
    stagedCount: number;
    entries: StagedEntry[];
    warnings: string[];
  };
  findStaged(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): StagedEntry | null;
  peekStaged(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): StagedEntry | null;
  findPendingDraft(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): StagedEntry | null;
  listStaged(options?: {
    documentId?: string;
    status?: StagedReviewStatus | "all";
    onlyWithComment?: boolean;
    offset?: number;
    limit?: number;
  }): {
    total: number;
    offset: number;
    limit: number;
    nextOffset: number | null;
    counts: StagedCounts;
    items: StagedEntry[];
  };
  updateStaged(input: {
    id: string;
    targetText?: string;
    targetHtml?: string;
    editedBy?: string;
    status?: StagedReviewStatus;
    reviewComment?: string;
    revertToRevision?: number;
  }): StagedEntry | null;
  setReviewFeedback(input: {
    id: string;
    comment: string;
    status?: StagedReviewStatus;
  }): StagedEntry | null;
  approveStaged(options?: {
    ids?: string[];
    documentId?: string;
    status?: "approved" | "draft";
  }): {
    updated: number;
    approvedTotal: number;
    draftTotal: number;
    needsRevisionTotal: number;
  };
  clearStaged(options?: { documentId?: string }): { removed: number; remaining: number };
  recordConfirmed(
    items: Array<{
      sourceLanguage: string;
      targetLanguage: string;
      requestType: string;
      sourceText: string;
      targetText: string;
    }>,
  ): number;
  listConfirmed(options?: {
    sourceLanguage?: string;
    targetLanguage?: string;
    limit?: number;
  }): ConfirmedEntry[];
  recordRecentRequest(entry: RecentMtRequestEntry): void;
  listRecentRequests(options?: { limit?: number; onlyWithTags?: boolean }): RecentMtRequestEntry[];
  clearRecentRequests(options?: { documentId?: string }): { removed: number; remaining: number };
  resolveRecentRequest(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): number;
  flush?(): void;
}

/**
 * Write UTF-8 text via temp file + rename, tolerating transient Windows NTFS locks.
 */
export function atomicWriteTextSync(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  try {
    writeFileSync(tempPath, content, "utf8");
    const transientCodes = new Set(["EPERM", "EBUSY", "EACCES"]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        renameSync(tempPath, targetPath);
        return;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (!code || !transientCodes.has(code)) {
          throw error;
        }
        Atomics.wait(sleepBuf, 0, 0, 15 * (attempt + 1));
      }
    }
    // Fall back to direct overwrite if indexer/AV holds the destination handle across retries.
    writeFileSync(targetPath, content, "utf8");
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function createStagingStore(options: StagingStoreOptions = {}): StagingStore {
  const persist = options.persist !== false;
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const statePath = options.statePath ?? join(dataDir, "state.json");
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxStaged = options.maxStaged ?? DEFAULT_MAX_STAGED;
  const maxConfirmed = options.maxConfirmed ?? DEFAULT_MAX_CONFIRMED;
  const maxRecentRequests = options.maxRecentRequests ?? DEFAULT_MAX_RECENT_REQUESTS;
  const now = options.now ?? (() => Date.now());

  let state: PersistedBridgeState = loadInitialState();
  let dirty = false;
  let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let indexDirty = true;
  let approvedIndex: BucketIndex = createEmptyBucketIndex();
  let pendingIndex: BucketIndex = createEmptyBucketIndex();
  let earliestExpiryMs = Number.POSITIVE_INFINITY;

  function recomputeEarliestExpiry(): void {
    let minExpiry = Number.POSITIVE_INFINITY;
    for (const entry of state.staged) {
      const ts = Date.parse(entry.updatedAt);
      if (!Number.isNaN(ts)) {
        const exp = ts + ttlMs;
        if (exp < minExpiry) minExpiry = exp;
      }
    }
    earliestExpiryMs = minExpiry;
  }

  function markStagedMutated(): void {
    indexDirty = true;
    recomputeEarliestExpiry();
  }

  function rebuildIndexesIfNeeded(): void {
    if (!indexDirty) return;
    const nextApproved = createEmptyBucketIndex();
    const nextPending = createEmptyBucketIndex();

    for (const entry of state.staged) {
      const targetIdx = entry.status === "approved" ? nextApproved : nextPending;
      pushBucket(targetIdx.byExactRaw, entry.sourceText, entry);
      if (entry.sourceHtml && entry.sourceHtml !== entry.sourceText) {
        pushBucket(targetIdx.byExactRaw, entry.sourceHtml, entry);
      }

      const norm = normalizeComparableText(entry.sourceText || entry.sourceHtml);
      if (norm) {
        pushBucket(targetIdx.byNormPlain, norm, entry);
      }

      const srcHasToken = hasAtomicSourceTagToken(entry.sourceText);
      const srcSkel = srcHasToken ? computeSlotSkeletonKey(entry.sourceText, false) : "";
      if (srcHasToken) {
        pushBucket(targetIdx.bySlotSkeleton, srcSkel, entry);
      }
      if (entry.sourceHtml && entry.sourceHtml !== entry.sourceText && hasAtomicSourceTagToken(entry.sourceHtml)) {
        const htmlSkel = computeSlotSkeletonKey(entry.sourceHtml, false);
        if (!srcHasToken || htmlSkel !== srcSkel) {
          pushBucket(targetIdx.bySlotSkeleton, htmlSkel, entry);
        }
      }
    }

    approvedIndex = nextApproved;
    pendingIndex = nextPending;
    indexDirty = false;
  }

  recomputeEarliestExpiry();

  function hydrateStagedEntry(raw: Partial<StagedEntry>): StagedEntry {
    const status: StagedReviewStatus =
      raw.status === "draft" || raw.status === "needs_revision" || raw.status === "approved"
        ? raw.status
        : "approved";
    const revision = Number.isInteger(raw.revision) && Number(raw.revision) >= 1 ? Number(raw.revision) : 1;
    return {
      id: String(raw.id ?? randomUUID()),
      documentId: String(raw.documentId ?? ""),
      sourceLanguage: String(raw.sourceLanguage ?? ""),
      targetLanguage: String(raw.targetLanguage ?? ""),
      sourceText: String(raw.sourceText ?? ""),
      sourceHtml: String(raw.sourceHtml ?? ""),
      targetText: String(raw.targetText ?? ""),
      targetHtml: String(raw.targetHtml ?? ""),
      hasInlineTags: Boolean(raw.hasInlineTags),
      confidence: Number.isFinite(raw.confidence) ? Number(raw.confidence) : 0,
      info: String(raw.info ?? ""),
      stagedBy: String(raw.stagedBy ?? "agent"),
      tagPolicy: raw.tagPolicy === "plaintext-fallback" ? "plaintext-fallback" : "protect",
      status,
      revision,
      history: Array.isArray(raw.history) ? raw.history : [],
      reviewComment: typeof raw.reviewComment === "string" ? raw.reviewComment : "",
      previewPartId: typeof raw.previewPartId === "string" ? raw.previewPartId : "",
      hitCount: Number.isFinite(raw.hitCount) ? Number(raw.hitCount) : 0,
      createdAt: String(raw.createdAt ?? new Date(now()).toISOString()),
      updatedAt: String(raw.updatedAt ?? new Date(now()).toISOString()),
    };
  }

  function loadInitialState(): PersistedBridgeState {
    if (!persist || !existsSync(statePath)) {
      return { version: 1, staged: [], confirmed: [], recentRequests: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PersistedBridgeState>;
      return {
        version: 1,
        staged: Array.isArray(parsed.staged) ? parsed.staged.map((entry) => hydrateStagedEntry(entry)) : [],
        confirmed: Array.isArray(parsed.confirmed) ? parsed.confirmed : [],
        recentRequests: Array.isArray(parsed.recentRequests) ? parsed.recentRequests : [],
      };
    } catch {
      return { version: 1, staged: [], confirmed: [], recentRequests: [] };
    }
  }

  function saveState(): void {
    if (pendingSaveTimer) {
      clearTimeout(pendingSaveTimer);
      pendingSaveTimer = null;
    }
    dirty = false;
    if (!persist) return;
    const serialized = state.staged.length > 2000 ? JSON.stringify(state) : JSON.stringify(state, null, 2);
    atomicWriteTextSync(statePath, serialized);
  }

  function scheduleSave(delayMs = 250): void {
    dirty = true;
    if (!persist || pendingSaveTimer) return;
    pendingSaveTimer = setTimeout(() => {
      pendingSaveTimer = null;
      if (dirty) {
        saveState();
      }
    }, delayMs);
    pendingSaveTimer.unref();
  }

  function flush(): void {
    if (dirty) {
      saveState();
    }
  }

  function pruneExpiredStaged(): boolean {
    if (state.staged.length === 0 || now() < earliestExpiryMs) {
      return false;
    }
    const cutoff = now() - ttlMs;
    const before = state.staged.length;
    state.staged = state.staged.filter((entry) => {
      const ts = Date.parse(entry.updatedAt);
      return Number.isNaN(ts) || ts >= cutoff;
    });
    recomputeEarliestExpiry();
    if (state.staged.length !== before) {
      indexDirty = true;
      return true;
    }
    return false;
  }

  function buildStagedKey(entry: {
    documentId: string;
    sourceLanguage: string;
    targetLanguage: string;
    sourceHtml: string;
    sourceText: string;
  }): string {
    const srcNorm = normalizeComparableText(entry.sourceHtml || entry.sourceText);
    const sLang = normalizeLanguageCode(entry.sourceLanguage).canonical;
    const tLang = normalizeLanguageCode(entry.targetLanguage).canonical;
    const hasHtml = Boolean(entry.sourceHtml && entry.sourceHtml !== entry.sourceText);
    return `${entry.documentId.toLowerCase()}|${sLang}|${tLang}|${hasHtml ? entry.sourceHtml : srcNorm}`;
  }

  function stageMany(items: StageTranslationInput[]) {
    pruneExpiredStaged();
    const warnings: string[] = [];
    const createdOrUpdated: StagedEntry[] = [];
    const timestamp = new Date(now()).toISOString();

    const byKey = new Map<string, StagedEntry>();
    for (const existing of state.staged) {
      byKey.set(buildStagedKey(existing), existing);
    }

    for (const item of items) {
      const sourceText = String(item.sourceText ?? "");
      const targetText = String(item.targetText ?? "");
      const sourceHtml = String(item.sourceHtml ?? "");
      const targetHtml = String(item.targetHtml ?? "");
      if (!sourceText.trim() && !sourceHtml.trim()) {
        warnings.push("Skipped staged entry with empty source text.");
        continue;
      }
      if (!targetText.trim() && !targetHtml.trim()) {
        warnings.push(`Skipped staged entry with empty target text for source "${sourceText.slice(0, 40)}".`);
        continue;
      }

      const documentId = String(item.documentId ?? "").trim();
      const sourceLanguage = String(item.sourceLanguage ?? "").trim();
      const targetLanguage = String(item.targetLanguage ?? "").trim();
      const hasInlineTags = hasMqInlineTags(sourceHtml) || hasMqInlineTags(targetHtml) || hasMqInlineTags(sourceText);
      const confidence = Math.max(0, Math.min(1, Number.isFinite(item.confidence) ? Number(item.confidence) : 0));
      const stagedBy = String(item.stagedBy ?? "agent").trim() || "agent";
      const reviewNote = item.reviewNote ? String(item.reviewNote).trim() : "";
      const info = String(
        item.info ?? (reviewNote ? `${stagedBy}: ${reviewNote}` : `Staged by ${stagedBy}`),
      ).trim();
      const tagPolicy: TagPolicy = item.tagPolicy === "plaintext-fallback" ? "plaintext-fallback" : "protect";

      const key = buildStagedKey({
        documentId,
        sourceLanguage,
        targetLanguage,
        sourceHtml,
        sourceText,
      });
      const existing = byKey.get(key);
      const nextTargetText = targetText || targetHtml;
      const nextTargetHtml = targetHtml;
      const targetChanged = Boolean(
        existing && (existing.targetText !== nextTargetText || existing.targetHtml !== nextTargetHtml),
      );
      const history = existing ? [...existing.history] : [];
      if (existing && targetChanged) {
        history.push({
          revision: existing.revision,
          targetText: existing.targetText,
          targetHtml: existing.targetHtml,
          editedBy: existing.stagedBy,
          ...(existing.reviewComment ? { note: existing.reviewComment } : {}),
          updatedAt: existing.updatedAt,
        });
      }
      const trimmedHistory = history.slice(-10);
      const revision = existing ? (targetChanged ? existing.revision + 1 : existing.revision) : 1;

      const explicitStatus =
        item.status === "draft" || item.status === "approved" || item.status === "needs_revision"
          ? item.status
          : undefined;
      const status: StagedReviewStatus = explicitStatus
        ?? (existing
          ? existing.status === "needs_revision" && targetChanged
            ? "draft"
            : existing.status
          : "approved");
      const reviewComment =
        item.reviewComment !== undefined
          ? String(item.reviewComment).trim()
          : existing?.status === "needs_revision" && targetChanged
            ? ""
            : (existing?.reviewComment ?? "");
      const previewPartId = String(item.previewPartId ?? existing?.previewPartId ?? "").trim();

      const nextEntry: StagedEntry = {
        id: existing?.id ?? randomUUID(),
        documentId,
        sourceLanguage,
        targetLanguage,
        sourceText: sourceText || sourceHtml,
        sourceHtml,
        targetText: nextTargetText,
        targetHtml: nextTargetHtml,
        hasInlineTags,
        confidence,
        info,
        stagedBy,
        tagPolicy,
        status,
        revision,
        history: trimmedHistory,
        reviewComment,
        previewPartId,
        hitCount: existing?.hitCount ?? 0,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      byKey.set(key, nextEntry);
      createdOrUpdated.push(nextEntry);

      if (hasInlineTags && !targetHtml.trim()) {
        warnings.push(`Source "${sourceText.slice(0, 40)}" contains inline tags, but targetHtml was omitted; tag guard will protect memoQ inline tags.`);
      }
    }

    state.staged = Array.from(byKey.values())
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, maxStaged);
    markStagedMutated();
    saveState();

    return {
      stagedCount: createdOrUpdated.length,
      entries: createdOrUpdated,
      warnings,
    };
  }

  function matchStagedCandidate(
    query: {
      documentId?: string;
      sourceLanguage: string;
      targetLanguage: string;
      text: string;
      plainText?: string;
    },
    wantApproved: boolean,
  ): { match: StagedEntry | null; expiredChanged: boolean } {
    const expiredChanged = pruneExpiredStaged();
    rebuildIndexesIfNeeded();

    const docId = (query.documentId ?? "").trim().toLowerCase();
    const text = String(query.text ?? "");
    const plain = String(query.plainText ?? text);
    const normIncoming = normalizeComparableText(plain);
    const incomingHasTagsOrBr = hasInlineTagOrBr(text);
    const idx = wantApproved ? approvedIndex : pendingIndex;

    const filterLang = (bucket: readonly StagedEntry[] | undefined, scopedDocId?: string): StagedEntry[] => {
      if (!bucket || bucket.length === 0) return [];
      const out: StagedEntry[] = [];
      for (const entry of bucket) {
        if (scopedDocId && entry.documentId.toLowerCase() !== scopedDocId) continue;
        if (
          languagesMatch(entry.sourceLanguage, query.sourceLanguage)
          && languagesMatch(entry.targetLanguage, query.targetLanguage)
        ) {
          out.push(entry);
        }
      }
      return out;
    };

    const matchesExactRaw = (entry: StagedEntry) =>
      (entry.sourceHtml !== "" && entry.sourceHtml === text) || entry.sourceText === text;

    const findSlotCandidate = (pool: readonly StagedEntry[]): StagedEntry | undefined => {
      if (!incomingHasTagsOrBr || pool.length === 0) return undefined;
      const matched: Array<{
        entry: StagedEntry;
        bindings: NonNullable<ReturnType<typeof matchInlineTagSlots>>;
      }> = [];

      for (const entry of pool) {
        const bindings =
          matchInlineTagSlots(text, entry.sourceText)
          ?? (entry.sourceHtml ? matchInlineTagSlots(text, entry.sourceHtml) : null);
        if (bindings) {
          matched.push({ entry, bindings });
        }
      }

      if (matched.length === 0) return undefined;
      if (matched.length === 1) return matched[0]!.entry;

      const restoredEntries: Array<{ entry: StagedEntry; restored: string }> = [];
      for (const item of matched) {
        const restored = restoreTargetFromBindings(
          text,
          item.entry.targetText,
          item.bindings,
          "BothFormattingAndTags",
        );
        if (restored !== null) {
          restoredEntries.push({ entry: item.entry, restored });
        }
      }

      if (restoredEntries.length === 0) return undefined;
      const uniqueOutputs = new Set(restoredEntries.map((item) => item.restored));
      if (uniqueOutputs.size === 1) {
        return restoredEntries[0]!.entry;
      }
      return undefined;
    };

    const rawBucket = idx.byExactRaw.get(text);
    const slotBucket = incomingHasTagsOrBr ? idx.bySlotSkeleton.get(computeSlotSkeletonKey(text, true)) : undefined;
    const normBucket = normIncoming ? idx.byNormPlain.get(normIncoming) : undefined;

    const findScoped = (scopedDocId?: string): StagedEntry | undefined => {
      const rawHit = filterLang(rawBucket, scopedDocId).find(matchesExactRaw);
      if (rawHit) return rawHit;

      if (incomingHasTagsOrBr) {
        const slotHit = findSlotCandidate(filterLang(slotBucket, scopedDocId));
        if (slotHit) return slotHit;
      }

      if (normIncoming) {
        const normHit = filterLang(normBucket, scopedDocId)[0];
        if (normHit) return normHit;
      }
      return undefined;
    };

    let match: StagedEntry | undefined;
    if (docId) {
      match = findScoped(docId);
    }
    if (!match) {
      match = findScoped();
    }

    return { match: match ?? null, expiredChanged };
  }

  function findStaged(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): StagedEntry | null {
    const { match, expiredChanged } = matchStagedCandidate(query, true);
    if (match) {
      match.hitCount += 1;
      scheduleSave();
      return match;
    }
    if (expiredChanged) scheduleSave();
    return null;
  }

  function peekStaged(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): StagedEntry | null {
    const { match } = matchStagedCandidate(query, true);
    return match;
  }

  function findPendingDraft(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): StagedEntry | null {
    const { match, expiredChanged } = matchStagedCandidate(query, false);
    if (expiredChanged) scheduleSave();
    return match;
  }

  function computeCounts(entries: StagedEntry[]): StagedCounts {
    let approved = 0;
    let draft = 0;
    let needsRevision = 0;
    for (const entry of entries) {
      if (entry.status === "approved") approved += 1;
      else if (entry.status === "needs_revision") needsRevision += 1;
      else draft += 1;
    }
    return { approved, draft, needsRevision };
  }

  function listStaged(
    options: {
      documentId?: string;
      status?: StagedReviewStatus | "all";
      onlyWithComment?: boolean;
      offset?: number;
      limit?: number;
    } = {},
  ) {
    if (pruneExpiredStaged()) saveState();
    const docId = (options.documentId ?? "").trim().toLowerCase();
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(1, Math.min(DEFAULT_MAX_STAGED, Math.floor(options.limit ?? 100)));
    const docScoped = docId
      ? state.staged.filter((entry) => entry.documentId.toLowerCase() === docId)
      : state.staged;
    const counts = computeCounts(docScoped);
    const filtered = docScoped.filter((entry) => {
      if (options.status && options.status !== "all" && entry.status !== options.status) {
        return false;
      }
      if (options.onlyWithComment && !entry.reviewComment.trim()) {
        return false;
      }
      return true;
    });
    const items = filtered.slice(offset, offset + limit);
    const next = offset + items.length;
    return {
      total: filtered.length,
      offset,
      limit,
      nextOffset: items.length > 0 && next < filtered.length ? next : null,
      counts,
      items,
    };
  }

  function updateStaged(input: {
    id: string;
    targetText?: string;
    targetHtml?: string;
    editedBy?: string;
    status?: StagedReviewStatus;
    reviewComment?: string;
    revertToRevision?: number;
  }): StagedEntry | null {
    const entry = state.staged.find((item) => item.id === input.id);
    if (!entry) return null;

    let nextTargetText = entry.targetText;
    let nextTargetHtml = entry.targetHtml;

    if (input.revertToRevision !== undefined) {
      const targetRev = entry.history.find((h) => h.revision === input.revertToRevision);
      if (!targetRev) return null;
      nextTargetText = targetRev.targetText;
      nextTargetHtml = targetRev.targetHtml;
    } else {
      if (input.targetText !== undefined) {
        nextTargetText = String(input.targetText);
        if (input.targetHtml === undefined) {
          nextTargetHtml = hasMqInlineTags(nextTargetText) ? nextTargetText : "";
        }
      }
      if (input.targetHtml !== undefined) {
        nextTargetHtml = String(input.targetHtml);
      }
    }

    const timestamp = new Date(now()).toISOString();
    const targetChanged = nextTargetText !== entry.targetText || nextTargetHtml !== entry.targetHtml;

    if (targetChanged) {
      entry.history = [
        ...entry.history,
        {
          revision: entry.revision,
          targetText: entry.targetText,
          targetHtml: entry.targetHtml,
          editedBy: entry.stagedBy,
          ...(entry.reviewComment ? { note: entry.reviewComment } : {}),
          updatedAt: entry.updatedAt,
        },
      ].slice(-10);
      entry.revision += 1;
      entry.targetText = nextTargetText;
      entry.targetHtml = nextTargetHtml;
      entry.hasInlineTags =
        hasMqInlineTags(entry.sourceHtml) || hasMqInlineTags(nextTargetHtml) || hasMqInlineTags(entry.sourceText);
      if (input.editedBy) {
        entry.stagedBy = input.editedBy.trim() || entry.stagedBy;
      }
    }

    if (
      input.status === "draft"
      || input.status === "approved"
      || input.status === "needs_revision"
    ) {
      entry.status = input.status;
    }
    if (input.reviewComment !== undefined) {
      entry.reviewComment = String(input.reviewComment).trim();
    }
    entry.updatedAt = timestamp;
    markStagedMutated();
    saveState();
    return entry;
  }

  function setReviewFeedback(input: {
    id: string;
    comment: string;
    status?: StagedReviewStatus;
  }): StagedEntry | null {
    const entry = state.staged.find((item) => item.id === input.id);
    if (!entry) return null;
    const comment = String(input.comment ?? "").trim();
    const nextStatus: StagedReviewStatus =
      input.status === "draft" || input.status === "approved" || input.status === "needs_revision"
        ? input.status
        : comment
          ? "needs_revision"
          : entry.status === "needs_revision"
            ? "draft"
            : entry.status;
    entry.reviewComment = comment;
    entry.status = nextStatus;
    entry.updatedAt = new Date(now()).toISOString();
    markStagedMutated();
    saveState();
    return entry;
  }

  function approveStaged(
    options: { ids?: string[]; documentId?: string; status?: "approved" | "draft" } = {},
  ) {
    const targetStatus: StagedReviewStatus = options.status === "draft" ? "draft" : "approved";
    const idSet = Array.isArray(options.ids) && options.ids.length > 0 ? new Set(options.ids) : null;
    const docId = (options.documentId ?? "").trim().toLowerCase();
    const timestamp = new Date(now()).toISOString();

    let updated = 0;
    for (const entry of state.staged) {
      if (idSet && !idSet.has(entry.id)) continue;
      if (docId && entry.documentId.toLowerCase() !== docId) continue;
      if (entry.status !== targetStatus) {
        entry.status = targetStatus;
        entry.updatedAt = timestamp;
        updated += 1;
      }
    }

    if (updated > 0) {
      markStagedMutated();
      saveState();
    }

    const scopeEntries = docId
      ? state.staged.filter((entry) => entry.documentId.toLowerCase() === docId)
      : state.staged;
    const counts = computeCounts(scopeEntries);
    return {
      updated,
      approvedTotal: counts.approved,
      draftTotal: counts.draft,
      needsRevisionTotal: counts.needsRevision,
    };
  }

  function clearStaged(options: { documentId?: string } = {}) {
    const before = state.staged.length;
    const docId = (options.documentId ?? "").trim().toLowerCase();
    if (!docId) {
      state.staged = [];
    } else {
      state.staged = state.staged.filter((entry) => entry.documentId.toLowerCase() !== docId);
    }
    markStagedMutated();
    saveState();
    return {
      removed: before - state.staged.length,
      remaining: state.staged.length,
    };
  }

  function recordConfirmed(
    items: Array<{
      sourceLanguage: string;
      targetLanguage: string;
      requestType: string;
      sourceText: string;
      targetText: string;
    }>,
  ): number {
    const storedAt = new Date(now()).toISOString();
    let count = 0;
    const next: ConfirmedEntry[] = [];
    for (const item of items) {
      const sourceText = String(item.sourceText ?? "").trim();
      const targetText = String(item.targetText ?? "").trim();
      if (!sourceText || !targetText) continue;
      count += 1;
      next.push({
        sourceLanguage: String(item.sourceLanguage ?? "").trim(),
        targetLanguage: String(item.targetLanguage ?? "").trim(),
        requestType: String(item.requestType ?? "Plaintext").trim() || "Plaintext",
        sourceText,
        targetText,
        storedAt,
      });
    }
    if (count > 0) {
      const seen = new Set<string>();
      const merged: ConfirmedEntry[] = [];
      for (const entry of [...next, ...state.confirmed]) {
        const dedupeKey = `${normalizeLanguageCode(entry.sourceLanguage).canonical}|${normalizeLanguageCode(entry.targetLanguage).canonical}|${entry.sourceText}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        merged.push(entry);
        if (merged.length >= maxConfirmed) break;
      }
      state.confirmed = merged;
      saveState();
    }
    return count;
  }

  function listConfirmed(options: {
    sourceLanguage?: string;
    targetLanguage?: string;
    limit?: number;
  } = {}): ConfirmedEntry[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    return state.confirmed
      .filter((entry) => {
        if (options.sourceLanguage && !languagesMatch(entry.sourceLanguage, options.sourceLanguage)) {
          return false;
        }
        if (options.targetLanguage && !languagesMatch(entry.targetLanguage, options.targetLanguage)) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  function recordRecentRequest(entry: RecentMtRequestEntry): void {
    const key = `${entry.documentId}|${entry.sourceLanguage}|${entry.targetLanguage}|${entry.text}`;
    state.recentRequests = [
      entry,
      ...state.recentRequests.filter(
        (existing) => `${existing.documentId}|${existing.sourceLanguage}|${existing.targetLanguage}|${existing.text}` !== key,
      ),
    ].slice(0, maxRecentRequests);
    scheduleSave();
  }

  function listRecentRequests(options: { limit?: number; onlyWithTags?: boolean } = {}): RecentMtRequestEntry[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const filtered = options.onlyWithTags
      ? state.recentRequests.filter((item) => item.hasInlineTags)
      : state.recentRequests;
    return filtered.slice(0, limit);
  }

  function clearRecentRequests(options: { documentId?: string } = {}): { removed: number; remaining: number } {
    const before = state.recentRequests.length;
    const docId = (options.documentId ?? "").trim().toLowerCase();
    if (!docId) {
      state.recentRequests = [];
    } else {
      state.recentRequests = state.recentRequests.filter((entry) => entry.documentId.toLowerCase() !== docId);
    }
    const removed = before - state.recentRequests.length;
    if (removed > 0) {
      saveState();
    }
    return {
      removed,
      remaining: state.recentRequests.length,
    };
  }

  function resolveRecentRequest(query: {
    documentId?: string;
    sourceLanguage: string;
    targetLanguage: string;
    text: string;
    plainText?: string;
  }): number {
    if (state.recentRequests.length === 0) return 0;
    const docId = (query.documentId ?? "").trim().toLowerCase();
    const text = String(query.text ?? "");
    const norm = normalizeComparableText(query.plainText ?? text);
    const before = state.recentRequests.length;
    state.recentRequests = state.recentRequests.filter((entry) => {
      if (docId && entry.documentId && entry.documentId.toLowerCase() !== docId) {
        return true;
      }
      if (
        !languagesMatch(entry.sourceLanguage, query.sourceLanguage)
        || !languagesMatch(entry.targetLanguage, query.targetLanguage)
      ) {
        return true;
      }
      if (entry.text === text) return false;
      const entryNorm = normalizeComparableText(entry.plainText || entry.text);
      return !(norm && entryNorm && entryNorm === norm);
    });
    const removed = before - state.recentRequests.length;
    if (removed > 0) {
      scheduleSave();
    }
    return removed;
  }

  return {
    stageMany,
    findStaged,
    peekStaged,
    findPendingDraft,
    listStaged,
    updateStaged,
    setReviewFeedback,
    approveStaged,
    clearStaged,
    recordConfirmed,
    listConfirmed,
    recordRecentRequest,
    listRecentRequests,
    clearRecentRequests,
    resolveRecentRequest,
    flush,
  };
}

export function describeMissedReason(reason: string): string {
  switch (reason) {
    case "not_staged":
      return "未暂存 (not_staged)";
    case "staged_draft_pending_approval":
      return "草稿未放行";
    case "inline_tags_required":
      return "行内标签不匹配";
    case "live_fallback_failed":
    case "live_fallback_error":
      return "实时翻译失败";
    default:
      return reason;
  }
}

function isStagedTagCompatible(item: RecentMtRequestEntry, matched: StagedEntry): boolean {
  if (!hasMqInlineTags(item.text)) {
    return true;
  }
  const preferred = matched.targetHtml || matched.targetText;
  if (verifyInlineTagInventory(item.text, preferred).ok) {
    return true;
  }
  if (restoreInlineTagsFromStaged(item.text, matched.sourceText, matched.targetText, item.requestType) !== null) {
    return true;
  }
  if (
    matched.sourceHtml
    && restoreInlineTagsFromStaged(item.text, matched.sourceHtml, matched.targetText, item.requestType) !== null
  ) {
    return true;
  }
  return matched.tagPolicy === "plaintext-fallback";
}

function richnessScore(item: RecentMtRequestEntry): number {
  return (item.hasInlineTags ? 4 : 0)
    + (item.requestType === "BothFormattingAndTags" ? 2 : item.requestType === "OnlyFormatting" ? 1 : 0);
}

export function summarizeMissedRequests(
  store: StagingStore,
  options: { documentId?: string; limit?: number } = {},
): { count: number; byReason: Record<string, number>; items: MissedMtSummaryItem[] } {
  const recent = store.listRecentRequests({ limit: 200 });
  const docFilter = (options.documentId ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));

  const grouped = new Map<string, MissedMtSummaryItem & { bestRichness: number }>();
  const liveResolvedAt = new Map<string, number>();
  for (const item of recent) {
    if (docFilter && item.documentId && item.documentId.toLowerCase() !== docFilter) {
      continue;
    }

    const srcCanon = normalizeLanguageCode(item.sourceLanguage).canonical;
    const tgtCanon = normalizeLanguageCode(item.targetLanguage).canonical;
    const normPlain = normalizeComparableText(item.plainText || item.text);
    const key = `${item.documentId.trim().toLowerCase()}|${srcCanon}|${tgtCanon}|${normPlain || item.text}`;
    if (item.reason === "live_fallback") {
      const resolvedMs = Date.parse(item.receivedAt);
      const normalizedMs = Number.isFinite(resolvedMs) ? resolvedMs : 0;
      const prev = liveResolvedAt.get(key);
      if (prev === undefined || normalizedMs > prev) {
        liveResolvedAt.set(key, normalizedMs);
      }
      continue;
    }
    const score = richnessScore(item);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        key,
        documentId: item.documentId,
        sourceLanguage: item.sourceLanguage,
        targetLanguage: item.targetLanguage,
        text: item.text,
        plainText: item.plainText || item.text,
        hasInlineTags: item.hasInlineTags,
        requestType: item.requestType,
        reason: item.reason,
        reasonLabel: describeMissedReason(item.reason),
        attempts: 1,
        receivedAt: item.receivedAt,
        tmSource: item.tmSource,
        tmTarget: item.tmTarget,
        bestRichness: score,
      });
    } else {
      existing.attempts += 1;
      if (item.receivedAt > existing.receivedAt) {
        existing.receivedAt = item.receivedAt;
        existing.reason = item.reason;
        existing.reasonLabel = describeMissedReason(item.reason);
      }
      if (score > existing.bestRichness) {
        existing.text = item.text;
        existing.plainText = item.plainText || item.text;
        existing.hasInlineTags = item.hasInlineTags;
        existing.requestType = item.requestType;
        existing.tmSource = item.tmSource || existing.tmSource;
        existing.tmTarget = item.tmTarget || existing.tmTarget;
        existing.bestRichness = score;
      }
    }
  }

  const byReason: Record<string, number> = {};
  const unresolved: MissedMtSummaryItem[] = [];
  for (const candidate of grouped.values()) {
    const resolvedAt = liveResolvedAt.get(candidate.key);
    if (resolvedAt !== undefined) {
      const candidateMs = Date.parse(candidate.receivedAt);
      if (!Number.isFinite(candidateMs) || candidateMs <= resolvedAt) {
        continue;
      }
    }
    const matched = store.peekStaged({
      ...(candidate.documentId ? { documentId: candidate.documentId } : {}),
      sourceLanguage: candidate.sourceLanguage,
      targetLanguage: candidate.targetLanguage,
      text: candidate.text,
      plainText: candidate.plainText,
    });
    if (matched && isStagedTagCompatible(
      {
        requestId: "",
        receivedAt: candidate.receivedAt,
        documentId: candidate.documentId,
        projectId: "",
        client: "",
        domain: "",
        subject: "",
        sourceLanguage: candidate.sourceLanguage,
        targetLanguage: candidate.targetLanguage,
        requestType: candidate.requestType,
        index: 0,
        text: candidate.text,
        plainText: candidate.plainText,
        hasInlineTags: candidate.hasInlineTags,
        tmSource: candidate.tmSource,
        tmTarget: candidate.tmTarget,
        reason: candidate.reason,
      },
      matched,
    )) {
      continue;
    }

    const { bestRichness: _ignored, ...cleanItem } = candidate;
    byReason[cleanItem.reason] = (byReason[cleanItem.reason] ?? 0) + 1;
    unresolved.push(cleanItem);
  }

  unresolved.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return {
    count: unresolved.length,
    byReason,
    items: unresolved.slice(0, limit),
  };
}
