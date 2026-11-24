import * as z from "zod/v4";
import { defineSharedTool } from "@langlink/l10n-core/tool";
import { type BridgeHttpClient, probeGatewayPort } from "./daemon.ts";
import {
  DEFAULT_AGENT_QA_PAGE_SIZE,
  MAX_MEMOQ_QA_PAGE_SIZE,
} from "./qa-runner.ts";
import type { StagedReviewStatus } from "./contract.ts";
import {
  buildPluginInstallPlan,
  executeConfirmedPluginInstall,
  executeConfirmedPluginUninstall,
  getIntegrationStatus,
  MEMOQ_FIRST_TIME_RESOURCE_STEPS,
} from "./dll-installer.ts";
import type { StageTranslationInput } from "./staging-store.ts";

const READ_LOCAL = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE_LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT_LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE_LOCAL = { ...WRITE_LOCAL, destructiveHint: true } as const;
const count = z.number().int().nonnegative();
const stagedCountsSchema = z.object({ approved: count, draft: count, needsRevision: count });
const DEFAULT_STAGED_LIST_PAGE_SIZE = 50;
const MAX_STAGED_LIST_PAGE_SIZE = 500;

interface MemoqToolOptions {
  getBridgeClient(): Promise<BridgeHttpClient>;
  getPort(): number;
  launchSetup(customInstallDir?: string): Promise<string>;
  statusDetails?: () => Promise<Record<string, unknown>>;
  defaultProjectDir?: () => string | undefined;
  packageRoot: string;
  dataDir?: string;
  buildInstallPlan?: typeof buildPluginInstallPlan;
  installPlugin?: typeof executeConfirmedPluginInstall;
  uninstallPlugin?: typeof executeConfirmedPluginUninstall;
}

export function createMemoqTools(options: MemoqToolOptions) {
  const { packageRoot, getBridgeClient: resolveClient } = options;
  return [
    defineSharedTool(
      "memoq_status",
      {
        title: "Inspect memoQ connection",
        annotations: READ_LOCAL,
        description:
          "Inspect memoQ Desktop integration status: Preview named-pipe connection, active document, port 5271 gateway owner, DLL installation status, and staged/confirmed counts.",
        inputSchema: {},
      },
      async (_args, signal) => {
        const client = await resolveClient();
        const status = await client.getStatus(signal);
        const probe = await probeGatewayPort(options.getPort(), undefined, undefined, signal);
        const coverage = status.coverage as { attentionMessage?: string } | undefined;
        const integ = status.integration as { status?: string } | undefined;
        return {
          ...status,
          ...(await options.statusDetails?.()),
          port5271Owner: probe.owner,
          ...(integ?.status && integ.status !== "installed"
            ? {
                setupHint:
                  "检测到 memoQ MT 插件尚未完全就绪，可让 Agent 调用 memoq_setup（action: 'plan' / 'install'）获取本地 DLL 并引导完成首次配置。",
              }
            : {}),
          ...(coverage?.attentionMessage ? { warning: coverage.attentionMessage } : {}),
          ...(probe.owner === "memoq-ai-hub"
            ? {
                note: "memoQ AI Hub is currently using port 5271. Preview tools work normally; to use agent staging via port 5271, close memoQ AI Hub or change MEMOQ_BRIDGE_PORT and plugin gateway port.",
              }
            : {}),
        };
      },
    ),

    defineSharedTool(
      "memoq_get_active_segment",
      {
        title: "Read active memoQ segment",
        annotations: READ_LOCAL,
        description:
          "Read the active segment currently focused in memoQ Desktop via Preview pipe, including source, target, focused ranges, neighbor context, and mappingCertain flag.",
        inputSchema: {
          contextBefore: z.number().int().min(0).max(20).optional().describe("Number of neighboring segments to include before the focused segment."),
          contextAfter: z.number().int().min(0).max(20).optional().describe("Number of neighboring segments to include after the focused segment."),
          settleMs: z.number().int().min(0).max(500).optional().describe("Milliseconds to wait for the latest focus event."),
        },
      },
      async ({ contextBefore, contextAfter, settleMs }, signal) => {
        const client = await resolveClient();
        return client.getActiveSegment(
          {
            ...(contextBefore === undefined ? {} : { contextBefore }),
            ...(contextAfter === undefined ? {} : { contextAfter }),
            ...(settleMs === undefined ? {} : { settleMs }),
          },
          signal,
        );
      },
    ),

    defineSharedTool(
      "memoq_list_documents",
      {
        title: "List cached memoQ documents",
        annotations: READ_LOCAL,
        description:
          "List all open memoQ documents and glued Views cached in Preview during this session, with per-document segment counts and staged review counts.",
        inputSchema: {},
        outputSchema: {
          previewConnected: z.boolean(),
          documents: z.array(z.record(z.string(), z.unknown())),
          tip: z.string(),
        },
      },
      async (_args, signal) => {
        const client = await resolveClient();
        const res = await client.listPreviewDocuments(signal);
        return {
          ...res,
          tip: "如需一次对整个 memoQ 项目的所有文档暂存翻译，请在 memoQ 列表全选文档 → Create View → Simply glue documents together 并打开该视图。",
        };
      },
    ),

    defineSharedTool(
      "memoq_get_document_segments",
      {
        title: "Read memoQ segments",
        annotations: READ_LOCAL,
        description:
          "Read cached Preview segments from a selected or active memoQ document. Use nextOffset with the same document and filters to continue. Results cover the Preview cache.",
        inputSchema: {
          documentId: z.string().optional().describe("Document ID from memoq_list_documents; defaults to the active document."),
          offset: count.optional().describe("Zero-based offset in the filtered results; defaults to 0."),
          limit: z.number().int().min(1).max(500).optional().describe("Maximum segments per page; defaults to 50."),
          onlyUntranslated: z.boolean().optional().describe("Include only segments with an empty target."),
          query: z.string().max(500).optional().describe("Substring filter across source text, target text, and Preview part ID."),
        },
        outputSchema: {
          available: z.boolean(),
          reason: z.string().optional(),
          document: z.object({
            documentId: z.string(), documentName: z.string(), sourceLanguage: z.string(), targetLanguage: z.string(),
          }).optional(),
          total: count, filtered: count, offset: count, limit: count, nextOffset: count.nullable(),
          segments: z.array(z.object({
            index: count, previewPartId: z.string(), sourceText: z.string(), targetText: z.string(), isActive: z.boolean(),
          })),
        },
      },
      async ({ documentId, offset, limit, onlyUntranslated, query }, signal) => {
        const client = await resolveClient();
        const page = await client.getDocumentSegments(
          {
            ...(documentId === undefined ? {} : { documentId }),
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
            ...(onlyUntranslated === undefined ? {} : { onlyUntranslated }),
            ...(query === undefined ? {} : { query }),
          },
          signal,
        );
        return page;
      },
    ),

    defineSharedTool(
      "memoq_focus_segment",
      {
        title: "Focus memoQ segment",
        annotations: WRITE_IDEMPOTENT_LOCAL,
        description:
          "Move the active selection/highlight inside memoQ Desktop editor to a specific previewPartId.",
        inputSchema: {
          previewPartId: z.string().min(1).describe("Preview part ID of the segment to focus, from memoq_get_document_segments or memoq_get_active_segment."),
          documentId: z.string().optional().describe("Optional document ID from memoq_list_documents to disambiguate across open documents."),
          sourceText: z.string().optional().describe("Optional source text hint for fallback matching when Preview cache refreshed."),
          targetText: z.string().optional().describe("Optional target text hint for fallback matching."),
        },
        outputSchema: {
          ok: z.boolean(),
          error: z.string().optional(),
        },
      },
      async ({ previewPartId, documentId, sourceText, targetText }, signal) => {
        const client = await resolveClient();
        return client.focusSegment(
          {
            previewPartId,
            ...(documentId === undefined ? {} : { documentId }),
            ...(sourceText === undefined ? {} : { sourceText }),
            ...(targetText === undefined ? {} : { targetText }),
          },
          signal,
        );
      },
    ),

    defineSharedTool(
      "memoq_stage_translations",
      {
        title: "Stage memoQ translations",
        annotations: WRITE_LOCAL,
        description:
          "Save translated segments as drafts for review in the local workbench. Set an item or batch status to approved only after the user approves release to memoQ Pre-translate.",
        inputSchema: {
          status: z.enum(["draft", "approved"]).optional().describe("Default status for all items in this batch; defaults to 'draft'. Use 'approved' only after explicit user approval."),
          items: z
            .array(
              z.object({
                sourceText: z.string().min(1).describe("Plain source text matching the memoQ segment."),
                targetText: z.string().min(1).describe("Plain translated target text."),
                sourceHtml: z.string().optional().describe("Source HTML with <span data-mqitag> inline tags when staging tagged segments."),
                targetHtml: z.string().optional().describe("Target HTML preserving all <span data-mqitag> inline tags."),
                documentId: z.string().optional().describe("Document ID from memoq_list_documents; scopes matching and review grouping."),
                sourceLanguage: z.string().min(1).describe("memoQ source language code (e.g. 'eng', 'zho-CN')."),
                targetLanguage: z.string().min(1).describe("memoQ target language code (e.g. 'zho-CN', 'ind')."),
                confidence: z.number().min(0).max(1).optional().describe("Optional translation confidence score between 0 and 1."),
                info: z.string().max(120).optional().describe("Short provenance note displayed in the review workbench."),
                stagedBy: z.string().max(60).optional().describe("Identifier of the agent or workflow staging this entry."),
                tagPolicy: z.enum(["protect", "plaintext-fallback"]).optional().describe("Inline tag handling policy; defaults to 'protect'."),
                status: z.enum(["draft", "approved", "needs_revision"]).optional().describe("Per-item status override; inherits batch status when omitted."),
                previewPartId: z.string().optional().describe("Preview part ID from memoq_get_document_segments for jump-to-segment linking."),
                reviewNote: z.string().max(240).optional().describe("Short translator-facing note for the review workbench."),
              }),
            )
            .min(1)
            .max(200)
            .describe("Batch of 1 to 200 translated segments to stage."),
        },
        outputSchema: {
          stagedCount: count,
          entryIds: z.array(z.string()),
          warnings: z.array(z.string()),
          counts: stagedCountsSchema.optional(),
          reviewUrl: z.string(),
          reviewLink: z.string().optional(),
          integrationReady: z.boolean(),
          nextStep: z.string(),
        },
      },
      async ({ status: topStatus, items }, signal) => {
        const client = await resolveClient();
        const batchStatus: StagedReviewStatus = topStatus === "approved" ? "approved" : "draft";
        const normalized: StageTranslationInput[] = items.map((item) => ({
          sourceText: item.sourceText,
          targetText: item.targetText,
          sourceLanguage: item.sourceLanguage,
          targetLanguage: item.targetLanguage,
          ...(item.sourceHtml === undefined ? {} : { sourceHtml: item.sourceHtml }),
          ...(item.targetHtml === undefined ? {} : { targetHtml: item.targetHtml }),
          ...(item.documentId === undefined ? {} : { documentId: item.documentId }),
          ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
          ...(item.info === undefined ? {} : { info: item.info }),
          ...(item.stagedBy === undefined ? {} : { stagedBy: item.stagedBy }),
          ...(item.tagPolicy === undefined ? {} : { tagPolicy: item.tagPolicy }),
          status: item.status ?? batchStatus,
          ...(item.previewPartId === undefined ? {} : { previewPartId: item.previewPartId }),
          ...(item.reviewNote === undefined ? {} : { reviewNote: item.reviewNote }),
        }));
        const result = await client.stageTranslations(normalized, signal);
        const status = await client.getStatus(signal);
        const reviewUrl = String(status.reviewUrl ?? "");
        const stagingMeta = status.staging as { counts?: { approved: number; draft: number; needsRevision: number } } | undefined;
        const integration = status.integration as { status?: string } | null;
        return {
          stagedCount: result.stagedCount,
          entryIds: result.entries.map((entry) => entry.id),
          warnings: result.warnings,
          ...(stagingMeta?.counts ? { counts: stagingMeta.counts } : {}),
          reviewUrl,
          ...(reviewUrl ? { reviewLink: `[打开 memoQ 双语审校与 QA 工作台](${reviewUrl})` } : {}),
          integrationReady: integration?.status === "installed",
          nextStep:
            integration?.status !== "installed"
              ? "MT plugin DLL is not installed yet. Call memoq_setup to guide the user through safe one-click setup."
              : batchStatus === "draft"
                ? `已按「草稿待审」状态暂存。请打开审校工作台查看/修改或写批注：${reviewUrl} ；确认无误后点击「一键放行全部定稿到 memoQ」（或调用 memoq_approve_staged），再回 memoQ 运行 Pre-translate。`
                : "Translations staged and approved. In memoQ Desktop, select the segment or run Pre-translate using memoQ AI Hub.",
        };
      },
    ),

    defineSharedTool(
      "memoq_list_staged",
      {
        title: "List staged translations",
        annotations: READ_LOCAL,
        description:
          "List currently staged translations in the local memoQ bridge with status filtering and cursor pagination. Use nextOffset with the same filters to continue.",
        inputSchema: {
          documentId: z.string().optional().describe("Filter staged entries to one document ID from memoq_list_documents."),
          status: z.enum(["all", "draft", "approved", "needs_revision"]).optional().describe("Filter by review status; defaults to 'all'."),
          onlyWithComment: z.boolean().optional().describe("Return only entries that have a non-empty translator reviewComment."),
          offset: count.optional().describe("Zero-based offset in the filtered staged entries; defaults to 0."),
          limit: z.number().int().min(1).max(MAX_STAGED_LIST_PAGE_SIZE).optional().describe("Maximum entries per page; defaults to 50."),
          includeHistory: z.boolean().optional().describe("Include full revision history arrays on each entry; defaults to false to save tokens."),
        },
        outputSchema: {
          total: count,
          offset: count,
          limit: count,
          nextOffset: count.nullable(),
          counts: stagedCountsSchema,
          items: z.array(z.record(z.string(), z.unknown())),
        },
      },
      async ({ documentId, status, onlyWithComment, offset, limit, includeHistory }, signal) => {
        const client = await resolveClient();
        const page = await client.listStaged(
          {
            ...(documentId === undefined ? {} : { documentId }),
            ...(status === undefined ? {} : { status }),
            ...(onlyWithComment === undefined ? {} : { onlyWithComment }),
            offset: offset ?? 0,
            limit: limit ?? DEFAULT_STAGED_LIST_PAGE_SIZE,
          },
          signal,
        );
        const items = includeHistory
          ? page.items
          : page.items.map(({ history: _history, ...rest }) => rest);
        return {
          ...page,
          items,
        };
      },
    ),

    defineSharedTool(
      "memoq_open_review",
      {
        title: "Get memoQ review workbench link",
        annotations: READ_LOCAL,
        description:
          "Get the clickable local URL of the interactive Review & QA Workbench where translators can review staged drafts, edit in multiple rounds, write agent feedback comments, run configurable QA, jump to memoQ segments, inspect any Pre-translate missed/uncovered segments, and approve final versions.",
        inputSchema: {},
      },
      async (_args, signal) => {
        const client = await resolveClient();
        const status = await client.getStatus(signal);
        const reviewUrl = String(status.reviewUrl ?? "");
        const coverage = status.coverage as { attentionMessage?: string } | undefined;
        return {
          reviewUrl,
          link: `[打开 memoQ 双语审校与 QA 工作台](${reviewUrl})`,
          preview: status.preview,
          staging: status.staging,
          ...(status.coverage ? { coverage: status.coverage } : {}),
          ...(status.missedPretranslate ? { missedPretranslate: status.missedPretranslate } : {}),
          ...(coverage?.attentionMessage ? { warning: coverage.attentionMessage } : {}),
          message: coverage?.attentionMessage
            ? `${coverage.attentionMessage} 请打开工作台查看处理：[打开 memoQ 双语审校与 QA 工作台](${reviewUrl})`
            : `请在浏览器中打开工作台查看/修改译文并放行定稿：[打开 memoQ 双语审校与 QA 工作台](${reviewUrl})`,
        };
      },
    ),

    defineSharedTool(
      "memoq_approve_staged",
      {
        title: "Release or retract staged translations",
        annotations: WRITE_IDEMPOTENT_LOCAL,
        description:
          "Release staged translations to memoQ Pre-translate or return them to draft after user approval. Use entry IDs or a document ID to scope the change; omitting both applies it to the entire staging pool.",
        inputSchema: {
          ids: z.array(z.string()).optional().describe("Specific staged entry IDs to update; omit to target by documentId or all entries."),
          documentId: z.string().optional().describe("Document ID to scope approval/retraction; omit together with ids to apply to all staged entries."),
          status: z.enum(["approved", "draft"]).optional().describe("Target status: 'approved' releases to memoQ Pre-translate (default), 'draft' retracts."),
        },
        outputSchema: {
          updated: count,
          approvedTotal: count,
          draftTotal: count,
          needsRevisionTotal: count,
          reviewUrl: z.string(),
          coverage: z.record(z.string(), z.unknown()).optional(),
          missedPretranslate: z.record(z.string(), z.unknown()).optional(),
          warning: z.string().optional(),
          nextStep: z.string(),
        },
      },
      async ({ ids, documentId, status }, signal) => {
        const client = await resolveClient();
        const result = await client.approveStaged(
          {
            ...(ids === undefined ? {} : { ids }),
            ...(documentId === undefined ? {} : { documentId }),
            ...(status === undefined ? {} : { status }),
          },
          signal,
        );
        const bridgeStatus = await client.getStatus(signal);
        const reviewUrl = String(bridgeStatus.reviewUrl ?? "");
        const coverage = bridgeStatus.coverage as
          | {
              uncoveredPreviewCount?: number;
              pendingDraftCount?: number;
              missedPretranslateCount?: number;
              attentionMessage?: string;
            }
          | undefined;
        const warnings: string[] = [];
        if (status !== "draft") {
          if ((coverage?.uncoveredPreviewCount ?? 0) > 0) {
            warnings.push(
              `Preview 当前窗口仍有 ${coverage!.uncoveredPreviewCount} 条句段未暂存译文，Pre-translate 会跳过或告警。`,
            );
          }
          if ((coverage?.missedPretranslateCount ?? 0) > 0) {
            warnings.push(
              `此前 Pre-translate 有 ${coverage!.missedPretranslateCount} 条未命中记录，可调用 memoq_get_recent_mt_requests 补全。`,
            );
          }
          if (result.draftTotal + result.needsRevisionTotal > 0) {
            warnings.push(
              `仍有 ${result.draftTotal} 条草稿 / ${result.needsRevisionTotal} 条需修订尚未放行。`,
            );
          }
        }
        return {
          ...result,
          reviewUrl,
          ...(bridgeStatus.coverage ? { coverage: bridgeStatus.coverage as Record<string, unknown> } : {}),
          ...(bridgeStatus.missedPretranslate
            ? { missedPretranslate: bridgeStatus.missedPretranslate as Record<string, unknown> }
            : {}),
          ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          nextStep:
            status === "draft"
              ? "已撤回为草稿锁定状态，memoQ Pre-translate 不会拉取这些条目。"
              : warnings.length > 0
                ? `已放行 ${result.approvedTotal} 条定稿。⚠ 注意：${warnings.join(" ")} 若 memoQ Pre-translate 弹出黄色告警，请立即调用 memoq_get_recent_mt_requests 或在工作台查看红色漏翻告警条进行补翻/复制原文。`
                : `已放行 ${result.approvedTotal} 条定稿。现在回 memoQ 运行 Pre-translate 即可将最终译文写入文档（若 memoQ 弹窗仍有黄色告警，通常是末尾页以外的短句或带标签句段，可调用 memoq_get_recent_mt_requests 查看具体漏翻句）。`,
        };
      },
    ),

    defineSharedTool(
      "memoq_qa_document",
      {
        title: "Run deterministic memoQ QA",
        annotations: READ_LOCAL,
        description:
          "Run deterministic QA, MQM scoring, and terminology checks on cached memoQ segments, staged drafts, or both. Returns aggregate coverage and one issue page. Use nextIssueOffset with the same scope and options, or open the review workbench for full context.",
        inputSchema: {
          scope: z.enum(["memoq", "staged", "merged"]).optional().describe("Segment source to check: 'memoq' (Preview only), 'staged' (staged only), or 'merged' (default: staged overriding Preview)."),
          documentId: z.string().optional().describe("Document ID to check; defaults to the active document."),
          allDocuments: z.boolean().optional().describe("Check all cached documents together instead of only the active/selected document."),
          enabledRules: z.array(z.string()).optional().describe("Explicit list of QA rule IDs to enable; omit to run all default deterministic rules."),
          customRules: z
            .array(
              z.object({
                name: z.string().min(1).max(80).describe("Short display name for the custom QA rule."),
                sourceContains: z.string().max(300).optional().describe("Optional source substring condition; omit to apply to every segment."),
                kind: z.enum(["required", "forbidden", "maxLength"]).describe("Rule check type: required substring, forbidden substring, or max target character length."),
                value: z.string().min(1).max(300).describe("Target substring for required/forbidden, or numeric character limit for maxLength."),
              }),
            )
            .max(20)
            .optional()
            .describe("Up to 20 ad-hoc custom QA rules to evaluate alongside built-in rules."),
          glossaryPath: z.string().optional().describe("Path to a local CSV or TBX glossary file for terminology checks."),
          projectDir: z.string().optional().describe("Project directory containing localization assets (glossaries/QA profiles)."),
          whitelist: z.array(z.string()).optional().describe("Terms or tokens to exempt from untranslated/terminology warnings."),
          targetLocale: z.string().optional().describe("Target locale override (e.g. 'zh-CN', 'ja-JP') for punctuation and number rules."),
          maxIssues: z.number().int().min(1).max(MAX_MEMOQ_QA_PAGE_SIZE).optional().describe("Maximum issues per page; defaults to 25, or 500 with includeSegments."),
          issueOffset: count.optional().describe("Start at 0 and use nextIssueOffset to continue."),
          includeSegments: z.boolean().optional().describe("Include full source and target snapshots for all checked segments. Defaults to false."),
        },
      },
      async ({ scope, documentId, allDocuments, enabledRules, customRules, glossaryPath, projectDir, whitelist, targetLocale, maxIssues, issueOffset, includeSegments }, signal) => {
        const client = await resolveClient();
        const effectiveProjectDir = projectDir ?? options.defaultProjectDir?.();
        const normalizedCustomRules = customRules?.map((rule) => ({
          name: rule.name,
          sourceContains: rule.sourceContains ?? "",
          kind: rule.kind,
          value: rule.value,
        }));
        const report = await client.runQa(
          {
            ...(scope === undefined ? {} : { scope }),
            ...(documentId === undefined ? {} : { documentId }),
            ...(allDocuments === undefined ? {} : { allDocuments }),
            ...(enabledRules === undefined ? {} : { enabledRules }),
            ...(normalizedCustomRules === undefined ? {} : { customRules: normalizedCustomRules }),
            ...(glossaryPath === undefined ? {} : { glossaryPath }),
            ...(effectiveProjectDir === undefined ? {} : { projectDir: effectiveProjectDir }),
            ...(whitelist === undefined ? {} : { whitelist }),
            ...(targetLocale === undefined ? {} : { targetLocale }),
            maxIssues: maxIssues ?? (includeSegments ? 500 : DEFAULT_AGENT_QA_PAGE_SIZE),
            issueOffset: issueOffset ?? 0,
            includeSegments: includeSegments === true,
          },
          signal,
        );
        return {
          ...report,
          link: `[在审校工作台中查看与修复 QA 问题](${report.reviewUrl})`,
        };
      },
    ),

    defineSharedTool(
      "memoq_clear_staged",
      {
        title: "Delete staged translations",
        annotations: DESTRUCTIVE_LOCAL,
        description: "Permanently delete staged translations and their revision history after the user confirms the scope. Omit documentId only when the user confirms clearing the entire staging pool.",
        inputSchema: {
          documentId: z.string().trim().min(1, "Provide a document ID or omit this field to clear all documents.").optional()
            .describe("Document to clear. Omit for all documents."),
          confirmed: z.boolean().optional().describe("Set true only after the user explicitly approves this deletion scope."),
        },
        outputSchema: {
          removed: count,
          remaining: count,
        },
      },
      async ({ documentId, confirmed }, signal) => {
        if (confirmed !== true) throw new Error("Show the user the deletion scope, then retry with confirmed: true after approval.");
        const client = await resolveClient();
        return await client.clearStaged(documentId, signal);
      },
    ),

    defineSharedTool(
      "memoq_get_confirmed_translations",
      {
        title: "Read confirmed memoQ translations",
        annotations: READ_LOCAL,
        description:
          "Read recent human-confirmed translations written back by memoQ StoreTranslation when the translator confirms segments.",
        inputSchema: {
          sourceLanguage: z.string().optional().describe("Filter by memoQ source language code (e.g. 'eng')."),
          targetLanguage: z.string().optional().describe("Filter by memoQ target language code (e.g. 'zho-CN')."),
          limit: z.number().int().min(1).max(200).optional().describe("Maximum recent confirmed entries to return (1-200)."),
        },
        outputSchema: {
          items: z.array(z.record(z.string(), z.unknown())),
        },
      },
      async ({ sourceLanguage, targetLanguage, limit }, signal) => {
        const client = await resolveClient();
        return client.getConfirmed(
          {
            ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
            ...(targetLanguage === undefined ? {} : { targetLanguage }),
            ...(limit === undefined ? {} : { limit }),
          },
          signal,
        );
      },
    ),

    defineSharedTool(
      "memoq_get_recent_mt_requests",
      {
        title: "Inspect recent memoQ Pre-translate requests",
        annotations: READ_LOCAL,
        description:
          "Inspect recent MT lookup requests from memoQ that missed staging or require inline <span data-mqitag> HTML tags, including deduplicated unresolved Pre-translate misses and memoQ's fuzzy TM hints.",
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional().describe("Maximum recent MT request records to return (1-200)."),
          onlyWithTags: z.boolean().optional().describe("Return only requests containing memoQ inline <span data-mqitag> tags."),
        },
        outputSchema: {
          items: z.array(z.record(z.string(), z.unknown())),
          deduplicatedMissed: z.array(z.record(z.string(), z.unknown())).optional(),
          unresolvedCount: count.optional(),
          byReason: z.record(z.string(), count).optional(),
          nextStep: z.string(),
        },
      },
      async ({ limit, onlyWithTags }, signal) => {
        const client = await resolveClient();
        const recent = await client.getRecentRequests(
          {
            ...(limit === undefined ? {} : { limit }),
            ...(onlyWithTags === undefined ? {} : { onlyWithTags }),
          },
          signal,
        );
        const unresolvedCount = recent.unresolvedCount ?? recent.deduplicatedMissed?.length ?? 0;
        return {
          ...recent,
          nextStep:
            unresolvedCount > 0
              ? `发现 ${unresolvedCount} 条未命中 Pre-translate 句段（已去重同句多模式重试）。请向用户明确列出并补翻暂存（若 hasInlineTags 为 true，务必保留全部 <span data-mqitag="..."> 标签并同时填 sourceHtml/targetHtml），然后调用 memoq_approve_staged 放行并提示用户再跑一次 Pre-translate。`
              : "当前无未解决的 Pre-translate 漏翻记录。",
        };
      },
    ),

    defineSharedTool(
      "memoq_setup",
      {
        title: "Plan or change memoQ plugin installation",
        annotations: { ...DESTRUCTIVE_LOCAL, openWorldHint: true },
        description:
          "Diagnose or change the local memoQ plugin installation. Start with action='plan' to discover installations and copy targets. Installation can download a DLL if needed. Set confirmed=true only after the user approves the exact install or uninstall changes.",
        inputSchema: {
          action: z.enum(["plan", "install", "uninstall"]).optional().describe("Operation to run: 'plan' (read-only diagnosis, default), 'install', or 'uninstall'."),
          customInstallDir: z.string().optional().describe("Custom memoQ installation directory if not auto-detected in standard Program Files paths."),
          memoqRoot: z.string().optional().describe("Explicit memoQ root directory selected from plan.installations."),
          dllPath: z.string().optional().describe("Local path to MemoQ.AI.Hub.Plugin.dll or its release ZIP archive."),
          searchDirs: z.array(z.string()).max(20).optional().describe("Additional local directories to scan for an existing plugin DLL/ZIP."),
          confirmed: z.boolean().optional().describe("Must be true for 'install' or 'uninstall', only after showing plannedChanges and receiving user approval."),
          openWizard: z.boolean().optional().describe("Set false during 'plan' to skip launching the local browser setup wizard."),
        },
      },
      async ({ action, customInstallDir, memoqRoot, dllPath, searchDirs, confirmed, openWizard }, signal) => {
        const effectiveAction = action ?? "plan";
        const targetCustomDir = customInstallDir ?? memoqRoot;
        const planFn = options.buildInstallPlan ?? buildPluginInstallPlan;
        const installFn = options.installPlugin ?? executeConfirmedPluginInstall;
        const uninstallFn = options.uninstallPlugin ?? executeConfirmedPluginUninstall;

        if (effectiveAction === "install") {
          if (confirmed !== true) {
            const plan = planFn({
              packageRoot,
              ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
              ...(targetCustomDir === undefined ? {} : { customInstallDir: targetCustomDir }),
              ...(dllPath === undefined ? {} : { dllPath }),
              ...(searchDirs === undefined ? {} : { searchDirs }),
            });
            return {
              action: "install",
              installed: false,
              confirmationRequired: true,
              plan,
              error:
                "必须先向用户展示拟变更清单（plan.plannedChanges：源 DLL、目标 Addins 复制路径、ClientDevConfig.xml 及是否触发 UAC），并在用户明确确认后再传 confirmed: true 执行安装。",
            };
          }
          const installResult = await installFn({
            packageRoot,
            ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
            ...(customInstallDir === undefined ? {} : { customInstallDir }),
            ...(memoqRoot === undefined ? {} : { memoqRoot }),
            ...(dllPath === undefined ? {} : { dllPath }),
            ...(searchDirs === undefined ? {} : { searchDirs }),
            confirmed: true,
          });
          return {
            action: "install",
            installed: true,
            ...installResult,
            memoqResourceSetupSteps: [...MEMOQ_FIRST_TIME_RESOURCE_STEPS],
          };
        }

        if (effectiveAction === "uninstall") {
          if (confirmed !== true) {
            return {
              action: "uninstall",
              uninstalled: false,
              confirmationRequired: true,
              error: "必须先获用户明确确认后再传 confirmed: true 才能卸载 memoQ 插件。",
            };
          }
          const uninstallResult = await uninstallFn({
            packageRoot,
            ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
            ...(customInstallDir === undefined ? {} : { customInstallDir }),
            ...(memoqRoot === undefined ? {} : { memoqRoot }),
            confirmed: true,
          });
          return {
            action: "uninstall",
            uninstalled: true,
            ...uninstallResult,
          };
        }

        const integration = getIntegrationStatus({
          packageRoot,
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
          ...(targetCustomDir === undefined ? {} : { customInstallDir: targetCustomDir }),
        });
        const plan = planFn({
          packageRoot,
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
          ...(targetCustomDir === undefined ? {} : { customInstallDir: targetCustomDir }),
          ...(dllPath === undefined ? {} : { dllPath }),
          ...(searchDirs === undefined ? {} : { searchDirs }),
        });
        const probe = await probeGatewayPort(options.getPort(), undefined, undefined, signal);
        const url = openWizard === false ? "" : await options.launchSetup(targetCustomDir);
        return {
          action: "plan",
          ...(url ? { url, link: `[打开 memoQ 连接器安装与诊断向导](${url})` } : {}),
          integration,
          plan,
          gateway: probe,
          confirmationRequired: true,
          memoqResourceSetupSteps: [...MEMOQ_FIRST_TIME_RESOURCE_STEPS],
          nextStep: integration.canReuseExisting
            ? "检测到已安装的兼容插件可直接复用。如果用户是首次使用本工具，请对照 memoqResourceSetupSteps 引导用户在 memoQ 中打开 Resource Console → MT settings → Create new 新建并勾选 memoQ AI Hub，同时在当前项目的 Project home → Settings → MT settings 中启用该资源；如需修复或安装到其他版本，请先向用户展示 plan.plannedChanges 并获明确确认后再调用 memoq_setup({ action: 'install', confirmed: true, memoqRoot, dllPath })。"
            : plan.readyToInstall
              ? "已定位目标 memoQ 目录与源 DLL。请先在对话中列出 plan.plannedChanges（源路径、复制目标路径、SHA-256、ClientDevConfig.xml 备份合并计划、是否弹 UAC），等用户确认后再调用 memoq_setup({ action: 'install', confirmed: true, memoqRoot: plan.recommendedMemoqRoot, dllPath: plan.plannedChanges.sourceDllPath })，安装完成后再对照 memoqResourceSetupSteps 引导用户在 memoQ 中新建并启用 MT 资源。"
              : `尚未就绪：${plan.blockers.join("；")}。请向用户确认 memoQ 目录 (customInstallDir) 或本地 DLL/ZIP 路径 (dllPath)，或使用本地可视化向导。`,
          message: integration.canReuseExisting
            ? `检测到已安装的 memoQ 插件可直接复用。${url ? `如需查看详情或修复，请打开：[打开 memoQ 连接器安装与诊断向导](${url})` : ""}`
            : plan.readyToInstall
              ? `已找到安装路径与插件文件（将复制并保留原件）。请在与用户确认具体变更路径后调用 memoq_setup({ action: "install", confirmed: true, ... }) 完成安装${url ? `，或打开可视化向导：[打开 memoQ 连接器安装与诊断向导](${url})` : ""}。`
              : `请在浏览器中打开本地设置向导查看将要写入的 2 个路径并点击安装${url ? `：[打开 memoQ 连接器安装与诊断向导](${url})` : ""}`,
        };
      },
    ),
  ];
}
