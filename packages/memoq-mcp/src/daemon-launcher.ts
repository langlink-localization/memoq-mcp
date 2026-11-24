import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  atomicWriteTextSync,
  type BridgeRuntimeHandle,
  BridgeHttpClient,
  defaultBridgeDataDir,
  ensureRunnableHelperBinary,
  readDaemonRecord,
  removeDaemonRecord,
  startBridgeRuntime,
  startSetupServer,
} from "@langlink/memoq-bridge";

const execFileAsync = promisify(execFile);

export const MEMOQ_BRIDGE_DAEMON_FLAG = "--memoq-bridge-daemon";
export const MEMOQ_SETUP_WORKER_FLAG = "--memoq-setup-worker";
const WORKER_START_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 50;

interface DaemonIpcResult {
  port: number;
  host: string;
  controlToken: string;
}

interface WorkerCliArgs {
  dataDir?: string;
  port?: number;
  readyFile?: string;
  customInstallDir?: string;
}

type WorkerReadyEnvelope<T> =
  | { ok: true; payload: T }
  | { ok: false; error?: string };

function parseWorkerCliArgs(argv: string[]): WorkerCliArgs {
  const result: WorkerCliArgs = {};
  for (let i = 0; i < argv.length - 1; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) continue;
    if (flag === "--data-dir") {
      result.dataDir = value;
      i += 1;
    } else if (flag === "--ready-file") {
      result.readyFile = value;
      i += 1;
    } else if (flag === "--custom-install-dir") {
      result.customInstallDir = value;
      i += 1;
    } else if (flag === "--port") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
        result.port = parsed;
      }
      i += 1;
    }
  }
  return result;
}

function parseConfiguredBridgePort(): number | undefined {
  const raw = process.env.MEMOQ_BRIDGE_PORT?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

async function trySpawnViaWindowsWmi(
  entrypoint: string,
  workerArgs: string[],
  dataDir: string,
): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const helperPath = ensureRunnableHelperBinary({
    dataDir,
    packageRoot: resolve(dirname(entrypoint), ".."),
  });
  if (!helperPath) return false;

  const specFile = join(dataDir, `launch-${randomUUID()}.json`);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      specFile,
      JSON.stringify({
        executable: process.execPath,
        args: workerArgs,
        workingDirectory: dataDir,
      }),
      "utf8",
    );
    const { stdout } = await execFileAsync(
      helperPath,
      ["--spawn-detached", "--spec-file", specFile],
      { timeout: 10_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; pid?: number };
    return parsed.ok === true && typeof parsed.pid === "number" && parsed.pid > 0;
  } catch {
    return false;
  } finally {
    try {
      rmSync(specFile, { force: true });
    } catch {
      // Best-effort cleanup if helper exited before removing the spec file.
    }
  }
}

function spawnViaNodeDetached(
  entrypoint: string,
  workerArgs: string[],
  dataDir: string,
): void {
  const child = spawn(process.execPath, workerArgs, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    cwd: dataDir,
    env: { ...process.env, MEMOQ_BRIDGE_DATA_DIR: dataDir },
  });
  child.unref();
}

async function spawnDetachedWorker<T>(
  entrypoint: string,
  flag: typeof MEMOQ_BRIDGE_DAEMON_FLAG | typeof MEMOQ_SETUP_WORKER_FLAG,
  options: { dataDir: string; port?: number; customInstallDir?: string },
): Promise<T> {
  mkdirSync(options.dataDir, { recursive: true });
  const readyFile = join(options.dataDir, `ready-${randomUUID()}.json`);
  const workerArgs = [
    entrypoint,
    flag,
    "--data-dir",
    options.dataDir,
    "--ready-file",
    readyFile,
    ...(options.port === undefined ? [] : ["--port", String(options.port)]),
    ...(options.customInstallDir === undefined ? [] : ["--custom-install-dir", options.customInstallDir]),
  ];

  const launchedByWmi = await trySpawnViaWindowsWmi(entrypoint, workerArgs, options.dataDir);
  if (!launchedByWmi) {
    spawnViaNodeDetached(entrypoint, workerArgs, options.dataDir);
  }

  try {
    const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(readyFile)) {
        try {
          const parsed = JSON.parse(readFileSync(readyFile, "utf8")) as WorkerReadyEnvelope<T>;
          if (parsed.ok === true && parsed.payload !== undefined) {
            return parsed.payload;
          }
          if (parsed.ok === false) {
            throw new Error(parsed.error || `Unable to start memoQ worker (${flag}).`);
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
        }
      }
      await new Promise((res) => setTimeout(res, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`memoQ worker timed out (${flag}).`);
  } finally {
    try {
      rmSync(readyFile, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function publishWorkerOutcome<T>(
  readyFile: string | undefined,
  outcome: WorkerReadyEnvelope<T>,
): Promise<void> {
  if (readyFile) {
    atomicWriteTextSync(readyFile, JSON.stringify(outcome));
    return;
  }
  if (!process.send || !process.connected) {
    return;
  }
  if (!outcome.ok) {
    return;
  }
  try {
    await new Promise<void>((resolveSend, rejectSend) => {
      process.send!(outcome.payload, (error) => (error ? rejectSend(error) : resolveSend()));
    });
  } finally {
    if (process.connected) {
      process.disconnect?.();
    }
  }
}

async function waitForDaemonShutdown(client: BridgeHttpClient, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.getStatus();
    } catch {
      return true;
    }
    await new Promise((res) => setTimeout(res, READY_POLL_INTERVAL_MS));
  }
  return false;
}

export async function connectOrLaunchBridgeClient(
  entrypoint: string,
  options: { dataDir?: string; expectedVersion?: string; port?: number } = {},
): Promise<BridgeHttpClient> {
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const existing = readDaemonRecord(dataDir);
  if (existing) {
    const client = new BridgeHttpClient(`http://${existing.host}:${existing.port}`, existing.controlToken);
    let alive = false;
    try {
      await client.getStatus();
      alive = true;
    } catch {
      alive = false;
    }

    if (alive) {
      const shouldUpgrade =
        Boolean(options.expectedVersion)
        && existing.owner === "memoq-mcp-daemon"
        && existing.version !== options.expectedVersion;
      if (!shouldUpgrade) {
        return client;
      }

      let shutdownRequested = false;
      try {
        const res = await client.shutdown();
        shutdownRequested = res.ok === true;
      } catch {
        shutdownRequested = false;
      }

      if (shutdownRequested) {
        const stopped = await waitForDaemonShutdown(client);
        if (!stopped) {
          return client;
        }
        const refreshed = readDaemonRecord(dataDir);
        if (refreshed && refreshed.controlToken !== existing.controlToken) {
          const refreshedClient = new BridgeHttpClient(
            `http://${refreshed.host}:${refreshed.port}`,
            refreshed.controlToken,
          );
          try {
            await refreshedClient.getStatus();
            return refreshedClient;
          } catch {
            // Replacement record is not reachable; fall through to launch a fresh daemon.
          }
        }
      } else {
        try {
          await client.getStatus();
          return client;
        } catch {
          // Existing daemon exited anyway; fall through to launch a fresh daemon.
        }
      }
    }
  }

  const configuredPort = options.port ?? parseConfiguredBridgePort();
  const payload = await spawnDetachedWorker<DaemonIpcResult>(entrypoint, MEMOQ_BRIDGE_DAEMON_FLAG, {
    dataDir,
    ...(configuredPort === undefined ? {} : { port: configuredPort }),
  });

  if (!payload || !payload.port || !payload.controlToken) {
    throw new Error("memoQ bridge daemon returned invalid connection details.");
  }
  return new BridgeHttpClient(`http://${payload.host}:${payload.port}`, payload.controlToken);
}

export function createSetupWizardLauncher(
  entrypoint: string,
  options: { dataDir?: string } = {},
): (customInstallDir?: string) => Promise<string> {
  let cached: { customInstallDir: string | undefined; url: string } | undefined;
  let inFlight: { customInstallDir: string | undefined; request: Promise<string> } | undefined;

  return async (customInstallDir) => {
    if (cached && cached.customInstallDir === customInstallDir) {
      try {
        const probe = await fetch(cached.url, { signal: AbortSignal.timeout(1000) });
        if (probe.ok) {
          return cached.url;
        }
      } catch { /* Replace an expired wizard. */ }
    }

    if (inFlight && inFlight.customInstallDir === customInstallDir) return inFlight.request;
    const request = spawnDetachedWorker<{ url: string }>(entrypoint, MEMOQ_SETUP_WORKER_FLAG, {
      dataDir: options.dataDir ?? defaultBridgeDataDir(),
      ...(customInstallDir === undefined ? {} : { customInstallDir }),
    })
      .then((payload) => {
        if (!payload?.url || !/^http:\/\/127\.0\.0\.1:\d+\/setup\?token=/u.test(payload.url)) {
          throw new Error("Invalid setup wizard URL.");
        }
        cached = { customInstallDir, url: payload.url };
        return payload.url;
      })
      .finally(() => {
        if (inFlight?.request === request) inFlight = undefined;
      });

    inFlight = { customInstallDir, request };
    return request;
  };
}

export async function runBridgeDaemonWorker(
  argv: string[] = process.argv.slice(2),
  version?: string,
  runtimeOptions: { startPreview?: boolean; toolName?: string } = {},
): Promise<void> {
  const args = parseWorkerCliArgs(argv);
  if (!args.readyFile && (!process.send || !process.connected)) {
    throw new Error("memoQ bridge daemon requires --ready-file or IPC.");
  }

  const dataDir = args.dataDir ?? defaultBridgeDataDir();
  try {
    let closing = false;
    let runtime: BridgeRuntimeHandle | undefined;
    const cleanup = () => {
      if (closing) return;
      closing = true;
      if (runtime) {
        removeDaemonRecord(runtime.gateway.controlToken, dataDir);
        void runtime.close().catch(() => {}).finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    };

    runtime = await startBridgeRuntime({
      dataDir,
      ...(args.port === undefined ? {} : { preferredPort: args.port }),
      ownerLabel: "memoq-mcp-daemon",
      toolName: runtimeOptions.toolName ?? "@langlink/memoq-mcp",
      ...(version ? { version } : {}),
      ...(runtimeOptions.startPreview === undefined ? {} : { startPreview: runtimeOptions.startPreview }),
      mode: "staging",
      onShutdown: cleanup,
    });

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);

    try {
      await publishWorkerOutcome<DaemonIpcResult>(args.readyFile, {
        ok: true,
        payload: {
          port: runtime.actualPort,
          host: runtime.gateway.host,
          controlToken: runtime.gateway.controlToken,
        },
      });
    } catch (error) {
      await runtime.close();
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await publishWorkerOutcome(args.readyFile, { ok: false, error: message });
    } catch {
      // Ignore ready-file write error while propagating original failure.
    }
    throw error;
  }
}

export async function runSetupWorker(
  argv: string[] = process.argv.slice(2),
  tool?: { name: string; version: string },
): Promise<void> {
  const args = parseWorkerCliArgs(argv);
  if (!args.readyFile && (!process.send || !process.connected)) {
    throw new Error("memoQ setup worker requires --ready-file or IPC.");
  }

  const dataDir = args.dataDir ?? defaultBridgeDataDir();
  try {
    const setup = await startSetupServer({
      keepAlive: true,
      dataDir,
      ...(args.customInstallDir === undefined ? {} : { detectOptions: { customInstallDir: args.customInstallDir } }),
      ...(tool ? { tool } : {}),
    });

    try {
      await publishWorkerOutcome<{ url: string }>(args.readyFile, {
        ok: true,
        payload: { url: setup.url },
      });
    } catch (error) {
      await setup.close();
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await publishWorkerOutcome(args.readyFile, { ok: false, error: message });
    } catch {
      // Ignore ready-file write error while propagating original failure.
    }
    throw error;
  }
}
