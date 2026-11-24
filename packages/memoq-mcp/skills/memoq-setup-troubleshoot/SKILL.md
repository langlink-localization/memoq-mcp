---
name: memoq-setup-troubleshoot
description: Guide the user through safe Agent-assisted memoQ MT DLL discovery and confirm-before-copy setup, port 5271 coexistence with memoQ AI Hub, and Preview pipe troubleshooting without scary scripts.
whenToUse: The user asks how to connect memoQ, install the memoQ plugin DLL, or reports memoQ connection, port 5271, or Preview errors.
---

# memoQ 连接器安装与排错（memoq-setup-troubleshoot）

**禁止给用户粘贴 `powershell -ExecutionPolicy Bypass` 等提权脚本，禁止跳过用户确认直接写入 `Addins` 或 `ClientDevConfig.xml`。**

## 标准处理步骤

1. 先调用 `memoq_status` 获取完整诊断信息：
   - Preview 状态（`preview.state` / `preview.connected` / `preview.lastError`）
   - 端口 5271 归属（`port5271Owner`）
   - DLL 与 `ClientDevConfig.xml` 状态（`integration.status`）
2. **未安装或需要修复 DLL（Agent 找路径 → 确认 → 复制安装）**：
   - 若 `integration.canReuseExisting === true`：告知用户本机已有兼容的 `MemoQ.AI.Hub.Plugin.dll`，无需重复安装。若用户是首次使用本工具，仍需按下方第 3 步引导其在 memoQ 中新建并启用 `memoQ AI Hub` MT 资源。
   - 否则先调用只读预检：`memoq_setup({ action: "plan" })`（若用户提供了本地 `.dll` / `.zip` 路径或自定义 memoQ 目录，一并传入 `dllPath` / `customInstallDir`）。
   - 工具会自动探测运行中 `MemoQ.exe` 进程路径、Windows 注册表与本机盘符中的 memoQ 安装目录，以及常用目录中的 `MemoQ.AI.Hub.Plugin.dll` / 发布 `.zip` 包；若本机尚无安装包，正式安装时会自动通过 HTTP Range 仅从 GitHub Release 拉取所需 DLL 片段（约 150 KB，无需下载完整 140 MB 安装包；若 Node 直连受阻会自动调用走 Windows 系统代理的 `.NET 4.8` Helper 拉取）并严格校验 SHA-256。
   - **在对话中把 `plan.plannedChanges` 的精确内容列给用户确认**：
     1. 源文件路径与种类（复制安装，**保留原文件不删除**；在线拉取时说明仅提取 `MemoQ.AI.Hub.Plugin.dll`）及 SHA-256 校验值；
     2. 目标路径（`<memoqRoot>\Addins\MemoQ.AI.Hub.Plugin.dll`，自动清除 MOTW）；
     3. 配置变更（`C:\ProgramData\MemoQ\ClientDevConfig.xml`，如存在先备份 `.bak` 再启用 `LoadUnsignedPlugins`）；
     4. 若 `requiresElevation: true`，提前说明将触发一次系统原生 UAC 提权弹窗。
   - **等待用户明确回复确认后**，再调用 `memoq_setup({ action: "install", confirmed: true, memoqRoot, dllPath })` 执行受控 Helper 安装；也可同时附上返回的本地可视化向导链接作为备选兜底。
3. **首次在 memoQ 中添加并启用 MT 资源（安装后必做）**：
   - 完全关闭并重新启动 **memoQ**（memoQ 仅在启动时扫描 `Addins` 目录）。
   - 打开 **Resource Console（资源控制台）→ MT settings → Create new**，选择 **My Computer** 并填写资源名称（如 `memoQ AI Hub` 或 `LangLink`）。
   - 在引擎列表中勾选 **memoQ AI Hub** 并点开其设置（**Options**），核对：
     - **Gateway Base URL**：`http://127.0.0.1:5271`
     - **Enable Gateway**：勾选
     - **Formatting Mode**：`BothFormattingAndTags`
     - 同时在资源选项中启用 **Pre-translation**、**Match and Patch**、**Send best fuzzy TM match** 与 **Self-learning MT** 并保存。
   - 打开 **Options → Default resources → MT settings** 勾选该资源作为默认配置；**若用户已有打开的 memoQ 项目，务必再提醒打开 `Project home → Settings → MT settings` 勾选启用该资源**，否则运行 Pre-translate 时不会调用本地网关。
4. **端口 5271 被 `memoQ AI Hub` 占用**：
   - 若 `port5271Owner === "memoq-ai-hub"`：说明用户同时开着 `memoQ AI Hub` 桌面端。Preview 读写和跳转完全不受影响；如需使用本连接器的暂存池/Agent 翻译，请用户在两个方案中二选一：① 暂时关闭 `memoQ AI Hub`；② 在 memoQ 插件 Options 中把网关端口改为 `5272` 并配置环境变量 `MEMOQ_BRIDGE_PORT=5272`。
5. **Preview 连接不到或无文本**：
   - 确认 memoQ 已打开项目和具体文档（仅停留在项目仪表盘不会推送 Preview）。
   - 某些特殊过滤器不提供目标预览；如仅需读源文可正常工作，如需无损编辑复杂标签建议导出 `.mqxliff`。
