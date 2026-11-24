---
name: memoq-stage-translate
description: Translate or polish segments from memoQ Desktop using the current agent session and stage them into the local memoQ bridge for one-click Pre-translate pull inside memoQ (Direction A).
whenToUse: The user asks to translate, pre-translate, or polish segments from memoQ Desktop using this agent (Codex, WorkBuddy, etc.).
---

# memoQ 会话翻译暂存闭环（Direction A：memoq-stage-translate）

采用**「Agent 翻译并暂存 → 译员在 memoQ 点选或 Pre-translate 拉取 → 人工确认回流」**闭环，直接使用当前对话模型和上下文，不额外消耗外部 MT API Key。

## 执行流程

1. **检查状态与参考定稿**：
   - 调用 `memoq_status` 查看 Preview 状态与 `integration.status`。
   - 调用 `memoq_get_confirmed_translations` 读取译员近期在 memoQ 中确认的译文，保持前后用词和风格一致。
2. **读取待翻内容**：
   - 检查多文档与整项目视图：调用 `memoq_list_documents` 查看会话期间打开过的所有文档与拼接视图（`Create View -> Simply glue documents together` 可一次翻译整个项目全部文档）。
   - 单句润色/翻译：调用 `memoq_get_active_segment`（带前后上下文 `contextBefore=2, contextAfter=2`）。
   - 批量段落：使用 `memoq_get_document_segments({ onlyUntranslated: true, offset: 0, limit: 200 })` 分页读取（单页最高支持 `500`），按 `total` 遍历完所有 `offset` 批次，避免漏翻长列表末尾句段。
3. **翻译与暂存**：
   - 结合术语表、上下文和已确认译文完成高质量翻译；**在 `targetText` 中原样保留占位符（如 `{value}`、`%s`）、游戏伪标签（如 `<CN-Medium>...</>`）及换行 `\n`**，使桥接器在 Pre-translate 时可 0ms 确定性回填 `<span data-mqitag="...">`。
   - 调用 `memoq_stage_translations` 写入本地暂存池（注明 `documentId`、`previewPartId`、`sourceLanguage`、`targetLanguage`、`stagedBy`）。**默认以 `status: "draft"` 草稿状态暂存**，方便译员在审校工作台多轮检查与修订；若用户明确要求跳过审校直接可用，可传顶层参数 `status: "approved"`。
4. **审校、QA 体检与多轮修改闭环**：
   - 返回结果里的 `reviewLink`（或调用 `memoq_open_review`）可直接在浏览器打开「双语审校与 QA 工作台」。
   - 用户要对当前 memoQ 文档、跨多份打开文档（`allDocuments: true`）或暂存草稿做 QA 检查时，调用 `memoq_qa_document`（`scope` 可选 `memoq` / `staged` / `merged`），可结合 `.csv/.tbx` 术语表输出 23 条确定性规则问题与 MQM 评分，并在工作台中一键跳回 memoQ 对应句段。
   - 用户在工作台标出修改意见后，调用 `memoq_list_staged({ status: "needs_revision", onlyWithComment: true })` 读取 `reviewComment` 逐条改好后重新调用 `memoq_stage_translations`（自动记录修订版本 `v1→v2...`）。
5. **处理复杂格式或特殊内联标签句段**：
   - 若某句在 memoQ 中包含无法通过占位符对齐的格式标签（如 `<b>/<i>/<u>`）并被标签守卫记入 `memoq_get_recent_mt_requests`，调用 `memoq_get_recent_mt_requests({ onlyWithTags: true })` 获取 memoQ 发来的完整带标签 `text`（以及 `tmSource`/`tmTarget`），保留全部 `<span data-mqitag="...">` 和格式标签后通过 `sourceHtml` + `targetHtml` 重新暂存。
6. **按用户自定义标准放行定稿与漏翻兜底检查**：
   - 本工具不内置固定 AI 放行裁决。放行前，如用户尚未指定放行标准，先引导用户确认自己的质量门槛（例如：普通 QA 无 Critical/标签/占位符报错、术语与自定义规则通过、或在审校工作台完成人工抽检/通读）。
   - 若返回 `integrationReady: false`，调用 `memoq_setup` 给出本地安装引导页链接（切勿给用户发 PowerShell 脚本）。
   - 用户确认最终版后，可在工作台点击「一键放行全部定稿到 memoQ」或由 Agent 调用 `memoq_approve_staged` 将状态切为 `approved`，再回 memoQ 点击目标句段或运行 **Pre-translate** 即可毫秒级写入，人工确认后的译文会自动回流供下一批参考。
   - **必须汇报覆盖缺口**：调用 `memoq_approve_staged` 或 `memoq_status` 时务必检查返回的 `coverage`（`uncoveredPreviewCount` / `draftTotal` / `needsRevisionTotal` / `missedPretranslateCount`）；若有未覆盖或未放行句段，必须明确提醒用户。若 memoQ Pre-translate 弹窗提示部分句段出错/告警（往往是 Preview 未加载到末尾页之外的极短句或带标签句段），立即调用 `memoq_get_recent_mt_requests` 读取 `deduplicatedMissed`（或让用户在工作台顶部红色「Pre-translate 漏翻告警」横幅查看并点击「复制原文」/交由 Agent 补暂存并放行）。
