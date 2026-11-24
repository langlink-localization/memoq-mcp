import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  BRIDGE_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PLUGIN_DLL_NAME,
  defaultBridgeDataDir,
} from "./contract.ts";
import { formatReviewTool, sanitizeReviewTool, type ReviewToolInfo } from "@langlink/l10n-core/qa-review";
import { probeGatewayPort, type GatewayProbeResult } from "./daemon.ts";
import {
  DEFAULT_PLUGIN_DLL_MANIFEST,
  discoverLocalPluginDllCandidates,
  getPluginAssetCachePath,
  resolvePluginDllAsset,
} from "./dll-assets.ts";
import {
  getIntegrationStatus,
  installPluginWithHelper,
  uninstallPluginWithHelper,
  type DetectIntegrationOptions,
  type IntegrationStatus,
} from "./dll-installer.ts";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface SetupServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  packageRoot?: string;
  gatewayPort?: number;
  keepAlive?: boolean;
  elevate?: boolean;
  allowDownload?: boolean;
  allowOpenFolder?: boolean;
  detectOptions?: DetectIntegrationOptions;
  probeGateway?: (port?: number) => Promise<GatewayProbeResult>;
  resolveDll?: typeof resolvePluginDllAsset;
  tool?: ReviewToolInfo;
  onClose?: () => void;
}

export interface SetupServer {
  url: string;
  baseUrl: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  send(response, statusCode, "application/json; charset=utf-8", JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 1 MB limit.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks, size).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function renderSetupHtml(
  nonce: string,
  token: string,
  initialStatus: { integration: IntegrationStatus; gateway: GatewayProbeResult },
  toolLabel: string,
): string {
  const payloadJson = JSON.stringify({ token, initialStatus }).replace(/</gu, "\\u003c");
  const generatorMeta = toolLabel ? `\n  <meta name="generator" content="${escapeHtml(toolLabel)}" />` : "";
  const toolBadge = toolLabel
    ? `<span id="setup-tool-version" style="margin-left:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;">工具版本：${escapeHtml(toolLabel)}</span>`
    : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />${generatorMeta}
  <title>LangLink memoQ 连接器设置与诊断</title>
  <style>
    :root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --text: #111827; --muted: #4b5563; --border: #d1d5db; --accent: #1d4ed8; --ok: #15803d; --warn: #b45309; --err: #b91c1c; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --muted: #94a3b8; --border: #334155; --accent: #3b82f6; --ok: #4ade80; --warn: #fbbf24; --err: #f87171; }
    }
    body { margin: 0; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    main { max-width: 820px; margin: 24px auto; padding: 0 16px 40px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    .sub { color: var(--muted); margin: 0 0 20px; font-size: 14px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
    .card h2 { font-size: 16px; margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
    .badge { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
    .badge-title { font-size: 12px; color: var(--muted); }
    .badge-val { font-weight: 600; margin-top: 2px; }
    .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
    input[type="text"], select { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 13px; }
    button { cursor: pointer; border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 7px; padding: 8px 14px; font-size: 13px; font-weight: 600; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
    button.danger { color: var(--err); border-color: var(--err); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .notice { background: rgba(29, 78, 216, 0.08); border-left: 3px solid var(--accent); padding: 10px 12px; border-radius: 4px; font-size: 13px; margin: 10px 0; }
    .msg { margin-top: 12px; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border); font-size: 13px; display: none; }
    .msg.show { display: block; }
    details summary { cursor: pointer; font-weight: 600; font-size: 14px; }
    ol { padding-left: 20px; margin: 8px 0; }
  </style>
</head>
<body>
  <main>
    <h1>LangLink memoQ 连接器 — 安装与诊断向导</h1>
    <p class="sub">透明安装 · 零脚本黑框 · 仅在您点击按钮并确认系统 UAC 后写入下面列出的两个位置。${toolBadge}</p>

    <section class="card">
      <h2>1. 当前本机状态</h2>
      <div id="status-grid" class="grid"></div>
      <div class="row">
        <button id="btn-refresh" type="button">重新检测 / 验证连通性</button>
        <button id="btn-open-cache" type="button">打开本地插件缓存目录</button>
      </div>
    </section>

    <section class="card">
      <h2>2. 选择 memoQ 安装目录</h2>
      <div id="install-targets"></div>
      <div style="margin-top: 10px;">
        <label for="custom-dir" style="font-size: 13px; color: var(--muted);">或输入自定义 memoQ 根目录（包含 Addins 子目录）：</label>
        <input id="custom-dir" type="text" placeholder="例如 C:\\Program Files\\memoQ\\memoQ-12" />
      </div>
      <div style="margin-top: 10px;">
        <label for="custom-dll" style="font-size: 13px; color: var(--muted);">可选：指定本地 DLL 或 ZIP 路径（留空则自动查找或从 Release 下载）：</label>
        <input id="custom-dll" type="text" placeholder="例如 C:\\Users\\...\\Downloads\\MemoQ.AI.Hub.Plugin.dll" />
        <div id="discovered-dlls" style="font-size: 12px; color: var(--muted); margin-top: 6px;"></div>
      </div>
    </section>

    <section class="card">
      <h2>3. 透明变更清单（点击安装前请确认）</h2>
      <ol>
        <li>插件文件：<code>&lt;所选 memoQ 根目录&gt;\\Addins\\${escapeHtml(PLUGIN_DLL_NAME)}</code></li>
        <li>开发配置：<code>${escapeHtml(initialStatus.integration.clientDevConfig.path || "C:\\ProgramData\\MemoQ\\ClientDevConfig.xml")}</code>（若已存在则先备份 <code>.bak</code> 再增量合并 <code>&lt;LoadUnsignedPlugins&gt;true&lt;/LoadUnsignedPlugins&gt;</code>）</li>
      </ol>
      <div class="notice">
        <div><strong>期望 DLL 版本与校验值：</strong>v${escapeHtml(initialStatus.integration.expectedPluginVersion)} · SHA-256 <code>${escapeHtml(initialStatus.integration.expectedPluginSha256)}</code></div>
        <div style="margin-top: 4px;"><strong>安全承诺：</strong>不修改 Windows 注册表 · 不注册开机自启服务 · 不读取您的模型密钥。使用纯 .NET 原生拷贝并自动清除文件锁定标记（MOTW）。</div>
      </div>
      <div class="row">
        <button id="btn-install" class="primary" type="button">一键安装 / 修复到 memoQ</button>
        <button id="btn-uninstall" class="danger" type="button">卸载 / 还原配置</button>
      </div>
      <div id="action-msg" class="msg"></div>
    </section>

    <section class="card">
      <h2>4. 安装后首次配置（在 memoQ 中添加并启用 MT 资源）</h2>
      <ol>
        <li>完全关闭并重新启动 <strong>memoQ</strong>（memoQ 只在启动时扫描 <code>Addins</code> 目录加载新插件）。</li>
        <li>首次使用需新建 MT 资源：打开 <strong>Resource Console → MT settings → Create new</strong>（选择 <strong>My Computer</strong>，填写资源名称如 <code>memoQ AI Hub</code>），勾选启用 <strong>memoQ AI Hub</strong>。</li>
        <li>点击该资源设置（<strong>Options</strong>），确认 <strong>Gateway Base URL</strong> 为 <code>http://127.0.0.1:5271</code>、勾选 <strong>Enable Gateway</strong>、<strong>Formatting Mode</strong> 为 <code>BothFormattingAndTags</code>；并在资源功能中启用 <strong>Pre-translation</strong>、<strong>Match and Patch</strong>、<strong>Send best fuzzy TM match</strong> 与 <strong>Self-learning MT</strong>。</li>
        <li>在 <strong>Options → Default resources → MT settings</strong> 中设为默认；<strong>对于已有项目</strong>，还必须打开 <strong>Project home → Settings → MT settings</strong> 勾选启用该资源，才能使用 Pre-translate 写入译文。</li>
      </ol>
      <details style="margin-top: 12px;">
        <summary>企业限制无法 UAC 提权？查看手动安装 3 步方案</summary>
        <ol>
          <li>点击上方「打开本地插件缓存目录」，如尚未下载可先从 GitHub Release 下载 <code>${escapeHtml(PLUGIN_DLL_NAME)}</code>。</li>
          <li>右键 DLL 属性勾选「解除锁定」，复制到 memoQ 安装目录下的 <code>Addins</code> 文件夹。</li>
          <li>在 <code>C:\\ProgramData\\MemoQ\\ClientDevConfig.xml</code> 中确保包含 <code>&lt;ClientDevConfig&gt;&lt;LoadUnsignedPlugins&gt;true&lt;/LoadUnsignedPlugins&gt;&lt;/ClientDevConfig&gt;</code>，重启 memoQ 并按上方第 2–4 步添加 MT 资源。</li>
        </ol>
      </details>
    </section>
  </main>

  <script nonce="${escapeHtml(nonce)}">
    const BOOT = ${payloadJson};
    const token = BOOT.token;
    let currentState = BOOT.initialStatus;
    let selectedRoot = (currentState.integration.installations[0] && currentState.integration.installations[0].rootDir) || "";

    function esc(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function render(state) {
      currentState = state;
      const grid = document.getElementById("status-grid");
      const gw = state.gateway;
      const integ = state.integration;
      const gwText = gw.owner === "langlink-memoq-bridge"
        ? "已运行 (" + (gw.mode || "bridge") + ")"
        : gw.owner === "memoq-ai-hub"
          ? "memoQ AI Hub 正在使用 5271"
          : gw.owner === "free"
            ? "端口 5271 空闲（使用暂存/翻译时自动启动）"
            : "端口被其他程序占用";
      const gwClass = gw.owner === "langlink-memoq-bridge" ? "ok" : gw.owner === "other" ? "err" : "warn";
      const dllText = integ.status === "installed"
        ? "已安装（可直接复用）"
        : integ.status === "needs_repair"
          ? "部分就绪，需修复"
          : integ.status === "not_found"
            ? "未自动检测到 memoQ"
            : "未安装";
      const dllClass = integ.status === "installed" ? "ok" : integ.status === "not_found" ? "err" : "warn";
      const cfgText = integ.clientDevConfig.loadUnsignedPluginsEnabled ? "已允许加载未签名插件" : "尚未启用";
      const cfgClass = integ.clientDevConfig.loadUnsignedPluginsEnabled ? "ok" : "warn";

      grid.innerHTML = [
        '<div class="badge"><div class="badge-title">插件 DLL 状态</div><div class="badge-val ' + dllClass + '">' + dllText + '</div></div>',
        '<div class="badge"><div class="badge-title">ClientDevConfig.xml</div><div class="badge-val ' + cfgClass + '">' + cfgText + '</div></div>',
        '<div class="badge"><div class="badge-title">本地 MT 网关 (5271)</div><div class="badge-val ' + gwClass + '">' + gwText + '</div></div>'
      ].join("");

      const targetsEl = document.getElementById("install-targets");
      if (!integ.installations.length) {
        targetsEl.innerHTML = '<div style="font-size:13px;color:var(--muted);">未在默认目录检测到 memoQ 10/11/12，请在下方输入自定义路径。</div>';
      } else {
        if (!selectedRoot) selectedRoot = integ.installations[0].rootDir;
        targetsEl.innerHTML = integ.installations.map(function (item, idx) {
          const checked = item.rootDir === selectedRoot ? "checked" : "";
          const badge = item.status === "installed" ? "✅ 已安装" : item.status === "needs_repair" ? "⚠️ 需修复" : "未安装";
          return '<label style="display:block;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;cursor:pointer;">'
            + '<input type="radio" name="memoqRoot" value="' + esc(item.rootDir) + '" ' + checked + ' data-idx="' + idx + '" /> '
            + '<strong>' + esc(item.label) + '</strong> — <code>' + esc(item.rootDir) + '</code> (' + badge + ')'
            + '</label>';
        }).join("");
        targetsEl.querySelectorAll('input[name="memoqRoot"]').forEach(function (el) {
          el.addEventListener("change", function (ev) { selectedRoot = ev.target.value; });
        });
      }

      const dllsEl = document.getElementById("discovered-dlls");
      const dllList = state.discoveredDlls || [];
      if (dllsEl) {
        if (!dllList.length) {
          dllsEl.textContent = "未在本机常用目录预发现 DLL；点击安装时将自动通过 HTTP Range 仅拉取所需 DLL（约 150 KB，支持系统代理）并校验 SHA-256。";
        } else {
          dllsEl.innerHTML = "本机已发现可用包（点击可填入路径）：" + dllList.slice(0, 4).map(function (c, i) {
            const ok = c.sha256MatchesExpected ? "✅" : "⚠️";
            return '<button type="button" class="pick-dll" data-idx="' + i + '" style="margin:4px 6px 0 0;padding:3px 8px;font-size:12px;">' + ok + " " + esc(c.path) + "</button>";
          }).join("");
          dllsEl.querySelectorAll(".pick-dll").forEach(function (btn) {
            btn.addEventListener("click", function () {
              const item = dllList[Number(btn.getAttribute("data-idx"))];
              if (item) document.getElementById("custom-dll").value = item.path;
            });
          });
        }
      }
    }

    function showMessage(text, isError) {
      const box = document.getElementById("action-msg");
      box.textContent = text;
      box.className = "msg show " + (isError ? "err" : "ok");
    }

    function effectiveRoot() {
      const custom = document.getElementById("custom-dir").value.trim();
      return custom || selectedRoot;
    }

    async function api(path, method, body) {
      const sep = path.indexOf("?") >= 0 ? "&" : "?";
      const res = await fetch(path + sep + "token=" + encodeURIComponent(token), {
        method: method,
        headers: { "Content-Type": "application/json", "X-Setup-Token": token },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    }

    document.getElementById("btn-refresh").addEventListener("click", async function () {
      try {
        const custom = document.getElementById("custom-dir").value.trim();
        const data = await api("/api/status" + (custom ? "?customDir=" + encodeURIComponent(custom) : ""), "GET");
        render(data);
        showMessage("已刷新本机状态。", false);
      } catch (e) { showMessage(e.message, true); }
    });

    document.getElementById("btn-open-cache").addEventListener("click", async function () {
      try {
        const res = await api("/api/open-asset-dir", "POST", {});
        showMessage("缓存目录：" + res.dir, false);
      } catch (e) { showMessage(e.message, true); }
    });

    document.getElementById("btn-install").addEventListener("click", async function () {
      const root = effectiveRoot();
      if (!root) { showMessage("请先选择或输入 memoQ 安装目录。", true); return; }
      const dllPath = (document.getElementById("custom-dll").value || "").trim();
      const btn = document.getElementById("btn-install");
      btn.disabled = true;
      showMessage("正在准备 DLL 并等待系统 UAC 确认…", false);
      try {
        const payload = dllPath ? { memoqRoot: root, dllPath: dllPath } : { memoqRoot: root };
        const res = await api("/api/install", "POST", payload);
        render(res.status);
        showMessage("安装成功！DLL 校验值 " + res.result.dllSha256 + "。请完全重启 memoQ，并按第 4 节在 Resource Console 与当前项目中启用 memoQ AI Hub。", false);
      } catch (e) { showMessage("安装失败：" + e.message, true); }
      finally { btn.disabled = false; }
    });

    document.getElementById("btn-uninstall").addEventListener("click", async function () {
      const root = effectiveRoot();
      if (!root) { showMessage("请先选择或输入 memoQ 安装目录。", true); return; }
      const btn = document.getElementById("btn-uninstall");
      btn.disabled = true;
      try {
        const res = await api("/api/uninstall", "POST", { memoqRoot: root });
        render(res.status);
        showMessage("已卸载插件（ClientDevConfig 状态：" + res.result.clientDevConfigAction + "）。", false);
      } catch (e) { showMessage("卸载失败：" + e.message, true); }
      finally { btn.disabled = false; }
    });

    render(currentState);
  </script>
</body>
</html>`;
}

export async function startSetupServer(options: SetupServerOptions = {}): Promise<SetupServer> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? 0;
  const token = randomBytes(24).toString("hex");
  const gatewayPort = options.gatewayPort ?? DEFAULT_PORT;
  const probeGateway = options.probeGateway ?? ((p?: number) => probeGatewayPort(p ?? gatewayPort));
  const resolveDll = options.resolveDll ?? resolvePluginDllAsset;
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const tool = sanitizeReviewTool(options.tool) ?? { name: "@langlink/memoq-bridge", version: BRIDGE_VERSION };
  const toolLabel = formatReviewTool(tool);

  let actualPort = requestedPort;
  let expectedOrigin = "";
  let expectedHost = "";

  async function collectStatus(customInstallDir?: string) {
    const detectOpts: DetectIntegrationOptions = {
      ...options.detectOptions,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      ...(customInstallDir ? { customInstallDir } : {}),
    };
    const [integration, gateway] = await Promise.all([
      Promise.resolve(getIntegrationStatus(detectOpts)),
      probeGateway(gatewayPort),
    ]);
    const discoveredDlls = discoverLocalPluginDllCandidates({
      dataDir,
      ...(options.detectOptions?.expectedSha256 === undefined
        ? {}
        : { expectedSha256: options.detectOptions.expectedSha256 }),
      extraFilePaths: integration.installations.filter((i) => i.pluginInstalled).map((i) => i.pluginTarget),
      includeDefaultUserDirs: options.detectOptions?.skipHostDiscovery ? false : true,
    });
    return { integration, gateway, discoveredDlls };
  }

  let idleTimer: NodeJS.Timeout;

  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.host?.toLowerCase() !== expectedHost.toLowerCase()) {
        sendJson(response, 403, { error: "请通过本机安装引导页访问。" });
        return;
      }

      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      idleTimer.refresh();

      const url = new URL(request.url ?? "/", expectedOrigin);
      const method = (request.method ?? "GET").toUpperCase();
      const providedToken = request.headers["x-setup-token"]?.toString() ?? url.searchParams.get("token") ?? "";
      if (!providedToken || !constantTimeEquals(providedToken, token)) {
        sendJson(response, 401, { error: "缺少或无效的本机访问令牌，请通过 Agent 返回的链接打开。" });
        return;
      }

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/setup")) {
        const nonce = randomBytes(16).toString("base64");
        response.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';`,
        );
        const status = await collectStatus(url.searchParams.get("customDir") ?? undefined);
        send(response, 200, "text/html; charset=utf-8", renderSetupHtml(nonce, token, status, toolLabel));
        return;
      }

      if (method === "GET" && url.pathname === "/api/status") {
        const status = await collectStatus(url.searchParams.get("customDir") ?? undefined);
        sendJson(response, 200, status);
        return;
      }

      if (method !== "POST" || request.headers.origin?.toLowerCase() !== expectedOrigin.toLowerCase()) {
        sendJson(response, 403, { error: "写操作仅允许从本机设置页面发起。" });
        return;
      }

      const body = await readJson(request);

      if (url.pathname === "/api/install") {
        const memoqRoot = String(body.memoqRoot ?? "").trim();
        const dllPath = typeof body.dllPath === "string" ? body.dllPath.trim() : "";
        if (!memoqRoot) {
          sendJson(response, 400, { error: "memoqRoot 不能为空。" });
          return;
        }
        const currentIntegration = getIntegrationStatus({
          ...options.detectOptions,
          dataDir,
          ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
          customInstallDir: memoqRoot,
        });
        const siblingDllPaths = currentIntegration.installations
          .filter((item) => item.pluginInstalled)
          .map((item) => item.pluginTarget);
        const resolvedAsset = await resolveDll({
          dataDir,
          ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
          ...(options.detectOptions?.helperExecutablePath === undefined
            ? {}
            : { helperExecutablePath: options.detectOptions.helperExecutablePath }),
          ...(dllPath ? { dllPath } : {}),
          ...(options.allowDownload === undefined ? {} : { allowDownload: options.allowDownload }),
          ...(options.detectOptions?.expectedSha256 === undefined
            ? {}
            : { expectedSha256: options.detectOptions.expectedSha256 }),
          searchPaths: siblingDllPaths,
          includeDefaultUserDirs: !options.detectOptions?.skipHostDiscovery,
        });
        const elevate = options.elevate ?? (process.platform === "win32");
        const result = await installPluginWithHelper({
          memoqRoot,
          dllSource: resolvedAsset.path,
          dllSha256: resolvedAsset.sha256,
          elevate,
          dataDir,
          ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
          ...(options.detectOptions?.programDataDir === undefined
            ? {}
            : { programDataDir: options.detectOptions.programDataDir }),
          ...(options.detectOptions?.helperExecutablePath === undefined
            ? {}
            : { helperExecutablePath: options.detectOptions.helperExecutablePath }),
        });
        const status = await collectStatus(memoqRoot);
        sendJson(response, 200, { result, status });
        return;
      }

      if (url.pathname === "/api/uninstall") {
        const memoqRoot = String(body.memoqRoot ?? "").trim();
        if (!memoqRoot) {
          sendJson(response, 400, { error: "memoqRoot 不能为空。" });
          return;
        }
        const elevate = options.elevate ?? (process.platform === "win32");
        const result = await uninstallPluginWithHelper({
          memoqRoot,
          elevate,
          dataDir,
          ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
          ...(options.detectOptions?.programDataDir === undefined
            ? {}
            : { programDataDir: options.detectOptions.programDataDir }),
          ...(options.detectOptions?.helperExecutablePath === undefined
            ? {}
            : { helperExecutablePath: options.detectOptions.helperExecutablePath }),
        });
        const status = await collectStatus(memoqRoot);
        sendJson(response, 200, { result, status });
        return;
      }

      if (url.pathname === "/api/open-asset-dir") {
        const dir = dirname(getPluginAssetCachePath(dataDir, DEFAULT_PLUGIN_DLL_MANIFEST.version));
        mkdirSync(dir, { recursive: true });
        if (options.allowOpenFolder !== false && process.platform === "win32" && existsSync(dir)) {
          const child = spawn("explorer.exe", [dir], { detached: true, windowsHide: true, stdio: "ignore" });
          child.unref();
        }
        sendJson(response, 200, { dir });
        return;
      }

      sendJson(response, 404, { error: "Unknown setup route." });
    })().catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind setup wizard port.");
  }
  actualPort = addr.port;
  expectedHost = `${host}:${actualPort}`;
  expectedOrigin = `http://${expectedHost}`;

  const close = () =>
    new Promise<void>((resolve) => {
      clearTimeout(idleTimer);
      server.close(() => {
        options.onClose?.();
        resolve();
      });
    });

  idleTimer = setTimeout(() => {
    void close();
  }, IDLE_TIMEOUT_MS);
  if (!options.keepAlive) {
    idleTimer.unref();
  }

  return {
    url: `${expectedOrigin}/setup?token=${token}`,
    baseUrl: expectedOrigin,
    token,
    port: actualPort,
    close,
  };
}
