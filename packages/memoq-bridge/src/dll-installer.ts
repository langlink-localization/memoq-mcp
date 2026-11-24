import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import {
  CLIENT_DEV_CONFIG_NAME,
  LEGACY_PLUGIN_DLL_NAME,
  PLUGIN_DLL_NAME,
  defaultBridgeDataDir,
} from "./contract.ts";
import {
  DEFAULT_PLUGIN_DLL_MANIFEST,
  acceptedPluginSha256s,
  computeFileSha256,
  discoverLocalPluginDllCandidates,
  matchesAcceptedSha256,
  resolvePluginDllAsset,
  type DiscoveredDllCandidate,
  type ResolvedPluginDllAsset,
} from "./dll-assets.ts";
import { ensureRunnableHelperBinary } from "./helper-path.ts";

const execFileAsync = promisify(execFile);
const SUPPORTED_VERSIONS = ["12", "11", "10"] as const;

export const MEMOQ_FIRST_TIME_RESOURCE_STEPS: readonly string[] = [
  "完全关闭并重新启动 memoQ（memoQ 仅在启动时扫描 Addins 目录加载新插件）。",
  "首次使用需在 memoQ 中新建 MT 资源：打开 Resource Console（资源控制台）→ MT settings → Create new（选择 My Computer，填写名称如 memoQ AI Hub / LangLink）。",
  "编辑新建的 MT 资源：勾选启用 memoQ AI Hub 并点开设置（Options），确认 Gateway Base URL 为 http://127.0.0.1:5271、已勾选 Enable Gateway、Formatting Mode 保持 BothFormattingAndTags；同时在 MT 资源选项中启用 Pre-translation、Match and Patch、Send best fuzzy TM match 与 Self-learning MT 并保存。",
  "设为默认并启用到当前项目：在 Options → Default resources → MT settings 中勾选该资源（供新项目默认生效）；对于已经创建的项目，还必须在 Project home → Settings → MT settings 中勾选启用该资源，随后即可在 WorkBuddy 放行译文后通过 memoQ 的 Pre-translate 写入。",
];

export interface MemoQInstallationInfo {
  version: string;
  label: string;
  rootDir: string;
  addinsDir: string;
  pluginTarget: string;
  pluginInstalled: boolean;
  pluginSha256: string;
  sha256MatchesExpected: boolean;
  legacyPluginInstalled: boolean;
  status: "installed" | "needs_repair" | "not_installed";
  discoverySource?: "custom" | "running-process" | "registry" | "drive-scan" | "default";
}

export interface ClientDevConfigState {
  path: string;
  exists: boolean;
  loadUnsignedPluginsEnabled: boolean;
}

export interface IntegrationStatus {
  platform: string;
  status: "installed" | "needs_repair" | "not_installed" | "not_found" | "unsupported_platform";
  canReuseExisting: boolean;
  expectedPluginDllName: string;
  expectedPluginVersion: string;
  expectedPluginSha256: string;
  clientDevConfig: ClientDevConfigState;
  installations: MemoQInstallationInfo[];
  helperAvailable: boolean;
  helperPath: string | null;
}

export interface DetectIntegrationOptions {
  platform?: string;
  customInstallDir?: string;
  programDataDir?: string;
  defaultRoots?: Array<{ version: string; rootDir: string }>;
  expectedSha256?: string;
  dataDir?: string;
  packageRoot?: string;
  helperExecutablePath?: string;
  skipHostDiscovery?: boolean;
}

export function defaultMemoQRooDirs(): Array<{ version: string; rootDir: string }> {
  return SUPPORTED_VERSIONS.map((version) => ({
    version,
    rootDir: win32.join("C:\\Program Files", "memoQ", `memoQ-${version}`),
  }));
}

export function resolveClientDevConfigPath(programDataDir?: string): string {
  const base = (programDataDir ?? process.env.ProgramData ?? "C:\\ProgramData").trim();
  const pathImpl = win32.isAbsolute(base) ? win32 : { join };
  return pathImpl.join(base, "MemoQ", CLIENT_DEV_CONFIG_NAME);
}

export function readClientDevConfigState(programDataDir?: string): ClientDevConfigState {
  const filePath = resolveClientDevConfigPath(programDataDir);
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false, loadUnsignedPluginsEnabled: false };
  }
  try {
    const xml = readFileSync(filePath, "utf8");
    const match = /<LoadUnsignedPlugins>\s*([^<]*?)\s*<\/LoadUnsignedPlugins>/iu.exec(xml);
    const enabled = (match?.[1] ?? "").trim().toLowerCase() === "true";
    return { path: filePath, exists: true, loadUnsignedPluginsEnabled: enabled };
  } catch {
    return { path: filePath, exists: true, loadUnsignedPluginsEnabled: false };
  }
}

export function discoverWindowsMemoQRoots(
  helperPath: string | null,
): Array<{ version: string; rootDir: string; source: "running-process" | "registry" | "drive-scan" }> {
  if (!helperPath || !existsSync(helperPath)) {
    return [];
  }
  try {
    const stdout = execFileSync(helperPath, ["--discover-memoq"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim()) as {
      ok?: boolean;
      roots?: Array<{ version?: unknown; rootDir?: unknown; source?: unknown }>;
    };
    if (!parsed?.ok || !Array.isArray(parsed.roots)) {
      return [];
    }
    const results: Array<{ version: string; rootDir: string; source: "running-process" | "registry" | "drive-scan" }> = [];
    for (const entry of parsed.roots) {
      const rootDir = typeof entry?.rootDir === "string" ? entry.rootDir.trim() : "";
      if (!rootDir) continue;
      const version = typeof entry?.version === "string" && entry.version.trim() ? entry.version.trim() : "custom";
      const srcRaw = typeof entry?.source === "string" ? entry.source.trim() : "";
      const source: "running-process" | "registry" | "drive-scan" =
        srcRaw === "running-process" || srcRaw === "registry" || srcRaw === "drive-scan" ? srcRaw : "drive-scan";
      results.push({ version, rootDir, source });
    }
    return results;
  } catch {
    return [];
  }
}

export function isProtectedWindowsPath(targetPath: string, programDataDir?: string): boolean {
  const checkOne = (raw: string | undefined): boolean => {
    if (!raw || !raw.trim()) return false;
    const norm = raw.trim().replace(/\//gu, "\\").toLowerCase();
    const envProtected = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramData,
      process.env.SystemRoot,
      process.env.WINDIR,
    ]
      .filter((v): v is string => Boolean(v && v.trim()))
      .map((v) => v.trim().replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase());

    for (const base of envProtected) {
      if (norm === base || norm.startsWith(`${base}\\`)) {
        return true;
      }
    }
    return /^[a-z]:\\(?:program files(?: \(x86\))?|programdata|windows)(?:\\|$)/iu.test(norm);
  };

  return checkOne(targetPath) || (programDataDir ? checkOne(programDataDir) : false);
}

export function detectMemoQInstallations(options: DetectIntegrationOptions = {}): {
  clientDevConfig: ClientDevConfigState;
  installations: MemoQInstallationInfo[];
} {
  const platform = options.platform ?? process.platform;
  const clientDevConfig = readClientDevConfigState(options.programDataDir);
  const candidates: Array<{
    version: string;
    rootDir: string;
    source: MemoQInstallationInfo["discoverySource"];
  }> = [];
  const seen = new Set<string>();

  if (options.customInstallDir?.trim()) {
    const customRoot = options.customInstallDir.trim();
    const versionMatch = /memoq[-_\s]?(\d+)/iu.exec(basename(customRoot));
    candidates.push({ version: versionMatch?.[1] ?? "custom", rootDir: customRoot, source: "custom" });
  }

  if (options.defaultRoots !== undefined) {
    for (const item of options.defaultRoots) {
      candidates.push({ ...item, source: "default" });
    }
  } else {
    if (platform === "win32" && options.skipHostDiscovery !== true) {
      let helperPath: string | null = options.helperExecutablePath ?? null;
      if (!helperPath) {
        try {
          helperPath = ensureRunnableHelperBinary({
            ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
            ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
          });
        } catch {
          helperPath = null;
        }
      }
      for (const discovered of discoverWindowsMemoQRoots(helperPath)) {
        candidates.push({
          version: discovered.version,
          rootDir: discovered.rootDir,
          source: discovered.source,
        });
      }
    }
    for (const item of defaultMemoQRooDirs()) {
      candidates.push({ ...item, source: "default" });
    }
  }

  const installations: MemoQInstallationInfo[] = [];
  for (const candidate of candidates) {
    const normalizedKey = candidate.rootDir.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);

    const addinsDir = join(candidate.rootDir, "Addins");
    if (!existsSync(addinsDir)) continue;

    const pluginTarget = join(addinsDir, PLUGIN_DLL_NAME);
    const legacyTarget = join(addinsDir, LEGACY_PLUGIN_DLL_NAME);
    const pluginInstalled = existsSync(pluginTarget);
    const legacyPluginInstalled = existsSync(legacyTarget);
    const pluginSha256 = pluginInstalled ? computeFileSha256(pluginTarget) : "";
    const sha256MatchesExpected = Boolean(
      pluginInstalled && matchesAcceptedSha256(pluginSha256, options.expectedSha256),
    );

    let status: MemoQInstallationInfo["status"] = "not_installed";
    if (pluginInstalled && clientDevConfig.loadUnsignedPluginsEnabled && !legacyPluginInstalled) {
      status = "installed";
    } else if (pluginInstalled || legacyPluginInstalled || clientDevConfig.loadUnsignedPluginsEnabled) {
      status = "needs_repair";
    }

    installations.push({
      version: candidate.version,
      label: candidate.version === "custom" ? `memoQ (${basename(candidate.rootDir)})` : `memoQ ${candidate.version}`,
      rootDir: candidate.rootDir,
      addinsDir,
      pluginTarget,
      pluginInstalled,
      pluginSha256,
      sha256MatchesExpected,
      legacyPluginInstalled,
      status,
      ...(candidate.source === undefined ? {} : { discoverySource: candidate.source }),
    });
  }

  return { clientDevConfig, installations };
}

export function getIntegrationStatus(options: DetectIntegrationOptions = {}): IntegrationStatus {
  const platform = options.platform ?? process.platform;
  const expectedSha = (options.expectedSha256 ?? DEFAULT_PLUGIN_DLL_MANIFEST.sha256).trim().toUpperCase();
  const helperPath =
    platform === "win32"
      ? options.helperExecutablePath ??
        ensureRunnableHelperBinary({
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
          ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
        })
      : null;

  if (platform !== "win32") {
    return {
      platform,
      status: "unsupported_platform",
      canReuseExisting: false,
      expectedPluginDllName: PLUGIN_DLL_NAME,
      expectedPluginVersion: DEFAULT_PLUGIN_DLL_MANIFEST.version,
      expectedPluginSha256: expectedSha,
      clientDevConfig: { path: "", exists: false, loadUnsignedPluginsEnabled: false },
      installations: [],
      helperAvailable: false,
      helperPath: null,
    };
  }

  const { clientDevConfig, installations } = detectMemoQInstallations(options);
  const hasInstalled = installations.some((item) => item.status === "installed");
  const hasNeedsRepair = installations.some((item) => item.status === "needs_repair");

  const status: IntegrationStatus["status"] = hasInstalled
    ? "installed"
    : hasNeedsRepair
      ? "needs_repair"
      : installations.length > 0
        ? "not_installed"
        : "not_found";

  return {
    platform,
    status,
    canReuseExisting: hasInstalled,
    expectedPluginDllName: PLUGIN_DLL_NAME,
    expectedPluginVersion: DEFAULT_PLUGIN_DLL_MANIFEST.version,
    expectedPluginSha256: expectedSha,
    clientDevConfig,
    installations,
    helperAvailable: Boolean(helperPath),
    helperPath,
  };
}

export interface HelperInstallResult {
  ok: boolean;
  action: "install" | "uninstall";
  memoqRoot?: string;
  dllTarget?: string;
  dllSha256?: string;
  legacyRemoved?: boolean;
  clientDevConfigPath?: string;
  clientDevConfigCreated?: boolean;
  backupPath?: string;
  dllRemoved?: boolean;
  clientDevConfigAction?: string;
  error?: string;
}

async function runHelperCommand(
  helperPath: string,
  args: string[],
  resultFile: string,
): Promise<HelperInstallResult> {
  try {
    const { stdout } = await execFileAsync(helperPath, args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (existsSync(resultFile)) {
      return JSON.parse(readFileSync(resultFile, "utf8")) as HelperInstallResult;
    }
    const line = stdout.trim().split(/\r?\n/u).pop() ?? "";
    if (line) {
      return JSON.parse(line) as HelperInstallResult;
    }
    return { ok: false, action: "install", error: "Helper completed without output." };
  } catch (error: unknown) {
    if (existsSync(resultFile)) {
      try {
        return JSON.parse(readFileSync(resultFile, "utf8")) as HelperInstallResult;
      } catch {
        // Fall through to process error.
      }
    }
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const candidate = (err.stdout ?? "").trim().split(/\r?\n/u).pop() ?? "";
    if (candidate.startsWith("{")) {
      try {
        return JSON.parse(candidate) as HelperInstallResult;
      } catch {
        // Fall through.
      }
    }
    throw new Error(err.stderr?.trim() || err.message || "Helper execution failed.");
  } finally {
    if (existsSync(resultFile)) {
      rmSync(resultFile, { force: true });
    }
  }
}

export async function installPluginWithHelper(options: {
  memoqRoot: string;
  dllSource: string;
  dllSha256: string;
  programDataDir?: string;
  elevate?: boolean;
  dataDir?: string;
  packageRoot?: string;
  helperExecutablePath?: string;
}): Promise<HelperInstallResult> {
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const helperPath =
    options.helperExecutablePath ??
    ensureRunnableHelperBinary({
      dataDir,
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    });
  if (!helperPath) {
    throw new Error("MemoQ.Bridge.Helper.exe is not available.");
  }

  const resultsDir = join(dataDir, "tmp");
  mkdirSync(resultsDir, { recursive: true });
  const resultFile = join(resultsDir, `install-${randomUUID()}.json`);
  const programData = options.programDataDir ?? process.env.ProgramData ?? "C:\\ProgramData";

  const modeFlag = options.elevate ? "--elevate-install" : "--install-plugin";
  const args = [
    modeFlag,
    "--memoq-root",
    options.memoqRoot,
    "--dll-source",
    options.dllSource,
    "--dll-sha256",
    options.dllSha256,
    "--program-data",
    programData,
    "--result-file",
    resultFile,
  ];
  const result = await runHelperCommand(helperPath, args, resultFile);
  if (!result.ok) {
    throw new Error(result.error || "memoQ plugin installation failed.");
  }
  return result;
}

export async function uninstallPluginWithHelper(options: {
  memoqRoot: string;
  programDataDir?: string;
  elevate?: boolean;
  dataDir?: string;
  packageRoot?: string;
  helperExecutablePath?: string;
}): Promise<HelperInstallResult> {
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const helperPath =
    options.helperExecutablePath ??
    ensureRunnableHelperBinary({
      dataDir,
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    });
  if (!helperPath) {
    throw new Error("MemoQ.Bridge.Helper.exe is not available.");
  }

  const resultsDir = join(dataDir, "tmp");
  mkdirSync(resultsDir, { recursive: true });
  const resultFile = join(resultsDir, `uninstall-${randomUUID()}.json`);
  const programData = options.programDataDir ?? process.env.ProgramData ?? "C:\\ProgramData";

  const modeFlag = options.elevate ? "--elevate-uninstall" : "--uninstall-plugin";
  const args = [
    modeFlag,
    "--memoq-root",
    options.memoqRoot,
    "--program-data",
    programData,
    "--result-file",
    resultFile,
  ];
  const result = await runHelperCommand(helperPath, args, resultFile);
  if (!result.ok) {
    throw new Error(result.error || "memoQ plugin uninstallation failed.");
  }
  return result;
}

export interface PluginInstallPlanOptions extends DetectIntegrationOptions {
  dllPath?: string;
  searchDirs?: string[];
  includeDefaultUserDirs?: boolean;
  allowDownload?: boolean;
  allowUnverifiedLocalDev?: boolean;
}

export interface PluginInstallPlan {
  platform: string;
  operation: "copy";
  preservesOriginalSource: true;
  readyToInstall: boolean;
  alreadyInstalled: boolean;
  canReuseExisting: boolean;
  blockers: string[];
  expectedPluginDllName: string;
  expectedPluginVersion: string;
  expectedSha256: string;
  acceptedSha256s: string[];
  recommendedMemoqRoot: string | null;
  installations: MemoQInstallationInfo[];
  discoveredDlls: DiscoveredDllCandidate[];
  selectedDllCandidate: DiscoveredDllCandidate | null;
  willDownloadFromRelease: boolean;
  downloadUrl: string;
  firstTimeResourceSteps: string[];
  plannedChanges: {
    sourceDllPath: string | null;
    sourceKind: "dll" | "zip" | "release-download";
    targetDllPath: string | null;
    clientDevConfigPath: string;
    clientDevConfigAction: "already_enabled" | "create_new" | "backup_and_merge";
    removesLegacyDll: boolean;
    removesMotw: boolean;
    requiresElevation: boolean;
    expectedSha256: string;
  };
}

export interface ExecuteConfirmedInstallOptions extends DetectIntegrationOptions {
  confirmed?: boolean;
  memoqRoot?: string;
  dllPath?: string;
  downloadUrl?: string;
  allowDownload?: boolean;
  allowUnverifiedLocalDev?: boolean;
  searchDirs?: string[];
  includeDefaultUserDirs?: boolean;
  elevate?: boolean;
}

export interface ExecuteConfirmedInstallResult {
  ok: true;
  operation: "copy";
  preservesOriginalSource: true;
  sourceAsset: ResolvedPluginDllAsset;
  result: HelperInstallResult;
  integration: IntegrationStatus;
  nextSteps: string[];
}

export interface ExecuteConfirmedUninstallOptions extends DetectIntegrationOptions {
  confirmed?: boolean;
  memoqRoot?: string;
  elevate?: boolean;
}

export interface ExecuteConfirmedUninstallResult {
  ok: true;
  result: HelperInstallResult;
  integration: IntegrationStatus;
}

export function buildPluginInstallPlan(options: PluginInstallPlanOptions = {}): PluginInstallPlan {
  const integration = getIntegrationStatus(options);
  const platform = integration.platform;
  const acceptedShas = acceptedPluginSha256s(options.expectedSha256);
  const expectedSha256 = acceptedShas[0] ?? integration.expectedPluginSha256;
  const effectiveProgramData = options.programDataDir ?? process.env.ProgramData ?? "C:\\ProgramData";

  const extraFilePaths = integration.installations
    .filter((item) => item.pluginInstalled)
    .map((item) => item.pluginTarget);

  const discoveredDlls = discoverLocalPluginDllCandidates({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.dllPath === undefined ? {} : { dllPath: options.dllPath }),
    ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
    ...(options.searchDirs === undefined ? {} : { searchDirs: options.searchDirs }),
    extraFilePaths,
    includeDefaultUserDirs: options.includeDefaultUserDirs ?? options.skipHostDiscovery !== true,
  });

  const explicitDllPath = (options.dllPath ?? process.env.MEMOQ_PLUGIN_DLL_PATH ?? "").trim();
  const explicitResolved = explicitDllPath ? resolve(explicitDllPath) : "";
  const explicitCandidate = explicitResolved
    ? discoveredDlls.find(
        (c) =>
          (process.platform === "win32"
            ? c.path.toLowerCase() === explicitResolved.toLowerCase()
            : c.path === explicitResolved) || c.source === "explicit",
      ) ?? null
    : null;

  const selectedDllCandidate: DiscoveredDllCandidate | null = explicitDllPath
    ? explicitCandidate
    : discoveredDlls.find((c) => c.sha256MatchesExpected)
      ?? discoveredDlls.find((c) => c.kind === "zip" && c.sha256 === "")
      ?? null;

  const blockers: string[] = [];
  if (platform !== "win32") {
    blockers.push(`当前系统 (${platform}) 不支持安装 memoQ Desktop Windows 插件。`);
  }

  if (options.customInstallDir?.trim()) {
    const customAddins = join(options.customInstallDir.trim(), "Addins");
    if (!existsSync(customAddins)) {
      blockers.push(`指定的 memoQ 目录下未找到 Addins 子目录: ${customAddins}`);
    }
  }

  if (platform === "win32" && integration.installations.length === 0) {
    blockers.push(
      "未检测到 memoQ 安装目录（已检查运行中进程、注册表、本地磁盘及默认路径）。请提供 customInstallDir 或 memoqRoot。",
    );
  }

  if (explicitDllPath) {
    if (!existsSync(explicitResolved)) {
      blockers.push(`指定的 DLL / ZIP 路径不存在: ${explicitResolved}`);
    } else if (!explicitCandidate) {
      blockers.push(`指定文件不是有效的 ${PLUGIN_DLL_NAME} 或包含该 DLL 的 ZIP 包: ${explicitResolved}`);
    } else if (
      !options.allowUnverifiedLocalDev
      && explicitCandidate.kind === "dll"
      && !explicitCandidate.sha256MatchesExpected
    ) {
      blockers.push(
        `指定 DLL 的 SHA-256 (${explicitCandidate.sha256}) 与预期 (${acceptedShas.join(" or ")}) 不匹配。`,
      );
    }
  } else if (!selectedDllCandidate && options.allowDownload === false) {
    blockers.push(
      `本机未找到可用的 ${PLUGIN_DLL_NAME} 且禁用了在线下载（期望 SHA-256: ${expectedSha256}）。请提供本地 DLL/ZIP 的 dllPath。`,
    );
  }

  let recommendedInst: MemoQInstallationInfo | null = null;
  if (options.customInstallDir?.trim()) {
    const normCustom = options.customInstallDir.trim().toLowerCase();
    recommendedInst =
      integration.installations.find((item) => item.rootDir.toLowerCase() === normCustom)
      ?? null;
  }
  if (!recommendedInst) {
    recommendedInst =
      integration.installations.find((item) => item.status === "not_installed" || item.status === "needs_repair")
      ?? integration.installations[0]
      ?? null;
  }

  const recommendedMemoqRoot = recommendedInst?.rootDir ?? null;
  const targetDllPath = recommendedInst?.pluginTarget ?? null;
  const clientDevConfigAction: PluginInstallPlan["plannedChanges"]["clientDevConfigAction"] =
    !integration.clientDevConfig.exists
      ? "create_new"
      : integration.clientDevConfig.loadUnsignedPluginsEnabled
        ? "already_enabled"
        : "backup_and_merge";

  const requiresElevation = Boolean(
    platform === "win32"
      && recommendedMemoqRoot
      && isProtectedWindowsPath(recommendedMemoqRoot, effectiveProgramData),
  );

  const willDownloadFromRelease = !selectedDllCandidate && !explicitDllPath;

  return {
    platform,
    operation: "copy",
    preservesOriginalSource: true,
    readyToInstall: blockers.length === 0 && Boolean(recommendedMemoqRoot),
    alreadyInstalled: integration.status === "installed",
    canReuseExisting: integration.canReuseExisting,
    blockers,
    expectedPluginDllName: integration.expectedPluginDllName,
    expectedPluginVersion: integration.expectedPluginVersion,
    expectedSha256,
    acceptedSha256s: acceptedShas,
    recommendedMemoqRoot,
    installations: integration.installations,
    discoveredDlls,
    selectedDllCandidate,
    willDownloadFromRelease,
    downloadUrl: DEFAULT_PLUGIN_DLL_MANIFEST.downloadUrl,
    firstTimeResourceSteps: [...MEMOQ_FIRST_TIME_RESOURCE_STEPS],
    plannedChanges: {
      sourceDllPath: selectedDllCandidate?.path ?? null,
      sourceKind: selectedDllCandidate ? selectedDllCandidate.kind : "release-download",
      targetDllPath,
      clientDevConfigPath: integration.clientDevConfig.path,
      clientDevConfigAction,
      removesLegacyDll: Boolean(recommendedInst?.legacyPluginInstalled),
      removesMotw: true,
      requiresElevation,
      expectedSha256: selectedDllCandidate?.sha256 || expectedSha256,
    },
  };
}

export async function executeConfirmedPluginInstall(
  options: ExecuteConfirmedInstallOptions = {},
): Promise<ExecuteConfirmedInstallResult> {
  if (options.confirmed !== true) {
    throw new Error(
      "Confirmation required: present plannedChanges to the user and pass confirmed: true after explicit approval.",
    );
  }

  const integrationBefore = getIntegrationStatus({
    ...options,
    ...(options.memoqRoot?.trim() && !options.customInstallDir?.trim()
      ? { customInstallDir: options.memoqRoot.trim() }
      : {}),
  });
  if (integrationBefore.platform !== "win32") {
    throw new Error(`memoQ plugin installation is only supported on Windows (current: ${integrationBefore.platform}).`);
  }

  let targetRoot = options.memoqRoot?.trim() || options.customInstallDir?.trim() || "";
  if (targetRoot) {
    const addins = join(targetRoot, "Addins");
    if (!existsSync(addins)) {
      throw new Error(`memoQ Addins directory was not found: ${addins}`);
    }
  } else if (integrationBefore.installations.length === 1) {
    targetRoot = integrationBefore.installations[0]!.rootDir;
  } else if (integrationBefore.installations.length > 1) {
    throw new Error(
      `Detected multiple memoQ installations (${integrationBefore.installations.map((i) => i.rootDir).join(", ")}). Please specify memoqRoot explicitly.`,
    );
  } else {
    throw new Error("No memoQ installation directory was found (not_found). Please provide memoqRoot.");
  }

  const siblingDllPaths = integrationBefore.installations
    .filter((item) => item.pluginInstalled)
    .map((item) => item.pluginTarget);

  const sourceAsset = await resolvePluginDllAsset({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.helperExecutablePath === undefined ? {} : { helperExecutablePath: options.helperExecutablePath }),
    ...(options.dllPath === undefined ? {} : { dllPath: options.dllPath }),
    ...(options.downloadUrl === undefined ? {} : { downloadUrl: options.downloadUrl }),
    ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
    ...(options.allowDownload === undefined ? {} : { allowDownload: options.allowDownload }),
    ...(options.allowUnverifiedLocalDev === undefined
      ? {}
      : { allowUnverifiedLocalDev: options.allowUnverifiedLocalDev }),
    searchPaths: siblingDllPaths,
    ...(options.searchDirs === undefined ? {} : { searchDirs: options.searchDirs }),
    includeDefaultUserDirs: options.includeDefaultUserDirs ?? options.skipHostDiscovery !== true,
  });

  const effectiveProgramData = options.programDataDir ?? process.env.ProgramData ?? "C:\\ProgramData";
  const shouldElevate =
    options.elevate ?? isProtectedWindowsPath(targetRoot, effectiveProgramData);

  const baseInstallParams = {
    memoqRoot: targetRoot,
    dllSource: sourceAsset.path,
    dllSha256: sourceAsset.sha256,
    programDataDir: effectiveProgramData,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.helperExecutablePath === undefined
      ? {}
      : { helperExecutablePath: options.helperExecutablePath }),
  };

  let result: HelperInstallResult;
  try {
    result = await installPluginWithHelper({
      ...baseInstallParams,
      elevate: shouldElevate,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.elevate === undefined && !shouldElevate && /access|denied|unauthorized|permission/iu.test(message)) {
      result = await installPluginWithHelper({
        ...baseInstallParams,
        elevate: true,
      });
    } else {
      throw error;
    }
  }

  const integrationAfter = getIntegrationStatus({
    ...options,
    customInstallDir: targetRoot,
  });

  return {
    ok: true,
    operation: "copy",
    preservesOriginalSource: true,
    sourceAsset,
    result,
    integration: integrationAfter,
    nextSteps: [...MEMOQ_FIRST_TIME_RESOURCE_STEPS],
  };
}

export async function executeConfirmedPluginUninstall(
  options: ExecuteConfirmedUninstallOptions = {},
): Promise<ExecuteConfirmedUninstallResult> {
  if (options.confirmed !== true) {
    throw new Error(
      "Confirmation required: pass confirmed: true after explicit user approval to uninstall the memoQ plugin.",
    );
  }

  const integrationBefore = getIntegrationStatus({
    ...options,
    ...(options.memoqRoot?.trim() && !options.customInstallDir?.trim()
      ? { customInstallDir: options.memoqRoot.trim() }
      : {}),
  });
  if (integrationBefore.platform !== "win32") {
    throw new Error(`memoQ plugin uninstallation is only supported on Windows (current: ${integrationBefore.platform}).`);
  }

  let targetRoot = options.memoqRoot?.trim() || options.customInstallDir?.trim() || "";
  if (!targetRoot) {
    const installedRoots = integrationBefore.installations.filter((item) => item.pluginInstalled);
    if (installedRoots.length === 1) {
      targetRoot = installedRoots[0]!.rootDir;
    } else if (integrationBefore.installations.length === 1) {
      targetRoot = integrationBefore.installations[0]!.rootDir;
    } else if (installedRoots.length > 1) {
      throw new Error(
        `Detected multiple installed memoQ copies (${installedRoots.map((i) => i.rootDir).join(", ")}). Please specify memoqRoot explicitly.`,
      );
    } else {
      throw new Error("No memoQ installation directory was found (not_found). Please provide memoqRoot.");
    }
  }

  const effectiveProgramData = options.programDataDir ?? process.env.ProgramData ?? "C:\\ProgramData";
  const shouldElevate =
    options.elevate ?? isProtectedWindowsPath(targetRoot, effectiveProgramData);

  const result = await uninstallPluginWithHelper({
    memoqRoot: targetRoot,
    programDataDir: effectiveProgramData,
    elevate: shouldElevate,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.helperExecutablePath === undefined
      ? {}
      : { helperExecutablePath: options.helperExecutablePath }),
  });

  const integrationAfter = getIntegrationStatus({
    ...options,
    customInstallDir: targetRoot,
  });

  return {
    ok: true,
    result,
    integration: integrationAfter,
  };
}
