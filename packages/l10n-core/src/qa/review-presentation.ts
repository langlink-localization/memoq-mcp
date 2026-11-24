import type { ReviewRow, ReviewSpan } from "./review-data.ts";

export type ReviewLocation = Pick<ReviewRow, "file" | "segment" | "source" | "target" | "segmentKey">;
export type ReviewSectionRow = { segment: ReviewLocation; findings: ReviewRow[]; aiqa?: ReviewRow };
export type ReviewRuleSection = { label: string; entries: Map<string, ReviewSectionRow> };
export type ReviewPresentation = ReturnType<typeof createReviewPresentation>;

// Also serialized into the standalone HTML. Keep dependencies inside the factory.
export function createReviewPresentation() {
  const ruleLabels = new Map([
    ["UNPAIRED_BRACKET", "括号或引号不配对"],
    ["PUNCT_DUP", "标点重复"],
    ["WHITESPACE", "空格异常"],
    ["TAG_MISMATCH", "标签不一致"],
    ["PLACEHOLDER_MISSING", "缺少占位符"],
    ["PLACEHOLDER_EXTRA", "多出占位符"],
    ["NUMBER_MISMATCH", "数字不一致"],
    ["DATE_MISMATCH", "日期不一致"],
    ["EMPTY_TARGET", "空译或正文缺失"],
    ["UNTRANSLATED_COPY", "原译相同"],
    ["URL_CHANGED", "网址或邮箱变更"],
    ["TB_SOURCE_FORBIDDEN", "原文命中禁用术语"],
    ["TB_FORBIDDEN_USED", "译文使用禁用词"],
    ["DATE_FORMAT", "日期格式异常"],
    ["DUPLICATE_WORD", "重复词"],
    ["TERM_MISSING", "漏用术语表译名"],
    ["TERMINOLOGY_INCONSISTENT", "术语译法前后不一致"],
    ["SOURCE_TARGET_INCONSISTENT", "同原文不同译文"],
    ["SOURCE_LEFTOVER", "残留源语言片段"],
    ["TRAILING_COLON", "句末冒号不一致"],
    ["SENTENCE_END_PUNCT", "句末标点不一致"],
    ["FULLWIDTH_HALFWIDTH", "全角半角标点混用"],
    ["LENGTH_RATIO", "长度比例异常"],
  ]);
  const aiTypeLabels = new Map([
    ["ACC", "语义错误"], ["OMI", "漏译"], ["ADD", "多译或虚构"], ["TER", "术语错误"],
    ["NUM", "数字、日期或单位错误"], ["ENT", "实体错误"], ["CTX", "上下文错误"],
    ["FLU", "语言质量问题"], ["STY", "违反风格要求"], ["LOC", "本地化问题"],
    ["TEC", "技术格式错误"], ["UNC", "信息不足"],
  ]);
  const verdictLabels = new Map([
    ["AUTO_PASS", "建议通过"], ["HUMAN_REVIEW", "人工审核"],
    ["AIQA_UNAVAILABLE", "无法判定"], ["AIQA_PENDING", "尚未完成"],
  ]);
  const collator = new Intl.Collator(undefined, { numeric: true });

  function segmentKey(row: ReviewLocation): string {
    return row.segmentKey ?? JSON.stringify([row.file, row.segment]);
  }

  function ruleName(rule: string): string {
    return ruleLabels.get(rule) ?? rule;
  }

  function ruleLabel(finding: ReviewRow): string {
    if (finding.category === "AIQA") return "AIQA";
    return finding.category === "自定义" ? finding.rule : ruleName(finding.rule);
  }

  function aiStatusKey(finding: ReviewRow): string {
    return verdictLabels.has(finding.rule) ? finding.rule : finding.message;
  }

  function aiStatus(finding: ReviewRow): string {
    return verdictLabels.get(aiStatusKey(finding)) ?? finding.message;
  }

  function aiTypes(finding: ReviewRow): string[] {
    return finding.rule.split(/,\s*/u).flatMap((code) => {
      const label = aiTypeLabels.get(code);
      return label ? [label] : [];
    });
  }

  function aiComment(aiqa?: ReviewRow): string {
    if (!aiqa) return "";
    const summary = typeof aiqa.aiqaSummary === "string" ? aiqa.aiqaSummary : "";
    const note = (summary || aiqa.evidence.split(/^确定性QA：/mu, 1)[0] || "")
      .replace(/\s+/gu, " ").trim();
    if (!note) return aiqa.evidence ? "请查看完整依据。" : "";
    const characters = Array.from(note);
    return characters.length > 100 ? characters.slice(0, 99).join("") + "…" : note;
  }

  function textParts(value: string, findings: ReviewRow[], side: "source" | "target"): Array<{ text: string; marked: boolean }> {
    const ranges = findings.flatMap((finding) => {
      const spans = finding.highlights?.[side];
      if (!Array.isArray(spans)) return [];
      return spans.filter((span) => span && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
        span.start >= 0 && span.start < span.end && span.end <= value.length);
    }).sort((left, right) => left.start - right.start || left.end - right.end);
    if (!ranges.length) {
      return [{ text: value, marked: false }];
    }
    const merged: ReviewSpan[] = [];
    for (const span of ranges) {
      const previous = merged.at(-1);
      if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
      else merged.push({ ...span });
    }
    const parts: Array<{ text: string; marked: boolean }> = [];
    let cursor = 0;
    for (const { start, end } of merged) {
      if (start > cursor) parts.push({ text: value.slice(cursor, start), marked: false });
      parts.push({ text: value.slice(start, end), marked: true });
      cursor = end;
    }
    if (cursor < value.length) parts.push({ text: value.slice(cursor), marked: false });
    return parts;
  }

  function collectSections(matches: ReviewRow[], rows = matches) {
    const aiqaBySegment = new Map(rows.filter((row) => row.category === "AIQA").map((row) => [segmentKey(row), row]));
    const rules = new Map<string, ReviewRuleSection>();
    const shown = new Set<string>();
    const included = new Set<ReviewRow>();
    for (const finding of matches) {
      if (finding.category === "AIQA") continue;
      const ruleKey = JSON.stringify([finding.category, finding.rule]);
      let section = rules.get(ruleKey);
      if (!section) {
        section = { label: ruleLabel(finding), entries: new Map() };
        rules.set(ruleKey, section);
      }
      const key = segmentKey(finding);
      let entry = section.entries.get(key);
      if (!entry) {
        const aiqa = aiqaBySegment.get(key);
        entry = { segment: finding, findings: [], ...(aiqa ? { aiqa } : {}) };
        section.entries.set(key, entry);
        if (aiqa) included.add(aiqa);
      }
      entry.findings.push(finding);
      included.add(finding);
      shown.add(key);
    }

    const sections = new Map([...rules].sort(([, left], [, right]) => collator.compare(left.label, right.label)));
    const aiqaEntries = new Map<string, ReviewSectionRow>();
    for (const verdict of matches) {
      if (verdict.category !== "AIQA") continue;
      const key = segmentKey(verdict);
      if (shown.has(key)) continue;
      aiqaEntries.set(key, { segment: verdict, findings: [], aiqa: verdict });
      included.add(verdict);
      shown.add(key);
    }
    if (aiqaEntries.size) sections.set("aiqa", { label: "AIQA", entries: aiqaEntries });
    return { sections, shown, filtered: [...included] };
  }

  return { ruleName, ruleLabel, aiStatus, aiStatusKey, aiTypes, aiComment, textParts, collectSections };
}
