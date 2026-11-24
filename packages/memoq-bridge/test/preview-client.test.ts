import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createPreviewClient, type PreviewSubprocessHandle } from "../src/preview-client.ts";

class MockHelperProcess extends EventEmitter implements PreviewSubprocessHandle {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  receivedCommands: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          this.receivedCommands.push(parsed);
          this.stdout.write(JSON.stringify({ type: "ack", id: parsed.id, ok: true }) + "\n");
        }
        nl = buffer.indexOf("\n");
      }
    });
  }

  emitEvent(event: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(event) + "\n");
  }

  kill(): void {
    this.emit("exit", 0);
  }
}

test("preview-client handles JSONL events, mappingCertain, pagination, and focusSegment", async () => {
  const proc = new MockHelperProcess();
  const client = createPreviewClient({
    platform: "win32",
    helperExecutablePath: "mock-helper.exe",
    spawner: () => proc,
  });

  await client.start();

  proc.emitEvent({ type: "status", state: "connected", connected: true, previewToolId: "7f4e9b21-8c34-4a62-9d51-3b7e2f8a6c14" });
  proc.emitEvent({ type: "part_ids", previewPartIds: ["p1", "p2", "p3"] });
  proc.emitEvent({
    type: "content_update",
    parts: [
      { documentId: "doc-1", documentName: "manual.docx", sourceLanguage: "eng", targetLanguage: "zho-CN", previewPartId: "p1", sourceText: "First sentence.", targetText: "第一句。", order: 0 },
      { documentId: "doc-1", documentName: "manual.docx", sourceLanguage: "eng", targetLanguage: "zho-CN", previewPartId: "p2", sourceText: "Second sentence.", targetText: "", order: 1 },
      { documentId: "doc-1", documentName: "manual.docx", sourceLanguage: "eng", targetLanguage: "zho-CN", previewPartId: "p3", sourceText: "Third sentence.", targetText: "第三句。", order: 2 },
    ],
  });
  proc.emitEvent({
    type: "highlight_change",
    activeParts: [
      { documentId: "doc-1", documentName: "manual.docx", sourceLanguage: "eng", targetLanguage: "zho-CN", previewPartId: "p2", sourceText: "Second sentence.", targetText: "" },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 30));

  const status = client.getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.activeDocumentId, "doc-1");

  const active = await client.getActiveSegment({ contextBefore: 1, contextAfter: 1, settleMs: 0 });
  assert.equal(active.available, true);
  assert.equal(active.mappingCertain, true);
  assert.equal(active.segment?.previewPartId, "p2");
  assert.equal(active.above[0]?.sourceText, "First sentence.");
  assert.equal(active.below[0]?.sourceText, "Third sentence.");

  // Multi-part ambiguity without focused range marks mappingCertain: false
  proc.emitEvent({
    type: "highlight_change",
    activeParts: [
      { documentId: "doc-1", previewPartId: "p1", sourceText: "First sentence.", targetText: "第一句。" },
      { documentId: "doc-1", previewPartId: "p2", sourceText: "Second sentence.", targetText: "" },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const ambiguous = await client.getActiveSegment({ settleMs: 0 });
  assert.equal(ambiguous.mappingCertain, false);
  assert.equal(ambiguous.reason, "multiple_active_parts");

  const untranslated = client.getDocumentSegments({ onlyUntranslated: true });
  assert.equal(untranslated.filtered, 1);
  assert.equal(untranslated.segments[0]?.previewPartId, "p2");

  const focusRes = await client.focusSegment({ previewPartId: "p3" });
  assert.equal(focusRes.ok, true);
  const focusCmd = proc.receivedCommands.find((cmd) => cmd.type === "focus_segment");
  assert.equal(focusCmd?.previewPartId, "p3");
  assert.equal(focusCmd?.sourceLangCode, "eng");
  assert.equal(focusCmd?.sourceContent, "Third sentence.");

  await client.stop();
});

test("preview-client sorts numeric-suffix previewPartIds naturally when part_ids is absent", async () => {
  const proc = new MockHelperProcess();
  const client = createPreviewClient({
    platform: "win32",
    helperExecutablePath: "mock-helper.exe",
    spawner: () => proc,
  });
  await client.start();

  proc.emitEvent({
    type: "content_update",
    parts: [
      { documentId: "doc-num", documentName: "game.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "mQ-default-guid-1", sourceText: "Part 1", targetText: "", order: 0 },
      { documentId: "doc-num", documentName: "game.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "mQ-default-guid-10", sourceText: "Part 10", targetText: "", order: 1 },
      { documentId: "doc-num", documentName: "game.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "mQ-default-guid-100", sourceText: "Part 100", targetText: "", order: 2 },
      { documentId: "doc-num", documentName: "game.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "mQ-default-guid-2", sourceText: "Part 2", targetText: "", order: 3 },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const natural = client.getDocumentSegments({ documentId: "doc-num" });
  assert.deepEqual(
    natural.segments.map((s) => s.previewPartId),
    ["mQ-default-guid-1", "mQ-default-guid-2", "mQ-default-guid-10", "mQ-default-guid-100"],
  );

  // MemoQ 12 lexicographically sorted part_ids array is normalized back to natural numeric order
  proc.emitEvent({
    type: "part_ids",
    previewPartIds: ["mQ-default-guid-1", "mQ-default-guid-10", "mQ-default-guid-100", "mQ-default-guid-2"],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const normalizedPartIds = client.getDocumentSegments({ documentId: "doc-num" });
  assert.deepEqual(
    normalizedPartIds.segments.map((s) => s.previewPartId),
    ["mQ-default-guid-1", "mQ-default-guid-2", "mQ-default-guid-10", "mQ-default-guid-100"],
  );

  // Explicit non-lexicographical part_ids event overrides natural sorting when present
  proc.emitEvent({
    type: "part_ids",
    previewPartIds: ["mQ-default-guid-100", "mQ-default-guid-10", "mQ-default-guid-2", "mQ-default-guid-1"],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const explicit = client.getDocumentSegments({ documentId: "doc-num" });
  assert.deepEqual(
    explicit.segments.map((s) => s.previewPartId),
    ["mQ-default-guid-100", "mQ-default-guid-10", "mQ-default-guid-2", "mQ-default-guid-1"],
  );

  await client.stop();
});

test("preview-client scopes part_ids updates to the matching document without clobbering prior documents", async () => {
  const proc = new MockHelperProcess();
  const client = createPreviewClient({
    platform: "win32",
    helperExecutablePath: "mock-helper.exe",
    spawner: () => proc,
  });
  await client.start();

  try {
    proc.emitEvent({
      type: "content_update",
      parts: [
        { documentId: "doc-1", documentName: "first.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "doc1-1", sourceText: "First 1", targetText: "", order: 0 },
        { documentId: "doc-1", documentName: "first.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "doc1-2", sourceText: "First 2", targetText: "", order: 1 },
        { documentId: "doc-1", documentName: "first.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "doc1-10", sourceText: "First 10", targetText: "", order: 2 },
        { documentId: "doc-1", documentName: "first.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "doc1-100", sourceText: "First 100", targetText: "", order: 3 },
      ],
    });
    proc.emitEvent({
      type: "part_ids",
      previewPartIds: ["doc1-100", "doc1-10", "doc1-2", "doc1-1"],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(
      client.getDocumentSegments({ documentId: "doc-1" }).segments.map((s) => s.previewPartId),
      ["doc1-100", "doc1-10", "doc1-2", "doc1-1"],
    );

    // Emit part_ids for doc-2 BEFORE doc-2's content_update arrives
    proc.emitEvent({
      type: "part_ids",
      previewPartIds: ["doc2-30", "doc2-20", "doc2-10"],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(
      client.getDocumentSegments({ documentId: "doc-1" }).segments.map((s) => s.previewPartId),
      ["doc1-100", "doc1-10", "doc1-2", "doc1-1"],
      "non-overlapping part_ids must not overwrite doc-1 explicit order",
    );

    proc.emitEvent({
      type: "content_update",
      parts: [
        { documentId: "doc-2", documentName: "second.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "doc2-10", sourceText: "Second 10", targetText: "", order: 0 },
        { documentId: "doc-2", documentName: "second.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "doc2-20", sourceText: "Second 20", targetText: "", order: 1 },
        { documentId: "doc-2", documentName: "second.xliff", sourceLanguage: "eng", targetLanguage: "ind", previewPartId: "doc2-30", sourceText: "Second 30", targetText: "", order: 2 },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(
      client.getDocumentSegments({ documentId: "doc-1" }).segments.map((s) => s.previewPartId),
      ["doc1-100", "doc1-10", "doc1-2", "doc1-1"],
    );
    assert.deepEqual(
      client.getDocumentSegments({ documentId: "doc-2" }).segments.map((s) => s.previewPartId),
      ["doc2-30", "doc2-20", "doc2-10"],
      "doc-2 should inherit latestPartIds order once its content_update arrives",
    );
  } finally {
    await client.stop();
  }
});

test("preview-client degrades cleanly on non-Windows platforms", async () => {
  const client = createPreviewClient({ platform: "linux" });
  await client.start();
  const status = client.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.state, "unsupported_platform");
  const active = await client.getActiveSegment({ settleMs: 0 });
  assert.equal(active.available, false);
  assert.equal(active.reason, "unsupported_platform");
});
