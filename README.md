# memoq-mcp (`@langlink/memoq-mcp`)

[中文说明](./README.zh-CN.md)

A local Windows **Model Context Protocol (MCP)** server for **memoQ Desktop (10 / 11 / 12)**, compatible with **Codex CLI**, **Claude Code**, **Cursor**, **WorkBuddy**, **ZCode**, and **Trae**.

Connect your AI agent to memoQ Desktop for **translation, proofreading, polishing, and deterministic QA** — read live Preview segments, jump to segments in the editor, stage drafts with inline tag protection, review in a local bilingual workbench, and write approved translations back via memoQ Pre-translate.

## Features

- **Live Preview Read & Focus**: Read active or paginated document segments (including glued Views) and jump memoQ editor focus to any segment.
- **Translation, Proofreading & Polishing**: Stage 1–200 segments per batch as drafts, iterate on translator comments in multiple rounds, and keep inline `<span data-mqitag>` tags intact.
- **Deterministic QA & Terminology**: Run 23 built-in QA rules, CSV/TBX glossary checks, up to 20 custom rules (`required` / `forbidden` / `maxLength`), and export reports to Excel, CSV, or HTML.
- **Local Review Workbench**: Inspect drafts side-by-side, edit translations, leave revision comments, and approve segments for memoQ Pre-translate.

## Installation

Requires **Windows**, **Node.js >= 22**, and **memoQ Desktop (10 / 11 / 12)**.

### Codex CLI

```bash
codex mcp add memoq -- npx -y @langlink/memoq-mcp
```

### Claude Code

```bash
claude mcp add --scope user --transport stdio memoq -- npx -y @langlink/memoq-mcp
```

### Other MCP Clients

Generate or write configuration automatically:

```bash
npx -y @langlink/memoq-mcp config --client codex
npx -y @langlink/memoq-mcp config --client claude
npx -y @langlink/memoq-mcp config --client all
```

Or add to your client's `mcp.json`:

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

## First-Time memoQ Setup (Optional for Preview, Required for Pre-translate)

Preview reading, segment focus, and QA work immediately with no plugin required. To write staged translations into memoQ via **Pre-translate**:

1. Ask your agent to run `memoq_setup` (starts in read-only `plan` mode to detect your memoQ directory and plugin DLL).
2. Review the target paths and confirm installation (`action: "install", confirmed: true`). This installs `MemoQ.AI.Hub.Plugin.dll` from [memoq-ai-hub](https://github.com/langlink-localization/memoq-ai-hub) with SHA-256 verification.
3. Restart **memoQ Desktop**.
4. In memoQ, open **Resource Console → MT settings → Create new** (`My Computer`), enable **memoQ AI Hub**, verify `Gateway Base URL` is `http://127.0.0.1:5271`, and enable **Pre-translation / Match and Patch / Send best fuzzy TM match / Self-learning MT**.
5. Enable the resource in **Options → Default resources → MT settings** (and **Project home → Settings → MT settings** for existing projects).

## Tools (14)

| Tool | Type | Description |
| :--- | :--- | :--- |
| `memoq_status` | Read | Check Preview connection, active document, port `5271` status, DLL status, and staged counts. |
| `memoq_list_documents` | Read | List open memoQ documents and glued Views cached in Preview. |
| `memoq_get_active_segment` | Read | Read the active segment, neighbor context, focused ranges, and `mappingCertain`. |
| `memoq_get_document_segments` | Read | Paginated read (`offset` / `nextOffset`) of cached Preview segments with filters. |
| `memoq_focus_segment` | Write | Jump memoQ editor selection to a specific `previewPartId`. |
| `memoq_stage_translations` | Write | Stage 1–200 draft translations with inline tag protection. |
| `memoq_list_staged` | Read | Paginated list (`offset` / `nextOffset`) of staged entries, statuses, and comments. |
| `memoq_open_review` | Read | Get the local URL for the bilingual Review & QA Workbench. |
| `memoq_approve_staged` | Write | Release staged translations to memoQ Pre-translate or retract them to `draft`. |
| `memoq_qa_document` | Read | Run deterministic QA rules, custom rules, glossary checks, and MQM scoring. |
| `memoq_clear_staged` | Destructive | Permanently delete staged entries and revision history (`confirmed: true`). |
| `memoq_get_confirmed_translations` | Read | Read translator-confirmed segments written back by memoQ `StoreTranslation`. |
| `memoq_get_recent_mt_requests` | Read | Inspect recent Pre-translate misses, inline-tag segments, and fuzzy TM hints. |
| `memoq_setup` | Plan / Destructive | Diagnose (`plan`) or install/uninstall (`confirmed: true`) the memoQ MT plugin DLL. |

## Development

Requires **Node.js >= 22.13** and **pnpm 12**.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm package:memoq-mcp
```

To rebuild the Windows `.NET 4.8` helper (`MemoQ.Bridge.Helper.exe`):

```powershell
pnpm build:memoq-helper
```

## Security & License

- Security details: [SECURITY.md](./SECURITY.md)
- License: [MIT](./LICENSE)
