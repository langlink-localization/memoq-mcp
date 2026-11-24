import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBridgeDataDir } from "./contract.ts";

export const HELPER_EXE_NAME = "MemoQ.Bridge.Helper.exe";

export function findHelperBinaryCandidates(packageRoot?: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const resolvedRoot = packageRoot ?? resolve(here, "..");
  const workspaceRoot = resolve(resolvedRoot, "../..");
  const candidates: string[] = [];

  const envPath = process.env.MEMOQ_BRIDGE_HELPER_PATH?.trim();
  if (envPath) candidates.push(envPath);

  candidates.push(
    join(resolvedRoot, "bin", HELPER_EXE_NAME),
    join(resolvedRoot, "..", "bin", HELPER_EXE_NAME),
    join(workspaceRoot, "packages", "memoq-bridge", "bin", HELPER_EXE_NAME),
    join(workspaceRoot, "native", "memoq-bridge-helper", "bin", "Release", "net48", HELPER_EXE_NAME),
  );

  return Array.from(new Set(candidates.map((item) => resolve(item))));
}

export function locateHelperBinary(packageRoot?: string): string | null {
  for (const candidate of findHelperBinaryCandidates(packageRoot)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").toUpperCase();
}

/**
 * Materialize a runnable copy in `<dataDir>/bin/<sha12>/MemoQ.Bridge.Helper.exe`.
 * Freshly written bytes inherit standard Medium integrity under `%LOCALAPPDATA%`
 * even when the workspace/npm cache sits under a Low-integrity Downloads folder.
 */
export function ensureRunnableHelperBinary(options: {
  sourcePath?: string;
  dataDir?: string;
  packageRoot?: string;
} = {}): string | null {
  const source = options.sourcePath ?? locateHelperBinary(options.packageRoot);
  if (!source || !existsSync(source)) {
    return null;
  }

  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const digest = fileSha256(source);
  const stagedPath = join(dataDir, "bin", digest.slice(0, 12).toLowerCase(), HELPER_EXE_NAME);
  if (existsSync(stagedPath) && fileSha256(stagedPath) === digest) {
    return stagedPath;
  }

  mkdirSync(dirname(stagedPath), { recursive: true });
  writeFileSync(stagedPath, readFileSync(source));
  return stagedPath;
}
