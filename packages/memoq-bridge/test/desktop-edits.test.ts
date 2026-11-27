import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopWriter, desktopEditSchema, planReplacements, type SegmentEdit } from "../src/desktop-edits.ts";

const edit: SegmentEdit = {
  previewPartId: "p1", expectedSource: "【Sun】 【Sea】", expectedTarget: "【海】/【日】",
  replacements: [{ oldText: "日", newText: "Sun" }, { oldText: "海", newText: "Sea" }],
};
const signal = new AbortController().signal;

test("plan exact local edits using original UTF-16 text and reject ambiguous or overlapping spans", () => {
  assert.equal(planReplacements(edit).final, "【Sea】/【Sun】");
  assert.throws(() => planReplacements({ ...edit, expectedTarget: "海海日" }), /unique/);
  assert.throws(() => planReplacements({ ...edit, replacements: [
    { oldText: "【海】", newText: "x" }, { oldText: "海", newText: "" },
  ] }), /overlap/);
  for (const value of ["", "𠮷😀", "e\u0301"]) {
    const empty = { ...edit, expectedTarget: "", replacements: [{ oldText: "", newText: value }] };
    assert.equal(planReplacements(empty).final, value);
    assert.ok(desktopEditSchema.safeParse({ documentId: "d", edits: [empty] }).success);
  }
  assert.equal(desktopEditSchema.safeParse({ documentId: "d", edits: [{ ...edit, expectedTarget: "\ud800" }] }).success, false);
});

test("one writer owns the editor and an uncertain native action stops the batch", async () => {
  let proceed!: () => void;
  const wait = new Promise<void>(r => { proceed = r; });
  const write = createDesktopWriter(async (_, item) => {
    await wait;
    return { previewPartId: item.previewPartId, status: "unverified", actualTarget: "partial" };
  });
  const batch = { documentId: "d", edits: [edit, { ...edit, previewPartId: "p2" }] };
  const first = write(batch, signal);
  assert.equal((await write(batch, signal)).results[0]?.reason, "editor_busy");
  proceed();
  assert.deepEqual((await first).results.map(r => r.status), ["unverified", "not_attempted"]);
  assert.deepEqual((await write(batch, AbortSignal.abort())).results.map(r => r.reason), ["cancelled", "cancelled"]);
});

test("conflicts skip one segment and invalid later edits are rejected before any write", async () => {
  let writes = 0;
  const write = createDesktopWriter(async (_, item) => {
    writes++;
    return { previewPartId: item.previewPartId, status: writes === 1 ? "conflict" : "applied" };
  });
  const batch = { documentId: "d", edits: [edit, { ...edit, previewPartId: "p2" }] };
  assert.match((await write({ ...batch, edits: [edit, edit] }, signal)).results[0]!.reason!, /Duplicate/);
  assert.match((await write({ ...batch, edits: [edit, { ...edit, previewPartId: "p3", expectedTarget: "!" }] }, signal)).results[0]!.reason!, /unique/);
  assert.equal(writes, 0);
  assert.deepEqual((await write(batch, signal)).results.map(r => r.status), ["conflict", "applied"]);
});
