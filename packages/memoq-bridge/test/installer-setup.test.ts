import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zipSync } from "fflate";
import { PLUGIN_DLL_NAME } from "../src/contract.ts";
import { probeGatewayPort } from "../src/daemon.ts";
import {
  DEFAULT_PLUGIN_DLL_MANIFEST,
  discoverLocalPluginDllCandidates,
  extractPluginDllFromBytes,
  parseAllowedAssetUrl,
  resolvePluginDllAsset,
} from "../src/dll-assets.ts";
import {
  MEMOQ_FIRST_TIME_RESOURCE_STEPS,
  buildPluginInstallPlan,
  executeConfirmedPluginInstall,
  executeConfirmedPluginUninstall,
  getIntegrationStatus,
  installPluginWithHelper,
  isProtectedWindowsPath,
  uninstallPluginWithHelper,
} from "../src/dll-installer.ts";
import { ensureRunnableHelperBinary } from "../src/helper-path.ts";
import { createMtGateway } from "../src/mt-gateway.ts";
import { startSetupServer } from "../src/setup-page.ts";
import { createStagingStore } from "../src/staging-store.ts";

const execFileAsync = promisify(execFile);

function fakePeBytes(tag: string): Uint8Array {
  return Buffer.from(`MZ_FAKE_DLL_${tag}`, "utf8");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

test("dll-assets verifies SHA-256, extracts from ZIP, and rejects non-https URLs", async () => {
  assert.throws(() => parseAllowedAssetUrl("http://example.com/plugin.zip"), /https/u);
  assert.equal(parseAllowedAssetUrl("http://127.0.0.1:8080/a.zip").hostname, "127.0.0.1");

  const dllBytes = fakePeBytes("v1");
  const expectedSha = sha256Hex(dllBytes);
  const zipped = zipSync({ [`resources/${PLUGIN_DLL_NAME}`]: dllBytes });
  const extracted = extractPluginDllFromBytes(zipped, expectedSha);
  assert.equal(extracted.sha256, expectedSha);

  assert.throws(() => extractPluginDllFromBytes(zipped, "0".repeat(64)), /SHA-256 mismatch/u);

  // Download from loopback test server
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/zip" });
    res.end(Buffer.from(zipped));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const dataDir = mkdtempSync(join(tmpdir(), "memoq-assets-"));
  try {
    const resolved = await resolvePluginDllAsset({
      dataDir,
      expectedSha256: expectedSha,
      downloadUrl: `http://127.0.0.1:${addr.port}/release.zip`,
      version: "1.0.99",
    });
    assert.equal(resolved.source, "downloaded");
    assert.equal(resolved.verified, true);
    assert.equal(existsSync(resolved.path), true);

    const cached = await resolvePluginDllAsset({
      dataDir,
      expectedSha256: expectedSha,
      version: "1.0.99",
      allowDownload: false,
    });
    assert.equal(cached.source, "cache");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("real MemoQ.Bridge.Helper.exe installs, preserves existing ClientDevConfig.xml with backup, verifies SHA-256, and uninstalls cleanly", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only C# helper binary test");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "memoq-inst-"));
  const dataDir = join(root, "bridge-data");
  const memoqRoot = join(root, "ProgramFiles", "memoQ", "memoQ-12");
  const addinsDir = join(memoqRoot, "Addins");
  const programDataDir = join(root, "ProgramData");
  const memoqProgramData = join(programDataDir, "MemoQ");
  mkdirSync(addinsDir, { recursive: true });
  mkdirSync(memoqProgramData, { recursive: true });

  const dllBytes = fakePeBytes("test-install");
  const dllSha = sha256Hex(dllBytes);
  const dllSource = join(root, PLUGIN_DLL_NAME);
  writeFileSync(dllSource, dllBytes);

  // Pre-existing legacy DLL + custom ClientDevConfig.xml
  writeFileSync(join(addinsDir, "MemoQ.AI.Desktop.Plugin.dll"), "legacy");
  const clientDevPath = join(memoqProgramData, "ClientDevConfig.xml");
  writeFileSync(
    clientDevPath,
    `<?xml version="1.0" encoding="utf-8"?>\n<ClientDevConfig>\n  <CustomSetting>keep-me</CustomSetting>\n  <LoadUnsignedPlugins>false</LoadUnsignedPlugins>\n</ClientDevConfig>`,
    "utf8",
  );

  try {
    // Reject wrong SHA-256 before touching target Addins
    await assert.rejects(
      () =>
        installPluginWithHelper({
          memoqRoot,
          dllSource,
          dllSha256: "F".repeat(64),
          programDataDir,
          elevate: false,
          dataDir,
        }),
      /SHA-256 mismatch/u,
    );
    assert.equal(existsSync(join(addinsDir, PLUGIN_DLL_NAME)), false);

    // Valid install
    const installRes = await installPluginWithHelper({
      memoqRoot,
      dllSource,
      dllSha256: dllSha,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.legacyRemoved, true);
    assert.equal(existsSync(join(addinsDir, PLUGIN_DLL_NAME)), true);
    assert.equal(existsSync(join(addinsDir, "MemoQ.AI.Desktop.Plugin.dll")), false);

    const updatedXml = readFileSync(clientDevPath, "utf8");
    assert.match(updatedXml, /<CustomSetting>keep-me<\/CustomSetting>/u);
    assert.match(updatedXml, /<LoadUnsignedPlugins>true<\/LoadUnsignedPlugins>/u);
    assert.ok(readdirSync(memoqProgramData).some((name) => name.startsWith("ClientDevConfig.xml.bak.")));

    // Integration status detects installed & reusable
    const status = getIntegrationStatus({
      platform: "win32",
      dataDir,
      programDataDir,
      expectedSha256: dllSha,
      defaultRoots: [{ version: "12", rootDir: memoqRoot }],
    });
    assert.equal(status.status, "installed");
    assert.equal(status.canReuseExisting, true);

    // Uninstall removes DLL and reverts LoadUnsignedPlugins while preserving CustomSetting
    const uninstallRes = await uninstallPluginWithHelper({
      memoqRoot,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(uninstallRes.ok, true);
    assert.equal(uninstallRes.dllRemoved, true);
    assert.equal(uninstallRes.clientDevConfigAction, "reverted_element_value");
    assert.equal(existsSync(join(addinsDir, PLUGIN_DLL_NAME)), false);
    const revertedXml = readFileSync(clientDevPath, "utf8");
    assert.match(revertedXml, /<CustomSetting>keep-me<\/CustomSetting>/u);
    assert.match(revertedXml, /<LoadUnsignedPlugins>false<\/LoadUnsignedPlugins>/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeGatewayPort distinguishes free, bridge, and memoQ AI Hub; setup-page enforces token and drives install", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only helper test");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "memoq-setup-"));
  const dataDir = join(root, "bridge-data");
  const memoqRoot = join(root, "memoQ-12");
  const programDataDir = join(root, "ProgramData");
  mkdirSync(join(memoqRoot, "Addins"), { recursive: true });
  mkdirSync(programDataDir, { recursive: true });

  const dllBytes = fakePeBytes("setup-page");
  const dllSha = sha256Hex(dllBytes);
  const dllSource = join(root, PLUGIN_DLL_NAME);
  writeFileSync(dllSource, dllBytes);

  const hubServer = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, productName: "memoQ AI Hub", contractVersion: "1", desktopVersion: "1.0.59" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
  const hubAddr = hubServer.address();
  assert.ok(hubAddr && typeof hubAddr !== "string");

  const bridgeGateway = await createMtGateway({
    port: 0,
    stagingStore: createStagingStore({ persist: false }),
  });

  const setup = await startSetupServer({
    dataDir,
    elevate: false,
    allowDownload: false,
    allowOpenFolder: false,
    gatewayPort: bridgeGateway.port,
    detectOptions: {
      platform: "win32",
      programDataDir,
      expectedSha256: dllSha,
      defaultRoots: [{ version: "12", rootDir: memoqRoot }],
    },
    tool: { name: "@langlink/memoq-mcp", version: "0.2.5" },
    resolveDll: async () => ({
      path: dllSource,
      sha256: dllSha,
      version: "1.0.7.0",
      source: "explicit",
      verified: true,
    }),
  });

  try {
    assert.equal((await probeGatewayPort(hubAddr.port)).owner, "memoq-ai-hub");
    assert.equal((await probeGatewayPort(bridgeGateway.port)).owner, "langlink-memoq-bridge");

    // Token enforcement
    const unauth = await fetch(`${setup.baseUrl}/api/status`);
    assert.equal(unauth.status, 401);

    const htmlRes = await fetch(setup.url);
    assert.equal(htmlRes.status, 200);
    const setupHtml = await htmlRes.text();
    assert.match(setupHtml, /LangLink memoQ 连接器/u);
    assert.match(setupHtml, /<meta name="generator" content="@langlink\/memoq-mcp@0\.2\.5" \/>/u);
    assert.match(setupHtml, /工具版本：@langlink\/memoq-mcp@0\.2\.5/u);
    assert.match(setupHtml, /Resource Console/u);
    assert.match(setupHtml, /Create new/u);
    assert.match(setupHtml, /Project home/u);
    assert.match(setupHtml, /BothFormattingAndTags/u);
    assert.match(setupHtml, /http:\/\/127\.0\.0\.1:5271/u);

    const statusWithCustomRes = await fetch(
      `${setup.baseUrl}/api/status?customDir=${encodeURIComponent(memoqRoot)}&token=${setup.token}`,
      { headers: { "X-Setup-Token": setup.token } },
    );
    assert.equal(statusWithCustomRes.status, 200);

    // Install via setup API
    const installRes = await fetch(`${setup.baseUrl}/api/install?token=${setup.token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: setup.baseUrl,
        "X-Setup-Token": setup.token,
      },
      body: JSON.stringify({ memoqRoot }),
    });
    assert.equal(installRes.status, 200);
    const installJson = (await installRes.json()) as {
      result: { ok: boolean; dllSha256: string };
      status: { integration: { status: string; clientDevConfig: { loadUnsignedPluginsEnabled: boolean } } };
    };
    assert.equal(installJson.result.ok, true);
    assert.equal(installJson.result.dllSha256, dllSha);
    assert.equal(installJson.status.integration.status, "installed");
    assert.equal(installJson.status.integration.clientDevConfig.loadUnsignedPluginsEnabled, true);
  } finally {
    await setup.close();
    await bridgeGateway.close();
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-version memoQ install tracks per-root entries and preserves ClientDevConfig.xml until the last copy uninstalls", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only C# helper binary test");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "memoq-multi-inst-"));
  const dataDir = join(root, "bridge-data");
  const memoqBase = join(root, "ProgramFiles", "memoQ");
  const root10 = join(memoqBase, "memoQ-10");
  const root11 = join(memoqBase, "memoQ-11");
  const root12 = join(memoqBase, "memoQ-12");
  const programDataDir = join(root, "ProgramData");
  mkdirSync(join(root10, "Addins"), { recursive: true });
  mkdirSync(join(root11, "Addins"), { recursive: true });
  mkdirSync(join(root12, "Addins"), { recursive: true });
  mkdirSync(join(programDataDir, "MemoQ"), { recursive: true });

  const dllBytes = fakePeBytes("multi-version");
  const dllSha = sha256Hex(dllBytes);
  const dllSource = join(root, PLUGIN_DLL_NAME);
  writeFileSync(dllSource, dllBytes);

  try {
    const res11 = await installPluginWithHelper({
      memoqRoot: root11,
      dllSource,
      dllSha256: dllSha,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(res11.ok, true);
    assert.equal(res11.clientDevConfigCreated, true);

    const res12 = await installPluginWithHelper({
      memoqRoot: root12,
      dllSource,
      dllSha256: dllSha,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(res12.ok, true);
    assert.equal(res12.clientDevConfigCreated, true);

    const clientDevPath = join(programDataDir, "MemoQ", "ClientDevConfig.xml");
    assert.equal(existsSync(clientDevPath), true);

    // Uninstalling an untracked memoQ-10 root must not touch ClientDevConfig.xml or tracked marker
    const uninstUntracked = await uninstallPluginWithHelper({
      memoqRoot: root10,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(uninstUntracked.ok, true);
    assert.equal(uninstUntracked.dllRemoved, false);
    assert.equal(uninstUntracked.clientDevConfigAction, "unchanged");
    assert.equal(existsSync(clientDevPath), true);

    // Uninstalling memoQ-12 while memoQ-11 remains installed must preserve ClientDevConfig.xml and memoQ-11's DLL
    const uninst12 = await uninstallPluginWithHelper({
      memoqRoot: root12,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(uninst12.ok, true);
    assert.equal(uninst12.dllRemoved, true);
    assert.equal(uninst12.clientDevConfigAction, "preserved_other_versions");
    assert.equal(existsSync(join(root12, "Addins", PLUGIN_DLL_NAME)), false);
    assert.equal(existsSync(join(root11, "Addins", PLUGIN_DLL_NAME)), true);
    assert.equal(existsSync(clientDevPath), true);

    // Uninstalling memoQ-11 as the last installed version cleanly deletes the created ClientDevConfig.xml
    const uninst11Last = await uninstallPluginWithHelper({
      memoqRoot: root11,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(uninst11Last.ok, true);
    assert.equal(uninst11Last.dllRemoved, true);
    assert.equal(uninst11Last.clientDevConfigAction, "deleted");
    assert.equal(existsSync(clientDevPath), false);

    // Re-install memoQ-11, then place an untracked sibling memoQ-10 copy; uninstalling memoQ-11 must still preserve ClientDevConfig.xml and retain the marker
    await installPluginWithHelper({
      memoqRoot: root11,
      dllSource,
      dllSha256: dllSha,
      programDataDir,
      elevate: false,
      dataDir,
    });
    const sibling10Dll = join(root10, "Addins", PLUGIN_DLL_NAME);
    writeFileSync(sibling10Dll, dllBytes);
    const uninst11WithSibling = await uninstallPluginWithHelper({
      memoqRoot: root11,
      programDataDir,
      elevate: false,
      dataDir,
    });
    const markerPath = join(programDataDir, "MemoQ", ".langlink-memoq-install.json");
    assert.equal(uninst11WithSibling.ok, true);
    assert.equal(uninst11WithSibling.dllRemoved, true);
    assert.equal(uninst11WithSibling.clientDevConfigAction, "preserved_other_versions");
    assert.equal(existsSync(clientDevPath), true);
    assert.equal(existsSync(markerPath), true);

    // Now uninstalling the remaining sibling memoQ-10 copy must apply the retained restore record and delete both ClientDevConfig.xml and the marker
    const uninst10Last = await uninstallPluginWithHelper({
      memoqRoot: root10,
      programDataDir,
      elevate: false,
      dataDir,
    });
    assert.equal(uninst10Last.ok, true);
    assert.equal(uninst10Last.dllRemoved, true);
    assert.equal(uninst10Last.clientDevConfigAction, "deleted");
    assert.equal(existsSync(clientDevPath), false);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MemoQ.Bridge.Helper.exe --spawn-detached enforces allowlist and launches daemon out-of-tree via WMI", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only C# helper WMI launcher test");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "memoq-wmi-spawn-"));
  const dataDir = join(root, "bridge-data");
  mkdirSync(dataDir, { recursive: true });
  const helperPath = ensureRunnableHelperBinary({ dataDir });
  assert.ok(helperPath, "expected MemoQ.Bridge.Helper.exe");

  const mcpEntrypoint = fileURLToPath(new URL("../../memoq-mcp/src/server.ts", import.meta.url));
  assert.equal(existsSync(mcpEntrypoint), true);

  let spawnedPid = 0;
  try {
    // 1. Reject non-node.exe executable
    const badExeSpec = join(dataDir, "bad-exe.json");
    writeFileSync(
      badExeSpec,
      JSON.stringify({
        executable: join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
        args: [mcpEntrypoint, "--memoq-bridge-daemon"],
      }),
      "utf8",
    );
    const badExeRes = spawnSync(helperPath, ["--spawn-detached", "--spec-file", badExeSpec], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(badExeRes.status, 0);
    assert.match(badExeRes.stdout, /node\.exe/iu);

    // 2. Reject disallowed worker flag
    const badFlagSpec = join(dataDir, "bad-flag.json");
    writeFileSync(
      badFlagSpec,
      JSON.stringify({
        executable: process.execPath,
        args: [mcpEntrypoint, "--unexpected-flag"],
      }),
      "utf8",
    );
    const badFlagRes = spawnSync(helperPath, ["--spawn-detached", "--spec-file", badFlagSpec], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(badFlagRes.status, 0);
    assert.match(badFlagRes.stdout, /Disallowed worker flag/iu);

    // 3. Valid detached daemon launch via WMI
    const readyFile = join(dataDir, "ready.json");
    const validSpec = join(dataDir, "valid-spawn.json");
    writeFileSync(
      validSpec,
      JSON.stringify({
        executable: process.execPath,
        args: [mcpEntrypoint, "--memoq-bridge-daemon", "--data-dir", dataDir, "--ready-file", readyFile, "--port", "0"],
        workingDirectory: dirname(mcpEntrypoint),
      }),
      "utf8",
    );

    const launchStdout = execFileSync(helperPath, ["--spawn-detached", "--spec-file", validSpec], {
      encoding: "utf8",
      windowsHide: true,
    });
    const launchJson = JSON.parse(launchStdout.trim()) as { ok: boolean; pid: number; method: string };
    assert.equal(launchJson.ok, true);
    assert.equal(launchJson.method, "wmi");
    assert.ok(Number.isInteger(launchJson.pid) && launchJson.pid > 0);
    spawnedPid = launchJson.pid;
    assert.equal(existsSync(validSpec), false, "helper must remove specFile after reading");

    let readyPayload: { port: number; host: string; controlToken: string } | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(readyFile)) {
        const parsed = JSON.parse(readFileSync(readyFile, "utf8")) as {
          ok: boolean;
          payload?: { port: number; host: string; controlToken: string };
          error?: string;
        };
        if (parsed.ok && parsed.payload) {
          readyPayload = parsed.payload;
          break;
        }
        if (!parsed.ok) {
          assert.fail(`WMI-spawned daemon reported error: ${parsed.error}`);
        }
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(readyPayload, "WMI-spawned daemon did not write readyFile in time");

    const healthRes = await fetch(`http://${readyPayload.host}:${readyPayload.port}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean; productName: string };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.productName, "LangLink memoQ Bridge");

    const parentIdOut = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${spawnedPid}").ParentProcessId`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    const parentPid = Number(parentIdOut);
    assert.ok(Number.isInteger(parentPid) && parentPid > 0 && parentPid !== process.pid);
  } finally {
    if (spawnedPid > 0) {
      spawnSync("taskkill", ["/PID", String(spawnedPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("discoverLocalPluginDllCandidates, buildPluginInstallPlan, and executeConfirmedPluginInstall preserve sources and require explicit confirmation", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only C# helper install/discovery test");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "memoq-agent-setup-"));
  const dataDir = join(root, "bridge-data");
  const downloadsDir = join(root, "Downloads");
  const memoqRoot = join(root, "CustomMemoQ", "memoQ-12");
  const addinsDir = join(memoqRoot, "Addins");
  const programDataDir = join(root, "ProgramData");
  mkdirSync(downloadsDir, { recursive: true });
  mkdirSync(addinsDir, { recursive: true });
  mkdirSync(join(programDataDir, "MemoQ"), { recursive: true });

  const dllBytes = fakePeBytes("agent-discovery-dll");
  const dllSha = sha256Hex(dllBytes);
  const dllInDownloads = join(downloadsDir, PLUGIN_DLL_NAME);
  writeFileSync(dllInDownloads, dllBytes);

  const zipBytes = zipSync({ [`memoq-integration/${PLUGIN_DLL_NAME}`]: dllBytes });
  const zipInDownloads = join(downloadsDir, "memoq-ai-hub-win32-x64.zip");
  writeFileSync(zipInDownloads, Buffer.from(zipBytes));

  try {
    // 1. Helper --discover-memoq returns valid JSON
    const helperPath = ensureRunnableHelperBinary({ dataDir });
    assert.ok(helperPath);
    const discoverOut = execFileSync(helperPath, ["--discover-memoq"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const discoverJson = JSON.parse(discoverOut.trim()) as { ok: boolean; roots: unknown[] };
    assert.equal(discoverJson.ok, true);
    assert.equal(Array.isArray(discoverJson.roots), true);

    // 2. isProtectedWindowsPath checks Program Files & ProgramData vs temp paths
    assert.equal(isProtectedWindowsPath("C:\\Program Files\\memoQ\\memoQ-12"), true);
    assert.equal(isProtectedWindowsPath("D:\\Custom\\memoQ-12", "C:\\ProgramData"), true);
    assert.equal(isProtectedWindowsPath(memoqRoot, programDataDir), false);

    // 3. discoverLocalPluginDllCandidates finds DLL and ZIP in searchDirs & honors compatibleSha256s
    const discovered = discoverLocalPluginDllCandidates({
      dataDir,
      expectedSha256: dllSha,
      searchDirs: [downloadsDir],
      includeDefaultUserDirs: false,
    });
    assert.ok(discovered.some((c) => c.path === dllInDownloads && c.kind === "dll" && c.sha256MatchesExpected));
    assert.ok(discovered.some((c) => c.path === zipInDownloads && c.kind === "zip" && c.sha256MatchesExpected));

    // Compatible SHA-256 check on manifest defaults
    const compatSha = DEFAULT_PLUGIN_DLL_MANIFEST.compatibleSha256s[1];
    assert.ok(compatSha);

    // 4. buildPluginInstallPlan discovers custom memoQ root + local DLL and refuses unconfirmed execution
    const plan = buildPluginInstallPlan({
      platform: "win32",
      dataDir,
      programDataDir,
      expectedSha256: dllSha,
      defaultRoots: [{ version: "12", rootDir: memoqRoot }],
      searchDirs: [downloadsDir],
      includeDefaultUserDirs: false,
      skipHostDiscovery: true,
      allowDownload: false,
    });
    assert.equal(plan.operation, "copy");
    assert.equal(plan.preservesOriginalSource, true);
    assert.equal(plan.readyToInstall, true);
    assert.equal(plan.recommendedMemoqRoot, memoqRoot);
    assert.equal(plan.plannedChanges.sourceDllPath, dllInDownloads);
    assert.equal(plan.plannedChanges.targetDllPath, join(addinsDir, PLUGIN_DLL_NAME));
    assert.equal(plan.plannedChanges.requiresElevation, false);

    await assert.rejects(
      () =>
        executeConfirmedPluginInstall({
          confirmed: false,
          platform: "win32",
          dataDir,
          programDataDir,
          expectedSha256: dllSha,
          memoqRoot,
          dllPath: dllInDownloads,
          defaultRoots: [{ version: "12", rootDir: memoqRoot }],
          skipHostDiscovery: true,
          allowDownload: false,
        }),
      /Confirmation required/u,
    );
    assert.equal(existsSync(join(addinsDir, PLUGIN_DLL_NAME)), false);

    // 5. Confirmed install from local DLL copies without deleting source
    const installedFromDll = await executeConfirmedPluginInstall({
      confirmed: true,
      platform: "win32",
      dataDir,
      programDataDir,
      expectedSha256: dllSha,
      memoqRoot,
      dllPath: dllInDownloads,
      defaultRoots: [{ version: "12", rootDir: memoqRoot }],
      skipHostDiscovery: true,
      allowDownload: false,
    });
    assert.equal(installedFromDll.ok, true);
    assert.equal(installedFromDll.operation, "copy");
    assert.equal(existsSync(dllInDownloads), true, "original DLL must remain preserved");
    assert.equal(existsSync(join(addinsDir, PLUGIN_DLL_NAME)), true);
    assert.equal(installedFromDll.integration.status, "installed");

    // 6. Uninstall enforces confirmation then cleans up
    await assert.rejects(
      () =>
        executeConfirmedPluginUninstall({
          confirmed: false,
          platform: "win32",
          dataDir,
          programDataDir,
          memoqRoot,
          defaultRoots: [{ version: "12", rootDir: memoqRoot }],
          skipHostDiscovery: true,
        }),
      /Confirmation required/u,
    );
    const uninstalled = await executeConfirmedPluginUninstall({
      confirmed: true,
      platform: "win32",
      dataDir,
      programDataDir,
      memoqRoot,
      defaultRoots: [{ version: "12", rootDir: memoqRoot }],
      skipHostDiscovery: true,
    });
    assert.equal(uninstalled.ok, true);
    assert.equal(existsSync(join(addinsDir, PLUGIN_DLL_NAME)), false);

    // 7. Confirmed install directly from local ZIP extracts cleanly & preserves original ZIP
    const installedFromZip = await executeConfirmedPluginInstall({
      confirmed: true,
      platform: "win32",
      dataDir,
      programDataDir,
      expectedSha256: dllSha,
      memoqRoot,
      dllPath: zipInDownloads,
      defaultRoots: [{ version: "12", rootDir: memoqRoot }],
      skipHostDiscovery: true,
      allowDownload: false,
    });
    assert.equal(installedFromZip.ok, true);
    assert.equal(existsSync(zipInDownloads), true, "original ZIP must remain preserved");
    assert.equal(existsSync(join(addinsDir, PLUGIN_DLL_NAME)), true);
    assert.ok(installedFromZip.nextSteps.some((step) => step.includes("Resource Console")));
    assert.ok(installedFromZip.nextSteps.some((step) => step.includes("Project home")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEFAULT_PLUGIN_DLL_MANIFEST pins v1.0.59 release DLL SHA-256 and includes first-time resource steps", () => {
  assert.equal(
    DEFAULT_PLUGIN_DLL_MANIFEST.sha256,
    "BB8250B5EFB6F742E1F10DA43E40008EB5DC04587B5DBA262AEAB0F7B7F5545E",
  );
  assert.ok(
    DEFAULT_PLUGIN_DLL_MANIFEST.compatibleSha256s.includes(
      "BB8250B5EFB6F742E1F10DA43E40008EB5DC04587B5DBA262AEAB0F7B7F5545E",
    ),
  );
  assert.ok(MEMOQ_FIRST_TIME_RESOURCE_STEPS.some((step) => step.includes("Resource Console")));
  assert.ok(MEMOQ_FIRST_TIME_RESOURCE_STEPS.some((step) => step.includes("Project home")));
});

test("resolvePluginDllAsset uses HTTP Range partial-ZIP download and fast local ZIP hashing", async (t) => {
  const dummyLargePayload = randomBytes(2 * 1024 * 1024);
  const dllBytes = fakePeBytes("range-and-fast-zip");
  const expectedSha = sha256Hex(dllBytes);
  const zipped = Buffer.from(
    zipSync(
      {
        "large-electron-dummy.bin": dummyLargePayload,
        [`resources/${PLUGIN_DLL_NAME}`]: dllBytes,
      },
      { level: 6 },
    ),
  );

  let totalBytesServed = 0;
  let rangeRequests = 0;
  let requireNativeFetcher = false;
  let nativeRequests = 0;
  const server = createServer((req, res) => {
    if (requireNativeFetcher) {
      if (req.headers["user-agent"] !== "LangLink-memoQ-Bridge/1.0") {
        res.writeHead(503).end();
        return;
      }
      nativeRequests += 1;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(zipped.length),
        "Accept-Ranges": "bytes",
      });
      res.end();
      return;
    }

    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string" && /^bytes=\d+-\d+$/u.test(rangeHeader)) {
      const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
      const start = Number.parseInt(startStr!, 10);
      const end = Math.min(zipped.length - 1, Number.parseInt(endStr!, 10));
      const slice = zipped.subarray(start, end + 1);
      rangeRequests += 1;
      totalBytesServed += slice.length;
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${start}-${end}/${zipped.length}`,
        "Content-Length": String(slice.length),
        "Accept-Ranges": "bytes",
      });
      res.end(slice);
      return;
    }

    totalBytesServed += zipped.length;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": String(zipped.length),
    });
    res.end(zipped);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  const root = mkdtempSync(join(tmpdir(), "memoq-range-test-"));
  const nodeDataDir = join(root, "node-cache");
  const downloadsDir = join(root, "Downloads");
  mkdirSync(downloadsDir, { recursive: true });

  try {
    // 1. Node HTTP Range partial-ZIP extraction serves <50% of archive bytes
    const resolved = await resolvePluginDllAsset({
      dataDir: nodeDataDir,
      expectedSha256: expectedSha,
      downloadUrl: `http://127.0.0.1:${addr.port}/memoq-ai-hub-win32-x64.zip`,
      version: "1.0.99-range",
      includeDefaultUserDirs: false,
    });
    assert.equal(resolved.source, "downloaded");
    assert.equal(resolved.verified, true);
    assert.equal(resolved.sha256, expectedSha);
    assert.equal(readFileSync(resolved.path).equals(Buffer.from(dllBytes)), true);
    assert.ok(rangeRequests >= 2, `expected HTTP Range requests, got ${rangeRequests}`);
    assert.ok(
      totalBytesServed < zipped.length / 2,
      `expected partial ZIP download (< ${zipped.length / 2}), got ${totalBytesServed}`,
    );

    // 2. Fast local ZIP discovery & extraction without skipping large archives
    const localZipPath = join(downloadsDir, "memoq-ai-hub-win32-x64.zip");
    writeFileSync(localZipPath, zipped);
    const candidates = discoverLocalPluginDllCandidates({
      dataDir: join(root, "local-cache"),
      expectedSha256: expectedSha,
      searchDirs: [downloadsDir],
      includeDefaultUserDirs: false,
    });
    const zipCand = candidates.find((c) => c.path === localZipPath);
    assert.ok(zipCand);
    assert.equal(zipCand.sha256, expectedSha);
    assert.equal(zipCand.sha256MatchesExpected, true);

    const extractedLocal = await resolvePluginDllAsset({
      dataDir: join(root, "local-cache-2"),
      expectedSha256: expectedSha,
      version: "1.0.99-local",
      searchDirs: [downloadsDir],
      includeDefaultUserDirs: false,
      allowDownload: false,
    });
    assert.equal(extractedLocal.source, "local-discovery");
    assert.equal(extractedLocal.sha256, expectedSha);

    await t.test("Windows helper atomically publishes direct downloads and handles standard installation", {
      skip: process.platform !== "win32" && "Windows-only C# helper download test",
    }, async () => {
      const helperPath = ensureRunnableHelperBinary({ dataDir: join(root, "helper-bin") });
      assert.ok(helperPath);

      const helperOut = join(root, "helper-fetched.dll");
      const helperUrl = `http://127.0.0.1:${addr.port}/memoq-ai-hub-win32-x64.zip`;
      const fetchArgs = (sha: string, output = helperOut) =>
        ["--fetch-plugin-dll", "--url", helperUrl, "--out", output, "--sha256", sha];
      const execOptions = { encoding: "utf8", windowsHide: true, timeout: 15_000 } as const;
      const { stdout: fetchStdout } = await execFileAsync(helperPath, fetchArgs(expectedSha), execOptions);
      const fetchJson = JSON.parse(fetchStdout.trim()) as { ok: boolean; sha256: string; method: string };
      assert.equal(fetchJson.ok, true);
      assert.equal(fetchJson.sha256, expectedSha);
      assert.equal(fetchJson.method, "range-zip");
      assert.deepEqual(readFileSync(helperOut), Buffer.from(dllBytes));

      const firstInvalidOut = join(root, "helper-fetched-invalid.dll");
      await assert.rejects(execFileAsync(helperPath, fetchArgs("0".repeat(64), firstInvalidOut), execOptions), {
        stdout: /SHA-256 mismatch/u,
      });
      assert.equal(existsSync(firstInvalidOut), false);

      const oldBytes = Buffer.from(fakePeBytes("old-target"));
      writeFileSync(helperOut, oldBytes);
      await assert.rejects(execFileAsync(helperPath, fetchArgs("0".repeat(64)), execOptions), {
        stdout: /SHA-256 mismatch/u,
      });
      assert.deepEqual(readFileSync(helperOut), oldBytes);

      // Allow readers while denying delete sharing, which a Windows replacement requires.
      const lockScript = [
        "$ErrorActionPreference = 'Stop'",
        "$lock = [IO.File]::Open($env:TEST_DLL_OUT, 'Open', 'Read', 'Read')",
        "try { & $env:TEST_DLL_HELPER --fetch-plugin-dll --url $env:TEST_DLL_URL --out $env:TEST_DLL_OUT --sha256 $env:TEST_DLL_SHA; exit $LASTEXITCODE } finally { $lock.Dispose() }",
      ].join("\n");
      await assert.rejects(
        execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", lockScript], {
          ...execOptions,
          env: {
            ...process.env,
            TEST_DLL_HELPER: helperPath,
            TEST_DLL_OUT: helperOut,
            TEST_DLL_URL: helperUrl,
            TEST_DLL_SHA: expectedSha,
          },
        }),
        { stdout: /"ok"\s*:\s*false/u },
      );
      assert.deepEqual(readFileSync(helperOut), oldBytes);
      assert.ok(!readdirSync(root).some((name) => name.startsWith("helper-fetched.dll.") && name.endsWith(".tmp")));

      await execFileAsync(helperPath, fetchArgs(expectedSha), execOptions);
      assert.deepEqual(readFileSync(helperOut), Buffer.from(dllBytes));

      // Exercise the standard install entry's random temporary output via the native fallback.
      requireNativeFetcher = true;
      const installDataDir = join(root, "install-data");
      const memoqRoot = join(root, "memoQ-12");
      const programDataDir = join(root, "ProgramData");
      mkdirSync(join(memoqRoot, "Addins"), { recursive: true });
      mkdirSync(join(programDataDir, "MemoQ"), { recursive: true });
      const installed = await executeConfirmedPluginInstall({
        confirmed: true,
        platform: "win32",
        memoqRoot,
        dataDir: installDataDir,
        programDataDir,
        expectedSha256: expectedSha,
        downloadUrl: helperUrl,
        helperExecutablePath: helperPath,
        defaultRoots: [{ version: "12", rootDir: memoqRoot }],
        skipHostDiscovery: true,
      });
      assert.equal(installed.sourceAsset.source, "downloaded");
      assert.ok(nativeRequests > 0);
      assert.deepEqual(readFileSync(join(memoqRoot, "Addins", PLUGIN_DLL_NAME)), Buffer.from(dllBytes));
      assert.deepEqual(readdirSync(join(installDataDir, "tmp")), []);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("download security blocks disallowed redirects and setup page HTML escapes dynamic paths", async () => {
  assert.throws(() => parseAllowedAssetUrl("https://127.0.0.1/x.zip", { allowLoopback: false }), /loopback/u);
  assert.throws(() => parseAllowedAssetUrl("http://localhost:8080/x.zip", { allowLoopback: false }), /loopback/u);

  const server = createServer((_req, res) => {
    res.writeHead(302, { Location: "http://example.com/evil.zip" });
    res.end();
  });
  const root = mkdtempSync(join(tmpdir(), "memoq-sec-test-"));
  const programDataDir = join(root, "ProgramData");
  const customRoot = join(root, "memoQ & Co");
  let setup: Awaited<ReturnType<typeof startSetupServer>> | undefined;

  try {
    mkdirSync(programDataDir, { recursive: true });
    mkdirSync(join(customRoot, "Addins"), { recursive: true });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");

    setup = await startSetupServer({
      dataDir: join(root, "bridge-data"),
      elevate: false,
      allowDownload: false,
      allowOpenFolder: false,
      probeGateway: async () =>
        ({
          owner: "free",
          url: "http://127.0.0.1:5271",
          mode: "Test</script><img src=x>",
        }) as never,
      detectOptions: {
        platform: "win32",
        programDataDir,
        defaultRoots: [],
        skipHostDiscovery: true,
      },
    });

    await assert.rejects(
      () =>
        resolvePluginDllAsset({
          dataDir: join(root, "dl-cache"),
          downloadUrl: `http://127.0.0.1:${addr.port}/plugin.zip`,
          version: "1.0.99-redir",
          includeDefaultUserDirs: false,
        }),
      /https/u,
    );

    const htmlRes = await fetch(`${setup.url}&customDir=${encodeURIComponent(customRoot)}`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /function esc\(s\)/u);
    assert.match(html, /esc\(item\.rootDir\)/u);
    assert.match(html, /esc\(c\.path\)/u);
    assert.equal(html.includes("<img src=x>"), false);
    assert.match(html, /\\u003c\/script>\\u003cimg src=x>/u);
    assert.equal(html.includes("memoQ & Co"), true);
  } finally {
    if (setup) {
      await setup.close();
    }
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
