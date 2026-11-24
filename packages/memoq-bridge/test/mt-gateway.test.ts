import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, ROUTES, restoreInlineTagsFromStaged, stripHtmlTags, verifyInlineTagInventory } from "../src/contract.ts";
import { createMtGateway } from "../src/mt-gateway.ts";
import { createStagingStore } from "../src/staging-store.ts";

test("verifyInlineTagInventory validates mqitag multisets and formatting balance", () => {
  assert.equal(
    verifyInlineTagInventory('Click <span data-mqitag="0">◿</span> now.', '点击 <span data-mqitag="0">◿</span>。').ok,
    true,
  );
  const missing = verifyInlineTagInventory('Click <span data-mqitag="0">◿</span> now.', "点击。");
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["mqitag:0"]);

  const fmtMissing = verifyInlineTagInventory("<b>Warning</b>: check", "警告：检查");
  assert.equal(fmtMissing.ok, false);
});

test("mt-gateway serves memoQ contract routes, staging hits, tag guard, aggregate, and store-translations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-gw-"));
  const store = createStagingStore({ statePath: join(dir, "state.json") });

  let alignCalls = 0;
  let autoAlignEnabled = false;

  const gateway = await createMtGateway({
    port: 0,
    stagingStore: store,
    getLiveConfig: () => ({
      mode: "staging_only",
      autoAlignTags: autoAlignEnabled,
      usePreviewContext: true,
      useConfirmedFeedForward: true,
      terminologyMode: "advisory",
      concurrency: 4,
    }),
    tagAligner: async ({ sourceHtml, stagedTarget }) => {
      alignCalls += 1;
      if (sourceHtml.includes('data-mqitag="0"')) {
        return `${stagedTarget}<span data-mqitag="0">◿</span>`;
      }
      return null;
    },
  });

  try {
    // 1. Desktop version handshake
    const verRes = await fetch(`${gateway.baseUrl}${ROUTES.desktopVersion}`);
    assert.equal(verRes.status, 200);
    const verJson = (await verRes.json()) as { contractVersion: string };
    assert.equal(verJson.contractVersion, CONTRACT_VERSION);

    // 2. Host & Origin guard rejects bad origin
    const badOriginRes = await fetch(`${gateway.baseUrl}${ROUTES.health}`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(badOriginRes.status, 403);

    // 3. Stage two segments using 2-letter language codes
    store.stageMany([
      {
        documentId: "doc-abc",
        sourceLanguage: "en-US",
        targetLanguage: "zh-CN",
        sourceText: "Save file",
        targetText: "保存文件",
        stagedBy: "Codex",
        confidence: 0.92,
      },
      {
        documentId: "doc-abc",
        sourceLanguage: "en-US",
        targetLanguage: "zh-CN",
        sourceText: "Click Next",
        targetText: "点击“下一步”",
        stagedBy: "Codex",
      },
    ]);

    // 4. memoQ calls /mt/translate with 3-letter codes ("eng" / "zho-CN") + partial miss + tagged rejection
    const trRes = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: "1",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: "doc-abc" },
        segments: [
          { index: 0, text: "Save file", plainText: "Save file" },
          { index: 1, text: 'Click <span data-mqitag="0">◿</span> Next', plainText: "Click Next" },
          { index: 2, text: "Unknown segment", plainText: "Unknown segment", tmSource: "Old src", tmTarget: "旧译文" },
        ],
      }),
    });
    assert.equal(trRes.status, 200);
    const trJson = (await trRes.json()) as {
      success: boolean;
      partial?: boolean;
      translations: Array<{ index: number; text: string; confidence: number; info: string }>;
      nonRetryableSegmentIndexes?: number[];
    };
    assert.equal(trJson.success, true);
    assert.equal(trJson.partial, true);
    assert.equal(trJson.translations.length, 1);
    assert.equal(trJson.translations[0]?.text, "保存文件");
    assert.equal(trJson.translations[0]?.confidence, 0, "MT results must not write a TM-style confidence match rate back to memoQ");
    assert.deepEqual(trJson.nonRetryableSegmentIndexes, [1, 2]);

    // Recent requests captured both the tag-protected and missed segments
    const recent = store.listRecentRequests({ limit: 10 });
    assert.equal(recent.length, 2);
    assert.ok(recent.some((item) => item.reason === "inline_tags_required" && item.hasInlineTags));
    assert.ok(recent.some((item) => item.reason === "not_staged" && item.tmTarget === "旧译文"));

    // 5. Enable autoAlignTags (DSH A+B mode) -> segment 1 now succeeds with aligned tag!
    autoAlignEnabled = true;
    const trRes2 = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: "1",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        metadata: { documentId: "doc-abc" },
        segments: [{ index: 0, text: 'Click <span data-mqitag="0">◿</span> Next', plainText: "Click Next" }],
      }),
    });
    const trJson2 = (await trRes2.json()) as {
      success: boolean;
      translations: Array<{ text: string; confidence: number; info: string }>;
    };
    assert.equal(trJson2.success, true);
    assert.equal(alignCalls, 1);
    assert.equal(trJson2.translations[0]?.text, '点击“下一步”<span data-mqitag="0">◿</span>');
    assert.equal(trJson2.translations[0]?.confidence, 0);

    // 6. Aggregate batch flow
    const subRes = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslateAggregate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: "1",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        metadata: { documentId: "doc-abc" },
        segments: [{ index: 0, text: "Save file", plainText: "Save file" }],
      }),
    });
    const subJson = (await subRes.json()) as { success: boolean; jobRequestId: string };
    assert.equal(subJson.success, true);

    const pollRes = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslateAggregateResult}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobRequestId: subJson.jobRequestId, waitTimeoutMs: 5000 }),
    });
    const pollJson = (await pollRes.json()) as {
      success: boolean;
      pending: boolean;
      translations: Array<{ text: string; confidence: number }>;
    };
    assert.equal(pollJson.success, true);
    assert.equal(pollJson.pending, false);
    assert.equal(pollJson.translations[0]?.text, "保存文件");
    assert.equal(pollJson.translations[0]?.confidence, 0);

    // 7. StoreTranslation writeback
    const storeRes = await fetch(`${gateway.baseUrl}${ROUTES.mtStoreTranslations}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: "1",
        sourceLanguage: "eng",
        targetLanguage: "zho-CN",
        requestType: "Plaintext",
        translations: [{ index: 0, sourceText: "Save file", targetText: "存储文件" }],
      }),
    });
    const storeJson = (await storeRes.json()) as { success: boolean; storedCount: number };
    assert.equal(storeJson.success, true);
    assert.equal(storeJson.storedCount, 1);
    assert.equal(store.listConfirmed({ limit: 5 })[0]?.targetText, "存储文件");

    // 8. Control API requires bearer token
    const unauth = await fetch(`${gateway.baseUrl}/bridge/status`);
    assert.equal(unauth.status, 401);
    const auth = await fetch(`${gateway.baseUrl}/bridge/status`, {
      headers: { Authorization: `Bearer ${gateway.controlToken}` },
    });
    assert.equal(auth.status, 200);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deterministic inline-tag restoration serves XLIFF placeholders, game tags, and multiline segments in 0ms with 0 LLM calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoq-slot-restore-"));
  const statePath = join(dir, "state.json");
  const store = createStagingStore({ statePath });

  let liveCalls = 0;
  let alignCalls = 0;

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
          text: s.text,
          confidence: 0.7,
          info: "live",
        })),
      };
    },
    tagAligner: async () => {
      alignCalls += 1;
      return null;
    },
  });

  try {
    // stripHtmlTags preserves non-HTML game pseudo-tags & decodes entities consistently
    assert.equal(
      stripHtmlTags("&lt;CN-Medium&gt;Once you have &lt;/&gt;&lt;Orange&gt;1 Gold Coin&lt;/&gt;"),
      "<CN-Medium>Once you have </><Orange>1 Gold Coin</>",
    );

    const docId = "doc-xliff-1";
    store.stageMany([
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "{efficiency}%",
        targetText: "{efficiency}%",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "{value}%",
        targetText: "{value}%",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "{sign}{value}%",
        targetText: "{sign}{value}%",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "Buy {buyNum} {buyName} and get {giftNum} {giftName} free. Use them to forge Curios.",
        targetText: "Beli {buyNum} {buyName} dan dapatkan {giftNum} {giftName} gratis. Gunakan untuk menempa Curio.",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "Get {count} of {itemName}.",
        targetText: "Dapatkan item {itemName} sebanyak {count}.",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "1. Refresh daily.\n2. Recruit all 3.\n3. Additional costs Diamonds.\n4. Odds:\u00a0Common 44.2%.",
        targetText: "1. Segarkan harian.\n2. Rekrut 3.\n3. Tambahan butuh Diamond.\n4. Peluang: Biasa 44.2%.",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "<CN-Medium>Once you have </><Orange>1 Gold Coin</><CN-Medium>, you can </><Orange>trade it on the Steam Market</><CN-Medium>!</>",
        targetText: "<CN-Medium>Setelah kamu punya </><Orange>1 Koin Emas</><CN-Medium>, kamu bisa </><Orange>memperdagangkannya di Steam Market</><CN-Medium>!</>",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "{value}% <Green>+{delta}</>",
        targetText: "{value}% <Green>+{delta}</>",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "<Red_Number>{value}% (-{drop})</>",
        targetText: "<Red_Number>{value}% (-{drop})</>",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "Greetings, Lord!\n  The official Discord is open.\n  Join our Discord: <a href=\"https://discord.gg/goldencity\">https://discord.gg/goldencity</>\n  See you there!",
        targetText: "Salam, Tuan!\n  Discord resmi dibuka.\n  Gabung: <a href=\"https://discord.gg/goldencity\">https://discord.gg/goldencity</>\n  Sampai jumpa!",
      },
      {
        documentId: docId,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "<CN-Medium>The Ravens are about to invade.</>",
        targetText: "<CN-Medium>Gagak akan segera menyerang & bertahan.</>",
      },
    ]);

    const t = (id: number) => `<span data-mqitag="${id}">◿</span>`;
    const incomingBatch = [
      // 0: Unanimous collision ({efficiency}% vs {value}%) -> 0ms deterministic hit
      { index: 0, text: `${t(0)}%`, plainText: "%" },
      // 1: Adjacent placeholders
      { index: 1, text: `${t(0)}${t(1)}%`, plainText: "%" },
      // 2: 4 placeholders
      {
        index: 2,
        text: `Buy ${t(0)} ${t(1)} and get ${t(2)} ${t(3)} free. Use them to forge Curios.`,
        plainText: "Buy   and get   free. Use them to forge Curios.",
      },
      // 3: Placeholder reordering preserves exact data-mqitag IDs
      { index: 3, text: `Get ${t(0)} of ${t(1)}.`, plainText: "Get  of ." },
      // 4: Multiline + NBSP where MemoQ stripped \n without inserting space in plainText
      {
        index: 4,
        text: `1. Refresh daily.${t(0)}2. Recruit all 3.${t(1)}3. Additional costs Diamonds.${t(2)}4. Odds:&nbsp;Common 44.2%.`,
        plainText: "1. Refresh daily.2. Recruit all 3.3. Additional costs Diamonds.4. Odds: Common 44.2%.",
      },
      // 5: Multiline using <br/> in BothFormattingAndTags
      {
        index: 5,
        text: "1. Refresh daily.<br/>2. Recruit all 3.<br/>3. Additional costs Diamonds.<br/>4. Odds: Common 44.2%.",
        plainText: "1. Refresh daily.2. Recruit all 3.3. Additional costs Diamonds.4. Odds: Common 44.2%.",
      },
      // 6: Game tags as 10 mqitags
      {
        index: 6,
        text: `${t(0)}Once you have ${t(1)}${t(2)}1 Gold Coin${t(3)}${t(4)}, you can ${t(5)}${t(6)}trade it on the Steam Market${t(7)}${t(8)}!${t(9)}`,
        plainText: "Once you have 1 Gold Coin, you can trade it on the Steam Market!",
      },
      // 7: Mixed placeholder + game tags
      { index: 7, text: `${t(0)}% ${t(1)}+${t(2)}${t(3)}`, plainText: "% +" },
      // 8: Mixed placeholder + game tags where <Green>/<Red_Number> remained escaped literal HTML and only {} became mqitag
      {
        index: 8,
        text: `&lt;Red_Number&gt;${t(0)}% (-${t(1)})&lt;/&gt;`,
        plainText: "<Red_Number>% (-)</>",
      },
      // 9: Indented multiline + <a href="...">...</> tags
      {
        index: 9,
        text: `Greetings, Lord!${t(0)}The official Discord is open.${t(1)}  Join our Discord: ${t(2)}https://discord.gg/goldencity${t(3)}${t(4)}See you there!`,
        plainText: "Greetings, Lord!The official Discord is open.Join our Discord: https://discord.gg/goldencitySee you there!",
      },
      // 10: HTML-escaped game tags without mqitags (PlainText matches, HTML response must escape < > &)
      {
        index: 10,
        text: "&lt;CN-Medium&gt;The Ravens are about to invade.&lt;/&gt;",
        plainText: "<CN-Medium>The Ravens are about to invade.</>",
      },
    ];

    const startedAt = Date.now();
    const res = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: "1",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: docId },
        segments: incomingBatch,
      }),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      success: boolean;
      partial?: boolean;
      providerId?: string;
      translations: Array<{ index: number; text: string; info: string }>;
    };

    assert.equal(json.success, true);
    assert.equal(json.partial, false);
    assert.equal(json.providerId, "langlink-staging");
    assert.equal(json.translations.length, incomingBatch.length);
    assert.equal(liveCalls, 0, "all 11 special segments must hit staging with 0 live LLM calls");
    assert.equal(alignCalls, 0, "all tagged segments must restore deterministically with 0 LLM tagAligner calls");
    assert.ok(elapsedMs < 2000, `expected sub-second batch staging response, got ${elapsedMs}ms`);

    for (const seg of incomingBatch) {
      const translated = json.translations.find((tr) => tr.index === seg.index);
      assert.ok(translated, `missing translation for index ${seg.index}`);
      assert.equal(
        verifyInlineTagInventory(seg.text, translated.text).ok,
        true,
        `tag inventory mismatch for index ${seg.index}: ${translated.text}`,
      );
    }

    assert.equal(json.translations[0]?.text, `${t(0)}%`);
    assert.equal(json.translations[1]?.text, `${t(0)}${t(1)}%`);
    assert.equal(json.translations[3]?.text, `Dapatkan item ${t(1)} sebanyak ${t(0)}.`);
    assert.equal(json.translations[5]?.text, "1. Segarkan harian.<br/>2. Rekrut 3.<br/>3. Tambahan butuh Diamond.<br/>4. Peluang: Biasa 44.2%.");
    assert.equal(json.translations[8]?.text, `&lt;Red_Number&gt;${t(0)}% (-${t(1)})&lt;/&gt;`);
    assert.equal(json.translations[10]?.text, "&lt;CN-Medium&gt;Gagak akan segera menyerang &amp; bertahan.&lt;/&gt;");

    // Safety check 1: Plain word gap must NOT match an inline tag slot
    assert.equal(
      restoreInlineTagsFromStaged(`Open ${t(0)} settings`, "Open advanced network settings", "Buka pengaturan lanjutan", "BothFormattingAndTags"),
      null,
    );

    // Safety check 2: Ambiguous distinct translations with identical tag skeleton must NOT guess
    const docAmbiguous = "doc-ambiguous";
    store.stageMany([
      {
        documentId: docAmbiguous,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "{hero} attacked",
        targetText: "Pahlawan {hero} menyerang",
      },
      {
        documentId: docAmbiguous,
        sourceLanguage: "eng",
        targetLanguage: "ind",
        sourceText: "{monster} attacked",
        targetText: "Monster {monster} menyerang",
      },
    ]);

    const ambigRes = await fetch(`${gateway.baseUrl}${ROUTES.mtTranslate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: "1",
        sourceLanguage: "eng",
        targetLanguage: "ind",
        requestType: "BothFormattingAndTags",
        metadata: { documentId: docAmbiguous },
        segments: [{ index: 0, text: `${t(0)} attacked`, plainText: "attacked" }],
      }),
    });
    const ambigJson = (await ambigRes.json()) as {
      providerId?: string;
      translations: Array<{ confidence: number }>;
    };
    assert.equal(ambigJson.providerId, "mock-live", "ambiguous slot collisions must fall through safely to live MT");
    assert.equal(ambigJson.translations[0]?.confidence, 0, "live fallback must also omit TM-style confidence match rate");
    assert.equal(liveCalls, 1);

    // Live fallback misses ARE recorded in recentRequests
    const recent = store.listRecentRequests({ limit: 10 });
    assert.ok(
      recent.some((entry) => entry.reason === "live_fallback" && entry.text === `${t(0)} attacked`),
      "staging_then_live misses must be logged in recentRequests for diagnostics",
    );

    // Debounced hitCount persistence is flushed cleanly via flush()
    store.flush?.();
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      staged: Array<{ sourceText: string; hitCount: number }>;
    };
    const buyItem = persisted.staged.find((e) => e.sourceText.startsWith("Buy {buyNum}"));
    assert.ok(buyItem && buyItem.hitCount === 1, "expected hitCount=1 persisted after flush()");
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
