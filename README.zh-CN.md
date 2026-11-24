# memoq-mcp（`@langlink/memoq-mcp`）

[English](./README.md)

面向 **memoQ Desktop (10 / 11 / 12)** 的本地 Windows **MCP（Model Context Protocol）** 连接器，支持 **Codex CLI**、**Claude Code**、**Cursor**、**WorkBuddy**、**ZCode** 与 **Trae**。

让 AI Agent 直接接入你正在使用的 memoQ Desktop，专注于 **翻译、校对、润色与普通 QA（确定性规则 + 术语表 + 自定义规则）**：实时读取 Preview 句段与上下文、定位跳转句段、将译文按草稿暂存并在本地双语审校与 QA 工作台检查，最终按**用户自己设定的放行标准**确认后一键放行给 memoQ Pre-translate 写入文档。

## 自定义放行标准

`@langlink/memoq-mcp` **不内置固定的 AI 自动放行判断**，将质量门禁完全交由用户自行掌控：

- **普通 QA 与自定义规则**：通过 `memoq_qa_document` 或工作台自由组合 23 条确定性规则、CSV/TBX 术语表、白名单与最多 20 条自定义规则（译文必含 / 禁用 / 长度上限）。
- **在 Agent 中约定自己的放行标准**：可在 Codex / Claude Code 的项目指令或对话中设定你的放行条件（例如：严重/标签/占位符错误为 0、术语零漏用、或人工在工作台通读确认后再放行）。
- **默认草稿隔离**：所有译文默认以 `draft` 状态暂存，只有经用户明确确认放行后才会被 memoQ Pre-translate 拉取。

## 快速配置

**Codex CLI**
```bash
codex mcp add memoq -- npx -y @langlink/memoq-mcp
```

**Claude Code**
```bash
claude mcp add --scope user --transport stdio memoq -- npx -y @langlink/memoq-mcp
```

**自动生成或写入客户端配置**
```bash
npx -y @langlink/memoq-mcp config --client codex
npx -y @langlink/memoq-mcp config --client claude
npx -y @langlink/memoq-mcp config --client workbuddy --write
```

## 首次配置 memoQ MT 插件（用于暂存与 Pre-translate 写入）

1. 让 Agent 调用 `memoq_setup`（默认 `action: "plan"` 只读诊断，自动定位 memoQ 安装目录并获取/校验 `MemoQ.AI.Hub.Plugin.dll`）。
2. 确认目标路径与 `ClientDevConfig.xml` 变更清单后，由 Agent 执行 `memoq_setup({ action: "install", confirmed: true, ... })`。
3. 重启 **memoQ Desktop**。
4. 在 memoQ 中打开 **Resource Console → MT settings → Create new**（`My Computer`），勾选 **memoQ AI Hub**，确认 `Gateway Base URL` 为 `http://127.0.0.1:5271`，勾选 **Pre-translation / Match and Patch / Send best fuzzy TM match / Self-learning MT**。
5. 在 **Options → Default resources → MT settings** 及当前项目的 **Project home → Settings → MT settings** 中启用该资源。

> 仅使用 Preview 读取、跳转与 QA 时，无需安装 MT 插件即可直接使用。

## 本地开发

需要 **Node.js >= 22.13** 与 **pnpm 12**。

```bash
pnpm install
pnpm typecheck
pnpm test
```

## 安全说明与开源协议

- 安全边界请见 [SECURITY.md](./SECURITY.md)。
- 本仓库采用 [MIT License](./LICENSE)，不包含任何 memoQ 专有 SDK 二进制文件。
