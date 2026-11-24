# @langlink/memoq-mcp

Local Windows stdio MCP connector for **memoQ Desktop (10 / 11 / 12)** supporting Codex CLI, Claude Code, WorkBuddy, ZCode, and Trae. It provides Preview read/focus, a staged translation pool, confirmed writeback, and a visual setup wizard.

## Quick Config

```bash
npx -y @langlink/memoq-mcp config --client codex
npx -y @langlink/memoq-mcp config --client claude
npx -y @langlink/memoq-mcp config --client workbuddy --write
```

Or add manually in `~/.workbuddy/mcp.json` (preserving any existing connectors such as `langlink`):

```json
{
  "mcpServers": {
    "memoq": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "@langlink/memoq-mcp@latest"]
    }
  }
}
```

Register the server with Codex or Claude Code:

```bash
codex mcp add memoq -- npx -y @langlink/memoq-mcp
claude mcp add --scope user --transport stdio memoq -- npx -y @langlink/memoq-mcp
```

## Available Tools (14)

- `memoq_status` — inspect Preview connection, active document, multi-document cache summary, port `5271` owner, `100,000`-capacity staging pool, and DLL status.
- `memoq_list_documents` — list all open memoQ documents and glued Views cached during this Preview session with per-document segment and staging counts.
- `memoq_get_active_segment` — read active source/target, focused ranges, neighbor context, and `mappingCertain`.
- `memoq_get_document_segments` — read cached document segments. Pass `nextOffset` as `offset` with the same document and filters. The JSON text and `structuredContent` provide the same data.
- `memoq_focus_segment` — jump memoQ editor focus to a `previewPartId`.
- `memoq_stage_translations` — stage translations (`draft` by default for multi-round Review Workbench inspection, or `approved` for immediate memoQ Pre-translate).
- `memoq_list_staged` — inspect staged entries. `memoq_clear_staged` permanently deletes staged entries and their revision history. Pass `confirmed: true` after the user approves the document or all-document scope.
- `memoq_open_review` — open the token-authenticated local Review & QA Workbench (with document switcher for single/all loaded documents, multi-round editing, comments, and batch approval).
- `memoq_approve_staged` — approve final drafts (or revert to `draft`) before running memoQ Pre-translate.
- `memoq_qa_document` — run deterministic QA, MQM scoring, and terminology checks on cached memoQ content and staged drafts. The default response contains the full QA summary and up to 25 issues. Use `nextIssueOffset` as `issueOffset` to continue with the same options, or set `includeSegments: true` when you need full segment snapshots.
- `memoq_get_confirmed_translations` — read confirmed segments sent by memoQ `StoreTranslation`.
- `memoq_get_recent_mt_requests` — inspect recent missed or inline-tag MT requests from memoQ.
- `memoq_setup` — auto-discover memoQ paths & local DLL/ZIP assets (`action: "plan"`), fetch only the ~150 KB DLL slice via HTTP Range (with `.NET 4.8` Windows system-proxy fallback + SHA-256 verification) when no local package exists, present exact copy targets for user confirmation, install via verified helper (`action: "install", confirmed: true`), and return first-time memoQ MT resource setup instructions (`Resource Console → MT settings → Create new` + `Project home → Settings → MT settings`) or open the local visual setup wizard (`http://127.0.0.1:<port>/setup?token=...`).

## First-Time memoQ Setup

1. Ask your agent to run `memoq_setup` (it finds memoQ and fetches/verifies `MemoQ.AI.Hub.Plugin.dll` into `Addins` + enables `<LoadUnsignedPlugins>` after confirmation).
2. Restart **memoQ Desktop**.
3. Open **Resource Console → MT settings → Create new** (`My Computer`), tick **memoQ AI Hub**, verify `Gateway Base URL` (`http://127.0.0.1:5271`), `Enable Gateway`, `BothFormattingAndTags`, and enable **Pre-translation / Match and Patch / Send best fuzzy TM match / Self-learning MT**.
4. Enable the resource in **Options → Default resources → MT settings** and, for existing projects, **Project home → Settings → MT settings**.
