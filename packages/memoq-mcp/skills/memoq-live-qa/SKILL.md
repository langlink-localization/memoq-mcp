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
   - 直写前读取文档和句段。读取入口会在已连接但看不到文档时自动刷新一次。若仍为 `waiting_for_document`，告知“本次写入 0 句”，请用户切回目标文档并点一个译文句段。若用户已试过，提供 `desktopEditing` 诊断摘要，避免重复提示点击或重启。
   - 已有确定译文时，可以征得用户同意后暂存并走预翻译。需要参考全文的任务须等到可以读取原文和译文。
2. 检查当前句段或润色时，调用 `memoq_get_active_segment`。
   - **严格检查 `mappingCertain`**：若 `mappingCertain === false`（例如选中了多段或过滤器未推送活动段），必须向用户明确说明原因，不要凭猜测下结论。
   - 若用户要求检查整篇已缓存句段，分批调用 `memoq_get_document_segments`（`limit <= 50`），不要一次性拉取过多破坏上下文。
3. 运行普通 QA（确定性规则 + 术语表 + 自定义规则）：
   - 调用 `memoq_qa_document` 执行 23 条确定性规则、CSV/TBX 术语表检查以及用户自定义的 `customRules`（必含/禁用/长度上限），结合原文与译文证据给出具体校对和润色建议。
   - **引导用户自设放行标准**：本工具不内置自动 AI 放行裁决；如用户需要质量门禁，可引导其自行约定放行标准（例如：Critical/标签/占位符错误数为 0、术语表零漏用、特定 `customRules` 全通过、MQM 分数目标或人工在审校工作台逐条确认）。
   - **注意**：Preview 通道默认传递 `Minimal` 纯文本，不包含 memoQ 专有内联标签（inline tags）；如需处理带标签句段的回填，请结合 `memoq_get_recent_mt_requests` 获取完整 HTML 标签。
4. 若某句需要用户在 memoQ 中定位复核，调用 `memoq_focus_segment` 传入该句的 `previewPartId`，让 memoQ 编辑器直接跳转高亮到对应句段。
5. 用户要求直接应用修改时，使用 `memoq_apply_edits`。每次限定一个 `documentId`，每条携带 `previewPartId`、完整的 `expectedSource`、`expectedTarget` 和唯一匹配的 `oldText` / `newText`。同一短语重复出现时，扩大上下文。专名调序由 Agent 按原译对应关系匹配。
   - memoQ 保持前台，工具通过快速查找读取实际选区。局部文字修改应避开内联对象，单句删除显式传空 `newText`。
   - 按 `counts` 分别报告已写入并核对、原本已符合、冲突和未核实的句数。`conflict` 需结合现有译文重新判断。`blocked` 按返回原因检查活动文档、焦点、选区或输入法，再重新定位。`unverified` 可能已部分写入，先检查当前编辑器并读回，按实际差异修复。`not_attempted` 可在前项解决后继续。
   - 以实际探测结果判断能力。遇到不同版本或布局，优先复查控件及文档身份；只在目标和实际选区能够核实时提交修改。
