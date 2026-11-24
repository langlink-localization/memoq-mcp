import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { CONTRACT_VERSION, CONTROL_ROUTES, ROUTES } from "../src/contract.ts";
import { readDaemonRecord, startBridgeRuntime } from "../src/daemon.ts";
import { createMtGateway } from "../src/mt-gateway.ts";
import { createPreviewClient } from "../src/preview-client.ts";
import { runMemoqQa } from "../src/qa-runner.ts";
import { DEFAULT_MAX_STAGED, createStagingStore, summarizeMissedRequests, type StageTranslationInput } from "../src/staging-store.ts";

test("legacy staged state hydrates cleanly and multi-round revision/feedback/approval workflow operates safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-review-lifecycle-"));
  const statePath = join(dir, "state.json");

  // Pre-seed legacy state without status/revision/history/reviewComment/previewPartId
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      staged: [
        {
          id: "legacy-1",
          documentId: "doc-rev",
          sourceLanguage: "eng",
          targetLanguage: "zho-CN",
          sourceText: "Legacy segment",
          sourceHtml: "",
          targetText: "历史已暂存句段",
          targetHtml: "",
          hasInlineTags: false,
          confidence: 0.9,
          info: "legacy",
          stagedBy: "agent",
          tagPolicy: "protect",
          hitCount: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      confirmed: [],
      recentRequests: [],
    }),
    "utf8",
  );

  const store = createStagingStore({ statePath });
  let liveCalls = 0;

  const gateway = await createMtGateway({
    port: 0,
    stagingStore: store,
    getLiveConfig: () => ({
      mode: "staging_then_live",
      autoAlignTags: true,
      usePreviewContext: true,
      useConfirmedFeedForward: true,
      terminologyMode: "advisory",
      concurrency: 2,
    }),
    liveTranslator: async ({ segments }) => {
      liveCalls += 1;
      return {
        providerId: "mock-live",
        model: "mock-model",
        translations: segments.map((s) => ({
          index: s.index,
          text: `LIVE:${s.text}`,
          confidence: 0.7,
          info: "live",
        })),
      };
    },
  });

  try {
    // 1. Legacy entry hydrates to status='approved', revision=1 and serves immediately
    const legacyList = store.listStaged({ documentId: "doc-rev" });
    assert.equal(legacyList.counts.approved, 1);
    assert.equal(legacyList.items[0]?.status, "approved");
    assert.equal(legacyList.items[0]?.revision, 1);

    // 2. Stage a draft entry and verify draft gate blocks BOTH MT serve and live LLM fallback
    const draftRes = store.stageMany([
      {
        documentId: "doc-rev",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        sourceText: "Click {btn} to buy 2 Gold Coins.",
        targetText: "点击 {btn} 购买2个金币。",
        status: "draft",
        stagedBy: "agent",
      },
    ]);
    const entryId = draftRes.entries[0]!.id;
    assert.equal(draftRes.entries[0]!.status, "draft");
    assert.equal(draftRes.entries[0]!.revision, 1);

    const blockedResp = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: "doc-rev" },
        segments: [
          {
            index: 0,
            text: 'Click <span data-mqitag="0">◿</span> to buy 2 Gold Coins.',
            plainText: "Click  to buy 2 Gold Coins.",
          },
          {
            index: 1,
            text: "Unstaged segment",
            plainText: "Unstaged segment",
          },
        ],
      }),
    });
    const blockedJson = (await blockedResp.json()) as {
      success: boolean;
      partial?: boolean;
      nonRetryableSegmentIndexes?: number[];
      translations: Array<{ index: number; text: string }>;
    };
    assert.equal(blockedJson.success, true);
    assert.equal(blockedJson.partial, true);
    assert.deepEqual(blockedJson.nonRetryableSegmentIndexes, [0], "draft entry must not fall through to LLM");
    assert.equal(blockedJson.translations.length, 1);
    assert.equal(blockedJson.translations[0]?.text, "LIVE:Unstaged segment");
    assert.equal(liveCalls, 1, "only the unstaged segment may reach liveTranslator");
    assert.ok(
      store.listRecentRequests({ limit: 10 }).some((r) => r.reason === "staged_draft_pending_approval"),
    );

    // 3. Multi-round edit + feedback + agent v3 update + revert + approve
    const edited = store.updateStaged({
      id: entryId,
      targetText: "点击 {btn} 立即购买 2 枚金币。",
      editedBy: "translator",
    });
    assert.equal(edited?.revision, 2);
    assert.equal(edited?.history.length, 1);
    assert.equal(edited?.history[0]?.revision, 1);

    const feedback = store.setReviewFeedback({
      id: entryId,
      comment: "改回用“个”，但保留空格。",
    });
    assert.equal(feedback?.status, "needs_revision");
    assert.equal(feedback?.reviewComment, "改回用“个”，但保留空格。");

    const agentRev3 = store.stageMany([
      {
        documentId: "doc-rev",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        sourceText: "Click {btn} to buy 2 Gold Coins.",
        targetText: "点击 {btn} 购买 2 个金币。",
        stagedBy: "agent",
      },
    ]);
    assert.equal(agentRev3.entries[0]?.revision, 3);
    assert.equal(agentRev3.entries[0]?.status, "draft", "re-staging after needs_revision resets to draft");
    assert.equal(agentRev3.entries[0]?.reviewComment, "");

    const reverted = store.updateStaged({
      id: entryId,
      revertToRevision: 2,
      editedBy: "translator",
    });
    assert.equal(reverted?.revision, 4);
    assert.equal(reverted?.targetText, "点击 {btn} 立即购买 2 枚金币。");

    const approved = store.approveStaged({ documentId: "doc-rev", status: "approved" });
    assert.equal(approved.updated, 1);
    assert.equal(approved.approvedTotal, 2);

    // 4. Now memoQ gets 0ms deterministic tag-restored serve with 0 LLM calls
    liveCalls = 0;
    const serveResp = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: "doc-rev" },
        segments: [
          {
            index: 0,
            text: 'Click <span data-mqitag="0">◿</span> to buy 2 Gold Coins.',
            plainText: "Click  to buy 2 Gold Coins.",
          },
        ],
      }),
    });
    const serveJson = (await serveResp.json()) as {
      providerId?: string;
      translations: Array<{ text: string }>;
    };
    assert.equal(serveJson.providerId, "langlink-staging");
    assert.equal(serveJson.translations[0]?.text, '点击 <span data-mqitag="0">◿</span> 立即购买 2 枚金币。');
    assert.equal(liveCalls, 0);

    // Persisted JSON retains revision history
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { staged: Array<{ id: string; history: unknown[] }> };
    const savedItem = saved.staged.find((s) => s.id === entryId);
    assert.ok(savedItem && savedItem.history.length === 3);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runMemoqQa and Review Workbench HTTP API run @langlink/l10n-core/qa with strict token & host security", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-review-qa-"));
  const glossaryPath = join(dir, "terms.csv");
  writeFileSync(
    glossaryPath,
    "source,target,forbidden\nCurio,珍奇,false\nSpecialist,专家,false\nGold Coin,铜币,true\n",
    "utf8",
  );

  const previewClient = createPreviewClient({ dataDir: dir, platform: "win32" });
  previewClient.ingestEventForTest?.({
    type: "status",
    state: "connected",
    connected: true,
    previewToolId: "test-preview-id",
  });
  previewClient.ingestEventForTest?.({
    type: "content_update",
    parts: [
      {
        documentId: "doc-qa-1",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        previewPartId: "doc-qa-1::p1",
        sourceText: "<CN-Medium>Buy {buyNum} Curio with 100 Gold Coin.</>",
        targetText: "<CN-Medium>用 50 铜币购买古玩。",
        order: 0,
      },
      {
        documentId: "doc-qa-1",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        previewPartId: "doc-qa-1::p2",
        sourceText: "Recruit a Specialist now.",
        targetText: "",
        order: 1,
      },
    ],
  });

  const store = createStagingStore({ statePath: join(dir, "state.json") });
  const gateway = await createMtGateway({
    port: 0,
    stagingStore: store,
    previewClient,
  });

  try {
    // 1. Direct runMemoqQa on scope='memoq' detects placeholder missing, tag mismatch, number mismatch, forbidden term, missing term, and empty target
    const memoqQa = runMemoqQa({
      scope: "memoq",
      glossaryPath,
      previewClient,
      stagingStore: store,
    });
    assert.equal(memoqQa.available, true);
    assert.equal(memoqQa.summary.totalSegments, 2);
    assert.ok(memoqQa.glossary.entriesCount >= 3);
    const ruleIds = new Set(memoqQa.issues.map((i) => i.ruleId));
    assert.ok(ruleIds.has("PLACEHOLDER_MISSING"), "expected PLACEHOLDER_MISSING on missing {buyNum}");
    assert.ok(ruleIds.has("TAG_MISMATCH"), "expected TAG_MISMATCH on missing </>");
    assert.ok(ruleIds.has("NUMBER_MISMATCH"), "expected NUMBER_MISMATCH on 100 vs 50");
    assert.ok(ruleIds.has("TB_FORBIDDEN_USED"), "expected TB_FORBIDDEN_USED on 铜币");
    assert.ok(ruleIds.has("TERM_MISSING"), "expected TERM_MISSING on missing 珍奇");
    assert.ok(ruleIds.has("EMPTY_TARGET"), "expected EMPTY_TARGET on p2");
    assert.equal(memoqQa.issues[0]?.previewPartId?.startsWith("doc-qa-1::"), true);

    // Custom enabledRules restricts report cleanly
    const filteredQa = runMemoqQa({
      scope: "memoq",
      enabledRules: ["NUMBER_MISMATCH"],
      previewClient,
      stagingStore: store,
    });
    assert.equal(filteredQa.issues.length, 1);
    assert.equal(filteredQa.issues[0]?.ruleId, "NUMBER_MISMATCH");

    // 2. Security guards & persisted token + HttpOnly cookie auth (repeated opens across restarts, strict Sec-Fetch-Site)
    assert.equal(gateway.reviewUrl, `${gateway.baseUrl}/review?token=${gateway.reviewToken}`);

    // Unauthenticated or wrong-token GET /review must return 401 without leaking secrets or setting cookies
    for (const unauthUrl of [
      `${gateway.baseUrl}/review`,
      `${gateway.baseUrl}/review?token=stale-token-from-history`,
    ]) {
      const unauthRes = await fetch(unauthUrl);
      assert.equal(unauthRes.status, 401, `expected 401 for ${unauthUrl}`);
      assert.equal(unauthRes.headers.get("set-cookie"), null);
      const unauthHtml = await unauthRes.text();
      assert.equal(unauthHtml.includes(gateway.reviewToken), false, "401 page must never leak reviewToken");
      assert.equal(unauthHtml.includes(gateway.controlToken), false, "401 page must never leak controlToken");
    }

    // Valid persisted token URL opens repeatedly and issues scoped HttpOnly SameSite=Strict cookie
    const firstOpenRes = await fetch(gateway.reviewUrl);
    assert.equal(firstOpenRes.status, 200);
    const setCookieHeader = firstOpenRes.headers.get("set-cookie") ?? "";
    assert.match(setCookieHeader, new RegExp(`memoq_review_token=${gateway.reviewToken}`, "u"));
    assert.match(setCookieHeader, /HttpOnly/iu);
    assert.match(setCookieHeader, /SameSite=Strict/iu);
    assert.match(setCookieHeader, /Path=\/review/iu);
    const reviewCookiePair = `memoq_review_token=${gateway.reviewToken}`;

    for (let i = 0; i < 2; i += 1) {
      const repeatUrlRes = await fetch(gateway.reviewUrl);
      assert.equal(repeatUrlRes.status, 200);
      const cookieRes = await fetch(`${gateway.baseUrl}/review`, {
        headers: { Cookie: reviewCookiePair },
      });
      assert.equal(cookieRes.status, 200);
    }

    // Explicit invalid ?token= must still fail even when a valid cookie is also sent
    const badQueryWithCookieRes = await fetch(`${gateway.baseUrl}/review?token=wrong-token`, {
      headers: { Cookie: reviewCookiePair },
    });
    assert.equal(badQueryWithCookieRes.status, 401);

    // /review/api/session must never exist or issue reviewToken
    for (const sessionHeaders of [
      { "X-Review-Handshake": "1" },
      { "X-Review-Handshake": "1", "Sec-Fetch-Site": "same-origin" },
      { "X-Review-Token": gateway.reviewToken, "Sec-Fetch-Site": "same-origin" },
    ]) {
      const sessionRes = await fetch(`${gateway.baseUrl}/review/api/session`, { headers: sessionHeaders });
      assert.notEqual(sessionRes.status, 200);
      const sessionBody = await sessionRes.text();
      assert.equal(sessionBody.includes(gateway.reviewToken), false);
    }

    // /review/api/* rejects missing or cross-site Sec-Fetch-Site (403) and rejects non-review tokens (401)
    const missingFetchSiteRes = await fetch(`${gateway.baseUrl}/review/api/state`, {
      headers: { "X-Review-Token": gateway.reviewToken },
    });
    assert.equal(missingFetchSiteRes.status, 403, "missing Sec-Fetch-Site must be denied on /review/api/*");

    const crossSiteApiRes = await fetch(`${gateway.baseUrl}/review/api/state`, {
      headers: {
        "X-Review-Token": gateway.reviewToken,
        "Sec-Fetch-Site": "cross-site",
      },
    });
    assert.equal(crossSiteApiRes.status, 403);

    const badApiHeaderRes = await fetch(`${gateway.baseUrl}/review/api/state`, {
      headers: {
        "X-Review-Token": gateway.controlToken,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    assert.equal(badApiHeaderRes.status, 401, "controlToken must NOT authenticate review API routes");
    const badApiJson = (await badApiHeaderRes.json()) as { code?: string };
    assert.equal(badApiJson.code, "REVIEW_TOKEN_REQUIRED");

    const rawHttpGet = (urlStr: string, headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(urlStr, { method: "GET", headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });

    assert.equal(await rawHttpGet(gateway.reviewUrl, { "Sec-Fetch-Mode": "no-cors" }), 403);
    assert.equal(
      await rawHttpGet(gateway.reviewUrl, { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "cross-site" }),
      403,
    );

    const badOriginRes = await fetch(gateway.reviewUrl, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(badOriginRes.status, 403);

    // 3. Serving CAT HTML workbench with CSP nonce, valid inline JS syntax, accurate percent highlighting, and zero controlToken exposure
    const htmlRes = await fetch(gateway.reviewUrl);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-security-policy") ?? "", /script-src 'nonce-/u);
    assert.equal(htmlRes.headers.get("x-frame-options"), "DENY");
    const html = await htmlRes.text();
    assert.ok(html.includes(gateway.reviewToken));
    assert.equal(html.includes(gateway.controlToken), false, "HTML must never leak controlToken");
    assert.equal(html.includes("/review/api/session"), false, "HTML must not reference removed session handshake route");
    assert.match(html, /cat-grid-head/u);
    assert.match(html, /cat-inspector/u);
    assert.match(html, /cat-statusbar/u);
    assert.match(html, /formatSourceHtml/u);

    const scriptMatch = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html);
    assert.ok(scriptMatch && scriptMatch[1], "expected inline script block in workbench HTML");
    assert.doesNotThrow(() => new Function(scriptMatch[1]!), "client script must parse cleanly without syntax errors");

    const tagFnMatch = /(function esc\([\s\S]*?return out;\s*\})/u.exec(scriptMatch[1]!);
    assert.ok(tagFnMatch && tagFnMatch[1], "expected formatSourceHtml helper in client script");
    const formatSourceHtml = new Function(`${tagFnMatch[1]!}; return formatSourceHtml;`)() as (s: string) => string;
    const pctPhraseHtml = formatSourceHtml("50% discount for 100% of users, 20% off, 15% faster, {0}% complete");
    assert.equal(
      pctPhraseHtml,
      '50% discount for 100% of users, 20% off, 15% faster, <span class="cat-tag">{0}</span>% complete',
      "percent signs before English words must not be split into printf tag chips",
    );
    const printfHtml = formatSourceHtml("Use %1$s with %-10.2f and %d (100%%)");
    assert.equal(
      printfHtml,
      'Use <span class="cat-tag">%1$s</span> with <span class="cat-tag">%-10.2f</span> and <span class="cat-tag">%d</span> (100<span class="cat-tag">%%</span>)',
    );

    // 4. End-to-end Review Workbench API: state -> create draft from memoQ-only row -> run QA -> feedback -> approve
    const reviewHeaders = {
      "Content-Type": "application/json",
      "X-Review-Token": gateway.reviewToken,
      "Sec-Fetch-Site": "same-origin",
    };

    const stateJson = (await fetch(`${gateway.baseUrl}/review/api/state`, { headers: reviewHeaders }).then((r) =>
      r.json(),
    )) as {
      previewSegments: Array<{ previewPartId: string }>;
      qaCatalog: Array<{ ruleId: string }>;
    };
    assert.equal(stateJson.previewSegments.length, 2);
    assert.equal(stateJson.qaCatalog.length, 23);

    // User fixes p1 right in the workbench (memoQ-only row creates draft entry)
    const updateRes = (await fetch(`${gateway.baseUrl}/review/api/update`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        sourceText: "<CN-Medium>Buy {buyNum} Curio with 100 Gold Coin.</>",
        targetText: "<CN-Medium>用 100 金币购买 {buyNum} 个珍奇。</>",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        documentId: "doc-qa-1",
        previewPartId: "doc-qa-1::p1",
        editedBy: "translator",
      }),
    }).then((r) => r.json())) as { entry: { id: string; status: string; targetText: string } };
    assert.equal(updateRes.entry.status, "draft");

    // Re-running QA with scope='merged' now reflects the fixed translation on p1
    const mergedQa = (await fetch(`${gateway.baseUrl}/review/api/qa`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        scope: "merged",
        glossaryPath,
      }),
    }).then((r) => r.json())) as { issues: Array<{ ruleId: string; previewPartId?: string }> };
    const p1Issues = mergedQa.issues.filter((i) => i.previewPartId === "doc-qa-1::p1");
    assert.deepEqual(
      p1Issues.map((i) => i.ruleId),
      ["TB_SOURCE_FORBIDDEN"],
      "edited draft should clear all target/tag/placeholder/number QA issues on p1 in merged mode",
    );

    // Leave feedback on untranslated p2 -> creates needs_revision draft
    const fbRes = (await fetch(`${gateway.baseUrl}/review/api/feedback`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        sourceText: "Recruit a Specialist now.",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        documentId: "doc-qa-1",
        previewPartId: "doc-qa-1::p2",
        comment: "请翻译这句，用术语“专家”。",
      }),
    }).then((r) => r.json())) as { entry: { status: string; reviewComment: string } };
    assert.equal(fbRes.entry.status, "needs_revision");
    assert.equal(fbRes.entry.reviewComment, "请翻译这句，用术语“专家”。");

    // Approve fixed p1 via /review/api/approve
    const approveHttp = await fetch(`${gateway.baseUrl}/review/api/approve`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({ ids: [updateRes.entry.id], status: "approved" }),
    });
    const approveText = await approveHttp.text();
    assert.equal(approveHttp.status, 200, `Expected 200 from /review/api/approve, got ${approveHttp.status}: ${approveText}`);
    const approveRes = JSON.parse(approveText) as { updated: number; approvedTotal: number };
    assert.equal(approveRes.updated, 1);
    assert.equal(approveRes.approvedTotal, 1);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staging pool supports 100k default cap and O(1) indexed exact/norm/slot lookups above 5000 entries", () => {
  assert.equal(DEFAULT_MAX_STAGED, 100_000);
  const dir = mkdtempSync(join(tmpdir(), "memoq-scale-index-"));
  const statePath = join(dir, "state.json");
  const store = createStagingStore({ statePath });

  try {
    const bulk: StageTranslationInput[] = [];
    for (let i = 0; i < 6000; i += 1) {
      bulk.push({
        documentId: i < 3000 ? "doc-part-1" : "doc-part-2",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        sourceText: i === 5999
          ? "<CN-Medium>Buy {buyNum} Curio</>"
          : `Segment item #${i}: upgrade facility level ${i}.`,
        targetText: i === 5999
          ? "<CN-Medium>购买 {buyNum} 个珍奇</>"
          : `句段 #${i}：升级设施等级 ${i}。`,
        status: "approved",
      });
    }

    const res = store.stageMany(bulk);
    assert.equal(res.stagedCount, 6000);
    const listed = store.listStaged({ limit: 10_000 });
    assert.equal(listed.total, 6000, "all 6,000 entries must be retained above legacy 5,000 cap");
    assert.equal(listed.items.length, 6000);

    // Compact JSON persisted cleanly (> 2000 threshold -> no pretty indent)
    const rawDisk = readFileSync(statePath, "utf8");
    assert.equal(rawDisk.includes("\n  \"staged\""), false, "large state.json uses compact JSON");

    // Reload from disk and time 200 mixed exact / norm / slot lookups
    const reloaded = createStagingStore({ statePath });
    const t0 = performance.now();
    const slotHit = reloaded.findStaged({
      documentId: "doc-part-2",
      sourceLanguage: "eng",
      targetLanguage: "zho-CN",
      text: '<span data-mqitag="0">◿</span>Buy <span data-mqitag="1">◿</span> Curio<span data-mqitag="2">◿</span>',
      plainText: "Buy Curio",
    });
    assert.ok(slotHit, "indexed slot lookup must hit entry 5999");
    assert.equal(slotHit.targetText, "<CN-Medium>购买 {buyNum} 个珍奇</>");

    for (let k = 0; k < 200; k += 1) {
      const idx = (k * 29) % 5998;
      const hit = reloaded.findStaged({
        documentId: idx < 3000 ? "doc-part-1" : "doc-part-2",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        text: `Segment item #${idx}: upgrade facility level ${idx}.`,
      });
      assert.ok(hit, `expected exact hit for item ${idx}`);
    }
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 200, `200 indexed lookups over 6,000 items should be fast, got ${elapsedMs.toFixed(1)}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-document Preview cache enables document switcher and cross-document consistency QA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-multi-doc-qa-"));
  const previewClient = createPreviewClient({ dataDir: dir, platform: "win32" });
  const store = createStagingStore({ statePath: join(dir, "state.json") });

  previewClient.ingestEventForTest?.({
    type: "status",
    state: "connected",
    connected: true,
    previewToolId: "test-multi-doc",
  });
  previewClient.ingestEventForTest?.({
    type: "content_update",
    parts: [
      {
        documentId: "doc-A",
        documentName: "ui.xliff",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        previewPartId: "doc-A::p1",
        sourceText: "Open Curio Cabinet",
        targetText: "打开珍奇柜",
        order: 0,
      },
      {
        documentId: "doc-B",
        documentName: "tutorial.xliff",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        previewPartId: "doc-B::p1",
        sourceText: "Open Curio Cabinet",
        targetText: "打开古玩柜",
        order: 0,
      },
    ],
  });

  const gateway = await createMtGateway({
    port: 0,
    stagingStore: store,
    previewClient,
  });

  try {
    // 1. Both open documents appear in Preview listDocuments and /bridge/preview/documents
    const docs = previewClient.listDocuments();
    assert.equal(docs.length, 2);
    const docsApi = (await fetch(`${gateway.baseUrl}/bridge/preview/documents`, {
      headers: { Authorization: `Bearer ${gateway.controlToken}` },
    }).then((r) => r.json())) as { documents: Array<{ documentId: string; documentName: string; segmentCount: number }> };
    assert.equal(docsApi.documents.length, 2);

    // 2. Single-doc QA does not see cross-doc conflict; allDocuments QA flags SOURCE_TARGET_INCONSISTENT
    const singleQa = runMemoqQa({ scope: "memoq", documentId: "doc-A", previewClient, stagingStore: store });
    assert.equal(singleQa.issues.some((i) => i.ruleId === "SOURCE_TARGET_INCONSISTENT"), false);

    const crossQa = runMemoqQa({ scope: "memoq", allDocuments: true, previewClient, stagingStore: store });
    assert.equal(crossQa.allDocuments, true);
    assert.equal(crossQa.documents.length, 2);
    const inconsistent = crossQa.issues.filter((i) => i.ruleId === "SOURCE_TARGET_INCONSISTENT");
    assert.ok(inconsistent.length >= 1, "cross-document QA must detect conflicting translations for identical source");
    assert.ok(inconsistent.every((i) => i.documentName && i.previewPartId));

    // 3. Workbench state endpoint supports __all__ vs specific documentId
    const reviewHeaders = {
      "X-Review-Token": gateway.reviewToken,
      "Sec-Fetch-Site": "same-origin",
    };
    const allState = (await fetch(`${gateway.baseUrl}/review/api/state?documentId=__all__`, {
      headers: reviewHeaders,
    }).then((r) => r.json())) as {
      selectedDocumentId: string;
      previewSegments: Array<{ documentId?: string; previewPartId: string }>;
      documents: Array<{ documentId: string }>;
    };
    assert.equal(allState.selectedDocumentId, "__all__");
    assert.equal(allState.documents.length, 2);
    assert.equal(allState.previewSegments.length, 2);

    const singleState = (await fetch(`${gateway.baseUrl}/review/api/state?documentId=doc-B`, {
      headers: reviewHeaders,
    }).then((r) => r.json())) as {
      selectedDocumentId: string;
      previewSegments: Array<{ documentId?: string; previewPartId: string }>;
    };
    assert.equal(singleState.selectedDocumentId, "doc-B");
    assert.equal(singleState.previewSegments.length, 1);
    assert.equal(singleState.previewSegments[0]?.previewPartId, "doc-B::p1");
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startBridgeRuntime persists reviewToken across restarts so saved URL and HttpOnly cookie stay valid while unauthenticated requests fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-review-token-persist-"));
  const rt1 = await startBridgeRuntime({
    dataDir: dir,
    preferredPort: 0,
    startPreview: false,
  });
  const token1 = rt1.gateway.reviewToken;
  const control1 = rt1.gateway.controlToken;
  const url1 = new URL(rt1.gateway.reviewUrl);
  assert.equal(url1.pathname, "/review");
  assert.equal(url1.searchParams.get("token"), token1);
  assert.notEqual(token1, control1);
  assert.equal(token1.length >= 48, true);
  await rt1.close();

  const rt2 = await startBridgeRuntime({
    dataDir: dir,
    preferredPort: 0,
    startPreview: false,
  });
  try {
    assert.equal(rt2.gateway.reviewToken, token1);
    assert.notEqual(rt2.gateway.reviewToken, rt2.gateway.controlToken);

    url1.port = String(rt2.actualPort);
    const okRes = await fetch(url1.toString());
    assert.equal(okRes.status, 200);
    assert.match(okRes.headers.get("set-cookie") ?? "", new RegExp(`memoq_review_token=${token1}`, "u"));

    const okResRepeat = await fetch(url1.toString());
    assert.equal(okResRepeat.status, 200);

    // Subsequent bare /review opens using the persisted cookie remain valid across daemon restarts
    const bareWithCookie = await fetch(`${rt2.gateway.baseUrl}/review`, {
      headers: { Cookie: `memoq_review_token=${token1}` },
    });
    assert.equal(bareWithCookie.status, 200);

    // Requests without token/cookie or with an invalid token are denied with 401 without leaking secrets
    const bareUnauth = await fetch(`${rt2.gateway.baseUrl}/review`);
    assert.equal(bareUnauth.status, 401);
    assert.equal((await bareUnauth.text()).includes(token1), false);

    const badQueryRes = await fetch(`${rt2.gateway.baseUrl}/review?token=expired-token-value`);
    assert.equal(badQueryRes.status, 401);
    assert.equal((await badQueryRes.text()).includes(token1), false);
  } finally {
    await rt2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /bridge/shutdown enforces Bearer auth, rejects unconfigured hosts, and triggers onShutdown with versioned daemon record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-bridge-shutdown-"));
  const rtNoShutdown = await startBridgeRuntime({
    dataDir: join(dir, "no-shutdown"),
    preferredPort: 0,
    startPreview: false,
    ownerLabel: "memoq-mcp-daemon",
    version: "0.2.4",
  });

  let shutdownInvoked = 0;
  const rtWithShutdown = await startBridgeRuntime({
    dataDir: join(dir, "with-shutdown"),
    preferredPort: 0,
    startPreview: false,
    ownerLabel: "memoq-mcp-daemon",
    version: "0.2.4",
    onShutdown: () => {
      shutdownInvoked += 1;
    },
  });

  try {
    const rec = readDaemonRecord(join(dir, "with-shutdown"));
    assert.equal(rec?.version, "0.2.4");
    assert.equal(rec?.owner, "memoq-mcp-daemon");

    // Unauthorized request must be rejected with 401 and must never invoke onShutdown
    const unauthRes = await fetch(`${rtWithShutdown.gateway.baseUrl}${CONTROL_ROUTES.shutdown}`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(unauthRes.status, 401);
    assert.equal(shutdownInvoked, 0);

    // Host without onShutdown returns 400
    await assert.rejects(() => rtNoShutdown.client.shutdown(), /Graceful shutdown is not enabled/u);

    // Authorized request succeeds and triggers onShutdown callback after response flushes
    const res = await rtWithShutdown.client.shutdown();
    assert.equal(res.ok, true);
    assert.equal(res.shuttingDown, true);
    const deadline = Date.now() + 2_000;
    while (shutdownInvoked === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(shutdownInvoked, 1);
  } finally {
    await rtNoShutdown.close();
    await rtWithShutdown.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missed Pre-translate retries deduplicate cleanly, surface coverage warnings, and resolve in workbench or on hit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-missed-alerts-"));
  const previewClient = createPreviewClient({ dataDir: dir, platform: "win32" });
  previewClient.ingestEventForTest?.({
    type: "status",
    state: "connected",
    connected: true,
    previewToolId: "test-missed-alerts",
  });
  previewClient.ingestEventForTest?.({
    type: "content_update",
    parts: [
      {
        documentId: "doc-miss",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        previewPartId: "doc-miss::p1",
        sourceText: "Forge Curio",
        targetText: "",
        order: 0,
      },
      {
        documentId: "doc-miss",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        previewPartId: "doc-miss::p2",
        sourceText: "Display Limit",
        targetText: "Batas Tampilan",
        order: 1,
      },
    ],
  });

  const store = createStagingStore({ statePath: join(dir, "state.json") });
  const gateway = await createMtGateway({
    port: 0,
    stagingStore: store,
    previewClient,
  });

  try {
    // 1. Simulate memoQ Pre-translate trying all 3 requestTypes for an unstaged tagged segment outside Preview's cache
    for (const [requestType, text] of [
      ["BothFormattingAndTags", 'Lv.<span data-mqitag="0">◿</span>'],
      ["OnlyFormatting", "Lv. "],
      ["Plaintext", "Lv."],
    ] as const) {
      const missRes = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractVersion: CONTRACT_VERSION,
          sourceLanguage: "eng",
          targetLanguage: "ind",
          requestType,
          metadata: { documentId: "doc-miss" },
          segments: [{ index: 0, text, plainText: "Lv." }],
        }),
      });
      assert.equal(missRes.status, 200);
      const missJson = (await missRes.json()) as { success: boolean; error?: { message: string } };
      assert.equal(missJson.success, false);
      assert.match(missJson.error?.message ?? "", /memoq_get_recent_mt_requests/u);
    }

    // 2. /bridge/status & /bridge/recent-requests collapse all 3 retries into 1 tagged item + report uncovered Preview segment
    const authHeaders = { Authorization: `Bearer ${gateway.controlToken}` };
    const statusJson = (await fetch(`${gateway.baseUrl}${CONTROL_ROUTES.status}`, { headers: authHeaders }).then((r) =>
      r.json(),
    )) as {
      missedPretranslate: { count: number; items: Array<{ text: string; attempts: number; hasInlineTags: boolean }> };
      coverage: { uncoveredPreviewCount: number; missedPretranslateCount: number; attentionMessage: string };
    };
    assert.equal(statusJson.missedPretranslate.count, 1);
    assert.equal(statusJson.missedPretranslate.items[0]?.text, 'Lv.<span data-mqitag="0">◿</span>');
    assert.equal(statusJson.missedPretranslate.items[0]?.attempts, 3);
    assert.equal(statusJson.missedPretranslate.items[0]?.hasInlineTags, true);
    assert.equal(statusJson.coverage.uncoveredPreviewCount, 1);
    assert.equal(statusJson.coverage.missedPretranslateCount, 1);
    assert.match(statusJson.coverage.attentionMessage, /未命中/u);
    assert.match(statusJson.coverage.attentionMessage, /空译句段/u);

    const recentJson = (await fetch(`${gateway.baseUrl}${CONTROL_ROUTES.recentRequests}`, { headers: authHeaders }).then((r) =>
      r.json(),
    )) as {
      items: Array<unknown>;
      unresolvedCount: number;
      deduplicatedMissed: Array<{ text: string }>;
      byReason: Record<string, number>;
    };
    assert.equal(recentJson.items.length, 3);
    assert.equal(recentJson.unresolvedCount, 1);
    assert.equal(recentJson.deduplicatedMissed[0]?.text, 'Lv.<span data-mqitag="0">◿</span>');
    assert.equal(recentJson.byReason.not_staged, 1);

    // 3. Review HTML parses cleanly and renders missed/uncovered banners & copy-source actions
    const html = await fetch(gateway.reviewUrl).then((r) => r.text());
    assert.match(html, /id="missedBanner"/u);
    assert.match(html, /id="uncoveredBanner"/u);
    assert.match(html, /data-filter="missed_mt"/u);
    const scriptMatch = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html);
    assert.ok(scriptMatch && scriptMatch[1]);
    assert.doesNotThrow(() => new Function(scriptMatch[1]!));

    const reviewHeaders = {
      "Content-Type": "application/json",
      "X-Review-Token": gateway.reviewToken,
      "Sec-Fetch-Site": "same-origin",
    };
    const stateBefore = (await fetch(`${gateway.baseUrl}/review/api/state?documentId=doc-miss`, {
      headers: reviewHeaders,
    }).then((r) => r.json())) as {
      missedMt: { count: number };
      coverage: { uncoveredPreviewCount: number };
    };
    assert.equal(stateBefore.missedMt.count, 1);
    assert.equal(stateBefore.coverage.uncoveredPreviewCount, 1);

    // 4. Translator saves & approves the tagged source in the workbench -> missedMt drops to 0 and memoQ serves it cleanly
    await fetch(`${gateway.baseUrl}/review/api/update`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        sourceText: 'Lv.<span data-mqitag="0">◿</span>',
        targetText: 'Lv.<span data-mqitag="0">◿</span>',
        sourceLanguage: "eng",
        targetLanguage: "ind",
        documentId: "doc-miss",
        status: "approved",
        editedBy: "translator",
      }),
    });

    const stateAfter = (await fetch(`${gateway.baseUrl}/review/api/state?documentId=doc-miss`, {
      headers: reviewHeaders,
    }).then((r) => r.json())) as { missedMt: { count: number } };
    assert.equal(stateAfter.missedMt.count, 0);

    const hitRes = (await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: "doc-miss" },
        segments: [{ index: 0, text: 'Lv.<span data-mqitag="0">◿</span>', plainText: "Lv." }],
      }),
    }).then((r) => r.json())) as { success: boolean; translations: Array<{ text: string }> };
    assert.equal(hitRes.success, true);
    assert.equal(hitRes.translations[0]?.text, 'Lv.<span data-mqitag="0">◿</span>');

    // Auto-resolved from recentRequests on serve; test explicit clear-missed endpoint as well
    assert.equal(store.listRecentRequests().length, 0);
    store.recordRecentRequest({
      requestId: "r-manual",
      receivedAt: new Date().toISOString(),
      documentId: "doc-miss",
      projectId: "",
      client: "",
      domain: "",
      subject: "",
      sourceLanguage: "eng",
      targetLanguage: "ind",
      requestType: "Plaintext",
      index: 0,
      text: "Temp miss",
      plainText: "Temp miss",
      hasInlineTags: false,
      tmSource: "",
      tmTarget: "",
      reason: "not_staged",
    });
    const clearRes = (await fetch(`${gateway.baseUrl}/review/api/clear-missed`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({ documentId: "doc-miss" }),
    }).then((r) => r.json())) as { removed: number; remaining: number };
    assert.equal(clearRes.removed, 1);
    assert.equal(clearRes.remaining, 0);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Grok review fixes: tagged second edit updates targetHtml, live fallback clears sibling misses, and norm-matched miss preserves tagged source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-grok-fixes-"));
  const store = createStagingStore({ statePath: join(dir, "state.json") });
  const previewClient = createPreviewClient({ dataDir: dir, platform: "win32" });
  previewClient.ingestEventForTest?.({
    type: "status",
    state: "connected",
    connected: true,
    previewToolId: "test-grok-fixes",
  });
  previewClient.ingestEventForTest?.({
    type: "content_update",
    parts: [
      {
        documentId: "doc-gf",
        documentName: "tags.xliff",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        previewPartId: "doc-gf::p1",
        sourceText: "Lv.",
        targetText: "",
        order: 0,
      },
    ],
  });

  let useLiveMode = false;
  const gateway = await createMtGateway({
    port: 0,
    stagingStore: store,
    previewClient,
    getLiveConfig: () => ({
      mode: useLiveMode ? "staging_then_live" : "staging_only",
      autoAlignTags: true,
      usePreviewContext: true,
      useConfirmedFeedForward: true,
      terminologyMode: "advisory",
      concurrency: 1,
    }),
    liveTranslator: async ({ segments }) => ({
      providerId: "mock-live",
      model: "mock-model",
      translations: segments.map((s) => ({
        index: s.index,
        text: `LIVE(${s.text})`,
        confidence: 0.9,
        info: "live",
      })),
    }),
  });

  try {
    const reviewHeaders = {
      "Content-Type": "application/json",
      "X-Review-Token": gateway.reviewToken,
      "Sec-Fetch-Site": "same-origin",
    };

    // 1. Finding #1: Creating tagged entry via workbench update, then doing a second edit by id must update targetHtml served by /mt/translate
    const created = (await fetch(`${gateway.baseUrl}/review/api/update`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        sourceText: 'Click <span data-mqitag="0">◿</span> here',
        targetText: 'Klik <span data-mqitag="0">◿</span> v1',
        sourceLanguage: "eng",
        targetLanguage: "ind",
        documentId: "doc-gf",
        editedBy: "translator",
      }),
    }).then((r) => r.json())) as { entry: { id: string; targetHtml: string } };
    assert.equal(created.entry.targetHtml, 'Klik <span data-mqitag="0">◿</span> v1');

    const edited = (await fetch(`${gateway.baseUrl}/review/api/update`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        id: created.entry.id,
        targetText: 'Klik <span data-mqitag="0">◿</span> v2',
        status: "approved",
        editedBy: "translator",
      }),
    }).then((r) => r.json())) as { entry: { targetText: string; targetHtml: string } };
    assert.equal(edited.entry.targetText, 'Klik <span data-mqitag="0">◿</span> v2');
    assert.equal(edited.entry.targetHtml, 'Klik <span data-mqitag="0">◿</span> v2');

    const servedEdited = (await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: "doc-gf" },
        segments: [{ index: 0, text: 'Click <span data-mqitag="0">◿</span> here', plainText: "Click here" }],
      }),
    }).then((r) => r.json())) as { translations: Array<{ text: string; confidence: number }> };
    assert.equal(servedEdited.translations[0]?.text, 'Klik <span data-mqitag="0">◿</span> v2');
    assert.equal(servedEdited.translations[0]?.confidence, 0);

    // 2. Finding #2: Live fallback success clears all sibling request-type misses in recentRequests & summarizeMissedRequests
    for (const [requestType, text] of [
      ["BothFormattingAndTags", "Unstaged phrase"],
      ["OnlyFormatting", "Unstaged  phrase"],
      ["Plaintext", "Unstaged phrase"],
    ] as const) {
      await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractVersion: CONTRACT_VERSION,
          sourceLanguage: "eng",
          targetLanguage: "ind",
          requestType,
          metadata: { documentId: "doc-gf" },
          segments: [{ index: 0, text, plainText: "Unstaged phrase" }],
        }),
      });
    }
    assert.equal(summarizeMissedRequests(store, { documentId: "doc-gf" }).count, 1);

    useLiveMode = true;
    const liveOk = (await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: "doc-gf" },
        segments: [{ index: 0, text: "Unstaged phrase", plainText: "Unstaged phrase" }],
      }),
    }).then((r) => r.json())) as { success: boolean; translations: Array<{ text: string; confidence: number }> };
    assert.equal(liveOk.success, true);
    assert.equal(liveOk.translations[0]?.text, "LIVE(Unstaged phrase)");
    assert.equal(liveOk.translations[0]?.confidence, 0);
    assert.equal(summarizeMissedRequests(store, { documentId: "doc-gf" }).count, 0);
    assert.ok(store.listRecentRequests({ limit: 10 }).some((r) => r.reason === "live_fallback"));
    assert.equal(store.listRecentRequests({ limit: 10 }).some((r) => r.reason === "not_staged" && r.plainText === "Unstaged phrase"), false);

    // 3. Finding #3: mergeRows keeps missedMt's tagged sourceText while keeping previewPartId & previewSourceText for focus
    useLiveMode = false;
    await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: "doc-gf" },
        segments: [{ index: 0, text: 'Lv.<span data-mqitag="0">◿</span>', plainText: "Lv." }],
      }),
    });

    const html = await fetch(gateway.reviewUrl).then((r) => r.text());
    const scriptMatch = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html);
    assert.ok(scriptMatch && scriptMatch[1]);
    assert.doesNotThrow(() => new Function(scriptMatch[1]!));

    const normFnMatch = /(function normComparable\([\s\S]*?function issuesByRowMap)/u.exec(scriptMatch[1]!);
    assert.ok(normFnMatch && normFnMatch[1]);
    const bodyForEval = normFnMatch[1]!.replace(/function issuesByRowMap$/u, "");
    const stateObj = (await fetch(`${gateway.baseUrl}/review/api/state?documentId=doc-gf`, {
      headers: reviewHeaders,
    }).then((r) => r.json())) as Record<string, unknown>;
    const mergeRows = new Function("state", `${bodyForEval}; return mergeRows();`) as (s: unknown) => Array<{
      previewPartId: string;
      sourceText: string;
      previewSourceText: string;
      missedMt: { text: string } | null;
    }>;
    const merged = mergeRows({ data: stateObj });
    assert.equal(merged.length, 2, "Preview row merges missedMt in place without duplicating top missed row");
    const mergedP1 = merged.find((r) => r.previewPartId === "doc-gf::p1");
    assert.ok(mergedP1);
    assert.equal(mergedP1.sourceText, 'Lv.<span data-mqitag="0">◿</span>');
    assert.equal(mergedP1.previewSourceText, "Lv.");
    assert.equal(mergedP1.missedMt?.text, 'Lv.<span data-mqitag="0">◿</span>');
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Aligned Agent QA UI & feature union: custom rules, highlights, and XLSX/CSV/HTML export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-agent-qa-union-"));
  const previewClient = createPreviewClient({ dataDir: dir, platform: "win32" });
  previewClient.ingestEventForTest?.({
    type: "status",
    state: "connected",
    connected: true,
    previewToolId: "test-qa-union",
  });
  previewClient.ingestEventForTest?.({
    type: "content_update",
    parts: [
      {
        documentId: "doc-u1",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        previewPartId: "doc-u1::p1",
        sourceText: "Buy {buyNum} Curio now.",
        targetText: "Beli Curio sekarang 99.",
        order: 0,
      },
      {
        documentId: "doc-u1",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        previewPartId: "doc-u1::p2",
        sourceText: "Save Gold Coin.",
        targetText: "Simpan Koin Perak.",
        order: 1,
      },
      {
        documentId: "doc-u1",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        previewPartId: "doc-u1::p3",
        sourceText: "Enter valid number.",
        targetText: "",
        order: 2,
      },
      {
        documentId: "doc-u1",
        documentName: "alchemy.xliff",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        previewPartId: "doc-u1::p4",
        sourceText: "Use 10 Silver Coins.",
        targetText: "Gunakan 99 Koin Perak.",
        order: 3,
      },
    ],
  });

  const store = createStagingStore({ statePath: join(dir, "state.json") });
  const gateway = await createMtGateway({
    port: 0,
    stagingStore: store,
    previewClient,
  });

  try {
    const reviewHeaders = {
      "Content-Type": "application/json",
      "X-Review-Token": gateway.reviewToken,
      "Sec-Fetch-Site": "same-origin",
    };

    // 1. HTML contains deterministic QA layout, filters, custom rules, user-defined release criteria hint, and exports (no proprietary AIQA)
    const html = await fetch(gateway.reviewUrl).then((r) => r.text());
    assert.match(html, /class="qa-layout"/u);
    assert.match(html, /id="qaSettingsForm"/u);
    assert.match(html, /id="qaCustomRules"/u);
    assert.match(html, /id="qaAllSegments"/u);
    assert.doesNotMatch(html, /id="btnRunAiqa"/u);
    assert.match(html, /放行标准由用户自行设定/u);
    assert.match(html, /id="qaExportScope"/u);
    assert.match(html, /data-qa-export="xlsx"/u);
    assert.match(html, /data-qa-export="csv"/u);
    assert.match(html, /data-qa-export="html"/u);
    assert.match(html, /id="qaRuleSections"/u);

    const stateJson = (await fetch(`${gateway.baseUrl}/review/api/state?documentId=doc-u1`, {
      headers: reviewHeaders,
    }).then((r) => r.json())) as {
      qaRuleGroups: Array<{ id: string; label: string; rules: string[] }>;
    };
    assert.equal(stateJson.qaRuleGroups.length, 7);

    // 2. Run QA with custom rule + verify highlights + snapshots + custom rule finding
    const qaRes = (await fetch(`${gateway.baseUrl}/review/api/qa`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        scope: "memoq",
        documentId: "doc-u1",
        customRules: [
          { name: "金币术语", sourceContains: "Gold Coin", kind: "required", value: "Koin Emas" },
        ],
      }),
    }).then((r) => r.json())) as {
      issues: Array<{
        ruleId: string;
        category: string;
        origin: string;
        highlights?: { source?: Array<{ start: number; end: number }> };
      }>;
      segments: Array<{ segmentKey: string; sourceText: string }>;
    };
    assert.equal(qaRes.segments.length, 4);
    const placeholderIss = qaRes.issues.find((i) => i.ruleId === "PLACEHOLDER_MISSING");
    assert.ok(placeholderIss);
    assert.equal(placeholderIss.category, "Tag 与变量");
    assert.ok((placeholderIss.highlights?.source?.length ?? 0) >= 1);

    const customIss = qaRes.issues.find((i) => i.origin === "custom" && i.ruleId === "金币术语");
    assert.ok(customIss);
    assert.equal(customIss.category, "自定义");

    // Invalid customRules rejected with 400
    const badQa = await fetch(`${gateway.baseUrl}/review/api/qa`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({
        scope: "memoq",
        customRules: [{ name: "bad", sourceContains: "", kind: "maxLength", value: "abc" }],
      }),
    });
    assert.equal(badQa.status, 400);

    // 3. Exports (XLSX, CSV with formula protection + BOM, HTML standalone report) with strict auth
    const unauthExport = await fetch(`${gateway.baseUrl}/review/api/qa/export/csv`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ rows: [], files: [] }),
    });
    assert.equal(unauthExport.status, 401);

    const exportPayload = {
      files: [{ name: "alchemy.xliff", segments: 3, incomplete: false }],
      rows: [
        {
          file: "alchemy.xliff",
          segment: "1",
          source: "=Buy {buyNum} Curio now.",
          target: "Beli Curio sekarang 99.",
          category: "Tag 与变量",
          severity: "critical",
          rule: "PLACEHOLDER_MISSING",
          message: "缺少占位符 {buyNum}",
          evidence: "missing: {buyNum}",
          highlights: { source: [{ start: 5, end: 13 }] },
        },
      ],
      configuration: { aiqa: false, checks: ["缺少占位符"] },
    };

    const csvRes = await fetch(`${gateway.baseUrl}/review/api/qa/export/csv`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify(exportPayload),
    });
    assert.equal(csvRes.status, 200);
    const csvText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await csvRes.arrayBuffer());
    assert.ok(csvText.startsWith("\uFEFF"));
    assert.match(csvText, /'=Buy \{buyNum\}/u);

    const htmlExportRes = await fetch(`${gateway.baseUrl}/review/api/qa/export/html`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify(exportPayload),
    });
    assert.equal(htmlExportRes.status, 200);
    const htmlExport = await htmlExportRes.text();
    assert.match(htmlExport, /双语 QA 报告/u);

    const xlsxRes = await fetch(`${gateway.baseUrl}/review/api/qa/export/xlsx`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify(exportPayload),
    });
    assert.equal(xlsxRes.status, 200);
    assert.match(xlsxRes.headers.get("content-type") ?? "", /spreadsheetml\.sheet/u);
    const xlsxBytes = new Uint8Array(await xlsxRes.arrayBuffer());
    const xlsxEntries = unzipSync(xlsxBytes);
    const xlsxXml = Object.entries(xlsxEntries)
      .filter(([name]) => name.endsWith(".xml"))
      .map(([, buf]) => new TextDecoder().decode(buf))
      .join("\n");
    assert.ok(xlsxEntries["xl/worksheets/sheet1.xml"]);
    assert.ok(xlsxEntries["xl/worksheets/sheet2.xml"]);
    assert.match(xlsxXml, /缺少占位符/u);
    assert.match(xlsxXml, /检查完成/u);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memoQ Review Workbench, QA APIs, and exported HTML/CSV/XLSX embed explicit tool version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-tool-version-"));
  const previewClient = createPreviewClient({ dataDir: dir, platform: "win32" });
  previewClient.ingestEventForTest?.({
    type: "status",
    state: "connected",
    connected: true,
    previewToolId: "test-version-id",
  });
  previewClient.ingestEventForTest?.({
    type: "content_update",
    parts: [
      {
        documentId: "doc-ver-1",
        documentName: "versioned.xliff",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        previewPartId: "doc-ver-1::p1",
        sourceText: "Save {count} items.",
        targetText: "保存项目。",
        order: 0,
      },
    ],
  });

  const store = createStagingStore({ statePath: join(dir, "state.json") });
  const gateway = await createMtGateway({
    port: 0,
    toolName: "@langlink/memoq-mcp",
    desktopVersion: "0.2.5",
    stagingStore: store,
    previewClient,
  });

  try {
    const html = await fetch(gateway.reviewUrl).then((r) => r.text());
    assert.match(html, /<meta name="generator" content="@langlink\/memoq-mcp@0\.2\.5" \/>/u);
    assert.match(html, /id="toolVersionBadge"[^>]*>v0\.2\.5</u);
    assert.match(html, /id="toolVersionFooter"[^>]*>@langlink\/memoq-mcp@0\.2\.5</u);

    const reviewHeaders = {
      "Content-Type": "application/json",
      "X-Review-Token": gateway.reviewToken,
      "Sec-Fetch-Site": "same-origin",
    };

    const stateJson = (await fetch(`${gateway.baseUrl}/review/api/state?documentId=doc-ver-1`, {
      headers: reviewHeaders,
    }).then((r) => r.json())) as { tool: { name: string; version: string } };
    assert.deepEqual(stateJson.tool, { name: "@langlink/memoq-mcp", version: "0.2.5" });

    const bridgeStatus = (await fetch(`${gateway.baseUrl}/bridge/status`, {
      headers: { Authorization: `Bearer ${gateway.controlToken}` },
    }).then((r) => r.json())) as { gateway: { toolName: string; version: string }; tool: { name: string; version: string } };
    assert.equal(bridgeStatus.gateway.toolName, "@langlink/memoq-mcp");
    assert.equal(bridgeStatus.gateway.version, "0.2.5");
    assert.deepEqual(bridgeStatus.tool, { name: "@langlink/memoq-mcp", version: "0.2.5" });

    const qaJson = (await fetch(`${gateway.baseUrl}/review/api/qa`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify({ scope: "memoq", documentId: "doc-ver-1" }),
    }).then((r) => r.json())) as { tool: { name: string; version: string } };
    assert.deepEqual(qaJson.tool, { name: "@langlink/memoq-mcp", version: "0.2.5" });

    const bridgeQaJson = (await fetch(`${gateway.baseUrl}/bridge/qa/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gateway.controlToken}`,
      },
      body: JSON.stringify({ scope: "memoq", documentId: "doc-ver-1" }),
    }).then((r) => r.json())) as { tool: { name: string; version: string } };
    assert.deepEqual(bridgeQaJson.tool, { name: "@langlink/memoq-mcp", version: "0.2.5" });

    const exportPayload = {
      files: [{ name: "versioned.xliff", segments: 1, incomplete: false }],
      rows: [
        {
          file: "versioned.xliff",
          segment: "1",
          source: "Save {count} items.",
          target: "保存项目。",
          category: "Tag 与变量",
          severity: "critical",
          rule: "PLACEHOLDER_MISSING",
          message: "缺少占位符 {count}",
          evidence: "missing: {count}",
        },
      ],
      configuration: { aiqa: false, checks: ["Tag 与变量"] },
    };

    const exportedHtml = await fetch(`${gateway.baseUrl}/review/api/qa/export/html`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify(exportPayload),
    }).then((r) => r.text());
    assert.match(exportedHtml, /<meta name="generator" content="@langlink\/memoq-mcp@0\.2\.5">/u);
    assert.match(exportedHtml, /工具版本：@langlink\/memoq-mcp@0\.2\.5/u);

    const exportedCsv = await fetch(`${gateway.baseUrl}/review/api/qa/export/csv`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify(exportPayload),
    }).then((r) => r.text());
    assert.match(exportedCsv, /,工具版本\r?\n/u);
    assert.match(exportedCsv, /,'@langlink\/memoq-mcp@0\.2\.5\r?\n/u);

    const xlsxRes = await fetch(`${gateway.baseUrl}/review/api/qa/export/xlsx`, {
      method: "POST",
      headers: reviewHeaders,
      body: JSON.stringify(exportPayload),
    });
    const xlsxBytes = new Uint8Array(await xlsxRes.arrayBuffer());
    const xlsxEntries = unzipSync(xlsxBytes);
    const xlsxXml = Object.entries(xlsxEntries)
      .filter(([name]) => name.endsWith(".xml"))
      .map(([, buf]) => new TextDecoder().decode(buf))
      .join("\n");
    assert.match(xlsxXml, /@langlink\/memoq-mcp@0\.2\.5/u);
    assert.match(xlsxXml, /工具版本/u);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
