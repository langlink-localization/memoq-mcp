import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BridgeHttpClient,
  CONTRACT_VERSION,
  MEMOQ_FIRST_TIME_RESOURCE_STEPS,
  ROUTES,
  startBridgeRuntime,
} from "@langlink/memoq-bridge";
import { createMemoqMcpServer } from "../src/server.ts";

function parseTextTool(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const first = result.content[0];
  assert.ok(first && first.type === "text" && typeof first.text === "string");
  return JSON.parse(first.text) as Record<string, unknown>;
}

test("BridgeHttpClient forwards AbortSignal to fetch", async (t) => {
  let receivedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    if (receivedSignal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    return Response.json({ ok: true });
  });
  const bridge = new BridgeHttpClient("http://127.0.0.1", "test-token");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => bridge.getStatus(controller.signal), { name: "AbortError" });
  assert.equal(receivedSignal?.aborted, true);
});

test("listStaged paging works when the MCP server shares a legacy bridge", async (t) => {
  const allItems = [{ id: "e1" }, { id: "e2" }, { id: "e3" }];
  const requestedLimits: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const parsed = new URL(url);
    const limit = Number(parsed.searchParams.get("limit") ?? "100");
    requestedLimits.push(limit);
    return Response.json({
      total: allItems.length,
      counts: { approved: 0, draft: 3, needsRevision: 0 },
      items: allItems.slice(0, limit),
    });
  });
  const bridge = new BridgeHttpClient("http://127.0.0.1", "test-token");
  const first = await bridge.listStaged({ offset: 0, limit: 1 });
  assert.equal(first.items[0]?.id, "e1");
  assert.equal(first.nextOffset, 1);
  const second = await bridge.listStaged({ offset: 1, limit: 1 });
  assert.equal(second.items[0]?.id, "e2");
  assert.equal(second.nextOffset, 2);
  const third = await bridge.listStaged({ offset: 2, limit: 1 });
  assert.equal(third.items[0]?.id, "e3");
  assert.equal(third.nextOffset, null);
  assert.deepEqual(requestedLimits, [1, 1, 2, 1, 3]);
});

test("QA paging works when the MCP server shares a legacy DSH bridge", async (t) => {
  const issueIds = ["first", "second", "third"];
  const requestedLimits: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requestedLimits.push(body.maxIssues);
    return Response.json({
      summary: { totalIssues: issueIds.length },
      issues: issueIds.slice(0, body.maxIssues).map((segmentId) => ({ segmentId })),
      segments: [{ segmentKey: "example" }],
      reviewUrl: "http://127.0.0.1/review",
    });
  });
  const bridge = new BridgeHttpClient("http://127.0.0.1", "test-token");
  const first = await bridge.runQa({ maxIssues: 1, includeSegments: false });
  assert.equal(first.issues[0]?.segmentId, "first");
  assert.equal(first.nextIssueOffset, 1);
  assert.deepEqual(first.segments, []);
  const next = await bridge.runQa({ maxIssues: 1, issueOffset: 1, includeSegments: true });
  assert.equal(next.issues[0]?.segmentId, "second");
  assert.equal(next.nextIssueOffset, 2);
  assert.equal(next.segments[0]?.segmentKey, "example");
  assert.deepEqual(requestedLimits, [1, 1, 2]);
});

test("memoq-mcp exposes its tools and bridges Preview, Staging, Confirmed feedback, MT requests, and Setup", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memoq-mcp-srv-"));
  const runtime = await startBridgeRuntime({
    preferredPort: 0,
    startPreview: false,
    writeDaemonFile: false,
    dataDir,
  });

  runtime.previewClient.ingestEventForTest?.({
    type: "status",
    state: "connected",
    connected: true,
    previewToolId: "7f4e9b21-8c34-4a62-9d51-3b7e2f8a6c14",
  });
  runtime.previewClient.ingestEventForTest?.({
    type: "content_update",
    parts: [
      {
        documentId: "doc-mcp-1",
        documentName: "guide.docx",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        previewPartId: "doc-mcp-1::p1",
        sourceText: "Save the document.",
        targetText: "",
        order: 0,
      },
      {
        documentId: "doc-mcp-1",
        documentName: "guide.docx",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        previewPartId: "doc-mcp-1::p2",
        sourceText: "Close the window.",
        targetText: "关闭窗口。",
        order: 1,
      },
    ],
  });
  runtime.previewClient.ingestEventForTest?.({
    type: "highlight_change",
    activeParts: [
      {
        documentId: "doc-mcp-1",
        previewPartId: "doc-mcp-1::p1",
        sourceFocusedRange: { startIndex: 0, length: 4 },
      },
    ],
  });

  let confirmedInstallCalled = false;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMemoqMcpServer({
    bridgeClient: runtime.client,
    launchSetupWizard: async () => "http://127.0.0.1:45678/?token=smoke-token",
    dataDir,
    buildInstallPlan: () => ({
      platform: "win32",
      operation: "copy",
      preservesOriginalSource: true,
      readyToInstall: true,
      alreadyInstalled: false,
      canReuseExisting: false,
      blockers: [],
      expectedPluginDllName: "MemoQ.AI.Hub.Plugin.dll",
      expectedPluginVersion: "1.0.7.0",
      expectedSha256: "ABC",
      acceptedSha256s: ["ABC"],
      recommendedMemoqRoot: "D:\\memoQ\\memoQ-12",
      installations: [],
      discoveredDlls: [],
      selectedDllCandidate: null,
      willDownloadFromRelease: false,
      downloadUrl: "https://example.com/plugin.zip",
      firstTimeResourceSteps: [...MEMOQ_FIRST_TIME_RESOURCE_STEPS],
      plannedChanges: {
        sourceDllPath: "D:\\Downloads\\MemoQ.AI.Hub.Plugin.dll",
        sourceKind: "dll",
        targetDllPath: "D:\\memoQ\\memoQ-12\\Addins\\MemoQ.AI.Hub.Plugin.dll",
        clientDevConfigPath: "C:\\ProgramData\\MemoQ\\ClientDevConfig.xml",
        clientDevConfigAction: "backup_and_merge",
        removesLegacyDll: false,
        removesMotw: true,
        requiresElevation: true,
        expectedSha256: "ABC",
      },
    }),
    installPlugin: async (opts) => {
      assert.equal(opts?.confirmed, true);
      confirmedInstallCalled = true;
      return {
        ok: true,
        operation: "copy",
        preservesOriginalSource: true,
        sourceAsset: {
          path: opts?.dllPath ?? "D:\\Downloads\\MemoQ.AI.Hub.Plugin.dll",
          sha256: "ABC",
          version: "1.0.7.0",
          source: "explicit",
          verified: true,
        },
        result: {
          ok: true,
          action: "install",
          memoqRoot: opts?.memoqRoot ?? "D:\\memoQ\\memoQ-12",
          dllTarget: "D:\\memoQ\\memoQ-12\\Addins\\MemoQ.AI.Hub.Plugin.dll",
          dllSha256: "ABC",
        },
        integration: {
          platform: "win32",
          status: "installed",
          canReuseExisting: true,
          expectedPluginDllName: "MemoQ.AI.Hub.Plugin.dll",
          expectedPluginVersion: "1.0.7.0",
          expectedPluginSha256: "ABC",
          clientDevConfig: { path: "C:\\ProgramData\\MemoQ\\ClientDevConfig.xml", exists: true, loadUnsignedPluginsEnabled: true },
          installations: [],
          helperAvailable: true,
          helperPath: "helper.exe",
        },
        nextSteps: ["Restart memoQ"],
      };
    },
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "memoq-mcp-test", version: "0.1.0" });
  await client.connect(clientTransport);

  try {
    const ambiguousEdit = await client.callTool({
      name: "memoq_apply_edits",
      arguments: {
        documentId: "fixture",
        edits: [{
          previewPartId: "row",
          expectedSource: "source",
          expectedTarget: "AA",
          replacements: [{ oldText: "A", newText: "B" }],
        }],
      },
    });
    assert.equal(ambiguousEdit.isError, undefined);
    assert.deepEqual(ambiguousEdit.structuredContent, JSON.parse(ambiguousEdit.content[0].text));
    assert.equal(ambiguousEdit.structuredContent?.results[0].status, "not_attempted");

    const listed = await client.listTools();
    assert.match(client.getInstructions() ?? "", /memoQ Desktop/u);
    assert.ok(listed.tools.every((tool) => tool.title && tool.annotations));
    for (const tool of listed.tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [propName, schema] of Object.entries(properties)) {
        assert.ok(
          typeof schema.description === "string" && schema.description.trim().length > 0,
          `${tool.name}.${propName} must have a parameter description`,
        );
      }
    }
    const annotations = new Map(listed.tools.map((tool) => [tool.name, tool.annotations]));
    assert.equal(annotations.get("memoq_get_document_segments")?.readOnlyHint, true);
    assert.equal(annotations.get("memoq_apply_edits")?.destructiveHint, true);
    assert.equal(annotations.get("memoq_focus_segment")?.readOnlyHint, false);
    assert.equal(annotations.get("memoq_focus_segment")?.idempotentHint, true);
    assert.equal(annotations.get("memoq_approve_staged")?.idempotentHint, true);
    assert.equal(annotations.get("memoq_clear_staged")?.destructiveHint, true);
    assert.equal(annotations.get("memoq_setup")?.destructiveHint, true);
    assert.equal(annotations.get("memoq_setup")?.openWorldHint, true);
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "memoq_apply_edits",
      "memoq_approve_staged",
      "memoq_clear_staged",
      "memoq_focus_segment",
      "memoq_get_active_segment",
      "memoq_get_confirmed_translations",
      "memoq_get_document_segments",
      "memoq_get_recent_mt_requests",
      "memoq_list_documents",
      "memoq_list_staged",
      "memoq_open_review",
      "memoq_qa_document",
      "memoq_setup",
      "memoq_stage_translations",
      "memoq_status",
    ]);

    const status = parseTextTool((await client.callTool({ name: "memoq_status", arguments: {} })) as never);
    assert.equal(typeof status.gateway, "object");
    assert.equal(typeof status.preview, "object");

    const docsRes = parseTextTool((await client.callTool({ name: "memoq_list_documents", arguments: {} })) as never);
    assert.equal((docsRes.documents as Array<{ documentId: string }>).length, 1);
    assert.equal((docsRes.documents as Array<{ documentId: string }>)[0]?.documentId, "doc-mcp-1");

    const active = parseTextTool(
      (await client.callTool({
        name: "memoq_get_active_segment",
        arguments: { contextBefore: 1, contextAfter: 1, settleMs: 0 },
      })) as never,
    );
    assert.equal(active.available, true);
    assert.equal((active.document as { sourceLanguage: string }).sourceLanguage, "eng");
    assert.equal((active.segment as { previewPartId: string }).previewPartId, "doc-mcp-1::p1");

    const docSegs = parseTextTool(
      (await client.callTool({
        name: "memoq_get_document_segments",
        arguments: { onlyUntranslated: true },
      })) as never,
    );
    assert.equal(docSegs.total, 2);
    assert.equal(docSegs.filtered, 1);
    assert.equal((docSegs.segments as Array<unknown>).length, 1);
    assert.equal(docSegs.nextOffset, null);
    const page = await client.callTool({ name: "memoq_get_document_segments", arguments: { limit: 1 } });
    const firstPage = parseTextTool(page as never);
    assert.deepEqual(page.structuredContent, firstPage);
    assert.equal(firstPage.nextOffset, 1);
    const secondPage = parseTextTool((await client.callTool({
      name: "memoq_get_document_segments", arguments: { offset: firstPage.nextOffset, limit: 1 },
    })) as never);
    assert.equal(secondPage.nextOffset, null);

    const stagedRaw = await client.callTool({
      name: "memoq_stage_translations",
      arguments: {
        items: [
          {
            documentId: "doc-mcp-1",
            sourceLanguage: "eng",
            targetLanguage: "zho-CN",
            sourceText: "Save the document.",
            targetText: "保存文档。",
            confidence: 0.96,
            info: "Staged by test",
          },
        ],
      },
    });
    const stagedRes = parseTextTool(stagedRaw as never);
    assert.equal(stagedRes.stagedCount, 1);
    assert.equal((stagedRes.entryIds as string[]).length, 1);
    assert.equal("entries" in stagedRes, false, "should return compact entryIds instead of echoing full segment bodies");
    assert.deepEqual(stagedRaw.structuredContent, stagedRes);
    assert.ok(String(stagedRes.reviewUrl ?? "").includes("/review?token="));

    const openReviewRes = parseTextTool(
      (await client.callTool({ name: "memoq_open_review", arguments: {} })) as never,
    );
    assert.ok(String(openReviewRes.reviewUrl ?? "").includes("/review?token="));
    assert.equal((openReviewRes.coverage as { pendingDraftCount: number }).pendingDraftCount, 1);
    assert.match(String(openReviewRes.warning ?? ""), /未放行/u);

    const qaRes = parseTextTool(
      (await client.callTool({ name: "memoq_qa_document", arguments: { scope: "merged" } })) as never,
    );
    assert.equal((qaRes.summary as { totalSegments: number }).totalSegments, 2);
    assert.equal(qaRes.segmentsIncluded, false);
    assert.deepEqual(qaRes.segments, []);
    const fullQa = parseTextTool((await client.callTool({
      name: "memoq_qa_document", arguments: { scope: "merged", includeSegments: true },
    })) as never);
    assert.equal(fullQa.segmentsIncluded, true);
    assert.equal((fullQa.segments as unknown[]).length, 2);
    assert.deepEqual(qaRes.summary, fullQa.summary);

    const listRaw = await client.callTool({
      name: "memoq_list_staged",
      arguments: { documentId: "doc-mcp-1", status: "draft", offset: 0, limit: 1 },
    });
    const listRes = parseTextTool(listRaw as never);
    assert.equal(listRes.total, 1);
    assert.equal(listRes.offset, 0);
    assert.equal(listRes.limit, 1);
    assert.equal(listRes.nextOffset, null);
    assert.equal((listRes.counts as { draft: number }).draft, 1);
    assert.equal("history" in ((listRes.items as Array<Record<string, unknown>>)[0] ?? {}), false);
    assert.deepEqual(listRaw.structuredContent, listRes);

    const listWithHistory = parseTextTool(
      (await client.callTool({
        name: "memoq_list_staged",
        arguments: { documentId: "doc-mcp-1", includeHistory: true },
      })) as never,
    );
    assert.ok(Array.isArray(((listWithHistory.items as Array<Record<string, unknown>>)[0] ?? {}).history));

    const approveRes = parseTextTool(
      (await client.callTool({
        name: "memoq_approve_staged",
        arguments: { documentId: "doc-mcp-1", status: "approved" },
      })) as never,
    );
    assert.equal(approveRes.approvedTotal, 1);
    assert.equal((approveRes.coverage as { uncoveredPreviewCount: number }).uncoveredPreviewCount, 0);

    // Simulate memoQ Desktop MT Lookup against the bridge gateway
    const mtResp = await fetch(`${runtime.gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        requestType: "Plaintext",
        metadata: { documentId: "doc-mcp-1" },
        segments: [
          { index: 0, text: "Save the document.", plainText: "Save the document." },
          {
            index: 1,
            text: 'Click <span data-mqitag="1">OK</span>.',
            plainText: "Click OK.",
            tmSource: "Click Cancel.",
            tmTarget: "点击取消。",
          },
        ],
      }),
    });
    assert.equal(mtResp.status, 200);
    const mtJson = (await mtResp.json()) as {
      success: boolean;
      translations: Array<{ index: number; text: string }>;
      nonRetryableSegmentIndexes?: number[];
    };
    assert.equal(mtJson.success, true);
    assert.equal(mtJson.translations.length, 1);
    assert.equal(mtJson.translations[0]?.text, "保存文档。");
    assert.deepEqual(mtJson.nonRetryableSegmentIndexes, [1]);

    // Missed tagged request appears in memoq_get_recent_mt_requests
    const recentRes = parseTextTool(
      (await client.callTool({
        name: "memoq_get_recent_mt_requests",
        arguments: { onlyWithTags: true },
      })) as never,
    );
    const recentItems = recentRes.items as Array<{ hasInlineTags: boolean; tmSource: string }>;
    assert.equal(recentItems.length, 1);
    assert.equal(recentItems[0]?.hasInlineTags, true);
    assert.equal(recentItems[0]?.tmSource, "Click Cancel.");
    assert.equal(recentRes.unresolvedCount, 1);
    assert.equal((recentRes.deduplicatedMissed as Array<unknown>).length, 1);
    assert.match(String(recentRes.nextStep ?? ""), /未命中 Pre-translate/u);

    // Simulate memoQ StoreTranslation feedback when user confirms a segment
    const storeResp = await fetch(`${runtime.gateway.baseUrl}${ROUTES.mtStoreTranslations}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        translations: [
          {
            index: 0,
            sourceText: "Save the document.",
            targetText: "保存该文档。",
          },
        ],
      }),
    });
    assert.equal(storeResp.status, 200);

    const confirmedRes = parseTextTool(
      (await client.callTool({
        name: "memoq_get_confirmed_translations",
        arguments: { sourceLanguage: "eng", targetLanguage: "zho-CN" },
      })) as never,
    );
    const confirmedItems = confirmedRes.items as Array<{ sourceText: string; targetText: string }>;
    assert.equal(confirmedItems.length, 1);
    assert.equal(confirmedItems[0]?.targetText, "保存该文档。");

    const unconfirmedClear = await client.callTool({ name: "memoq_clear_staged", arguments: { documentId: "doc-mcp-1" } });
    assert.equal(unconfirmedClear.isError, true);
    assert.equal((await runtime.client.listStaged()).total, 1);
    const clearRes = parseTextTool(
      (await client.callTool({ name: "memoq_clear_staged", arguments: { documentId: "doc-mcp-1", confirmed: true } })) as never,
    );
    assert.equal(clearRes.removed, 1);
    assert.equal(clearRes.remaining, 0);

    const focusRaw = (await client.callTool({
      name: "memoq_focus_segment",
      arguments: { previewPartId: "doc-mcp-1::p1" },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    assert.equal(focusRaw.isError, true);
    assert.match(focusRaw.content[0]?.text ?? "", /not running/i);

    const setupRes = parseTextTool((await client.callTool({ name: "memoq_setup", arguments: {} })) as never);
    assert.equal(setupRes.action, "plan");
    assert.equal(setupRes.url, "http://127.0.0.1:45678/?token=smoke-token");
    assert.equal(typeof setupRes.integration, "object");
    assert.equal(typeof setupRes.plan, "object");

    const unconfirmedInstall = parseTextTool(
      (await client.callTool({
        name: "memoq_setup",
        arguments: { action: "install", memoqRoot: "D:\\memoQ\\memoQ-12" },
      })) as never,
    );
    assert.equal(unconfirmedInstall.installed, false);
    assert.equal(unconfirmedInstall.confirmationRequired, true);
    assert.equal(confirmedInstallCalled, false);

    const confirmedInstall = parseTextTool(
      (await client.callTool({
        name: "memoq_setup",
        arguments: {
          action: "install",
          confirmed: true,
          memoqRoot: "D:\\memoQ\\memoQ-12",
          dllPath: "D:\\Downloads\\MemoQ.AI.Hub.Plugin.dll",
        },
      })) as never,
    );
    assert.equal(confirmedInstall.installed, true);
    assert.equal(confirmedInstallCalled, true);
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
