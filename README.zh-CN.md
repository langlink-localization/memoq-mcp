# memoq-mcp（`@langlink/memoq-mcp`）

[English](./README.md)

面向 **memoQ Desktop (10 / 11 / 12)** 的本地 Windows **MCP（Model Context Protocol）** 服务，支持 **Codex CLI**、**Claude Code**、**Cursor**、**WorkBuddy**、**ZCode** 与 **Trae**。

## 0.3.0 新功能：直接写回译文，无需点击「预翻译」

在 memoQ 中打开文档，就可以让 WorkBuddy 等 AI 助手批量润色已有译文、统一专名或修正 QA 问题。**改动直接写入当前文档，省去手动运行 Pre-translate 的步骤。**

> 把当前文档译文中【】里的专名改回对应原文，保留括号、已有标签和其余文字，直接写回 memoQ。

发出指令后，切回 memoQ 并在写入期间保持编辑器在前台。

助手先读取目标文档和句段，再进行修改。若已连接却看不到文档，工具会自动刷新一次；仍提示等待时，在文档里点一下译文句段。如果已经点过，可以让助手给出连接诊断摘要。工具会跳过与预期译文不符的句段，并在每次修改后回读核对。

## 核心功能

- **实时读取与跳转**：读取当前活动句段或分页拉取整篇文档/拼接视图（View），并支持一键定位跳转至 memoQ 编辑器对应句段。
- **翻译、校对与润色**：每批暂存 1–200 条草稿，支持多轮修订历史、审校批注回流，以及 `<span data-mqitag>` 内联标签自动保护与回填。
- **普通 QA 与术语检查**：内置 23 条确定性 QA 规则、CSV/TBX 术语表检查、最多 20 条自定义规则（必含 / 禁用 / 长度上限）及 MQM 评分，支持导出 Excel / CSV / HTML 报告。
- **本地双语工作台**：在浏览器中逐句查看、修改译文、查看漏翻提示并一键放行给 memoQ Pre-translate。

## 安装与配置

需要 **Windows**、**Node.js >= 22** 与 **memoQ Desktop (10 / 11 / 12)**。

### Codex CLI

```bash
codex mcp add memoq -- npx -y @langlink/memoq-mcp
```

### Claude Code

```bash
claude mcp add --scope user --transport stdio memoq -- npx -y @langlink/memoq-mcp
```

### WorkBuddy

1. 在运行 memoQ 的 Windows 电脑上打开 WorkBuddy「连接器 → 自定义连接器 → 配置 MCP」。
2. 将下方的 `memoq` 条目合并到界面显示的 `mcpServers` 中并保存。已有 `memoq` 时，只更新 `command` 和 `args`，保留 `env`、其他设置和其他连接器。
3. 启用 `memoq` 并确认没有红色失败状态。在 memoQ 打开文档和 Preview，然后在 WorkBuddy 的新本地会话里调用 `memoq_status`，确认 Preview 已连接且活动文档正确。

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

也可以用「配置 MCP」显示的实际路径自动写入。

```bash
npx -y @langlink/memoq-mcp config --client workbuddy --config-path "<配置 MCP 显示的路径>" --write
```

省略路径时，安装器只在能明确识别现有配置时写入，否则会打印配置供粘贴。列表为空时，先确认界面显示的文件里有 `mcpServers.memoq`。显示「连接已关闭」时，点该连接器的「复制日志」，根据首条启动错误检查 Node.js、`npx`、npm 下载或 MCP 握手。对话本身报网络错误时，可用 WorkBuddy 的诊断工具单独检查。

> WorkBuddy 内置独立子进程回收机制，本工具已自动使用独立后台守护进程（detached daemon），会话结束后本地审校工作台链接仍可正常打开和刷新。

### 其他 MCP 客户端（Cursor / ZCode / Trae）

自动输出或写入配置：

```bash
npx -y @langlink/memoq-mcp config --client codex
npx -y @langlink/memoq-mcp config --client claude
npx -y @langlink/memoq-mcp config --client all
```

## 首次配置 memoQ MT 插件（仅 Pre-translate 写入需要）

Preview 读取、跳转与普通 QA 无需安装插件即可直接使用。如需通过 **Pre-translate** 将暂存译文写入 memoQ：

1. 让 Agent 调用 `memoq_setup`（默认只读 `plan` 模式，自动定位 memoQ 目录与插件 DLL）。
2. 确认变更路径后执行安装（`action: "install", confirmed: true`），自动从 [memoq-ai-hub](https://github.com/langlink-localization/memoq-ai-hub) 获取并校验 SHA-256 后安装 `MemoQ.AI.Hub.Plugin.dll`。
3. 重启 **memoQ Desktop**。
4. 在 memoQ 中打开 **Resource Console → MT settings → Create new**（`My Computer`），勾选 **memoQ AI Hub**，确认 `Gateway Base URL` 为 `http://127.0.0.1:5271`，勾选 **Pre-translation / Match and Patch / Send best fuzzy TM match / Self-learning MT**。
5. 在 **Options → Default resources → MT settings** 及现有项目的 **Project home → Settings → MT settings** 中启用该资源。

## 工具列表（15）

| 工具名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `memoq_status` | 只读 | 检查 Preview 连接状态、活动文档、5271 端口、插件状态与暂存统计。 |
| `memoq_list_documents` | 只读 | 列出当前会话中已缓存的所有打开文档与拼接视图（View）。 |
| `memoq_get_active_segment` | 只读 | 读取当前聚焦句段、前后上下文、选中范围及 `mappingCertain`。 |
| `memoq_get_document_segments` | 只读 | 分页读取（`offset` / `nextOffset`）缓存句段，支持未译筛选与搜索。 |
| `memoq_focus_segment` | 写入 | 将 memoQ 编辑器高亮跳转至指定 `previewPartId`。 |
| `memoq_apply_edits` | 写入 | 在打开的译文中应用已审核的局部修改，核对句段身份、旧值及回读结果。 |
| `memoq_stage_translations` | 写入 | 批量暂存 1–200 条草稿译文，支持内联标签保护。 |
| `memoq_list_staged` | 只读 | 分页查看（`offset` / `nextOffset`）暂存译文、状态与审校批注。 |
| `memoq_open_review` | 只读 | 获取本地双语审校与 QA 工作台链接。 |
| `memoq_approve_staged` | 写入 | 放行已确认译文供 memoQ Pre-translate 拉取，或撤回为草稿。 |
| `memoq_qa_document` | 只读 | 运行 23 条确定性 QA 规则、自定义规则、术语检查与 MQM 评分。 |
| `memoq_clear_staged` | 危险 | 永久清空指定文档或全部暂存记录（需传 `confirmed: true`）。 |
| `memoq_get_confirmed_translations` | 只读 | 读取译员在 memoQ 中确认后回流的译文记录。 |
| `memoq_get_recent_mt_requests` | 只读 | 查看近期 Pre-translate 未命中记录、带标签句段及 TM 模糊提示。 |
| `memoq_setup` | 诊断 / 危险 | 诊断（`plan`）或安装/卸载（`confirmed: true`）memoQ MT 插件。 |

## 本地开发

需要 **Node.js >= 22.13** 与 **pnpm 12**。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm package:memoq-mcp
```

## 安全与开源协议

- 安全说明：[SECURITY.md](./SECURITY.md)
- 开源协议：[MIT](./LICENSE)
