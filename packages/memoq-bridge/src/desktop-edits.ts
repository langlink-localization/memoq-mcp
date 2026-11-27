import * as z from "zod/v4";

const text = z.string().max(64_000).refine(value => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value), "Expected Unicode text without NUL or lone surrogates.");
const replacement = z.object({ oldText: text, newText: text });
export const desktopEditSchema = z.object({
  documentId: z.string().min(1).describe("Active Preview document ID from memoq_list_documents."),
  edits: z.array(z.object({
    previewPartId: z.string().min(1),
    expectedSource: text,
    expectedTarget: text,
    replacements: z.array(replacement).min(1).max(128),
  })).min(1).max(200).describe("Reviewed edits with exact source and target snapshots. Each oldText must match once. Use more surrounding text for repeated matches; an empty newText deletes the match."),
});
export type DesktopEditBatch = z.infer<typeof desktopEditSchema>;
export type SegmentEdit = DesktopEditBatch["edits"][number];
export const editResultSchema = z.object({
  previewPartId: z.string(),
  status: z.enum(["applied", "already_applied", "conflict", "blocked", "unverified", "not_attempted"]),
  reason: z.string().optional(),
  actualSource: z.string().optional(),
  actualTarget: z.string().optional(),
});
export type EditResult = z.infer<typeof editResultSchema>;

export function planReplacements(edit: SegmentEdit) {
  const spans = edit.replacements.map(({ oldText, newText }) => {
    if (!oldText && (edit.expectedTarget || edit.replacements.length !== 1)) {
      throw new Error("An empty oldText is only valid when filling an empty target.");
    }
    const start = edit.expectedTarget.indexOf(oldText);
    if (start < 0 || start !== edit.expectedTarget.lastIndexOf(oldText)) {
      throw new Error("oldText must identify a unique substring in expectedTarget; include more context.");
    }
    return { start, oldText, newText };
  }).sort((a, b) => b.start - a.start);
  let boundary = edit.expectedTarget.length;
  let final = edit.expectedTarget;
  for (const { start, oldText, newText } of spans) {
    if (start + oldText.length > boundary) throw new Error("Replacements overlap.");
    final = final.slice(0, start) + newText + final.slice(start + oldText.length);
    boundary = start;
  }
  return { spans, final };
}

// One editor is shared by every stdio client attached to this bridge.
export function createDesktopWriter(
  write: (documentId: string, edit: SegmentEdit, plan: ReturnType<typeof planReplacements>, signal: AbortSignal) => Promise<EditResult>,
) {
  let busy = false;
  return async (batch: DesktopEditBatch, signal: AbortSignal): Promise<{ results: EditResult[] }> => {
    const ids = new Set(batch.edits.map(edit => edit.previewPartId));
    let plans: ReturnType<typeof planReplacements>[];
    try {
      if (ids.size !== batch.edits.length) throw new Error("Duplicate previewPartId in one batch.");
      plans = batch.edits.map(planReplacements);
    } catch (error) {
      return { results: batch.edits.map(({ previewPartId }) => ({ previewPartId, status: "not_attempted",
        reason: error instanceof Error ? error.message : String(error) })) };
    }
    const results: EditResult[] = [];
    if (busy) return { results: batch.edits.map(({ previewPartId }) => ({ previewPartId, status: "not_attempted", reason: "editor_busy" })) };
    busy = true;
    try {
      let stopped = false;
      for (const [index, edit] of batch.edits.entries()) {
        const id = edit.previewPartId;
        if (stopped || signal.aborted) {
          results.push({ previewPartId: id, status: "not_attempted", reason: signal.aborted ? "cancelled" : "batch_stopped" });
          continue;
        }
        let result: EditResult;
        try {
          result = await write(batch.documentId, edit, plans[index]!, signal);
        } catch (error) {
          result = { previewPartId: id, status: "unverified", reason: String(error) };
        }
        results.push(result);
        stopped = result.status === "blocked" || result.status === "unverified";
      }
      return { results };
    } finally {
      busy = false;
    }
  };
}
