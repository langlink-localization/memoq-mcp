# memoq-mcp (`@langlink/memoq-mcp`)

[中文说明](./README.zh-CN.md)

A local Windows **Model Context Protocol (MCP)** server for **memoQ Desktop (10 / 11 / 12)**, built for **Codex CLI**, **Claude Code**, **Cursor**, **WorkBuddy**, **ZCode**, and **Trae**.

It connects AI coding and localization agents directly to your live memoQ Desktop session for **translation, proofreading, polishing, and deterministic QA** — reading Preview segments, staging draft translations with inline tag protection, running rule/glossary QA in a local bilingual Review Workbench, and releasing approved translations into memoQ via Pre-translate under **your own release criteria**.

## Customizing Your Release Criteria

`@langlink/memoq-mcp` intentionally does **not** ship a hardcoded AI auto-pass / release verdict. You stay in full control of what qualifies for release:

- **Deterministic QA & Custom Rules**: Configure built-in rules, CSV/TBX glossaries, whitelists, and up to 20 custom `required` / `forbidden` / `maxLength` rules via `memoq_qa_document` or the Review Workbench.
- **Agent-Guided Policy**: Define your own approval checklist in your Codex / Claude Code instructions (for example: *zero critical/tag/placeholder errors, glossary compliance, and human review of flagged segments before calling `memoq_approve_staged`*).
- **Human-in-the-Loop Workbench**: All translations are staged as `draft` by default and only released to memoQ Pre-translate after explicit user approval.

## Architecture

```text
Codex / Claude Code / MCP Client
        │  (stdio MCP)
        ▼
@langlink/memoq-mcp  ──▶  Local Detached Bridge Daemon (127.0.0.1:5271)
                              ├── Preview Pipe Client (MemoQ.Bridge.Helper.exe, .NET 4.8)
                              │       ↕ Bidirectional Preview Named Pipe
                              │   memoQ Desktop Editor (read segments, focus/jump)
                              ├── Local Review & QA Workbench (token-authenticated HTTP)
                              └── Local MT Gateway (/v1/mt/*)
                                      ↕ memoQ MT Plugin (MemoQ.AI.Hub.Plugin.dll)
                                  memoQ Pre-translate & StoreTranslation feedback
```

- **Preview-only mode** works out of the box with zero memoQ plugins (read active/document segments, jump to segment, run QA).
- **Stage-and-Pull translation mode** uses the open-source [memoQ AI Hub MT plugin](https://github.com/langlink-localization/memoq-ai-hub) (`MemoQ.AI.Hub.Plugin.dll`) installed safely via `memoq_setup` with SHA-256 verification and explicit user confirmation.

## Quick Start

### 1. Register the MCP Server

**Codex CLI**
```bash
codex mcp add memoq -- npx -y @langlink/memoq-mcp
```

**Claude Code**
```bash
claude mcp add --scope user --transport stdio memoq -- npx -y @langlink/memoq-mcp
```

**Generate or write config for supported clients**
```bash
npx -y @langlink/memoq-mcp config --client codex
npx -y @langlink/memoq-mcp config --client claude
npx -y @langlink/memoq-mcp config --client all
```

### 2. First-Time memoQ MT Plugin Setup (for Stage & Pre-translate)

1. Ask your agent to run `memoq_setup` (starts in read-only `action: "plan"` mode).
2. Review the exact file paths (`Addins\MemoQ.AI.Hub.Plugin.dll` and `ClientDevConfig.xml`) and confirm installation (`action: "install", confirmed: true`).
3. Restart **memoQ Desktop**.
4. In memoQ: **Resource Console → MT settings → Create new** (`My Computer`), enable **memoQ AI Hub**, confirm `Gateway Base URL` is `http://127.0.0.1:5271`, and enable **Pre-translation / Match and Patch / Send best fuzzy TM match / Self-learning MT**.
5. Enable the MT resource in **Options → Default resources → MT settings** and, for existing projects, **Project home → Settings → MT settings**.

## Available MCP Tools (14)

| Tool | Mode | Description |
| :--- | :--- | :--- |
| `memoq_status` | Read-only | Inspect Preview connection, active document, port `5271` owner, DLL status, and staged counts. |
| `memoq_list_documents` | Read-only | List all open memoQ documents and glued Views cached in Preview. |
| `memoq_get_active_segment` | Read-only | Read the currently focused segment, neighbor context, focused ranges, and `mappingCertain`. |
| `memoq_get_document_segments` | Read-only | Paginated (`offset` / `nextOffset`) read of cached Preview segments with filters. |
| `memoq_focus_segment` | Write (idempotent) | Jump memoQ Desktop editor selection to a specific `previewPartId`. |
| `memoq_stage_translations` | Write | Stage 1–200 draft translations (with inline `<span data-mqitag>` protection) for workbench review. |
| `memoq_list_staged` | Read-only | Paginated (`offset` / `nextOffset`) listing of staged entries, statuses, and translator comments. |
| `memoq_open_review` | Read-only | Return the token-authenticated local Review & QA Workbench URL. |
| `memoq_approve_staged` | Write (idempotent) | Release approved drafts to memoQ Pre-translate or retract them back to `draft`. |
| `memoq_qa_document` | Read-only | Run deterministic QA rules, MQM scoring, and CSV/TBX glossary checks with paginated issues. |
| `memoq_clear_staged` | Destructive | Permanently delete staged entries and revision history (requires `confirmed: true`). |
| `memoq_get_confirmed_translations` | Read-only | Read human-confirmed translations written back by memoQ `StoreTranslation`. |
| `memoq_get_recent_mt_requests` | Read-only | Inspect recent Pre-translate misses, inline-tag segments, and fuzzy TM hints. |
| `memoq_setup` | Plan / Destructive | Diagnose (`plan`) or safely install/uninstall (`confirmed: true`) the memoQ MT plugin DLL. |

## Development

Requires **Node.js >= 22.13** and **pnpm 12** (Windows + .NET SDK only needed if rebuilding `MemoQ.Bridge.Helper.exe`).

```bash
pnpm install
pnpm typecheck
pnpm test
```

### Rebuilding the Windows Helper (optional)
```powershell
pnpm build:memoq-helper
```

### Packaging the npm tarball
```bash
pnpm package:memoq-mcp
```

## Security & Compliance

See [SECURITY.md](./SECURITY.md). This repository contains **zero proprietary memoQ SDK binaries**; packaging enforces a strict denylist and emits `THIRD_PARTY_NOTICES.txt`.

## License

[MIT](./LICENSE) © 2026 LangLink
