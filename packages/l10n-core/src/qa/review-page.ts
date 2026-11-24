import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { REVIEW_GROUPS, formatReviewTool, type ReviewReport, type ReviewRow, type ReviewToolInfo } from "./review-data.ts";
import { createReviewPresentation, type ReviewPresentation, type ReviewRuleSection, type ReviewSectionRow } from "./review-presentation.ts";
import { writeReviewXlsx } from "./review-xlsx.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const styles = `
  :root { color-scheme: light; --paper: #f4f6f9; --ink: #192438; --muted: #4b5a6f;
    --border: #d9e0ea; --blue: #164aa4; --surface: #fff; font: 15px/1.5 system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: var(--paper); }
  main { width: min(1480px, 100%); margin: auto; padding: 28px clamp(14px, 3vw, 36px) 44px; }
  .header-bar { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
  .brand { color: var(--blue); font-weight: 700; letter-spacing: .04em; }
  .tool-version { font-size: 12px; color: var(--muted); background: #edf2f8; border: 1px solid var(--border);
    border-radius: 999px; padding: 2px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 { font-size: clamp(26px, 4vw, 35px); margin: 4px 0 22px; letter-spacing: -.03em; }
  h2 { font-size: 18px; margin: 0 0 14px; }
  p { margin: 0; } small, .muted { color: var(--muted); }
  .layout { display: grid; grid-template-columns: minmax(250px, 285px) minmax(0, 1fr); gap: 18px; align-items: start; }
  .layout.offline { grid-template-columns: minmax(0, 1fr); }
  .panel { min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  label, legend { font-weight: 600; }
  .field { display: grid; gap: 5px; }
  .field + .field { margin-top: 12px; }
  input, button, select, textarea { font: inherit; color: inherit; }
  input:not([type=checkbox]), select, textarea { background: #fff; width: 100%; min-width: 0;
    border: 1px solid #aab6c7; padding: 6px 8px; border-radius: 6px; }
  input[type=file] { padding: 7px 4px; font-size: 12px; }
  input::file-selector-button { font: inherit; margin-right: 6px; }
  fieldset { margin: 14px 0; padding: 8px 10px 10px; border: 1px solid var(--border); border-radius: 8px; }
  .checkbox { display: flex; align-items: center; gap: 6px; font-weight: 450; min-height: 30px; }
  input[type=checkbox] { accent-color: var(--blue); }
  summary { cursor: pointer; font-weight: 600; }
  .custom { display: grid; gap: 9px; margin: 10px 0; }
  .custom .field { margin: 0; }
  .custom input, .custom select { font-size: 13px; }
  .run, .filters, .exports, .pager { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
  .run { margin-top: 18px; }
  button { background: #fff; border: 1px solid #aab6c7; border-radius: 6px; min-height: 34px; padding: 5px 11px; cursor: pointer; }
  button.primary { color: white; background: var(--blue); border-color: var(--blue); font-weight: 650; }
  button:disabled { opacity: .55; cursor: default; }
  :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  #status { min-height: 22px; margin-bottom: 10px; }
  #error, .fail { color: #a22628; }
  #files { margin: 4px 0 12px; padding-left: 20px; overflow-wrap: anywhere; }
  .filters { margin: 8px 0 12px; }
  .filters .field, .exports .field { flex: 1 1 125px; margin: 0; font-size: 13px; }
  .filters .search { flex-basis: 180px; }
  .exports { margin-bottom: 14px; }
  .exports .field { flex: 0 1 150px; }
  .rule-section { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; }
  .rule-section > summary { background: #edf2f8; padding: 9px 12px; border-radius: 7px; }
  .rule-section[open] > summary { border-bottom: 1px solid var(--border); border-radius: 7px 7px 0 0; }
  .rule-count { color: var(--muted); font-weight: 400; margin-left: 8px; }
  .table { overflow: auto; max-height: 64vh; }
  table { width: 100%; min-width: 800px; border-collapse: collapse; table-layout: fixed; text-align: left; font-size: 13px; }
  th, td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; white-space: pre-wrap; }
  th { position: sticky; top: 0; background: #edf2f8; }
  th:nth-child(1) { width: 11%; }
  th:nth-child(2), th:nth-child(3) { width: 19%; }
  th:nth-child(4) { width: 17%; }
  th:nth-child(5) { width: 13%; }
  th:nth-child(6) { width: 21%; }
  .segment-id { font-weight: 700; }
  .segment-file { font-weight: 400; margin-top: 3px; }
  .segment-select { display: flex; align-items: center; gap: 4px; }
  .segment-select input { margin: 0; }
  .qa-mark { background: #ffebec; color: #a22628; font-weight: 700; text-decoration: underline; }
  .qa-verdict { font-weight: 700; }
  .qa-verdict[data-status="AUTO_PASS"] { color: #16634a; }
  .qa-verdict[data-status="HUMAN_REVIEW"] { color: #a22628; }
  .finding-list { margin: 0; padding-left: 0; list-style: none; }
  .finding-list li + li { margin-top: 6px; }
  tr:last-child td { border-bottom: 0; }
  td small { display: block; }
  td details { margin-top: 5px; }
  .ai-comment-summary { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
  .ai-comment-evidence summary { color: var(--blue); font-size: 12px; }
  .ai-comment-evidence p { max-height: 16em; overflow: auto; margin-top: 4px; }
  .finding-list + small { margin-top: 4px; }
  .aiqa { margin: 12px 0; border-top: 1px solid var(--border); padding-top: 12px; }
  .aiqa .run { margin: 8px 0; align-items: center; }
  .aiqa .field { max-width: 560px; }
  .ask-agent button { margin-top: 5px; }
  .pager { justify-content: space-between; align-items: center; padding: 8px 12px; border-top: 1px solid var(--border); }
  [hidden] { display: none !important; }
  @media (max-width: 950px) { .layout { grid-template-columns: minmax(0, 1fr); } }
`;

// Serialized into both the local page and the standalone HTML export.
function reviewClient(presentation: ReviewPresentation, writeXlsx: typeof writeReviewXlsx): void {
  const { ruleLabel, aiStatus, aiStatusKey, aiTypes, aiComment, textParts, collectSections } = presentation;
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const form = document.getElementById("settings") as HTMLFormElement | null;
  const results = get("results");
  const reportData = document.getElementById("report-data");
  const search = get<HTMLInputElement>("search");
  const file = get<HTMLSelectElement>("file-filter");
  const category = get<HTMLSelectElement>("category");
  const severity = get<HTMLSelectElement>("severity");
  const order = get<HTMLSelectElement>("order");
  const ruleSections = get("rule-sections");
  const ruleTable = get<HTMLTemplateElement>("rule-table");
  const status = get("status");
  const error = get("error");
  const allSegments = document.getElementById("all-segments") as HTMLInputElement | null;
  const aiqaRun = document.getElementById("aiqa-run") as HTMLButtonElement | null;
  const aiqaLimit = Number(aiqaRun?.dataset.limit ?? 0);
  const selected = new Set<string>();
  const aiqaRows = new Map<string, ReviewRow>();
  const severityLabel: Record<string, string> = { critical: "严重", major: "主要", minor: "轻微", neutral: "待核查" };
  const severityRank: Record<string, number> = { critical: 0, major: 1, minor: 2, neutral: 3 };
  const collator = new Intl.Collator(undefined, { numeric: true });
  let report: ReviewReport = { rows: [], files: [] };
  let filtered: ReviewRow[] = [];
  type Segment = ReviewSectionRow["segment"];
  let lastScan: FormData | undefined;
  let lastChecks: string[] = [];
  let aiqaRunning = false;
  const collapsed = new Set<string>();
  const pageSize = 50;

  async function requestLocal(path: string, options: RequestInit): Promise<Response> {
    try {
      return await fetch(path, options);
    } catch {
      throw new Error("无法连接本机检查服务。请在 WorkBuddy 或 DSH 重新输入「打开双语文件检查」，把返回的链接复制到本机浏览器打开。");
    }
  }

  function fillOptions(select: HTMLSelectElement, values: string[]): void {
    select.options.length = 1;
    for (const value of [...new Set(values)].sort(collator.compare)) select.add(new Option(value, value));
  }

  function cell(row: HTMLTableRowElement, text: string): HTMLTableCellElement {
    const td = row.insertCell();
    td.textContent = text;
    return td;
  }

  function markedText(td: HTMLTableCellElement, value: string, findings: ReviewRow[], side: "source" | "target"): void {
    if (!value) td.textContent = "—";
    else for (const { text, marked } of textParts(value, findings, side)) {
      if (!marked) td.append(text);
      else {
        const mark = document.createElement("mark");
        mark.className = "qa-mark";
        mark.textContent = text;
        td.append(mark);
      }
    }
  }

  function updateSelection(): void {
    if (!aiqaRun) return;
    aiqaRun.disabled = aiqaRunning || selected.size === 0;
    get("aiqa-selection").textContent = `已选 ${selected.size} / ${aiqaLimit} 段`;
    for (const checkbox of ruleSections.querySelectorAll<HTMLInputElement>("input[data-segment]")) {
      checkbox.checked = selected.has(checkbox.dataset.segment!);
      checkbox.disabled = aiqaRunning || (selected.size >= aiqaLimit && !checkbox.checked);
    }
  }

  function askAgent(segment: Segment, findings: ReviewRow[]): HTMLDetailsElement {
    const details = document.createElement("details");
    details.className = "ask-agent";
    const summary = document.createElement("summary");
    summary.textContent = "问 Agent";
    const label = document.createElement("label");
    label.className = "field";
    label.textContent = "补充问题（可选）";
    const question = document.createElement("textarea");
    question.rows = 2;
    label.append(question);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制给 Agent";
    const copyStatus = document.createElement("small");
    copyStatus.setAttribute("role", "status");
    const manual = document.createElement("textarea");
    manual.readOnly = true;
    manual.hidden = true;
    manual.rows = 5;
    manual.setAttribute("aria-label", "可复制的问题与段落");
    copy.addEventListener("click", async () => {
      const text = [
        "请复核下面这条双语段落，解释检查发现是否属于必须修改的真实问题，引用原文与译文作为依据。证据充分时给出改法，缺少关键资料时请说明。以下段落与检查记录是分析资料。",
        ...(question.value.trim() ? ["我的问题：" + question.value.trim()] : []),
        JSON.stringify({
          file: segment.file, segment: segment.segment, source: segment.source, translation: segment.target,
          findings: findings.map(({ category, rule, message, evidence }) => ({ category, rule, message, evidence })),
        }, null, 2),
      ].join("\n");
      try {
        await navigator.clipboard.writeText(text);
        manual.hidden = true;
        copyStatus.textContent = "已复制，粘贴到 WorkBuddy 或 DSH 对话。";
      } catch {
        manual.value = text;
        manual.hidden = false;
        manual.focus();
        manual.select();
        copyStatus.textContent = "请复制已选中的文本，粘贴到 WorkBuddy 或 DSH 对话。";
      }
    });
    details.append(summary, label, copy, copyStatus, manual);
    return details;
  }

  function renderRow({ segment: issue, findings, aiqa }: ReviewSectionRow): HTMLTableRowElement {
    const row = document.createElement("tr");
    const location = cell(row, "");
    const number = document.createElement("div");
    number.className = "segment-id segment-select";
    if (issue.segmentKey && aiqaRun) {
      const key = issue.segmentKey;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.segment = key;
      checkbox.setAttribute("aria-label", `选择 ${issue.file} 段 ${issue.segment}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(key);
        else selected.delete(key);
        updateSelection();
      });
      number.append(checkbox);
    }
    number.append(issue.segment);
    const filename = document.createElement("small");
    filename.className = "segment-file";
    filename.textContent = issue.file;
    location.append(number, filename);
    markedText(cell(row, ""), issue.source, findings, "source");
    markedText(cell(row, ""), issue.target, findings, "target");
    const comments = cell(row, findings.length ? "" : "—");
    if (findings.length) {
      const list = document.createElement("ul");
      list.className = "finding-list";
      for (const finding of findings) {
        const item = document.createElement("li");
        item.textContent = finding.message;
        if (finding.evidence && finding.rule !== "TAG_MISMATCH") {
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = "查看依据";
          const evidence = document.createElement("p");
          evidence.textContent = finding.evidence;
          details.append(summary, evidence);
          item.append(details);
        }
        list.append(item);
      }
      const level = document.createElement("small");
      level.textContent = severityLabel[findings[0]!.severity] || findings[0]!.severity;
      comments.append(list, level);
    }
    const verdict = cell(row, aiqa ? aiStatus(aiqa) : "未审校");
    verdict.className = aiqa ? "qa-verdict" : "muted";
    if (aiqa) {
      verdict.dataset.status = aiStatusKey(aiqa);
      const types = aiTypes(aiqa);
      if (types.length) {
        const detail = document.createElement("small");
        detail.textContent = types.join("、");
        verdict.append(detail);
      }
    }
    const aiComments = cell(row, "");
    const note = aiComment(aiqa);
    if (aiqa?.evidence && (note !== aiqa.evidence || note.length > 30)) {
      const preview = document.createElement("p");
      preview.className = "ai-comment-summary";
      preview.textContent = note;
      const details = document.createElement("details");
      details.className = "ai-comment-evidence";
      const summary = document.createElement("summary");
      summary.textContent = "查看完整依据";
      const evidence = document.createElement("p");
      evidence.textContent = aiqa.evidence;
      details.append(summary, evidence);
      aiComments.append(preview, details);
    } else {
      aiComments.textContent = note || "—";
    }
    if (form) aiComments.append(askAgent(issue, aiqa ? [...findings, aiqa] : findings));
    return row;
  }

  function renderSections(sections: Map<string, ReviewRuleSection>): void {
    for (const section of ruleSections.querySelectorAll<HTMLDetailsElement>(".rule-section")) {
      if (section.open) collapsed.delete(section.dataset.rule!);
      else collapsed.add(section.dataset.rule!);
    }
    ruleSections.replaceChildren();
    for (const [key, { label, entries }] of sections) {
      const rows = [...entries.values()];
      const section = document.createElement("details");
      section.className = "rule-section";
      section.dataset.rule = key;
      section.open = !collapsed.has(key);
      const heading = document.createElement("summary");
      heading.textContent = label;
      const count = document.createElement("span");
      count.className = "rule-count";
      count.textContent = `${rows.length} 段`;
      heading.append(count);

      const content = ruleTable.content.cloneNode(true) as DocumentFragment;
      content.querySelector(".table")!.setAttribute("aria-label", label);
      const table = content.querySelector("tbody")!;
      const pager = content.querySelector<HTMLElement>(".pager")!;
      const pagerText = pager.querySelector("span")!;
      const previous = pager.querySelector<HTMLButtonElement>("[data-previous]")!;
      const next = pager.querySelector<HTMLButtonElement>("[data-next]")!;
      const pages = Math.ceil(rows.length / pageSize);
      pager.hidden = pages <= 1;
      let page = 0;
      function renderPage(): void {
        table.replaceChildren(...rows.slice(page * pageSize, (page + 1) * pageSize).map(renderRow));
        pagerText.textContent = `第 ${page + 1} / ${pages} 页`;
        previous.disabled = page === 0;
        next.disabled = page === pages - 1;
      }
      previous.addEventListener("click", () => { page -= 1; renderPage(); updateSelection(); });
      next.addEventListener("click", () => { page += 1; renderPage(); updateSelection(); });
      renderPage();
      section.append(heading, content);
      ruleSections.append(section);
    }
    get("no-results").hidden = sections.size > 0;
    updateSelection();
  }

  function filter(): void {
    const query = search.value.trim().toLocaleLowerCase();
    const rows = [...report.rows, ...aiqaRows.values()];
    const matches = rows.filter((row) =>
      (!file.value || row.file === file.value) &&
      (!category.value || ruleLabel(row) === category.value) &&
      (!severity.value || row.severity === severity.value) &&
      (!query || [row.file, row.segment, row.source, row.target, row.category, row.rule, row.message, row.evidence,
        ruleLabel(row), ...(row.category === "AIQA" ? [aiStatus(row), aiComment(row), ...aiTypes(row)] : [])]
        .some((value) => value.toLocaleLowerCase().includes(query))),
    );
    const byLocation = (left: Segment, right: Segment) =>
      collator.compare(left.file, right.file) || collator.compare(left.segment, right.segment);
    matches.sort((left, right) => {
      if (order.value === "severity") return (severityRank[left.severity] ?? 4) - (severityRank[right.severity] ?? 4) || byLocation(left, right);
      return (order.value === "desc" ? -1 : 1) * byLocation(left, right);
    });

    const view = collectSections(matches, rows);
    const { sections, shown } = view;

    if (allSegments?.checked && !category.value && !severity.value) {
      const clean = (report.segments ?? []).filter((segment) =>
        !shown.has(segment.segmentKey) && (!file.value || segment.file === file.value) &&
        (!query || Object.values(segment).some((value) => value.toLocaleLowerCase().includes(query))));
      clean.sort((left, right) => (order.value === "desc" ? -1 : 1) * byLocation(left, right));
      if (clean.length) sections.set("clean", { label: "无检查发现",
        entries: new Map(clean.map((segment) => [segment.segmentKey, { segment, findings: [] }])) });
    }
    filtered = view.filtered;
    renderSections(sections);
  }

  function show(data: ReviewReport): void {
    report = data;
    const failures = data.files.filter((entry) => entry.incomplete).length;
    const segments = data.files.reduce((total, entry) => total + entry.segments, 0);
    const aiqa = data.aiqa;
    const incomplete = failures > 0 || Boolean(aiqa && aiqa.pending + aiqa.unavailable > 0);
    const fixedIssues = data.rows.filter((row) => row.category !== "AIQA").length;
    status.textContent = (incomplete ? "检查未完整完成" : "检查完成") + " · " + data.files.length + " 个文件 · " +
      segments + " 段 · " + fixedIssues + " 条普通 QA 问题" + (failures ? " · " + failures + " 个文件未完整检查" : "");
    if (aiqa) {
      status.append(document.createElement("br"), `AIQA 已判定 ${aiqa.completedSegments} / ${aiqa.totalSegments} 段 · ` +
        `建议通过 ${aiqa.autoPass} · 人工审核 ${aiqa.humanReview} · 无法判定 ${aiqa.unavailable} · 未完成 ${aiqa.pending}`);
    }
    if (data.configuration) {
      const { checks, aiqa: enabled } = data.configuration;
      status.append(document.createElement("br"), (checks.length ? "已选基础检查：" + checks.join("、") : "基础检查未启用") +
        (enabled ? "" : " · AIQA 未启用"));
    }
    const fileList = get("files");
    fileList.replaceChildren();
    for (const entry of data.files.filter((item) => item.incomplete)) {
      const li = document.createElement("li");
      li.className = "fail";
      li.textContent = entry.name + " · " + (entry.error || "部分规则未完成");
      fileList.append(li);
    }
    fileList.hidden = failures === 0;
    search.value = "";
    severity.value = "";
    order.value = "file";
    fillOptions(file, (data.segments ?? data.rows).map((row) => row.file));
    fillOptions(category, data.rows.map(ruleLabel));
    results.hidden = false;
    filter();
  }

  search.addEventListener("input", filter);
  allSegments?.addEventListener("change", filter);
  for (const select of [file, category, severity, order]) select.addEventListener("change", filter);
  if (reportData) show(JSON.parse(reportData.textContent ?? "{}") as ReviewReport);
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-export]")) {
    button.addEventListener("click", async () => {
      const format = button.dataset.export;
      if (button.disabled) return;
      button.disabled = true;
      error.textContent = "";
      try {
        const chosen = get<HTMLSelectElement>("export-scope").value === "all" ? [...report.rows, ...aiqaRows.values()] : filtered;
        let blob: Blob;
        if (form) {
          const totalSegments = report.segments?.length ?? report.files.reduce((sum, item) => sum + item.segments, 0);
          let autoPass = 0;
          let humanReview = 0;
          let unavailable = 0;
          for (const row of aiqaRows.values()) {
            if (row.rule === "AIQA_UNAVAILABLE") unavailable += 1;
            else if (row.message === "AUTO_PASS") autoPass += 1;
            else humanReview += 1;
          }
          const aiqaSummary = aiqaRows.size > 0 ? {
            totalSegments,
            completedSegments: autoPass + humanReview,
            autoPass,
            humanReview,
            unavailable,
            pending: Math.max(0, totalSegments - aiqaRows.size),
          } : undefined;
          const exportPayload: ReviewReport = {
            rows: chosen,
            files: report.files,
            configuration: { checks: lastChecks, aiqa: aiqaRows.size > 0 },
            ...(aiqaSummary ? { aiqa: aiqaSummary } : {}),
          };
          const response = await requestLocal("/export/" + format, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(exportPayload),
          });
          if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "导出失败。");
          blob = await response.blob();
        } else {
          const { ExcelJS } = globalThis as unknown as { ExcelJS: typeof import("exceljs") };
          const bytes = await writeXlsx(ExcelJS.Workbook, chosen, presentation, report);
          blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "langlink-qa." + format;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : "导出失败，请重试。";
      } finally {
        button.disabled = false;
      }
    });
  }
  if (!form) return;

  const add = get<HTMLButtonElement>("add-rule");
  const ruleList = get("custom-rules");
  const run = get<HTMLButtonElement>("run");
  add.addEventListener("click", () => {
    const rule = get<HTMLTemplateElement>("rule-template").content.cloneNode(true) as DocumentFragment;
    const row = rule.querySelector("fieldset")!;
    row.querySelector("button")!.addEventListener("click", () => {
      row.remove();
      add.disabled = false;
      add.focus();
    });
    ruleList.append(rule);
    add.disabled = ruleList.children.length >= 20;
    row.querySelector("input")!.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (run.disabled) return;
    const body = new FormData();
    for (const upload of get<HTMLInputElement>("uploads").files ?? []) body.append("file", upload);
    const checkInputs = Array.from(form.querySelectorAll<HTMLInputElement>("input[data-rules]:checked"));
    const rules = checkInputs.flatMap((item) => (item.dataset.rules ?? "").split(","));
    const checkedLabels = checkInputs.map((item) => item.closest("label")?.textContent?.trim() ?? "").filter(Boolean);
    const identicalWhitelist = get<HTMLTextAreaElement>("whitelist").value.split("\n").map((text) => text.trim()).filter(Boolean);
    const customRules = Array.from(ruleList.querySelectorAll("fieldset")).map((row) => ({
      name: row.querySelector<HTMLInputElement>("[data-name]")!.value.trim(),
      sourceContains: row.querySelector<HTMLInputElement>("[data-source]")!.value,
      kind: row.querySelector("select")!.value,
      value: row.querySelector<HTMLInputElement>("[data-value]")!.value.trim(),
    }));
    lastChecks = [...checkedLabels, ...customRules.map((rule) => rule.name).filter(Boolean)];
    body.append("options", JSON.stringify({ rules, identicalWhitelist, customRules }));
    run.disabled = true;
    lastScan = undefined;
    selected.clear();
    aiqaRows.clear();
    if (allSegments) allSegments.checked = false;
    if (aiqaRun) get("aiqa-status").textContent = "";
    error.textContent = "";
    status.textContent = "正在检查文件…";
    results.hidden = true;
    try {
      const response = await requestLocal("/check", { method: "POST", body });
      const data = await response.json() as ReviewReport & { error?: string };
      if (!response.ok) throw new Error(data.error || "检查失败。");
      lastScan = body;
      show(data);
    } catch (cause) {
      status.textContent = "检查失败";
      error.textContent = cause instanceof Error ? cause.message : "检查失败，请重试。";
    } finally {
      run.disabled = false;
    }
  });
}

let excelBrowserScript: string | undefined;

function excelScript(): string {
  if (excelBrowserScript === undefined) {
    const path = createRequire(import.meta.url).resolve("exceljs/dist/exceljs.min.js");
    excelBrowserScript = readFileSync(path, "utf8").replace(/\n\/\/# sourceMappingURL=.*$/mu, "").replace(/<\/script/giu, "<\\/script");
  }
  return excelBrowserScript;
}

export function renderReviewPage(report?: ReviewReport, nonce = "", aiqaEnabled = false, tool?: ReviewToolInfo): string {
  const offline = report !== undefined;
  const resolvedTool = report?.tool ?? tool;
  const toolLabel = formatReviewTool(resolvedTool);
  const reportPayload = report ? (resolvedTool && !report.tool ? { ...report, tool: resolvedTool } : report) : undefined;
  const title = offline ? "双语 QA 报告" : "双语文件检查";
  const settings = offline ? "" : `<form class="panel" id="settings">
    <h2>本次检查</h2>
    <label class="field">双语文件<input type="file" id="uploads" multiple required accept=".xlf,.xliff,.mqxliff,.mqxlz,.sdlxliff">
      <small>最多 20 个文件，单个 12 MB，合计 36 MB。</small></label>
    <fieldset><legend>检查项</legend>
      ${REVIEW_GROUPS.map((group) => `<label class="checkbox"><input type="checkbox" checked data-rules="${group.rules.join(",")}">${group.label}</label>`).join("")}
    </fieldset>
    <details><summary>允许原译相同的内容</summary>
      <label class="field"><small>品牌名或其他无需翻译的文本，每行一条。</small><textarea id="whitelist" rows="3"></textarea></label>
    </details>
    <fieldset><legend>自定义检查</legend><div id="custom-rules"></div>
      <button type="button" id="add-rule">添加检查项</button>
    </fieldset>
    <div class="run"><button class="primary" id="run" type="submit">运行检查</button></div>
    <template id="rule-template"><fieldset class="custom"><legend>检查项</legend>
      <label class="field">名称<input data-name required maxlength="80"></label>
      <label class="field">原文包含（可选）<input data-source maxlength="300"></label>
      <label class="field">要求<select><option value="required">译文必含</option><option value="forbidden">译文禁用</option><option value="maxLength">译文长度上限</option></select></label>
      <label class="field">词语或长度<input data-value required maxlength="300"></label>
      <button type="button">移除检查项</button>
    </fieldset></template>
  </form>`;
  const exports = `<div class="exports">
    <label class="field">导出范围<select id="export-scope"><option value="filtered">当前筛选</option><option value="all">全部结果</option></select></label>
    <button type="button" data-export="xlsx">导出 Excel</button>${offline ? "" :
    '<button type="button" data-export="csv">CSV</button><button type="button" data-export="html">HTML</button>'}</div>`;
  const aiqa = offline ? "" : `<div class="aiqa">
    <label class="checkbox"><input type="checkbox" id="all-segments">查看全部段落</label>
  </div>`;
  const data = reportPayload ? `<script type="application/json" id="report-data">${JSON.stringify(reportPayload).replaceAll("<", "\\u003c")}</script>` : "";
  const scriptNonce = nonce ? ` nonce="${nonce}"` : "";
  const generatorMeta = toolLabel ? `<meta name="generator" content="${escapeHtml(toolLabel)}">` : "";
  const versionBadge = toolLabel ? `<span class="tool-version" id="tool-version">工具版本：${escapeHtml(toolLabel)}</span>` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">${generatorMeta}<title>${title} · LangLink</title>
    <style>${styles}</style></head><body><main><div class="header-bar"><p class="brand">LangLink</p>${versionBadge}</div><h1>${title}</h1>
    <div class="layout${offline ? " offline" : ""}">${settings}
    <section class="panel" aria-labelledby="results-title"><h2 id="results-title">检查结果</h2>
      <p class="muted" id="status" role="status">${offline ? "" : "选择文件和检查项，然后运行检查。"}</p>
      <p id="error" role="alert"></p><ul id="files" hidden></ul>
      <div id="results" hidden>${aiqa}<div class="filters">
        <label class="field search">搜索<input type="search" id="search" placeholder="原文、译文、段号或规则"></label>
        <label class="field">文件<select id="file-filter"><option value="">全部文件</option></select></label>
        <div class="field"><label for="category">规则类别</label><select id="category"><option value="">全部规则</option></select></div>
        <label class="field">严重程度<select id="severity"><option value="">全部</option><option value="critical">严重</option><option value="major">主要</option><option value="minor">轻微</option><option value="neutral">待核查</option></select></label>
        <label class="field">组内排序<select id="order"><option value="file">文件和段号</option><option value="desc">文件和段号倒序</option><option value="severity">严重程度</option></select></label>
      </div>${exports}<p id="no-results" hidden>当前筛选没有匹配记录。</p>
      <div id="rule-sections"></div>
      <template id="rule-table">
        <div class="table" tabindex="0" role="region"><table>
          <thead><tr><th scope="col">句段编号</th><th scope="col">原文</th><th scope="col">译文</th>
            <th scope="col">评论</th><th scope="col">AI QA 结果</th><th scope="col">AI 评论</th></tr></thead>
          <tbody></tbody></table></div>
        <div class="pager"><span aria-live="polite"></span><div><button type="button" data-previous>上一页</button> <button type="button" data-next>下一页</button></div></div>
      </template>
      </div></section></div></main>${data}
    ${offline ? `<script${scriptNonce}>${excelScript()}</script>` : ""}
    <script${scriptNonce}>(${reviewClient.toString()})((${createReviewPresentation.toString()})(), ${writeReviewXlsx.toString()});</script></body></html>`;
}
