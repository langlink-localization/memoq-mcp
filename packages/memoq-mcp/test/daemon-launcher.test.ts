import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDaemonRecord, startBridgeRuntime } from "@langlink/memoq-bridge";
import { connectOrLaunchBridgeClient } from "../src/daemon-launcher.ts";

const LAUNCHER_MODULE_URL = pathToFileURL(resolve(import.meta.dirname, "../src/daemon-launcher.ts")).href;

function writeFakeNpxEntrypoint(distDir: string): string {
  mkdirSync(distDir, { recursive: true });
  const entryPath = join(distDir, "entry.mjs");
  writeFileSync(
    entryPath,
    `import { MEMOQ_BRIDGE_DAEMON_FLAG, runBridgeDaemonWorker } from ${JSON.stringify(LAUNCHER_MODULE_URL)};
if (process.argv[2] === MEMOQ_BRIDGE_DAEMON_FLAG) {
  await runBridgeDaemonWorker(process.argv.slice(3), process.env.TEST_DAEMON_VERSION || "0.2.4", {
    startPreview: false,
  });
}
`,
    "utf8",
  );
  return entryPath;
}

function killPidBestEffort(pid: number | undefined): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process already exited.
  }
}

test("detached bridge daemon does not lock its own dist folder so npx upgrades never hit EBUSY", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoq-daemon-cwd-"));
  const dataDir = join(root, "data");
  const fakeNpxDir = join(root, "fake-npx");
  const distDir = join(fakeNpxDir, "dist");
  const upgradedDistDir = join(fakeNpxDir, "dist-upgraded");
  const entrypoint = writeFakeNpxEntrypoint(distDir);

  let spawnedPid: number | undefined;
  try {
    const client = await connectOrLaunchBridgeClient(entrypoint, {
      dataDir,
      expectedVersion: "0.2.4",
      port: 0,
    });
    const record = readDaemonRecord(dataDir);
    assert.ok(record);
    spawnedPid = record.pid;
    assert.equal(record.owner, "memoq-mcp-daemon");
    assert.equal(record.version, "0.2.4");

    const status = await client.getStatus();
    assert.equal((status.gateway as { running: boolean }).running, true);

    // Must succeed without EBUSY even while the daemon process is still running.
    renameSync(distDir, upgradedDistDir);

    const statusAfterRename = await client.getStatus();
    assert.equal((statusAfterRename.gateway as { running: boolean }).running, true);

    const stopRes = await client.shutdown();
    assert.equal(stopRes.ok, true);
    assert.equal(stopRes.shuttingDown, true);

    const deadline = Date.now() + 5_000;
    while (readDaemonRecord(dataDir) !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(readDaemonRecord(dataDir), null);
  } finally {
    killPidBestEffort(spawnedPid);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("connectOrLaunchBridgeClient upgrades outdated memoq-mcp daemon but preserves DSH hosts", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoq-daemon-upgrade-"));
  const mcpDataDir = join(root, "mcp-data");
  const dshDataDir = join(root, "dsh-data");
  const entrypoint = writeFakeNpxEntrypoint(join(root, "pkg", "dist"));

  let oldShutdownCalled = false;
  const oldRuntime = await startBridgeRuntime({
    dataDir: mcpDataDir,
    preferredPort: 0,
    startPreview: false,
    ownerLabel: "memoq-mcp-daemon",
    version: "0.2.3",
    onShutdown: () => {
      oldShutdownCalled = true;
      void oldRuntime.close();
    },
  });

  const dshRuntime = await startBridgeRuntime({
    dataDir: dshDataDir,
    preferredPort: 0,
    startPreview: false,
    ownerLabel: "dsh-memoq",
    mode: "dsh-live",
    version: "0.1.9",
  });

  let upgradedPid: number | undefined;
  try {
    const upgradedClient = await connectOrLaunchBridgeClient(entrypoint, {
      dataDir: mcpDataDir,
      expectedVersion: "0.2.4",
      port: 0,
    });
    assert.equal(oldShutdownCalled, true, "expected outdated memoq-mcp daemon to be shut down cleanly");
    const newRecord = readDaemonRecord(mcpDataDir);
    assert.ok(newRecord);
    upgradedPid = newRecord.pid;
    assert.equal(newRecord.version, "0.2.4");
    assert.notEqual(newRecord.controlToken, oldRuntime.gateway.controlToken);
    const status = await upgradedClient.getStatus();
    assert.equal((status.gateway as { running: boolean }).running, true);

    await upgradedClient.shutdown();

    const reusedDshClient = await connectOrLaunchBridgeClient(entrypoint, {
      dataDir: dshDataDir,
      expectedVersion: "0.2.4",
      port: 0,
    });
    assert.equal(
      reusedDshClient.controlToken,
      dshRuntime.gateway.controlToken,
      "non-memoq-mcp-daemon hosts like dsh-memoq must not be replaced",
    );
  } finally {
    killPidBestEffort(upgradedPid);
    await oldRuntime.close().catch(() => {});
    await dshRuntime.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
