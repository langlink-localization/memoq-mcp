import type { ReviewToolInfo } from "@langlink/l10n-core/qa-review";

export interface RenderReviewWorkbenchOptions {
  nonce: string;
  reviewToken: string;
  initialDocumentName?: string;
  tool?: ReviewToolInfo;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderReviewWorkbenchHtml(options: RenderReviewWorkbenchOptions): string {
  const toolInfo = options.tool?.name && options.tool?.version ? options.tool : undefined;
  const toolLabel = toolInfo ? `${toolInfo.name}@${toolInfo.version}` : "";
  const toolShort = toolInfo ? `v${toolInfo.version}` : "";
  const generatorMeta = toolLabel
    ? `\n  <meta name="generator" content="${escapeHtmlAttr(toolLabel)}" />`
    : "";
  const bootJson = JSON.stringify({
    reviewToken: options.reviewToken,
    initialDocumentName: options.initialDocumentName ?? "",
    tool: toolInfo ?? null,
  }).replace(/</gu, "\\u003c");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />${generatorMeta}
  <title>LangLink memoQ CAT 双语审校与 QA 工作台</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f6f9;
      --panel: #ffffff;
      --subtle: #f8fafc;
      --grid-head: #edf2f8;
      --row-hover: #f8fafc;
      --row-active: #eef4fc;
      --text: #192438;
      --muted: #4b5a6f;
      --faint: #64748b;
      --border: #d9e0ea;
      --border-soft: #e6ebf2;
      --input-border: #aab6c7;
      --accent: #164aa4;
      --accent-solid: #164aa4;
      --accent-soft: #e6eefb;
      --ok: #16634a;
      --ok-soft: #dcfce7;
      --warn: #b45309;
      --warn-soft: #fef3c7;
      --err: #a22628;
      --err-soft: #ffebec;
      --rev: #6d28d9;
      --rev-soft: #ede9fe;
      --tag-bg: #e0f2fe;
      --tag-fg: #0369a1;
      --tag-border: #bae6fd;
      --mark-bg: #ffebec;
      --mark-fg: #a22628;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1120;
        --panel: #111827;
        --subtle: #0f172a;
        --grid-head: #1e293b;
        --row-hover: #172033;
        --row-active: #172554;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --faint: #64748b;
        --border: #334155;
        --border-soft: #1e293b;
        --input-border: #475569;
        --accent: #60a5fa;
        --accent-solid: #2563eb;
        --accent-soft: #1e3a8a;
        --ok: #4ade80;
        --ok-soft: #14532d;
        --warn: #fbbf24;
        --warn-soft: #451a03;
        --err: #f87171;
        --err-soft: #450a0a;
        --rev: #c4b5fd;
        --rev-soft: #2e1065;
        --tag-bg: #0c4a6e;
        --tag-fg: #7dd3fc;
        --tag-border: #0369a1;
        --mark-bg: #7f1d1d;
        --mark-fg: #fecaca;
      }
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 "Segoe UI", -apple-system, BlinkMacSystemFont, "Microsoft YaHei UI", system-ui, sans-serif;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .hidden, [hidden] { display: none !important; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
    small, .qa-muted { color: var(--muted); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Top CAT Ribbon */
    .cat-ribbon {
      flex-shrink: 0;
      min-height: 46px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 6px 12px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .ribbon-left, .ribbon-right {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .brand-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: -0.01em;
    }
    .brand-badge {
      background: var(--accent-solid);
      color: #ffffff;
      border-radius: 5px;
      padding: 2px 6px;
      font-size: 11px;
      font-weight: 700;
    }
    .doc-title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      max-width: 240px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .doc-select {
      max-width: 280px;
      height: 28px;
      padding: 2px 8px;
      border: 1px solid var(--input-border);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      font-size: 12px;
    }

    /* Sub-toolbar */
    .cat-subbar {
      flex-shrink: 0;
      min-height: 38px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 4px 12px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .tabs { display: flex; gap: 4px; align-items: center; }
    .tab-btn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      padding: 4px 10px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .tab-btn.active {
      background: var(--accent-soft);
      color: var(--accent);
      border-color: var(--accent);
    }
    .v-sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
    .filter-pills { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .filter-pill {
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--subtle);
      color: var(--text);
      cursor: pointer;
    }
    .filter-pill.active {
      background: var(--accent-solid);
      color: #ffffff;
      border-color: var(--accent-solid);
    }
    .search-wrap { display: flex; align-items: center; gap: 8px; }
    .kbd-hint { font-size: 11px; color: var(--faint); white-space: nowrap; }

    /* Buttons & Inputs */
    button {
      cursor: pointer;
      border-radius: 6px;
      border: 1px solid var(--input-border);
      background: var(--panel);
      color: var(--text);
      padding: 4px 10px;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--accent-solid); color: #ffffff; border-color: var(--accent-solid); }
    button.success { background: #16634a; color: #ffffff; border-color: #16634a; }
    button.warn { background: #b45309; color: #ffffff; border-color: #b45309; }
    button.sm { padding: 3px 7px; font-size: 11px; }
    button.active-toggle { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    input[type="text"], input[type="search"], textarea, select {
      border: 1px solid var(--input-border);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      padding: 5px 8px;
      font: inherit;
      font-size: 12px;
    }
    input[type="checkbox"], input[type="radio"] { accent-color: var(--accent-solid); }

    /* Pills & Banners */
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--border);
      background: var(--subtle);
      white-space: nowrap;
    }
    .pill.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
    .pill.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
    .pill.err { color: var(--err); background: var(--err-soft); border-color: transparent; }
    .pill.rev { color: var(--rev); background: var(--rev-soft); border-color: transparent; }
    .pill.info { color: var(--accent); background: var(--accent-soft); border-color: transparent; }

    .banner {
      flex-shrink: 0;
      padding: 6px 14px;
      font-size: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .banner.ok { background: var(--ok-soft); color: var(--ok); }
    .banner.warn { background: var(--warn-soft); color: var(--warn); }
    .banner.err { background: var(--err-soft); color: var(--err); }
    .banner.rev { background: var(--rev-soft); color: var(--rev); }

    /* Main Split CAT Workspace */
    .cat-workspace {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 336px;
      background: var(--bg);
    }
    .cat-workspace.inspector-collapsed,
    .cat-workspace.qa-mode {
      grid-template-columns: minmax(0, 1fr);
    }
    .cat-workspace.qa-mode .cat-inspector {
      display: none;
    }
    .cat-main {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--panel);
      overflow: hidden;
    }
    .cat-workspace.qa-mode .cat-main {
      background: var(--bg);
    }
    .cat-grid-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      scrollbar-gutter: stable;
    }

    /* Classic 4-column CAT Bilingual Grid */
    .cat-grid-head, .cat-row {
      display: grid;
      grid-template-columns: 60px minmax(0, 1fr) minmax(0, 1fr) 128px;
      align-items: stretch;
    }
    .cat-grid-head {
      position: sticky;
      top: 0;
      z-index: 3;
      background: var(--grid-head);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .cat-grid-head > div { padding: 7px 10px; }
    .cat-grid-head > div:nth-child(3),
    .cat-grid-head > div:nth-child(4) { border-left: 1px solid var(--border-soft); }
    .cat-row {
      border-bottom: 1px solid var(--border-soft);
      background: var(--panel);
      transition: background 120ms ease;
    }
    .cat-row:hover { background: var(--row-hover); }
    .cat-row.active-row { background: var(--row-active); }
    .cat-rail {
      padding: 9px 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      border-left: 3px solid transparent;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      user-select: none;
    }
    .cat-row.st-approved .cat-rail { border-left-color: var(--ok); }
    .cat-row.st-draft .cat-rail { border-left-color: var(--warn); }
    .cat-row.st-needs_revision .cat-rail { border-left-color: var(--rev); }
    .cat-row.st-memoq .cat-rail { border-left-color: var(--border); }
    .cat-row.st-missed .cat-rail { border-left-color: var(--err); }
    .cat-row.st-missed { background: color-mix(in srgb, var(--err-soft) 35%, var(--panel)); }
    .cat-row.active-row .cat-rail { border-left-color: var(--accent-solid); }
    .missed-reason-line { font-size: 11px; color: var(--err); font-weight: 600; }

    .doc-chip {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--accent-soft);
      color: var(--accent);
      max-width: 50px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cat-source {
      min-width: 0;
      padding: 9px 12px;
      border-left: 1px solid var(--border-soft);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .src-text {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.65;
      color: var(--text);
    }
    .cat-tag {
      display: inline-block;
      margin: 0 1px;
      padding: 0 4px;
      border-radius: 3px;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11px;
      line-height: 1.4;
      background: var(--tag-bg);
      color: var(--tag-fg);
      border: 1px solid var(--tag-border);
      vertical-align: baseline;
    }
    .cat-target {
      min-width: 0;
      padding: 7px 10px;
      border-left: 1px solid var(--border-soft);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .tgt-edit {
      width: 100%;
      min-height: 44px;
      padding: 5px 7px;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--text);
      font: 13px/1.65 "Segoe UI", -apple-system, BlinkMacSystemFont, "Microsoft YaHei UI", sans-serif;
      resize: vertical;
      outline: none;
    }
    .cat-row:hover .tgt-edit { border-color: var(--border-soft); background: var(--panel); }
    .tgt-edit:focus {
      border-color: var(--accent-solid);
      background: var(--panel);
      box-shadow: 0 0 0 2px var(--accent-soft);
    }
    .memoq-ref-line {
      font-size: 11px;
      color: var(--muted);
      padding: 3px 6px;
      border-left: 2px solid var(--border);
      background: var(--subtle);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .cmt-chip {
      font-size: 11px;
      color: var(--rev);
      background: var(--rev-soft);
      padding: 2px 7px;
      border-radius: 4px;
      width: fit-content;
      max-width: 100%;
      word-break: break-word;
    }
    .dirty-tag { display: inline-block; font-size: 10px; color: var(--warn); font-weight: 600; }
    .cat-status {
      padding: 8px 8px;
      border-left: 1px solid var(--border-soft);
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 5px;
    }
    .row-mini-btns { display: flex; flex-wrap: wrap; gap: 4px; }
    .badge-list { display: flex; flex-wrap: wrap; gap: 4px; }

    /* Docked CAT Inspector */
    .cat-inspector {
      min-width: 0;
      min-height: 0;
      border-left: 1px solid var(--border);
      background: var(--panel);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      padding: 12px;
      gap: 12px;
    }
    .cat-workspace.inspector-collapsed .cat-inspector { display: none; }
    .insp-section {
      border: 1px solid var(--border-soft);
      border-radius: 7px;
      padding: 9px 10px;
      background: var(--subtle);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .insp-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.02em;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .insp-ref-text { font-size: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
    .qa-issue-card {
      border: 1px solid var(--border-soft);
      border-radius: 6px;
      padding: 7px 8px;
      background: var(--panel);
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    /* Aligned Agent QA Workspace */
    .qa-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      scrollbar-gutter: stable;
      background: var(--bg);
    }
    .qa-page-wrap {
      width: min(1480px, 100%);
      margin: 0 auto;
      padding: 18px clamp(14px, 2.5vw, 28px) 32px;
    }
    .qa-layout {
      display: grid;
      grid-template-columns: minmax(260px, 305px) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .qa-card {
      min-width: 0;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
    }
    .qa-card h2 { font-size: 18px; margin: 0 0 14px; font-weight: 700; }
    .qa-field { display: grid; gap: 5px; font-weight: 600; font-size: 13px; }
    .qa-field + .qa-field { margin-top: 10px; }
    .qa-field small { font-weight: 400; font-size: 12px; }
    .qa-card input[type="text"],
    .qa-card input[type="search"],
    .qa-card select,
    .qa-card textarea {
      width: 100%;
      min-width: 0;
      font-size: 13px;
    }
    .qa-fieldset {
      margin: 14px 0;
      padding: 8px 10px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .qa-fieldset legend { font-weight: 600; font-size: 13px; padding: 0 4px; }
    .qa-checkbox, .qa-radio {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 450;
      font-size: 13px;
      min-height: 28px;
      cursor: pointer;
    }
    .qa-details { margin: 8px 0; }
    .qa-details > summary { cursor: pointer; font-weight: 600; font-size: 13px; }
    .qa-fine-rule {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 12px;
      padding: 3px 0;
      cursor: pointer;
    }
    .qa-doc-note {
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
      background: var(--subtle);
      border-radius: 6px;
      padding: 5px 8px;
    }
    .qa-custom {
      display: grid;
      gap: 8px;
      margin: 10px 0;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .qa-custom legend { font-weight: 600; font-size: 12px; padding: 0 4px; }
    .qa-run { margin-top: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .qa-card button { min-height: 32px; font-size: 13px; font-weight: 500; }
    .qa-card button.primary { font-weight: 650; }
    .qa-card button.sm { min-height: 24px; padding: 2px 7px; font-size: 11px; }
    #qaStatusLine { min-height: 22px; margin: 0 0 8px; font-size: 14px; }
    .qa-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border-soft);
    }
    .qa-aiqa { margin: 12px 0; border-top: 1px solid var(--border); padding-top: 12px; }
    .qa-aiqa .qa-field { max-width: 560px; }
    .qa-filters, .qa-exports, .qa-pager { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
    .qa-filters { margin: 10px 0 12px; }
    .qa-filters .qa-field, .qa-exports .qa-field { flex: 1 1 125px; margin: 0; font-size: 13px; }
    .qa-filters .qa-search-field { flex-basis: 185px; }
    .qa-exports { margin-bottom: 14px; }
    .qa-exports .qa-field { flex: 0 1 150px; }
    .rule-section { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; background: var(--panel); }
    .rule-section > summary {
      background: var(--grid-head);
      padding: 9px 12px;
      border-radius: 7px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
    }
    .rule-section[open] > summary { border-bottom: 1px solid var(--border); border-radius: 7px 7px 0 0; }
    .rule-count { color: var(--muted); font-weight: 400; margin-left: 8px; }
    .qa-table-wrap { overflow: auto; max-height: 64vh; }
    .qa-report-table {
      width: 100%;
      min-width: 800px;
      border-collapse: collapse;
      table-layout: fixed;
      text-align: left;
      font-size: 13px;
    }
    .qa-report-table th, .qa-report-table td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .qa-report-table th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--grid-head);
      font-weight: 700;
      font-size: 12px;
      color: var(--text);
    }
    .qa-report-table th:nth-child(1) { width: 13%; }
    .qa-report-table th:nth-child(2),
    .qa-report-table th:nth-child(3) { width: 19%; }
    .qa-report-table th:nth-child(4) { width: 17%; }
    .qa-report-table th:nth-child(5) { width: 12%; }
    .qa-report-table th:nth-child(6) { width: 20%; }
    .qa-report-table tr:last-child td { border-bottom: 0; }
    .qa-report-table td small { display: block; margin-top: 2px; }
    .qa-report-table td details { margin-top: 5px; }
    .qa-report-table td summary { cursor: pointer; font-weight: 600; font-size: 12px; }
    .segment-id { font-weight: 700; }
    .segment-file { font-weight: 400; margin-top: 3px; color: var(--muted); }
    .segment-select { display: flex; align-items: center; gap: 4px; }
    .segment-select input { margin: 0; }
    .segment-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    .qa-mark {
      background: var(--mark-bg);
      color: var(--mark-fg);
      font-weight: 700;
      text-decoration: underline;
      padding: 0 1px;
      border-radius: 2px;
    }
    .qa-verdict { font-weight: 700; }
    .qa-verdict[data-status="AUTO_PASS"] { color: var(--ok); }
    .qa-verdict[data-status="HUMAN_REVIEW"] { color: var(--err); }
    .finding-list { margin: 0; padding-left: 0; list-style: none; }
    .finding-list li + li { margin-top: 6px; }
    .finding-list + small { margin-top: 4px; }
    .ai-comment-summary {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      margin: 0;
    }
    .ai-comment-evidence summary { color: var(--accent); font-size: 12px; }
    .ai-comment-evidence p { max-height: 16em; overflow: auto; margin: 4px 0 0; }
    .ask-agent button { margin-top: 5px; }
    .ask-agent textarea { width: 100%; margin-top: 4px; font-size: 12px; }
    .qa-pager {
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
    }

    /* Bottom CAT Status Bar */
    .cat-statusbar {
      flex-shrink: 0;
      min-height: 30px;
      background: var(--panel);
      border-top: 1px solid var(--border);
      padding: 4px 12px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 11px;
      color: var(--muted);
    }
    .status-group { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .progress-track {
      width: 110px;
      height: 6px;
      border-radius: 999px;
      background: var(--border-soft);
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
    }
    .progress-fill { height: 100%; width: 0%; background: var(--ok); transition: width 200ms ease; }
    .empty-state { padding: 36px 20px; text-align: center; color: var(--muted); font-size: 13px; }
    @media (max-width: 1024px) {
      .cat-workspace { grid-template-columns: minmax(0, 1fr); }
      .cat-inspector { display: none; }
      .kbd-hint { display: none; }
      .qa-layout { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <header class="cat-ribbon">
    <div class="ribbon-left">
      <span class="brand-chip"><span class="brand-badge">CAT</span><span id="docTitle" class="doc-title">LangLink memoQ 工作台</span></span>
      <span id="toolVersionBadge" class="pill mono${toolShort ? "" : " hidden"}" title="${escapeHtmlAttr(toolLabel)}">${escapeHtmlAttr(toolShort)}</span>
      <select id="docSelector" class="doc-select" aria-label="文档切换"></select>
      <span id="langPair" class="pill">- → -</span>
      <span id="previewBadge" class="pill">Preview: 检测中</span>
      <span id="docIdLine" class="mono" style="color:var(--faint);"></span>
    </div>
    <div class="ribbon-right">
      <button id="btnApproveAll" class="success" type="button">一键放行全部定稿到 memoQ</button>
      <button id="btnRevokeAll" type="button">撤回全部为草稿</button>
      <button id="btnRunQa" class="primary" type="button">运行 QA 检查</button>
      <button id="btnToggleQaCfg" type="button">QA 设置</button>
      <button id="btnToggleInspector" class="active-toggle" type="button">详情面板</button>
      <label style="font-size:11px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
        <input id="chkAutoPoll" type="checkbox" checked /> 自动同步 (3s)
      </label>
      <button id="btnRefresh" type="button">刷新</button>
    </div>
  </header>

  <nav class="cat-subbar">
    <div class="ribbon-left">
      <div class="tabs">
        <button id="tabBtnReview" class="tab-btn active" type="button">双语网格</button>
        <button id="tabBtnQa" class="tab-btn" type="button">双语 QA 检查</button>
      </div>
      <span id="reviewToolbarSep" class="v-sep"></span>
      <div class="filter-pills" id="filterPills">
        <button class="filter-pill active" data-filter="all" type="button">全部</button>
        <button class="filter-pill" data-filter="missed_mt" id="pillFilterMissed" type="button">Pre-translate 漏翻</button>
        <button class="filter-pill" data-filter="untranslated" id="pillFilterUntranslated" type="button">未译/未覆盖</button>
        <button class="filter-pill" data-filter="draft" type="button">待审草稿</button>
        <button class="filter-pill" data-filter="needs_revision" type="button">需修订</button>
        <button class="filter-pill" data-filter="approved" type="button">已放行</button>
        <button class="filter-pill" data-filter="qa_issue" type="button">有 QA 问题</button>
        <button class="filter-pill" data-filter="diff" type="button">与 memoQ 不同</button>
        <button class="filter-pill" data-filter="comment" type="button">有批注</button>
      </div>
    </div>
    <div id="reviewSearchWrap" class="search-wrap">
      <span class="kbd-hint">Ctrl+Enter 放行并下一句 · Ctrl+S 保存 · Alt+↑↓ 切换</span>
      <input id="searchBox" type="text" style="width:220px;" placeholder="搜索原文 / 译文 / 批注..." />
    </div>
  </nav>

  <div id="statusBanner" class="banner hidden"></div>
  <div id="missedBanner" class="banner err hidden">
    <span>⚠ memoQ Pre-translate 有 <strong id="missedCount">0</strong> 条句段未命中（memoQ 弹窗告警原因）：<span id="missedPreview" class="mono"></span></span>
    <span style="display:flex;gap:6px;flex-wrap:wrap;">
      <button id="btnFilterMissed" class="sm primary" type="button">查看漏翻句段</button>
      <button id="btnCopyMissedPrompt" class="sm" type="button">复制补翻指令给 Agent</button>
      <button id="btnClearMissed" class="sm" type="button">清除告警</button>
    </span>
  </div>
  <div id="uncoveredBanner" class="banner warn hidden">
    <span>当前文档在 memoQ Preview 中仍有 <strong id="uncoveredCount">0</strong> 条未翻译且未暂存的句段，直接 Pre-translate 将漏翻或告警。</span>
    <button id="btnFilterUntranslated" class="sm primary" type="button">查看未译句段</button>
  </div>
  <div id="revBanner" class="banner rev hidden">
    <span>当前有 <strong id="revCount">0</strong> 条句段标记为「需 Agent 修改」。可直接复制指令发送给对话里的 Agent：</span>
    <button id="btnCopyPrompt" class="sm primary" type="button">复制给 Agent 的修订指令</button>
  </div>

  <main id="catWorkspace" class="cat-workspace">
    <section class="cat-main">
      <div id="panelReview" class="cat-grid-scroll">
        <div class="cat-grid-head">
          <div>#</div>
          <div>原文 (Source)</div>
          <div>译文 (Target)</div>
          <div>状态 / 操作</div>
        </div>
        <div id="segmentList"></div>
      </div>

      <div id="panelQa" class="qa-scroll hidden">
        <div class="qa-page-wrap">
          <div class="qa-layout">
            <form class="qa-card" id="qaSettingsForm">
              <h2>本次检查</h2>
              <fieldset class="qa-fieldset">
                <legend>检查对象</legend>
                <label class="qa-radio"><input type="radio" name="qaScope" value="merged" checked /> 合并视图（暂存优先，空缺补 memoQ）</label>
                <label class="qa-radio"><input type="radio" name="qaScope" value="memoq" /> 仅 memoQ 现有译文</label>
                <label class="qa-radio"><input type="radio" name="qaScope" value="staged" /> 仅 Agent 暂存译文</label>
                <div class="qa-doc-note" id="qaDocScopeNote">检查对象跟随顶部文档切换</div>
              </fieldset>
              <fieldset class="qa-fieldset">
                <legend>检查项</legend>
                <div id="qaRuleGroupsContainer"></div>
                <details class="qa-details" style="margin-top:8px;">
                  <summary>精细勾选 23 项规则与预设</summary>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 6px;">
                    <button id="btnRulesDefault" class="sm" type="button">默认规则</button>
                    <button id="btnRulesAll" class="sm" type="button">全部规则</button>
                    <button id="btnRulesCritical" class="sm" type="button">仅严重错误</button>
                  </div>
                  <div id="qaRulesContainer"></div>
                </details>
              </fieldset>
              <details class="qa-details">
                <summary>允许原译相同的内容</summary>
                <label class="qa-field" style="margin-top:6px;">
                  <small>品牌名或其他无需翻译的文本，每行一条或逗号分隔。</small>
                  <textarea id="inpWhitelist" rows="3" placeholder="Gold Coin&#10;Discord"></textarea>
                </label>
              </details>
              <details class="qa-details">
                <summary>术语表与项目目录（可选）</summary>
                <label class="qa-field" style="margin-top:6px;">术语表文件 (.csv/.tsv/.tbx)
                  <input id="inpGlossaryPath" type="text" placeholder="例如 D:\\project\\terms.csv" />
                </label>
                <label class="qa-field">项目目录 (.langlink/manifest.json)
                  <input id="inpProjectDir" type="text" placeholder="留空沿用已配置项目目录" />
                </label>
              </details>
              <fieldset class="qa-fieldset">
                <legend>自定义检查</legend>
                <div id="qaCustomRules"></div>
                <button type="button" id="btnAddCustomRule">添加检查项</button>
              </fieldset>
              <template id="qaCustomRuleTpl">
                <fieldset class="qa-custom">
                  <legend>检查项</legend>
                  <label class="qa-field">名称<input data-name required maxlength="80" placeholder="例如 统一译名" /></label>
                  <label class="qa-field">原文包含（可选）<input data-source maxlength="300" placeholder="留空表示检查所有句段" /></label>
                  <label class="qa-field">要求<select><option value="required">译文必含</option><option value="forbidden">译文禁用</option><option value="maxLength">译文长度上限</option></select></label>
                  <label class="qa-field">词语或长度<input data-value required maxlength="300" /></label>
                  <button type="button" class="btn-remove-custom">移除检查项</button>
                </fieldset>
              </template>
              <div class="qa-run">
                <button class="primary" id="btnRunQaForm" type="submit">运行检查</button>
              </div>
            </form>

            <section class="qa-card" aria-labelledby="qaResultsTitle">
              <h2 id="qaResultsTitle">检查结果</h2>
              <p class="qa-muted" id="qaStatusLine" role="status">选择检查范围与规则后，点击「运行检查」或顶部「运行 QA 检查」。</p>
              <div id="qaMetricsBar" class="qa-metrics hidden"></div>
              <div id="qaRuleExecDetails"></div>
              <div id="qaResultsBody" class="hidden">
                <div class="qa-aiqa">
                  <label class="qa-checkbox"><input type="checkbox" id="qaAllSegments" /> 查看全部段落</label>
                  <small class="qa-muted">本工作台提供确定性普通 QA 检查与自定义规则；放行标准由用户自行设定（可通过上方自定义规则、术语表、MQM 分值或与 Agent 约定审核标准），每条记录均可点击「问 Agent」交由你自己的 Agent 复核或润色。</small>
                </div>

                <div class="qa-filters">
                  <label class="qa-field qa-search-field">搜索<input type="search" id="qaSearch" placeholder="原文、译文、段号或规则" /></label>
                  <label class="qa-field">文件<select id="qaFileFilter"><option value="">全部文件</option></select></label>
                  <label class="qa-field">规则类别<select id="qaCategoryFilter"><option value="">全部规则</option></select></label>
                  <label class="qa-field">严重程度<select id="qaSeverityFilter"><option value="">全部</option><option value="critical">严重</option><option value="major">主要</option><option value="minor">轻微</option><option value="neutral">待核查</option></select></label>
                  <label class="qa-field">组内排序<select id="qaOrderSelect"><option value="file">文件和段号</option><option value="desc">文件和段号倒序</option><option value="severity">严重程度</option></select></label>
                </div>

                <div class="qa-exports">
                  <label class="qa-field">导出范围<select id="qaExportScope"><option value="filtered">当前筛选</option><option value="all">全部结果</option></select></label>
                  <button type="button" data-qa-export="xlsx">导出 Excel</button>
                  <button type="button" data-qa-export="csv">CSV</button>
                  <button type="button" data-qa-export="html">HTML</button>
                </div>

                <p id="qaNoResults" class="qa-muted hidden">当前筛选没有匹配记录。</p>
                <div id="qaRuleSections"></div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>

    <aside id="inspectorPane" class="cat-inspector" aria-label="句段详情面板">
      <div id="inspectorContent"></div>
    </aside>
  </main>

  <footer class="cat-statusbar">
    <div class="status-group">
      <span id="pillTotal">总句段: 0</span>
      <span>放行进度: <span class="progress-track"><span id="progressFill" class="progress-fill"></span></span> <strong id="progressPct">0%</strong></span>
      <span class="pill warn" id="pillDraft">草稿待审: 0</span>
      <span class="pill rev" id="pillRev">需修订: 0</span>
      <span class="pill ok" id="pillApproved">已放行: 0</span>
      <span class="pill err hidden" id="pillMissed">漏翻告警: 0</span>
      <span class="pill warn hidden" id="pillUntranslated">未覆盖: 0</span>
      <span class="pill err" id="pillQa">QA 问题: -</span>
      <span class="pill info" id="pillMqm">MQM: -</span>
    </div>
    <div class="status-group">
      <span id="toolVersionFooter" class="mono${toolLabel ? "" : " hidden"}" style="color:var(--muted);">${escapeHtmlAttr(toolLabel)}</span>
      <span id="bridgeStatusPill" class="pill ok">● 桥接已连接</span>
    </div>
  </footer>

  <script nonce="${options.nonce}">
    const BOOT = ${bootJson};
    if (window.location.search) {
      try {
        history.replaceState(null, "", window.location.pathname);
      } catch {}
    }

    const SEVERITY_LABEL = { critical: "严重", major: "主要", minor: "轻微", neutral: "待核查" };
    const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, neutral: 3 };
    const QA_COLLATOR = new Intl.Collator(undefined, { numeric: true });

    const state = {
      data: null,
      qa: null,
      qaRows: [],
      qaMetaByKey: new Map(),
      qaCollapsed: new Set(),
      qaFilteredRows: [],
      qaLastPayload: null,
      qaRunning: false,
      selectedDocumentId: "",
      renderLimit: 300,
      filter: "all",
      search: "",
      activeTab: "review",
      selectedRules: null,
      dirtyTexts: new Map(),
      dirtyComments: new Map(),
      activeRowKey: "",
      lastFilteredKeys: [],
      inspectorOpen: true,
      bridgeConnected: true
    };

    const headers = () => ({
      "Content-Type": "application/json",
      "X-Review-Token": BOOT.reviewToken
    });

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    const TAG_TOKEN_RE = /<span\\b[^>]*\\bdata-mqitag=(?:"[^"]*"|'[^']*')[^>]*>[\\s\\S]*?<\\/span>|\\{\\{[^{}\\r\\n]+\\}\\}|\\$\\{[^{}\\r\\n]+\\}|\\{[^{}\\r\\n]+\\}|<\\/>|<\\/?[A-Za-z0-9_#][^\\r\\n<>]*>|%(?:\\d+\\$)?[-+#0]*(?:\\d+)?(?:\\.\\d+)?[hlL]?[sdifFeEgGxXoucpaA%](?![A-Za-z])|\\r?\\n|\\\\[nrt]/gu;

    function formatSourceHtml(rawText) {
      const text = String(rawText ?? "");
      if (!text) return "";
      let out = "";
      let lastIndex = 0;
      TAG_TOKEN_RE.lastIndex = 0;
      let match;
      while ((match = TAG_TOKEN_RE.exec(text)) !== null) {
        const idx = match.index;
        if (idx > lastIndex) {
          out += esc(text.slice(lastIndex, idx));
        }
        const tok = match[0];
        if (tok === "\\n" || tok === "\\r\\n") {
          out += '<span class="cat-tag" title="换行">↵</span>\\n';
        } else {
          out += '<span class="cat-tag">' + esc(tok) + "</span>";
        }
        lastIndex = idx + tok.length;
      }
      if (lastIndex < text.length) {
        out += esc(text.slice(lastIndex));
      }
      return out;
    }

    function showBanner(type, text) {
      const el = document.getElementById("statusBanner");
      el.className = "banner " + type;
      el.textContent = text;
      el.classList.remove("hidden");
    }

    function hideBanner() {
      document.getElementById("statusBanner").classList.add("hidden");
    }

    function renderBridgePill() {
      const el = document.getElementById("bridgeStatusPill");
      if (!el) return;
      if (state.bridgeConnected) {
        el.className = "pill ok";
        el.textContent = "● 桥接已连接";
      } else {
        el.className = "pill warn";
        el.textContent = "○ 桥接重连中…";
      }
    }

    async function apiRequest(method, path, body) {
      let res;
      try {
        res = await fetch(path, {
          method,
          headers: method === "GET" ? { "X-Review-Token": BOOT.reviewToken } : headers(),
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch (networkErr) {
        state.bridgeConnected = false;
        renderBridgePill();
        throw networkErr;
      }

      if (res.status === 401) {
        throw new Error("审校授权已失效，请保留当前编辑并从 Agent 对话重新打开 memoq_open_review 链接。");
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      if (!state.bridgeConnected) {
        state.bridgeConnected = true;
        renderBridgePill();
      }
      return data;
    }

    function apiGet(path) {
      return apiRequest("GET", path);
    }

    function apiPost(path, body) {
      return apiRequest("POST", path, body);
    }

    function normComparable(text) {
      return String(text || "").replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim().toLowerCase();
    }

    function mergeRows() {
      const previewSegs = (state.data && state.data.previewSegments) || [];
      const stagedItems = (state.data && state.data.staged && state.data.staged.items) || [];
      const missedItems = (state.data && state.data.missedMt && state.data.missedMt.items) || [];
      const docInfo = (state.data && state.data.document) || {};
      const byPart = new Map();
      const byDocExact = new Map();
      const byGlobalExact = new Map();
      const byDocNorm = new Map();
      const byGlobalNorm = new Map();

      for (const s of stagedItems) {
        const dId = String(s.documentId || "").toLowerCase();
        if (s.previewPartId) byPart.set(s.previewPartId, s);
        if (dId) {
          const dk = dId + "\\0" + s.sourceText;
          if (!byDocExact.has(dk)) byDocExact.set(dk, s);
        }
        if (!byGlobalExact.has(s.sourceText)) byGlobalExact.set(s.sourceText, s);
        const norm = String(s.sourceText || "").toLowerCase().replace(/\\s+/g, " ").trim();
        if (norm) {
          if (dId) {
            const dn = dId + "\\0" + norm;
            if (!byDocNorm.has(dn)) byDocNorm.set(dn, s);
          }
          if (!byGlobalNorm.has(norm)) byGlobalNorm.set(norm, s);
        }
      }

      const missedByExact = new Map();
      const missedByNorm = new Map();
      for (const m of missedItems) {
        if (m.text && !missedByExact.has(m.text)) missedByExact.set(m.text, m);
        const mNorm = normComparable(m.plainText || m.text);
        if (mNorm && !missedByNorm.has(mNorm)) missedByNorm.set(mNorm, m);
      }

      const usedStaged = new Set();
      const usedMissedKeys = new Set();
      const previewRows = [];
      for (const p of previewSegs) {
        const pDocId = p.documentId || (docInfo.documentId !== "__all__" ? docInfo.documentId : "") || "";
        const dKey = String(pDocId).toLowerCase();
        const norm = String(p.sourceText || "").toLowerCase().replace(/\\s+/g, " ").trim();
        const staged = byPart.get(p.previewPartId)
          || (dKey && byDocExact.get(dKey + "\\0" + p.sourceText))
          || byGlobalExact.get(p.sourceText)
          || (norm && dKey && byDocNorm.get(dKey + "\\0" + norm))
          || (norm && byGlobalNorm.get(norm))
          || null;
        if (staged) usedStaged.add(staged.id);
        const missedMatch = missedByExact.get(p.sourceText) || (norm && missedByNorm.get(norm)) || null;
        if (missedMatch) usedMissedKeys.add(missedMatch.key);
        const preserveTaggedMissed = Boolean(
          missedMatch
          && missedMatch.hasInlineTags
          && !/<span\\b[^>]*\\bdata-mqitag=/iu.test(p.sourceText || "")
        );
        previewRows.push({
          rowKey: pDocId ? (pDocId + "::" + p.previewPartId) : p.previewPartId,
          index: p.index,
          docSegmentNumber: p.docSegmentNumber || (p.index + 1),
          previewPartId: p.previewPartId,
          sourceText: preserveTaggedMissed ? missedMatch.text : p.sourceText,
          previewSourceText: p.sourceText,
          memoqTargetText: p.targetText || "",
          staged,
          missedMt: missedMatch,
          sourceLanguage: p.sourceLanguage || (staged && staged.sourceLanguage) || docInfo.sourceLanguage || "",
          targetLanguage: p.targetLanguage || (staged && staged.targetLanguage) || docInfo.targetLanguage || "",
          documentId: pDocId || (staged && staged.documentId) || "",
          documentName: p.documentName || docInfo.documentName || ""
        });
      }

      let extraIdx = previewRows.length;
      const extraStagedRows = [];
      for (const s of stagedItems) {
        if (usedStaged.has(s.id)) continue;
        const sNorm = normComparable(s.sourceText);
        const missedMatch = missedByExact.get(s.sourceText) || (sNorm && missedByNorm.get(sNorm)) || null;
        if (missedMatch) usedMissedKeys.add(missedMatch.key);
        const preserveTaggedMissed = Boolean(
          missedMatch
          && missedMatch.hasInlineTags
          && !/<span\\b[^>]*\\bdata-mqitag=/iu.test(s.sourceText || "")
        );
        extraStagedRows.push({
          rowKey: "staged:" + s.id,
          index: extraIdx++,
          docSegmentNumber: extraIdx,
          previewPartId: s.previewPartId || "",
          sourceText: preserveTaggedMissed ? missedMatch.text : s.sourceText,
          previewSourceText: s.sourceText,
          memoqTargetText: "",
          staged: s,
          missedMt: missedMatch,
          sourceLanguage: s.sourceLanguage || docInfo.sourceLanguage || "",
          targetLanguage: s.targetLanguage || docInfo.targetLanguage || "",
          documentId: s.documentId || (docInfo.documentId !== "__all__" ? docInfo.documentId : "") || "",
          documentName: s.documentId || ""
        });
      }

      // Put unmatched Pre-translate missed segments right at the top so translators never miss them.
      const missedTopRows = [];
      let mIdx = 0;
      for (const m of missedItems) {
        if (usedMissedKeys.has(m.key)) continue;
        missedTopRows.push({
          rowKey: "missed:" + m.key,
          index: mIdx++,
          docSegmentNumber: 0,
          previewPartId: "",
          sourceText: m.text,
          previewSourceText: m.plainText || m.text,
          memoqTargetText: "",
          staged: null,
          missedMt: m,
          sourceLanguage: m.sourceLanguage || docInfo.sourceLanguage || "",
          targetLanguage: m.targetLanguage || docInfo.targetLanguage || "",
          documentId: m.documentId || (docInfo.documentId !== "__all__" ? docInfo.documentId : "") || "",
          documentName: m.documentId ? m.documentId.slice(0, 8) : "Pre-translate"
        });
      }
      return [...missedTopRows, ...previewRows, ...extraStagedRows];
    }

    function issuesByRowMap() {
      const map = new Map();
      if (!state.qa || !Array.isArray(state.qa.issues)) return map;
      for (const issue of state.qa.issues) {
        const keys = [];
        if (issue.previewPartId) {
          if (issue.documentId) keys.push(issue.documentId + "::" + issue.previewPartId);
          keys.push(issue.previewPartId);
        }
        if (issue.stagedId) keys.push("staged:" + issue.stagedId);
        if (issue.segmentId) keys.push(issue.segmentId);
        for (const k of new Set(keys)) {
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(issue);
        }
      }
      return map;
    }

    function rowStatusClass(rowOrStaged) {
      const hasRowObj = rowOrStaged && ("rowKey" in rowOrStaged || "missedMt" in rowOrStaged || "staged" in rowOrStaged);
      const staged = hasRowObj ? rowOrStaged.staged : rowOrStaged;
      const missedMt = hasRowObj ? rowOrStaged.missedMt : null;
      if (missedMt && (!staged || staged.status !== "approved" || missedMt.reason === "inline_tags_required")) {
        return "st-missed";
      }
      if (!staged) return "st-memoq";
      if (staged.status === "approved") return "st-approved";
      if (staged.status === "needs_revision") return "st-needs_revision";
      return "st-draft";
    }

    function statusBadgeHtml(rowOrStaged) {
      const hasRowObj = rowOrStaged && ("rowKey" in rowOrStaged || "missedMt" in rowOrStaged || "staged" in rowOrStaged);
      const staged = hasRowObj ? rowOrStaged.staged : rowOrStaged;
      const missedMt = hasRowObj ? rowOrStaged.missedMt : null;
      const missedBadge = missedMt
        ? ('<span class="pill err" title="' + esc(missedMt.reasonLabel) + '">⚠ 漏翻</span>')
        : "";
      if (!staged) return missedBadge || '<span class="pill">仅 memoQ</span>';
      if (staged.status === "approved") {
        return missedMt && missedMt.reason === "inline_tags_required"
          ? missedBadge + ' <span class="pill ok">✓ 已放行 v' + staged.revision + "</span>"
          : '<span class="pill ok">✓ 已放行 v' + staged.revision + "</span>";
      }
      if (staged.status === "needs_revision") return (missedBadge ? missedBadge + " " : "") + '<span class="pill rev">需修订 v' + staged.revision + "</span>";
      return (missedBadge ? missedBadge + " " : "") + '<span class="pill warn">草稿 v' + staged.revision + "</span>";
    }

    function syncGroupCheckboxesFromRules() {
      const groups = (state.data && state.data.qaRuleGroups) || [];
      for (const chk of document.querySelectorAll(".qa-group-chk")) {
        const gId = chk.getAttribute("data-group");
        const g = groups.find((x) => x.id === gId);
        if (!g || !state.selectedRules) continue;
        const hits = g.rules.filter((rid) => state.selectedRules.has(rid)).length;
        chk.checked = hits > 0 && hits === g.rules.length;
        chk.indeterminate = hits > 0 && hits < g.rules.length;
      }
    }

    function renderRulesCatalog() {
      const groupContainer = document.getElementById("qaRuleGroupsContainer");
      const fineContainer = document.getElementById("qaRulesContainer");
      const catalog = (state.data && state.data.qaCatalog) || [];
      const groups = (state.data && state.data.qaRuleGroups) || [];
      if (!catalog.length) {
        groupContainer.innerHTML = "";
        fineContainer.innerHTML = "";
        return;
      }
      if (!state.selectedRules) {
        state.selectedRules = new Set(catalog.filter((r) => r.defaultEnabled).map((r) => r.ruleId));
      }

      let grpHtml = "";
      for (const g of groups) {
        grpHtml += '<label class="qa-checkbox">' +
          '<input type="checkbox" class="qa-group-chk" data-group="' + esc(g.id) + '" />' +
          "<span>" + esc(g.label) + "</span></label>";
      }
      groupContainer.innerHTML = grpHtml;

      let fineHtml = "";
      for (const r of catalog) {
        const checked = state.selectedRules.has(r.ruleId) ? "checked" : "";
        fineHtml += '<label class="qa-fine-rule" title="' + esc(r.description) + '">' +
          '<input type="checkbox" class="qa-rule-chk" value="' + esc(r.ruleId) + '" ' + checked + " />" +
          "<span><strong>" + esc(r.label) + '</strong> <small>(' + esc(SEVERITY_LABEL[r.severity] || r.severity) + ")</small></span></label>";
      }
      fineContainer.innerHTML = fineHtml;
      syncGroupCheckboxesFromRules();
    }

    function renderHeader() {
      const d = state.data || {};
      const doc = d.document || {};
      const prev = d.preview || {};
      const counts = (d.staged && d.staged.counts) || { approved: 0, draft: 0, needsRevision: 0 };
      const previewSegCount = (d.previewSegments && d.previewSegments.length) || 0;
      const total = Math.max(previewSegCount, (d.staged && d.staged.total) || 0);
      const missedMt = d.missedMt || { count: 0, items: [] };
      const coverage = d.coverage || { uncoveredPreviewCount: 0, pendingDraftCount: 0, missedPretranslateCount: missedMt.count || 0 };

      document.getElementById("docTitle").textContent =
        (doc.documentName || BOOT.initialDocumentName || "memoQ 当前文档");
      document.getElementById("langPair").textContent =
        (doc.sourceLanguage || "-") + " → " + (doc.targetLanguage || "-");
      document.getElementById("docIdLine").textContent = doc.documentId && doc.documentId !== "__all__"
        ? doc.documentId.slice(0, 8)
        : (doc.documentId === "__all__" ? "跨文档" : "");

      const docScopeNote = document.getElementById("qaDocScopeNote");
      if (docScopeNote) {
        docScopeNote.textContent = doc.documentId === "__all__"
          ? ("检查范围：全部已打开文档（" + ((d.documents && d.documents.length) || 0) + " 份）")
          : ("当前文档：" + (doc.documentName || BOOT.initialDocumentName || "当前活跃文档"));
      }

      const sel = document.getElementById("docSelector");
      const docsList = d.documents || [];
      const currentVal = state.selectedDocumentId || d.selectedDocumentId || doc.documentId || "";
      let optHtml = '<option value="">当前活跃文档（跟随 memoQ）</option>';
      if (docsList.length > 0) {
        optHtml += '<option value="__all__"' + (currentVal === "__all__" ? " selected" : "") + '>全部已打开文档 (共 ' + docsList.length + " 份)</option>";
      }
      for (const item of docsList) {
        const activeTag = item.isActive ? "[活跃] " : "";
        const segTag = item.segmentCount > 0 ? (" · " + item.segmentCount + "句") : "";
        const stTag = item.stagedCounts && item.stagedCounts.total > 0 ? (" / 暂存" + item.stagedCounts.total) : "";
        const label = activeTag + (item.documentName || item.documentId) + segTag + stTag;
        const selected = currentVal === item.documentId ? " selected" : "";
        optHtml += '<option value="' + esc(item.documentId) + '"' + selected + ">" + esc(label) + "</option>";
      }
      sel.innerHTML = optHtml;

      const prevEl = document.getElementById("previewBadge");
      prevEl.textContent = prev.connected ? "Preview: 已连接" : ("Preview: " + (prev.state || "未连接"));
      prevEl.className = "pill " + (prev.connected ? "ok" : "warn");

      document.getElementById("pillTotal").textContent = "总句段: " + total;
      document.getElementById("pillDraft").textContent = "草稿待审: " + counts.draft;
      document.getElementById("pillRev").textContent = "需修订: " + counts.needsRevision;
      document.getElementById("pillApproved").textContent = "已放行: " + counts.approved;
      const pct = total > 0 ? Math.min(100, Math.round((counts.approved / total) * 100)) : 0;
      document.getElementById("progressFill").style.width = pct + "%";
      document.getElementById("progressPct").textContent = pct + "%";

      const missedCount = missedMt.count || 0;
      const missedBanner = document.getElementById("missedBanner");
      document.getElementById("missedCount").textContent = String(missedCount);
      document.getElementById("missedPreview").textContent = (missedMt.items || [])
        .slice(0, 3)
        .map((m) => (m.plainText || m.text || "").slice(0, 28) + " [" + m.reasonLabel + "]")
        .join(" · ");
      missedBanner.classList.toggle("hidden", missedCount === 0);

      const pillMissed = document.getElementById("pillMissed");
      pillMissed.textContent = "漏翻告警: " + missedCount;
      pillMissed.classList.toggle("hidden", missedCount === 0);
      const pillFilterMissed = document.getElementById("pillFilterMissed");
      if (pillFilterMissed) {
        pillFilterMissed.textContent = missedCount > 0 ? ("Pre-translate 漏翻 (" + missedCount + ")") : "Pre-translate 漏翻";
      }

      const uncoveredCount = coverage.uncoveredPreviewCount || 0;
      const uncoveredBanner = document.getElementById("uncoveredBanner");
      document.getElementById("uncoveredCount").textContent = String(uncoveredCount);
      uncoveredBanner.classList.toggle("hidden", uncoveredCount === 0);

      const pillUntranslated = document.getElementById("pillUntranslated");
      pillUntranslated.textContent = "未覆盖: " + uncoveredCount;
      pillUntranslated.classList.toggle("hidden", uncoveredCount === 0);
      const pillFilterUntranslated = document.getElementById("pillFilterUntranslated");
      if (pillFilterUntranslated) {
        pillFilterUntranslated.textContent = uncoveredCount > 0 ? ("未译/未覆盖 (" + uncoveredCount + ")") : "未译/未覆盖";
      }

      const revBanner = document.getElementById("revBanner");
      document.getElementById("revCount").textContent = String(counts.needsRevision);
      if (counts.needsRevision > 0) revBanner.classList.remove("hidden");
      else revBanner.classList.add("hidden");

      if (state.qa) {
        const s = state.qa.summary;
        const qaEl = document.getElementById("pillQa");
        qaEl.textContent = "QA 问题: " + s.totalIssues;
        qaEl.className = "pill " + (s.totalIssues === 0 ? "ok" : (s.bySeverity.critical > 0 ? "err" : "warn"));
        document.getElementById("pillMqm").textContent = "MQM RQS: " + s.mqm.rqs;
      }

      const projInput = document.getElementById("inpProjectDir");
      if (!projInput.value && d.projectDir) projInput.value = d.projectDir;
      const toolMeta = (d.tool && d.tool.name && d.tool.version) ? d.tool : BOOT.tool;
      const toolText = toolMeta && toolMeta.name && toolMeta.version ? (toolMeta.name + "@" + toolMeta.version) : "";
      const tvBadge = document.getElementById("toolVersionBadge");
      if (tvBadge) {
        tvBadge.textContent = toolText ? ("v" + toolMeta.version) : "";
        tvBadge.title = toolText;
        tvBadge.classList.toggle("hidden", !toolText);
      }
      const tvFooter = document.getElementById("toolVersionFooter");
      if (tvFooter) {
        tvFooter.textContent = toolText;
        tvFooter.classList.toggle("hidden", !toolText);
      }
      renderBridgePill();
    }

    function autoSizeTextarea(el) {
      if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.max(44, Math.min(el.scrollHeight + 2, 240)) + "px";
    }

    function renderInspector() {
      const box = document.getElementById("inspectorContent");
      if (!box) return;
      const rows = mergeRows();
      const row = rows.find((r) => r.rowKey === state.activeRowKey) || null;
      if (!row) {
        box.innerHTML = '<div class="empty-state">在左侧双语网格中点击任意句段，即可在此查看修订历史、memoQ 实时译文、QA 问题并写批注。</div>';
        return;
      }

      const s = row.staged;
      const issueMap = issuesByRowMap();
      const rowIssues = issueMap.get(row.rowKey)
        || issueMap.get(row.previewPartId)
        || (s ? issueMap.get("staged:" + s.id) : null)
        || [];
      const currentComment = state.dirtyComments.has(row.rowKey)
        ? state.dirtyComments.get(row.rowKey)
        : (s ? s.reviewComment : "");

      let historyHtml = '<div style="font-size:12px;color:var(--muted);">暂无多轮历史（首次保存或修订后自动记录）。</div>';
      if (s && Array.isArray(s.history) && s.history.length > 0) {
        historyHtml = '<div style="display:flex;gap:6px;align-items:center;">' +
          '<select class="rev-select" style="flex:1;min-width:0;" data-row="' + esc(row.rowKey) + '" data-id="' + esc(s.id) + '">' +
          s.history.slice().reverse().map((h) =>
            '<option value="' + h.revision + '">v' + h.revision + " (" + esc(h.editedBy) + "): " + esc(h.targetText.slice(0, 36)) + "</option>"
          ).join("") +
          '</select><button class="sm btn-revert" data-id="' + esc(s.id) + '" data-row="' + esc(row.rowKey) + '" type="button">回退</button></div>';
      }

      let qaHtml = '<div style="font-size:12px;color:var(--muted);">' + (state.qa ? "本句段未检出 QA 问题。" : "尚未运行 QA 检查。") + "</div>";
      if (rowIssues.length > 0) {
        qaHtml = rowIssues.map((iss) => {
          const cls = iss.severity === "critical" ? "err" : (iss.severity === "major" ? "warn" : "info");
          return '<div class="qa-issue-card">' +
            '<div><span class="pill ' + cls + '">' + esc(SEVERITY_LABEL[iss.severity] || iss.severity) + "</span> <strong>" + esc(iss.ruleLabel) + "</strong></div>" +
            "<div>" + esc(iss.message) + "</div>" +
            (iss.evidence ? '<div class="mono" style="color:var(--muted);">' + esc(iss.evidence) + "</div>" : "") +
            (iss.suggestion ? '<div style="color:var(--ok);font-size:11px;">建议: ' + esc(iss.suggestion) + "</div>" : "") +
          "</div>";
        }).join("");
      }

      const memoqText = row.memoqTargetText || "";
      const fillBtn = memoqText
        ? '<button id="btnFillMemoqTarget" class="sm" data-row="' + esc(row.rowKey) + '" type="button">填入编辑框</button>'
        : "";
      const focusBtn = row.previewPartId
        ? '<button class="sm btn-focus" data-part="' + esc(row.previewPartId) + '" data-doc="' + esc(row.documentId) + '" data-src="' + esc(row.previewSourceText || row.sourceText) + '" type="button">定位 memoQ</button>'
        : "";
      const copySourceBtn =
        '<button class="sm btn-copy-source" data-row="' + esc(row.rowKey) + '" type="button">复制原文</button>';

      let missedHtml = "";
      if (row.missedMt) {
        const m = row.missedMt;
        missedHtml = '<div class="insp-section" style="border-color:var(--err);">' +
          '<div class="insp-title"><span style="color:var(--err);">Pre-translate 未命中诊断</span><span class="pill err">' + esc(m.reasonLabel) + "</span></div>" +
          '<div style="font-size:12px;">请求次数: <strong>' + m.attempts + '</strong> · 模式: <span class="mono">' + esc(m.requestType) + "</span></div>" +
          (m.hasInlineTags ? '<div style="font-size:11px;color:var(--warn);">包含 memoQ 内联标签，可直接点击下方「复制原文」保留 &lt;span data-mqitag&gt; 占位标签后编辑并 Ctrl+Enter 放行。</div>' : "") +
          (m.tmSource ? '<div class="mono" style="color:var(--muted);">TM参考: ' + esc(m.tmSource) + " → " + esc(m.tmTarget) + "</div>" : "") +
        "</div>";
      }

      box.innerHTML =
        missedHtml +
        '<div class="insp-section">' +
          '<div class="insp-title"><span>句段 #' + (row.docSegmentNumber > 0 ? row.docSegmentNumber : (row.index + 1)) + "</span>" + statusBadgeHtml(row) + "</div>" +
          '<div style="font-size:11px;color:var(--muted);">' +
            (row.documentName ? esc(row.documentName) + " · " : "") +
            esc(row.sourceLanguage || "-") + " → " + esc(row.targetLanguage || "-") +
            (s && s.stagedBy ? (" · by " + esc(s.stagedBy)) : "") +
          "</div>" +
          '<div style="margin-top:2px;display:flex;gap:6px;flex-wrap:wrap;">' + focusBtn + copySourceBtn + "</div>" +
        "</div>" +
        '<div class="insp-section">' +
          '<div class="insp-title"><span>memoQ 实时译文对照</span>' + fillBtn + "</div>" +
          '<div class="insp-ref-text">' + (memoqText ? esc(memoqText) : '<span style="color:var(--faint);">(memoQ 中当前为空)</span>') + "</div>" +
        "</div>" +
        '<div class="insp-section">' +
          '<div class="insp-title"><span>给 Agent 的修改意见</span></div>' +
          '<textarea id="inspectorCommentInput" class="cmt-edit" data-row="' + esc(row.rowKey) + '" rows="2" placeholder="输入批注（如：术语改用珍奇，语气更口语）">' + esc(currentComment) + "</textarea>" +
          '<div><button class="sm warn btn-feedback" data-row="' + esc(row.rowKey) + '" data-id="' + esc(s ? s.id : "") + '" type="button">标记需修订并保存批注</button></div>' +
        "</div>" +
        '<div class="insp-section">' +
          '<div class="insp-title"><span>多轮修订历史</span></div>' +
          historyHtml +
        "</div>" +
        '<div class="insp-section">' +
          '<div class="insp-title"><span>句段 QA 诊断 (' + rowIssues.length + ")</span></div>" +
          qaHtml +
        "</div>";
    }

    function selectActiveRow(rowKey, focusEditor = false) {
      if (!rowKey) return;
      state.activeRowKey = rowKey;
      for (const el of document.querySelectorAll("[data-row-card]")) {
        el.classList.toggle("active-row", el.getAttribute("data-row-card") === rowKey);
      }
      renderInspector();
      if (focusEditor) {
        const card = document.querySelector('[data-row-card="' + CSS.escape(rowKey) + '"]');
        const ta = card && card.querySelector(".tgt-edit");
        if (ta) {
          ta.focus();
          ta.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
    }

    function renderReviewList() {
      const container = document.getElementById("segmentList");
      const rows = mergeRows();
      const issueMap = issuesByRowMap();
      const q = state.search.trim().toLowerCase();

      const filtered = rows.filter((row) => {
        const s = row.staged;
        const rowIssues = issueMap.get(row.rowKey) || issueMap.get(row.previewPartId) || (s ? issueMap.get("staged:" + s.id) : null) || [];
        if (state.filter === "missed_mt" && !row.missedMt) return false;
        if (state.filter === "untranslated" && !row.missedMt && (s || row.memoqTargetText.trim())) return false;
        if (state.filter === "draft" && (!s || s.status !== "draft")) return false;
        if (state.filter === "needs_revision" && (!s || s.status !== "needs_revision")) return false;
        if (state.filter === "approved" && (!s || s.status !== "approved")) return false;
        if (state.filter === "qa_issue" && rowIssues.length === 0) return false;
        if (state.filter === "diff") {
          if (!s || s.targetText.trim() === row.memoqTargetText.trim()) return false;
        }
        if (state.filter === "comment" && (!s || !s.reviewComment.trim())) return false;
        if (q) {
          const hay = [
            row.sourceText,
            row.memoqTargetText,
            s ? s.targetText : "",
            s ? s.reviewComment : "",
            row.missedMt ? row.missedMt.reasonLabel : ""
          ].join("\\n").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      state.lastFilteredKeys = filtered.map((r) => r.rowKey);
      if (filtered.length === 0) {
        state.activeRowKey = "";
        container.innerHTML = '<div class="empty-state">当前筛选条件下没有句段。</div>';
        renderInspector();
        return;
      }

      if (!state.activeRowKey || !filtered.some((r) => r.rowKey === state.activeRowKey)) {
        state.activeRowKey = filtered[0].rowKey;
      }

      const showDocBadge = state.selectedDocumentId === "__all__"
        || (state.data && state.data.selectedDocumentId === "__all__")
        || (state.data && Array.isArray(state.data.documents) && state.data.documents.length > 1);
      const maxRender = Math.max(300, state.renderLimit || 300);
      const sliced = filtered.slice(0, maxRender);
      let html = "";
      for (const row of sliced) {
        const s = row.staged;
        const rowIssues = issueMap.get(row.rowKey)
          || issueMap.get(row.previewPartId)
          || (s ? issueMap.get("staged:" + s.id) : null)
          || [];
        const isDirty = state.dirtyTexts.has(row.rowKey);
        const currentTarget = isDirty
          ? state.dirtyTexts.get(row.rowKey)
          : (s ? s.targetText : row.memoqTargetText);
        const activeClass = state.activeRowKey === row.rowKey ? " active-row" : "";
        const docBadge = showDocBadge && row.documentName
          ? '<span class="doc-chip" title="' + esc(row.documentName) + '">' + esc(row.documentName) + "</span>"
          : "";

        let issuesBadges = "";
        if (rowIssues.length > 0) {
          issuesBadges = '<div class="badge-list">' + rowIssues.slice(0, 3).map((iss) => {
            const cls = iss.severity === "critical" ? "err" : (iss.severity === "major" ? "warn" : "info");
            return '<span class="pill ' + cls + '" title="' + esc(iss.evidence) + '">' + esc(iss.ruleLabel) + "</span>";
          }).join("") + (rowIssues.length > 3 ? '<span class="pill info">+' + (rowIssues.length - 3) + "</span>" : "") + "</div>";
        }

        const missedReasonLine = row.missedMt
          ? '<div class="missed-reason-line">Pre-translate 未命中: ' + esc(row.missedMt.reasonLabel) + "（请求 " + row.missedMt.attempts + " 次；可修改或复制原文后 Ctrl+Enter 放行）</div>"
          : "";
        const memoqDiffHtml = s && row.memoqTargetText && row.memoqTargetText !== s.targetText
          ? '<div class="memoq-ref-line">memoQ: ' + esc(row.memoqTargetText) + "</div>"
          : "";
        const cmtBadge = s && s.reviewComment
          ? '<div class="cmt-chip">批注: ' + esc(s.reviewComment) + "</div>"
          : "";

        const approveBtn = s
          ? (s.status === "approved"
              ? '<button class="sm btn-toggle-approve" data-id="' + esc(s.id) + '" data-next="draft" type="button" title="撤回为草稿">撤回</button>'
              : '<button class="sm success btn-toggle-approve" data-id="' + esc(s.id) + '" data-next="approved" type="button" title="放行定稿到 memoQ">✓</button>')
          : "";
        const focusBtn = row.previewPartId
          ? '<button class="sm btn-focus" data-part="' + esc(row.previewPartId) + '" data-doc="' + esc(row.documentId) + '" data-src="' + esc(row.previewSourceText || row.sourceText) + '" data-tgt="' + esc(currentTarget) + '" type="button" title="在 memoQ 中定位">⌖</button>'
          : "";
        const copySrcMini = (!s || row.missedMt)
          ? '<button class="sm btn-copy-source" data-row="' + esc(row.rowKey) + '" type="button" title="复制原文到译文栏">源→译</button>'
          : "";

        html += '<div class="cat-row ' + rowStatusClass(row) + activeClass + '" data-row-card="' + esc(row.rowKey) + '">' +
          '<div class="cat-rail"><strong>' + (row.docSegmentNumber > 0 ? row.docSegmentNumber : "!") + "</strong>" + docBadge + (isDirty ? '<span class="dirty-tag">未保存</span>' : "") + "</div>" +
          '<div class="cat-source"><div class="src-text">' + formatSourceHtml(row.sourceText) + "</div>" + issuesBadges + missedReasonLine + "</div>" +
          '<div class="cat-target">' +
            '<textarea class="tgt-edit" data-row="' + esc(row.rowKey) + '" placeholder="输入译文或点右侧「源→译」，按 Ctrl+Enter 直接放行...">' + esc(currentTarget) + "</textarea>" +
            memoqDiffHtml + cmtBadge +
          "</div>" +
          '<div class="cat-status">' +
            statusBadgeHtml(row) +
            '<div class="row-mini-btns">' +
              '<button class="sm primary btn-save-edit" data-row="' + esc(row.rowKey) + '" data-id="' + esc(s ? s.id : "") + '" type="button">' + (s ? "保存" : "暂存") + "</button>" +
              approveBtn + copySrcMini + focusBtn +
            "</div>" +
          "</div>" +
        "</div>";
      }
      if (filtered.length > maxRender) {
        const remaining = filtered.length - maxRender;
        html += '<div class="banner warn"><span>已展示前 ' + maxRender + " 条（共匹配 " + filtered.length + " 条，还有 " + remaining + ' 条未展开）。</span><button id="btnLoadMoreRows" class="sm primary" type="button">再加载 300 条</button></div>';
      }
      container.innerHTML = html;
      for (const ta of container.querySelectorAll(".tgt-edit")) {
        autoSizeTextarea(ta);
      }
      renderInspector();
    }

    function qaRuleDisplayLabel(row) {
      const meta = state.qaMetaByKey.get(row.segmentKey);
      if (row.category === "自定义") return row.rule;
      return (meta && meta.ruleLabel) || row.rule;
    }

    function renderMarkedCell(td, value, findings, side) {
      if (!value) {
        td.textContent = "—";
        return;
      }
      const ranges = [];
      for (const f of findings) {
        const spans = f.highlights && f.highlights[side];
        if (!Array.isArray(spans)) continue;
        for (const sp of spans) {
          if (sp && Number.isSafeInteger(sp.start) && Number.isSafeInteger(sp.end) && sp.start >= 0 && sp.start < sp.end && sp.end <= value.length) {
            ranges.push(sp);
          }
        }
      }
      ranges.sort((a, b) => a.start - b.start || a.end - b.end);
      if (!ranges.length) {
        td.textContent = value;
        return;
      }
      const merged = [];
      for (const sp of ranges) {
        const prev = merged[merged.length - 1];
        if (prev && sp.start < prev.end) prev.end = Math.max(prev.end, sp.end);
        else merged.push({ start: sp.start, end: sp.end });
      }
      let cursor = 0;
      for (const sp of merged) {
        if (sp.start > cursor) td.append(value.slice(cursor, sp.start));
        const mark = document.createElement("mark");
        mark.className = "qa-mark";
        mark.textContent = value.slice(sp.start, sp.end);
        td.append(mark);
        cursor = sp.end;
      }
      if (cursor < value.length) td.append(value.slice(cursor));
    }

    function fillQaSelectOptions(selectEl, values) {
      const prev = selectEl.value;
      selectEl.options.length = 1;
      for (const val of Array.from(new Set(values)).filter(Boolean).sort(QA_COLLATOR.compare)) {
        selectEl.add(new Option(val, val));
      }
      if (prev && Array.from(selectEl.options).some((opt) => opt.value === prev)) {
        selectEl.value = prev;
      }
    }

    function buildAskAgentWidget(segment, combinedFindings, meta) {
      const details = document.createElement("details");
      details.className = "ask-agent";
      const summary = document.createElement("summary");
      summary.textContent = "问 Agent";
      const label = document.createElement("label");
      label.className = "qa-field";
      label.textContent = "补充问题（可选）";
      const question = document.createElement("textarea");
      question.rows = 2;
      label.append(question);
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "sm";
      copyBtn.textContent = "复制给 Agent";
      const copyStatus = document.createElement("small");
      copyStatus.setAttribute("role", "status");
      const manual = document.createElement("textarea");
      manual.readOnly = true;
      manual.hidden = true;
      manual.rows = 5;
      copyBtn.addEventListener("click", async () => {
        const payload = [
          "请复核下面这条 memoQ 双语段落，解释检查发现是否属于必须修改的真实问题，引用原文与译文作为依据。若需要修改暂存，请给出改法或直接更新暂存。",
          ...(question.value.trim() ? ["我的问题：" + question.value.trim()] : []),
          JSON.stringify({
            document: segment.file,
            documentId: (meta && meta.documentId) || "",
            previewPartId: (meta && meta.previewPartId) || "",
            segment: segment.segment,
            source: segment.source,
            translation: segment.target,
            findings: combinedFindings.map((f) => ({
              category: f.category,
              rule: f.rule,
              message: f.message,
              evidence: f.evidence
            }))
          }, null, 2)
        ].join("\\n");
        try {
          await navigator.clipboard.writeText(payload);
          manual.hidden = true;
          copyStatus.textContent = "已复制，粘贴到 WorkBuddy 或 DSH 对话。";
        } catch {
          manual.value = payload;
          manual.hidden = false;
          manual.focus();
          manual.select();
          copyStatus.textContent = "请复制已选中的文本，粘贴到 WorkBuddy 或 DSH 对话。";
        }
      });
      details.append(summary, label, copyBtn, copyStatus, manual);
      return details;
    }

    function renderQaTableRow(entry) {
      const seg = entry.segment;
      const findings = entry.findings;
      const meta = state.qaMetaByKey.get(seg.segmentKey) || {};
      const tr = document.createElement("tr");

      // Col 1: segment number + file + memoQ action buttons
      const tdLoc = tr.insertCell();
      const numWrap = document.createElement("div");
      numWrap.className = "segment-id segment-select";
      numWrap.append("#" + seg.segment);
      tdLoc.append(numWrap);
      const fileSmall = document.createElement("small");
      fileSmall.className = "segment-file";
      fileSmall.textContent = seg.file;
      tdLoc.append(fileSmall);

      const actDiv = document.createElement("div");
      actDiv.className = "segment-actions";
      if (meta.jumpKey) {
        const jumpBtn = document.createElement("button");
        jumpBtn.type = "button";
        jumpBtn.className = "sm primary btn-jump-review";
        jumpBtn.setAttribute("data-row", meta.jumpKey);
        jumpBtn.textContent = "去审校";
        actDiv.append(jumpBtn);
      }
      if (meta.previewPartId) {
        const focusBtn = document.createElement("button");
        focusBtn.type = "button";
        focusBtn.className = "sm btn-focus";
        focusBtn.setAttribute("data-part", meta.previewPartId);
        focusBtn.setAttribute("data-doc", meta.documentId || "");
        focusBtn.setAttribute("data-src", seg.source);
        focusBtn.setAttribute("data-tgt", seg.target);
        focusBtn.textContent = "定位";
        actDiv.append(focusBtn);
      }
      if (actDiv.childElementCount > 0) tdLoc.append(actDiv);

      // Col 2 & 3: Source & Target with highlights
      renderMarkedCell(tr.insertCell(), seg.source, findings, "source");
      renderMarkedCell(tr.insertCell(), seg.target, findings, "target");

      // Col 4: Findings list
      const tdComments = tr.insertCell();
      if (!findings.length) {
        tdComments.textContent = "—";
      } else {
        const ul = document.createElement("ul");
        ul.className = "finding-list";
        for (const f of findings) {
          const li = document.createElement("li");
          li.textContent = f.message;
          if (f.evidence && f.rule !== "TAG_MISMATCH") {
            const det = document.createElement("details");
            const sum = document.createElement("summary");
            sum.textContent = "查看依据";
            const evP = document.createElement("p");
            evP.textContent = f.evidence;
            det.append(sum, evP);
            li.append(det);
          }
          if (f.suggestion) {
            const sugSmall = document.createElement("small");
            sugSmall.style.color = "var(--ok)";
            sugSmall.textContent = "建议：" + f.suggestion;
            li.append(sugSmall);
          }
          ul.append(li);
        }
        const lvl = document.createElement("small");
        lvl.textContent = SEVERITY_LABEL[findings[0].severity] || findings[0].severity;
        tdComments.append(ul, lvl);
      }

      // Col 5: Ask your own Agent
      const tdAsk = tr.insertCell();
      tdAsk.append(buildAskAgentWidget(seg, findings, meta));
      return tr;
    }

    function renderQaSections() {
      const container = document.getElementById("qaRuleSections");
      const noResEl = document.getElementById("qaNoResults");
      if (!state.qa) return;

      for (const sec of container.querySelectorAll("details.rule-section")) {
        const rk = sec.getAttribute("data-rule");
        if (sec.open) state.qaCollapsed.delete(rk);
        else state.qaCollapsed.add(rk);
      }

      const query = document.getElementById("qaSearch").value.trim().toLowerCase();
      const fileFilter = document.getElementById("qaFileFilter").value;
      const catFilter = document.getElementById("qaCategoryFilter").value;
      const sevFilter = document.getElementById("qaSeverityFilter").value;
      const orderMode = document.getElementById("qaOrderSelect").value;
      const showClean = document.getElementById("qaAllSegments").checked;

      const allRows = [...state.qaRows];
      const matches = allRows.filter((row) => {
        if (fileFilter && row.file !== fileFilter) return false;
        const rLabel = qaRuleDisplayLabel(row);
        if (catFilter && rLabel !== catFilter) return false;
        if (sevFilter && row.severity !== sevFilter) return false;
        if (query) {
          const hay = [
            row.file, row.segment, row.source, row.target, row.category, row.rule, row.message, row.evidence, rLabel
          ];
          if (!hay.some((v) => String(v || "").toLowerCase().includes(query))) return false;
        }
        return true;
      });

      const byLoc = (a, b) => QA_COLLATOR.compare(a.file, b.file) || QA_COLLATOR.compare(a.segment, b.segment);
      matches.sort((a, b) => {
        if (orderMode === "severity") {
          return (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) || byLoc(a, b);
        }
        return (orderMode === "desc" ? -1 : 1) * byLoc(a, b);
      });

      const grouped = new Map();
      const shown = new Set();
      const included = new Set();

      for (const finding of matches) {
        const label = qaRuleDisplayLabel(finding);
        const rKey = JSON.stringify([finding.category, finding.rule]);
        let section = grouped.get(rKey);
        if (!section) {
          section = { label, entries: new Map() };
          grouped.set(rKey, section);
        }
        let entry = section.entries.get(finding.segmentKey);
        if (!entry) {
          entry = { segment: finding, findings: [] };
          section.entries.set(finding.segmentKey, entry);
        }
        entry.findings.push(finding);
        included.add(finding);
        shown.add(finding.segmentKey);
      }

      const sections = new Map(
        Array.from(grouped.entries()).sort((a, b) => QA_COLLATOR.compare(a[1].label, b[1].label))
      );

      if (showClean && !catFilter && !sevFilter) {
        const reportSegs = (state.qa.segments || []).map((s) => ({
          segmentKey: s.segmentKey,
          file: s.documentName || state.qa.document.documentName || "memoQ 文档",
          segment: String(s.docSegmentNumber || s.segmentNumber),
          source: s.sourceText,
          target: s.targetText
        }));
        const clean = reportSegs.filter((s) =>
          !shown.has(s.segmentKey)
          && (!fileFilter || s.file === fileFilter)
          && (!query || [s.file, s.segment, s.source, s.target].some((v) => String(v || "").toLowerCase().includes(query)))
        );
        clean.sort((a, b) => (orderMode === "desc" ? -1 : 1) * byLoc(a, b));
        if (clean.length > 0) {
          const cleanEntries = new Map();
          for (const s of clean) cleanEntries.set(s.segmentKey, { segment: s, findings: [] });
          sections.set("clean", { label: "无检查发现", entries: cleanEntries });
        }
      }

      state.qaFilteredRows = Array.from(included);
      container.replaceChildren();
      const pageSize = 50;

      for (const [secKey, secObj] of sections) {
        const entries = Array.from(secObj.entries.values());
        const det = document.createElement("details");
        det.className = "rule-section";
        det.setAttribute("data-rule", secKey);
        det.open = !state.qaCollapsed.has(secKey);

        const sum = document.createElement("summary");
        sum.textContent = secObj.label;
        const cnt = document.createElement("span");
        cnt.className = "rule-count";
        cnt.textContent = entries.length + " 段";
        sum.append(cnt);

        const wrap = document.createElement("div");
        wrap.className = "qa-table-wrap";
        wrap.setAttribute("tabindex", "0");
        wrap.setAttribute("role", "region");
        wrap.setAttribute("aria-label", secObj.label);

        const tbl = document.createElement("table");
        tbl.className = "qa-report-table";
        const thead = tbl.createTHead();
        const hr = thead.insertRow();
        for (const colTitle of ["句段编号", "原文", "译文", "检查说明", "复核操作"]) {
          const th = document.createElement("th");
          th.scope = "col";
          th.textContent = colTitle;
          hr.append(th);
        }
        const tbody = tbl.createTBody();
        wrap.append(tbl);

        const pager = document.createElement("div");
        pager.className = "qa-pager";
        const pageInfo = document.createElement("span");
        const navDiv = document.createElement("div");
        const prevBtn = document.createElement("button");
        prevBtn.type = "button";
        prevBtn.className = "sm";
        prevBtn.textContent = "上一页";
        const nextBtn = document.createElement("button");
        nextBtn.type = "button";
        nextBtn.className = "sm";
        nextBtn.textContent = "下一页";
        navDiv.append(prevBtn, " ", nextBtn);
        pager.append(pageInfo, navDiv);

        const pages = Math.max(1, Math.ceil(entries.length / pageSize));
        pager.hidden = entries.length <= pageSize;
        let page = 0;
        function renderPage() {
          const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
          tbody.replaceChildren(...slice.map(renderQaTableRow));
          pageInfo.textContent = "第 " + (page + 1) + " / " + pages + " 页";
          prevBtn.disabled = page === 0;
          nextBtn.disabled = page >= pages - 1;
        }
        prevBtn.addEventListener("click", () => { page -= 1; renderPage(); });
        nextBtn.addEventListener("click", () => { page += 1; renderPage(); });
        renderPage();

        det.append(sum, wrap, pager);
        container.append(det);
      }

      noResEl.classList.toggle("hidden", sections.size > 0);
    }

    function renderQaStatusLine() {
      const statusEl = document.getElementById("qaStatusLine");
      if (!state.qa) return;
      const r = state.qa;
      const s = r.summary;
      const docCount = (r.documents && r.documents.length) || 1;
      statusEl.textContent =
        (s.coverage === "incomplete" ? "检查未完整完成" : "检查完成") +
        " · " + docCount + " 个文档 · " + s.totalSegments + " 段 · " +
        s.totalIssues + " 条普通 QA 问题";
    }

    function renderQaReport() {
      const metricsEl = document.getElementById("qaMetricsBar");
      const ruleExecEl = document.getElementById("qaRuleExecDetails");
      const resultsBodyEl = document.getElementById("qaResultsBody");
      if (!state.qa) {
        metricsEl.classList.add("hidden");
        ruleExecEl.innerHTML = "";
        resultsBodyEl.classList.add("hidden");
        return;
      }

      const r = state.qa;
      const s = r.summary;
      renderQaStatusLine();

      const covPill = s.coverage === "complete"
        ? '<span class="pill ok">覆盖完整</span>'
        : '<span class="pill warn">部分规则跳过</span>';
      const glossaryInfo = r.glossary.entriesCount > 0
        ? ("已加载术语 " + r.glossary.entriesCount + " 条")
        : "未加载外部术语表";
      metricsEl.innerHTML =
        '<span class="pill info">检查模式: ' + esc(r.scope) + "</span>" +
        '<span class="pill">已译/非空: ' + s.translatedSegments + " / 空译: " + s.emptyTargetSegments + "</span>" +
        '<span class="pill err">严重: ' + s.bySeverity.critical + "</span>" +
        '<span class="pill warn">主要: ' + s.bySeverity.major + "</span>" +
        '<span class="pill info">轻微: ' + s.bySeverity.minor + "</span>" +
        '<span class="pill">MQM RQS: ' + s.mqm.rqs + " (APT=" + s.mqm.apt + ", EWC=" + s.mqm.ewc + ")</span>" +
        covPill +
        '<span class="pill">' + esc(glossaryInfo) + "</span>";
      metricsEl.classList.remove("hidden");

      ruleExecEl.innerHTML = '<details class="qa-details" style="margin-bottom:8px;"><summary>规则执行明细（共 ' + r.rules.length + ' 条）</summary>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:4px 10px;margin-top:6px;font-size:11px;">' +
        r.rules.map((rule) => "<div><strong>" + esc(rule.ruleId) + "</strong>: " + esc(rule.status) + " (" + rule.checkedSegments + ")" + (rule.reason ? " - " + esc(rule.reason) : "") + "</div>").join("") +
        "</div></details>";

      resultsBodyEl.classList.remove("hidden");
      fillQaSelectOptions(document.getElementById("qaFileFilter"), state.qaRows.map((x) => x.file));
      fillQaSelectOptions(
        document.getElementById("qaCategoryFilter"),
        state.qaRows.map((x) => qaRuleDisplayLabel(x))
      );
      renderQaSections();
    }

    async function refreshState(silent = false) {
      try {
        const docParam = state.selectedDocumentId
          ? ("?documentId=" + encodeURIComponent(state.selectedDocumentId))
          : "";
        state.data = await apiGet("/review/api/state" + docParam);
        renderHeader();
        if (!document.getElementById("qaRuleGroupsContainer").innerHTML) {
          renderRulesCatalog();
        }
        renderReviewList();
        if (!silent) hideBanner();
      } catch (err) {
        if (!silent) showBanner("err", "刷新失败: " + (err.message || err));
      }
    }

    async function saveRowDraft(rowKey, stagedId, targetText, nextStatus) {
      const row = mergeRows().find((r) => r.rowKey === rowKey);
      if (!row) return null;
      const res = await apiPost("/review/api/update", {
        ...(stagedId ? { id: stagedId } : {}),
        targetText,
        ...(nextStatus ? { status: nextStatus } : {}),
        editedBy: "translator",
        sourceText: row.sourceText,
        sourceLanguage: row.sourceLanguage || "eng",
        targetLanguage: row.targetLanguage || "zho-CN",
        documentId: row.documentId || "",
        previewPartId: row.previewPartId || ""
      });
      state.dirtyTexts.delete(rowKey);
      return res.entry || null;
    }

    function readCustomRulesFromForm() {
      const box = document.getElementById("qaCustomRules");
      return Array.from(box.querySelectorAll("fieldset")).map((fs) => ({
        name: fs.querySelector("[data-name]").value.trim(),
        sourceContains: fs.querySelector("[data-source]").value,
        kind: fs.querySelector("select").value,
        value: fs.querySelector("[data-value]").value.trim()
      }));
    }

    function buildQaRequestPayload() {
      const scopeEl = document.querySelector('input[name="qaScope"]:checked');
      const scope = scopeEl ? scopeEl.value : "merged";
      const glossaryPath = document.getElementById("inpGlossaryPath").value.trim();
      const projectDir = document.getElementById("inpProjectDir").value.trim();
      const whitelistRaw = document.getElementById("inpWhitelist").value.trim();
      const whitelist = whitelistRaw
        ? whitelistRaw.split(/[\\r\\n,，]+/).map((s) => s.trim()).filter(Boolean)
        : [];
      const enabledRules = state.selectedRules ? Array.from(state.selectedRules) : undefined;
      const customRules = readCustomRulesFromForm();
      const selectedDoc = state.selectedDocumentId || (state.data && state.data.selectedDocumentId) || "";
      const isAllDocs = selectedDoc === "__all__";
      const docId = !isAllDocs
        ? (selectedDoc || (state.data && state.data.document && state.data.document.documentId) || "")
        : "";
      return {
        scope,
        ...(isAllDocs ? { allDocuments: true } : {}),
        ...(docId ? { documentId: docId } : {}),
        ...(enabledRules ? { enabledRules } : {}),
        ...(customRules.length > 0 ? { customRules } : {}),
        ...(glossaryPath ? { glossaryPath } : {}),
        ...(projectDir ? { projectDir } : {}),
        ...(whitelist.length ? { whitelist } : {})
      };
    }

    async function runQa() {
      if (state.qaRunning) return;
      let payload;
      try {
        payload = buildQaRequestPayload();
      } catch (err) {
        showBanner("err", "QA 参数错误: " + (err.message || err));
        return;
      }

      const topBtn = document.getElementById("btnRunQa");
      const formBtn = document.getElementById("btnRunQaForm");
      const statusEl = document.getElementById("qaStatusLine");
      state.qaRunning = true;
      topBtn.disabled = true;
      formBtn.disabled = true;
      topBtn.textContent = "检查中...";
      formBtn.textContent = "正在检查...";
      statusEl.textContent = "正在执行 QA 检查…";

      try {
        const report = await apiPost("/review/api/qa", payload);
        state.qa = report;
        state.qaLastPayload = payload;
        state.qaCollapsed.clear();
        document.getElementById("qaSearch").value = "";
        document.getElementById("qaSeverityFilter").value = "";
        document.getElementById("qaCategoryFilter").value = "";
        document.getElementById("qaOrderSelect").value = "file";

        const metaMap = new Map();
        for (const seg of (report.segments || [])) {
          const jumpKey = (seg.documentId && seg.previewPartId ? (seg.documentId + "::" + seg.previewPartId) : seg.previewPartId)
            || (seg.stagedId ? ("staged:" + seg.stagedId) : "");
          metaMap.set(seg.segmentKey, {
            segmentKey: seg.segmentKey,
            documentName: seg.documentName || report.document.documentName || "memoQ 文档",
            documentId: seg.documentId || report.document.documentId || "",
            previewPartId: seg.previewPartId || "",
            segmentNum: String(seg.docSegmentNumber || seg.segmentNumber),
            jumpKey,
            sourceLanguage: seg.sourceLanguage || report.document.sourceLanguage || "",
            targetLanguage: seg.targetLanguage || report.document.targetLanguage || ""
          });
        }

        const rows = [];
        for (const iss of (report.issues || [])) {
          const segMeta = metaMap.get(iss.segmentId) || {};
          if (!segMeta.ruleLabel) segMeta.ruleLabel = iss.ruleLabel;
          metaMap.set(iss.segmentId, segMeta);
          const jumpKey = (iss.documentId && iss.previewPartId ? (iss.documentId + "::" + iss.previewPartId) : iss.previewPartId)
            || (iss.stagedId ? ("staged:" + iss.stagedId) : "")
            || segMeta.jumpKey
            || "";
          metaMap.set(iss.segmentId + "::" + iss.ruleId, { ...segMeta, ruleLabel: iss.ruleLabel, jumpKey });
          rows.push({
            segmentKey: iss.segmentId,
            file: iss.documentName || report.document.documentName || "memoQ 文档",
            segment: String(iss.docSegmentNumber || iss.segmentNumber),
            source: iss.sourceText,
            target: iss.targetText,
            category: iss.category || "语言与风格扩展",
            severity: iss.severity,
            rule: iss.ruleId,
            message: iss.message,
            evidence: iss.evidence,
            ...(iss.suggestion ? { suggestion: iss.suggestion } : {}),
            ...(iss.highlights ? { highlights: iss.highlights } : {})
          });
        }
        state.qaMetaByKey = metaMap;
        state.qaRows = rows;

        renderHeader();
        renderReviewList();
        renderQaReport();
        switchTab("qa");
        showBanner(
          report.summary.totalIssues === 0 ? "ok" : "warn",
          "QA 完成：共检查 " + report.summary.totalSegments + " 段，检出 " + report.summary.totalIssues + " 项问题（MQM RQS = " + report.summary.mqm.rqs + "）。"
        );
      } catch (err) {
        statusEl.textContent = "QA 检查失败";
        showBanner("err", "QA 检查失败: " + (err.message || err));
      } finally {
        state.qaRunning = false;
        topBtn.disabled = false;
        formBtn.disabled = false;
        topBtn.textContent = "运行 QA 检查";
        formBtn.textContent = "运行检查";
      }
    }

    async function exportQaReport(format, btn) {
      if (!state.qa || btn.disabled) return;
      btn.disabled = true;
      try {
        const scopeVal = document.getElementById("qaExportScope").value;
        const chosen = scopeVal === "all"
          ? [...state.qaRows]
          : state.qaFilteredRows;
        const cleanRows = chosen.map((r) => ({
          ...(r.segmentKey ? { segmentKey: r.segmentKey } : {}),
          file: r.file,
          segment: r.segment,
          source: r.source,
          target: r.target,
          category: r.category,
          severity: r.severity,
          rule: r.rule,
          message: r.message,
          evidence: r.evidence,
          ...(r.highlights ? { highlights: r.highlights } : {})
        }));
        const files = (state.qa.documents && state.qa.documents.length > 0)
          ? state.qa.documents.map((d) => ({
              name: d.documentName || d.documentId,
              segments: d.segmentCount,
              incomplete: state.qa.summary.coverage === "incomplete"
            }))
          : [{
              name: state.qa.document.documentName || "memoQ 文档",
              segments: state.qa.summary.totalSegments,
              incomplete: state.qa.summary.coverage === "incomplete"
            }];
        const catalog = (state.data && state.data.qaCatalog) || [];
        const checkedLabels = state.selectedRules
          ? catalog.filter((c) => state.selectedRules.has(c.ruleId)).map((c) => c.label)
          : [];
        const activeTool = (state.qa && state.qa.tool) || (state.data && state.data.tool) || BOOT.tool;
        const toolPayload = activeTool && activeTool.name && activeTool.version
          ? { name: String(activeTool.name), version: String(activeTool.version) }
          : undefined;
        const payload = {
          rows: cleanRows,
          files,
          configuration: {
            aiqa: false,
            checks: checkedLabels
          },
          ...(toolPayload ? { tool: toolPayload } : {})
        };

        const res = await fetch("/review/api/qa/export/" + format, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || ("导出失败 HTTP " + res.status));
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "langlink-memoq-qa." + format;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showBanner("ok", "已导出 " + a.download + "（共 " + cleanRows.length + " 条记录）。");
      } catch (err) {
        showBanner("err", "导出失败: " + (err.message || err));
      } finally {
        btn.disabled = false;
      }
    }

    function switchTab(tab) {
      state.activeTab = tab;
      const isQa = tab === "qa";
      document.getElementById("tabBtnReview").classList.toggle("active", !isQa);
      document.getElementById("tabBtnQa").classList.toggle("active", isQa);
      document.getElementById("panelReview").classList.toggle("hidden", isQa);
      document.getElementById("panelQa").classList.toggle("hidden", !isQa);
      document.getElementById("filterPills").classList.toggle("hidden", isQa);
      document.getElementById("reviewToolbarSep").classList.toggle("hidden", isQa);
      document.getElementById("reviewSearchWrap").classList.toggle("hidden", isQa);
      document.getElementById("catWorkspace").classList.toggle("qa-mode", isQa);
      if (isQa) renderQaReport();
    }

    document.getElementById("docSelector").addEventListener("change", (ev) => {
      state.selectedDocumentId = ev.target.value || "";
      state.renderLimit = 300;
      void refreshState(false);
    });

    document.getElementById("btnRefresh").addEventListener("click", () => void refreshState(false));
    document.getElementById("btnRunQa").addEventListener("click", () => void runQa());
    document.getElementById("qaSettingsForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      void runQa();
    });
    document.getElementById("tabBtnReview").addEventListener("click", () => switchTab("review"));
    document.getElementById("tabBtnQa").addEventListener("click", () => switchTab("qa"));
    document.getElementById("btnToggleQaCfg").addEventListener("click", () => {
      switchTab("qa");
      const formEl = document.getElementById("qaSettingsForm");
      if (formEl && formEl.scrollIntoView) formEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    document.getElementById("btnToggleInspector").addEventListener("click", () => {
      state.inspectorOpen = !state.inspectorOpen;
      document.getElementById("catWorkspace").classList.toggle("inspector-collapsed", !state.inspectorOpen);
      document.getElementById("btnToggleInspector").classList.toggle("active-toggle", state.inspectorOpen);
    });

    document.getElementById("btnRulesDefault").addEventListener("click", () => {
      const cat = (state.data && state.data.qaCatalog) || [];
      state.selectedRules = new Set(cat.filter((r) => r.defaultEnabled).map((r) => r.ruleId));
      renderRulesCatalog();
    });
    document.getElementById("btnRulesAll").addEventListener("click", () => {
      const cat = (state.data && state.data.qaCatalog) || [];
      state.selectedRules = new Set(cat.map((r) => r.ruleId));
      renderRulesCatalog();
    });
    document.getElementById("btnRulesCritical").addEventListener("click", () => {
      const cat = (state.data && state.data.qaCatalog) || [];
      state.selectedRules = new Set(cat.filter((r) => r.severity === "critical").map((r) => r.ruleId));
      renderRulesCatalog();
    });

    document.getElementById("qaRuleGroupsContainer").addEventListener("change", (ev) => {
      const target = ev.target;
      if (!target || !target.classList || !target.classList.contains("qa-group-chk")) return;
      const gId = target.getAttribute("data-group");
      const groups = (state.data && state.data.qaRuleGroups) || [];
      const g = groups.find((x) => x.id === gId);
      if (!g) return;
      if (!state.selectedRules) state.selectedRules = new Set();
      for (const rid of g.rules) {
        if (target.checked) state.selectedRules.add(rid);
        else state.selectedRules.delete(rid);
      }
      for (const chk of document.querySelectorAll(".qa-rule-chk")) {
        chk.checked = state.selectedRules.has(chk.value);
      }
      syncGroupCheckboxesFromRules();
    });

    document.getElementById("qaRulesContainer").addEventListener("change", (ev) => {
      const target = ev.target;
      if (target && target.classList && target.classList.contains("qa-rule-chk")) {
        if (!state.selectedRules) state.selectedRules = new Set();
        if (target.checked) state.selectedRules.add(target.value);
        else state.selectedRules.delete(target.value);
        syncGroupCheckboxesFromRules();
      }
    });

    document.getElementById("btnAddCustomRule").addEventListener("click", () => {
      const box = document.getElementById("qaCustomRules");
      const addBtn = document.getElementById("btnAddCustomRule");
      if (box.children.length >= 20) return;
      const frag = document.getElementById("qaCustomRuleTpl").content.cloneNode(true);
      const fs = frag.querySelector("fieldset");
      fs.querySelector(".btn-remove-custom").addEventListener("click", () => {
        fs.remove();
        addBtn.disabled = false;
        addBtn.focus();
      });
      box.append(frag);
      addBtn.disabled = box.children.length >= 20;
      fs.querySelector("[data-name]").focus();
    });

    document.getElementById("qaAllSegments").addEventListener("change", () => renderQaSections());
    document.getElementById("qaSearch").addEventListener("input", () => renderQaSections());
    for (const id of ["qaFileFilter", "qaCategoryFilter", "qaSeverityFilter", "qaOrderSelect"]) {
      document.getElementById(id).addEventListener("change", () => renderQaSections());
    }
    for (const btn of document.querySelectorAll("button[data-qa-export]")) {
      btn.addEventListener("click", () => void exportQaReport(btn.getAttribute("data-qa-export"), btn));
    }

    document.getElementById("btnApproveAll").addEventListener("click", async () => {
      try {
        const docId = (state.data && state.data.document && state.data.document.documentId) || "";
        const res = await apiPost("/review/api/approve", { ...(docId ? { documentId: docId } : {}), status: "approved" });
        await refreshState(true);
        showBanner("ok", "已放行 " + res.approvedTotal + " 条最终定稿！请切回 memoQ 运行 Pre-translate 即可毫秒写入。");
      } catch (err) {
        showBanner("err", "放行失败: " + (err.message || err));
      }
    });

    document.getElementById("btnRevokeAll").addEventListener("click", async () => {
      try {
        const docId = (state.data && state.data.document && state.data.document.documentId) || "";
        const res = await apiPost("/review/api/approve", { ...(docId ? { documentId: docId } : {}), status: "draft" });
        await refreshState(true);
        showBanner("warn", "已将 " + res.draftTotal + " 条暂存退回为草稿锁定状态，memoQ 不会再拉取它们。");
      } catch (err) {
        showBanner("err", "撤回失败: " + (err.message || err));
      }
    });

    document.getElementById("btnCopyPrompt").addEventListener("click", async () => {
      const promptText = '请调用 memoq_list_staged({ status: "needs_revision", onlyWithComment: true }) 查看我在审校工作台里标注的修改意见，逐条按意见修订后更新暂存。';
      try {
        await navigator.clipboard.writeText(promptText);
        showBanner("rev", "已复制修订指令，粘贴回 DSH / WorkBuddy 对话框发送给 Agent 即可。");
      } catch {
        showBanner("rev", "请对 Agent 说：" + promptText);
      }
    });

    function activateFilter(filterKey) {
      state.filter = filterKey || "all";
      for (const el of document.querySelectorAll("#filterPills [data-filter]")) {
        el.classList.toggle("active", el.getAttribute("data-filter") === state.filter);
      }
      switchTab("review");
      renderReviewList();
    }

    document.getElementById("btnFilterMissed").addEventListener("click", () => activateFilter("missed_mt"));
    document.getElementById("btnFilterUntranslated").addEventListener("click", () => activateFilter("untranslated"));

    document.getElementById("btnCopyMissedPrompt").addEventListener("click", async () => {
      const promptText = "请调用 memoq_get_recent_mt_requests() 检查刚刚 memoQ Pre-translate 未命中的句段（deduplicatedMissed），逐条翻译并暂存放行；若带有 <span data-mqitag> 标签请务必原样保留。";
      try {
        await navigator.clipboard.writeText(promptText);
        showBanner("warn", "已复制补翻指令，粘贴回 DSH / WorkBuddy 对话框发送给 Agent 即可。");
      } catch {
        showBanner("warn", "请对 Agent 说：" + promptText);
      }
    });

    document.getElementById("btnClearMissed").addEventListener("click", async () => {
      try {
        const docId = state.selectedDocumentId || (state.data && state.data.document && state.data.document.documentId) || "";
        const res = await apiPost("/review/api/clear-missed", { ...(docId ? { documentId: docId } : {}) });
        if (state.filter === "missed_mt") activateFilter("all");
        await refreshState(true);
        showBanner("ok", "已清除 " + res.removed + " 条 Pre-translate 未命中告警记录。");
      } catch (err) {
        showBanner("err", "清除告警失败: " + (err.message || err));
      }
    });

    document.getElementById("filterPills").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-filter]");
      if (!btn) return;
      activateFilter(btn.getAttribute("data-filter") || "all");
    });

    document.getElementById("searchBox").addEventListener("input", (ev) => {
      state.search = ev.target.value || "";
      renderReviewList();
    });

    document.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t || !t.getAttribute) return;
      const rowKey = t.getAttribute("data-row");
      if (!rowKey) return;
      if (t.classList.contains("tgt-edit")) {
        state.dirtyTexts.set(rowKey, t.value);
        autoSizeTextarea(t);
      }
      if (t.classList.contains("cmt-edit")) {
        state.dirtyComments.set(rowKey, t.value);
      }
    });

    document.addEventListener("focusin", (ev) => {
      const card = ev.target && ev.target.closest ? ev.target.closest("[data-row-card]") : null;
      if (card) {
        const rk = card.getAttribute("data-row-card");
        if (rk && rk !== state.activeRowKey) {
          selectActiveRow(rk, false);
        }
      }
    });

    document.addEventListener("keydown", async (ev) => {
      const t = ev.target;
      if (!t || !t.classList || !t.classList.contains("tgt-edit")) return;
      const rowKey = t.getAttribute("data-row") || "";
      if (!rowKey) return;

      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
        ev.preventDefault();
        const card = t.closest("[data-row-card]");
        const saveBtn = card && card.querySelector(".btn-save-edit");
        const stagedId = (saveBtn && saveBtn.getAttribute("data-id")) || "";
        const keys = state.lastFilteredKeys || [];
        const curIdx = keys.indexOf(rowKey);
        const nextKey = curIdx >= 0 && curIdx + 1 < keys.length ? keys[curIdx + 1] : rowKey;
        try {
          await saveRowDraft(rowKey, stagedId, t.value, "approved");
          state.activeRowKey = nextKey;
          await refreshState(true);
          selectActiveRow(nextKey, true);
          showBanner("ok", "已放行当前句段并跳转到下一句。");
        } catch (err) {
          showBanner("err", "快捷放行失败: " + (err.message || err));
        }
        return;
      }

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        const card = t.closest("[data-row-card]");
        const saveBtn = card && card.querySelector(".btn-save-edit");
        const stagedId = (saveBtn && saveBtn.getAttribute("data-id")) || "";
        try {
          await saveRowDraft(rowKey, stagedId, t.value);
          await refreshState(true);
          selectActiveRow(rowKey, true);
          showBanner("ok", "已保存当前修订版本。");
        } catch (err) {
          showBanner("err", "保存失败: " + (err.message || err));
        }
        return;
      }

      if (ev.altKey && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
        ev.preventDefault();
        const keys = state.lastFilteredKeys || [];
        const curIdx = keys.indexOf(rowKey);
        if (curIdx < 0) return;
        const delta = ev.key === "ArrowDown" ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(keys.length - 1, curIdx + delta));
        selectActiveRow(keys[nextIdx], true);
      }
    });

    document.addEventListener("click", async (ev) => {
      const btnLoadMore = ev.target.closest("#btnLoadMoreRows");
      if (btnLoadMore) {
        state.renderLimit = (state.renderLimit || 300) + 300;
        renderReviewList();
        return;
      }

      const btnCopySrc = ev.target.closest(".btn-copy-source");
      if (btnCopySrc) {
        const rowKey = btnCopySrc.getAttribute("data-row") || "";
        const row = mergeRows().find((r) => r.rowKey === rowKey);
        if (!row) return;
        state.dirtyTexts.set(rowKey, row.sourceText);
        const card = document.querySelector('[data-row-card="' + CSS.escape(rowKey) + '"]');
        const ta = card && card.querySelector(".tgt-edit");
        if (ta) {
          ta.value = row.sourceText;
          autoSizeTextarea(ta);
          ta.focus();
        }
        showBanner("ok", "已复制原文到编辑框（可直接按 Ctrl+Enter 放行定稿，或修改后放行）。");
        return;
      }

      const btnFillMemoq = ev.target.closest("#btnFillMemoqTarget");
      if (btnFillMemoq) {
        const rowKey = btnFillMemoq.getAttribute("data-row") || "";
        const row = mergeRows().find((r) => r.rowKey === rowKey);
        if (!row || !row.memoqTargetText) return;
        state.dirtyTexts.set(rowKey, row.memoqTargetText);
        const card = document.querySelector('[data-row-card="' + CSS.escape(rowKey) + '"]');
        const ta = card && card.querySelector(".tgt-edit");
        if (ta) {
          ta.value = row.memoqTargetText;
          autoSizeTextarea(ta);
          ta.focus();
        }
        showBanner("ok", "已将 memoQ 实时译文填入编辑框（别忘了按 Ctrl+S 保存）。");
        return;
      }

      const btnFocus = ev.target.closest(".btn-focus");
      if (btnFocus) {
        try {
          const res = await apiPost("/review/api/focus", {
            previewPartId: btnFocus.getAttribute("data-part"),
            documentId: btnFocus.getAttribute("data-doc") || "",
            sourceText: btnFocus.getAttribute("data-src") || "",
            targetText: btnFocus.getAttribute("data-tgt") || ""
          });
          showBanner(res.ok ? "ok" : "warn", res.ok ? "已在 memoQ 编辑器中定位到该句段。" : ("定位未成功: " + (res.error || "未知原因")));
        } catch (err) {
          showBanner("err", "定位失败: " + (err.message || err));
        }
        return;
      }

      const btnSave = ev.target.closest(".btn-save-edit");
      if (btnSave) {
        const rowKey = btnSave.getAttribute("data-row") || "";
        const id = btnSave.getAttribute("data-id") || "";
        const card = btnSave.closest("[data-row-card]");
        const targetText = card.querySelector(".tgt-edit").value;
        try {
          await saveRowDraft(rowKey, id, targetText);
          await refreshState(true);
          showBanner("ok", "已保存修订版本。");
        } catch (err) {
          showBanner("err", "保存失败: " + (err.message || err));
        }
        return;
      }

      const btnRevert = ev.target.closest(".btn-revert");
      if (btnRevert) {
        const id = btnRevert.getAttribute("data-id");
        const rowKey = btnRevert.getAttribute("data-row") || "";
        const insp = document.getElementById("inspectorPane");
        const sel = insp && insp.querySelector(".rev-select");
        if (!id || !sel) return;
        try {
          await apiPost("/review/api/update", { id, revertToRevision: Number(sel.value), editedBy: "translator" });
          state.dirtyTexts.delete(rowKey);
          await refreshState(true);
          showBanner("ok", "已回退至 v" + sel.value + "。");
        } catch (err) {
          showBanner("err", "回退失败: " + (err.message || err));
        }
        return;
      }

      const btnFeedback = ev.target.closest(".btn-feedback");
      if (btnFeedback) {
        const rowKey = btnFeedback.getAttribute("data-row") || "";
        const id = btnFeedback.getAttribute("data-id") || "";
        const row = mergeRows().find((r) => r.rowKey === rowKey);
        if (!row) return;
        const cmtInput = document.getElementById("inspectorCommentInput");
        const comment = cmtInput ? cmtInput.value : "";
        const card = document.querySelector('[data-row-card="' + CSS.escape(rowKey) + '"]');
        const ta = card && card.querySelector(".tgt-edit");
        const currentTarget = ta ? ta.value : (row.staged ? row.staged.targetText : row.memoqTargetText);
        try {
          await apiPost("/review/api/feedback", {
            ...(id ? { id } : {}),
            comment,
            targetText: currentTarget,
            sourceText: row.sourceText,
            sourceLanguage: row.sourceLanguage || "eng",
            targetLanguage: row.targetLanguage || "zho-CN",
            documentId: row.documentId || "",
            previewPartId: row.previewPartId || ""
          });
          state.dirtyComments.delete(rowKey);
          await refreshState(true);
          showBanner("rev", "已提交修改批注，回到对话让 Agent 按批注修订即可。");
        } catch (err) {
          showBanner("err", "提交批注失败: " + (err.message || err));
        }
        return;
      }

      const btnApprove = ev.target.closest(".btn-toggle-approve");
      if (btnApprove) {
        const id = btnApprove.getAttribute("data-id");
        const nextStatus = btnApprove.getAttribute("data-next");
        try {
          await apiPost("/review/api/approve", { ids: [id], status: nextStatus });
          await refreshState(true);
          showBanner("ok", nextStatus === "approved" ? "该条译文已放行，memoQ Pre-translate 可立即拉取。" : "该条译文已撤回为草稿。");
        } catch (err) {
          showBanner("err", "状态切换失败: " + (err.message || err));
        }
        return;
      }

      const btnJump = ev.target.closest(".btn-jump-review");
      if (btnJump) {
        const rowKey = btnJump.getAttribute("data-row") || "";
        state.filter = "all";
        for (const el of document.querySelectorAll("#filterPills [data-filter]")) {
          el.classList.toggle("active", el.getAttribute("data-filter") === "all");
        }
        switchTab("review");
        renderReviewList();
        selectActiveRow(rowKey, true);
        return;
      }

      const clickedCard = ev.target.closest("[data-row-card]");
      if (clickedCard) {
        const rk = clickedCard.getAttribute("data-row-card");
        if (rk && rk !== state.activeRowKey) {
          selectActiveRow(rk, false);
        }
      }
    });

    setInterval(() => {
      const chk = document.getElementById("chkAutoPoll");
      if (!chk || !chk.checked) return;
      if (state.dirtyTexts.size > 0 || state.dirtyComments.size > 0) return;
      const active = document.activeElement;
      if (active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type === "text"))) return;
      void refreshState(true);
    }, 3000);

    void refreshState(false);
  </script>
</body>
</html>`;
}
