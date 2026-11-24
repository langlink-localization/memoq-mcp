---
name: memoq-live-qa
description: Read live source/target segments and document context from memoQ Desktop via Preview pipe, run deterministic QA (built-in rules, custom rules, terminology), proofread/polish translations, and jump memoQ focus to flagged segments.
whenToUse: The user asks to check, proofread, polish, QA, or inspect the active segment or document currently open in memoQ Desktop.
---

# memoQ 实时校对、润色与普通 QA（memoq-live-qa）

使用本地 Preview 通道读取当前 memoQ 编辑器内容——**无需安装 MT DLL、无需提权**。

## 执行流程

1. 先调用 `memoq_status` 检查 Preview 连接状态与当前打开的文档。
   - 若 `preview.connected === false`，提示用户先打开 memoQ 并打开文档；如 memoQ 弹出外部预览工具授权框，点击允许。
2. 检查当前句段或润色时，调用 `memoq_get_active_segment`。
   - **严格检查 `mappingCertain`**：若 `mappingCertain === false`（例如选中了多段或过滤器未推送活动段），必须向用户明确说明原因，不要凭猜测下结论。
   - 若用户要求检查整篇已缓存句段，分批调用 `memoq_get_document_segments`（`limit <= 50`），不要一次性拉取过多破坏上下文。
3. 运行普通 QA（确定性规则 + 术语表 + 自定义规则）：
   - 调用 `memoq_qa_document` 执行 23 条确定性规则、CSV/TBX 术语表检查以及用户自定义的 `customRules`（必含/禁用/长度上限），结合原文与译文证据给出具体校对和润色建议。
   - **引导用户自设放行标准**：本工具不内置自动 AI 放行裁决；如用户需要质量门禁，可引导其自行约定放行标准（例如：Critical/标签/占位符错误数为 0、术语表零漏用、特定 `customRules` 全通过、MQM 分数目标或人工在审校工作台逐条确认）。
   - **注意**：Preview 通道默认传递 `Minimal` 纯文本，不包含 memoQ 专有内联标签（inline tags）；如需处理带标签句段的回填，请结合 `memoq_get_recent_mt_requests` 获取完整 HTML 标签。
4. 若某句需要用户在 memoQ 中定位复核，调用 `memoq_focus_segment` 传入该句的 `previewPartId`，让 memoQ 编辑器直接跳转高亮到对应句段。
