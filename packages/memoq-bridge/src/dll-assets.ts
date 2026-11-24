import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { unzipSync } from "fflate";
import { PLUGIN_DLL_NAME, defaultBridgeDataDir } from "./contract.ts";
import { ensureRunnableHelperBinary } from "./helper-path.ts";

const execFileAsync = promisify(execFile);

export interface PluginDllManifest {
  pluginDllName: string;
  version: string;
  sha256: string;
  compatibleSha256s: string[];
  releaseTag: string;
  downloadUrl: string;
}

export const DEFAULT_PLUGIN_DLL_MANIFEST: PluginDllManifest = {
  pluginDllName: PLUGIN_DLL_NAME,
  version: "1.0.7.0",
  sha256: "BB8250B5EFB6F742E1F10DA43E40008EB5DC04587B5DBA262AEAB0F7B7F5545E",
  compatibleSha256s: [
    "BB8250B5EFB6F742E1F10DA43E40008EB5DC04587B5DBA262AEAB0F7B7F5545E",
    "E0C731FFBDD7F613104D372C376F35596C95B46A628B8C574C753EAAF4A20CE1",
    "385F22C08DBBBB98A962A2119DA10675ADF996ECD16F397B50CE627AFBAFA4F9",
  ],
  releaseTag: "v1.0.59",
  downloadUrl:
    "https://github.com/langlink-localization/memoq-ai-hub/releases/download/v1.0.59/memoq-ai-hub-win32-x64.zip",
};

export interface ResolvePluginDllOptions {
  dataDir?: string;
  packageRoot?: string;
  helperExecutablePath?: string;
  dllPath?: string;
  downloadUrl?: string;
  expectedSha256?: string;
  version?: string;
  allowDownload?: boolean;
  allowUnverifiedLocalDev?: boolean;
  searchPaths?: string[];
  searchDirs?: string[];
  includeDefaultUserDirs?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ResolvedPluginDllAsset {
  path: string;
  sha256: string;
  version: string;
  source: "explicit" | "cache" | "local-discovery" | "downloaded";
  verified: boolean;
}

export interface DiscoveredDllCandidate {
  path: string;
  kind: "dll" | "zip";
  source: "explicit" | "cache" | "memoq-ai-hub" | "memoq-addins" | "local-folder";
  sha256: string;
  sha256MatchesExpected: boolean;
  sizeBytes: number;
}

const MAX_DISCOVERY_DIR_ENTRIES = 200;
const MAX_ZIP_INSPECT_BYTES = 200 * 1024 * 1024;
const MAX_DLL_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 25_000;
const ZIP_CANDIDATE_NAME_RE = /memoq.*(?:ai[-_]?hub|plugin)|memoq\.ai\.hub\.plugin/iu;

class PluginAssetIntegrityError extends Error {}
class PluginAssetPolicyError extends Error {}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isPluginDllZipEntry(name: string): boolean {
  const normalized = name.replace(/\\/gu, "/").toLowerCase();
  const target = PLUGIN_DLL_NAME.toLowerCase();
  return normalized === target || normalized.endsWith(`/${target}`);
}

export function acceptedPluginSha256s(explicitExpectedSha256?: string): string[] {
  const override = (explicitExpectedSha256?.trim() || process.env.MEMOQ_PLUGIN_DLL_SHA256?.trim() || "").toUpperCase();
  if (override) {
    return [override];
  }
  const all = [DEFAULT_PLUGIN_DLL_MANIFEST.sha256, ...DEFAULT_PLUGIN_DLL_MANIFEST.compatibleSha256s]
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(all));
}

export function matchesAcceptedSha256(actualSha256: string, explicitExpectedSha256?: string): boolean {
  const normalized = actualSha256.trim().toUpperCase();
  if (!normalized) return false;
  return acceptedPluginSha256s(explicitExpectedSha256).includes(normalized);
}

export function computeBufferSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function computeFileSha256(filePath: string): string {
  return computeBufferSha256(readFileSync(filePath));
}

export function parseAllowedAssetUrl(raw: string, options?: { allowLoopback?: boolean }): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PluginAssetPolicyError("Plugin DLL download URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PluginAssetPolicyError("Plugin DLL download URL must use https or loopback http.");
  }
  const isLoopback = isLoopbackHost(url.hostname);
  if (options?.allowLoopback === false && isLoopback) {
    throw new PluginAssetPolicyError("External plugin DLL download URL must not redirect to loopback.");
  }
  if (url.protocol === "http:" && !isLoopback) {
    throw new PluginAssetPolicyError("Plugin DLL download URL must use https unless it points at loopback.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PluginAssetPolicyError("Plugin DLL download URL must not embed credentials.");
  }
  return url;
}

async function fetchFollowingValidatedRedirects(
  initialUrl: URL,
  init: Omit<RequestInit, "redirect" | "signal">,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ response: Response; finalUrl: URL }> {
  const allowLoopback = isLoopbackHost(initialUrl.hostname);
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchFn(currentUrl, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel?.().catch(() => {});
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`Exceeded maximum redirect limit (${MAX_REDIRECTS}).`);
      }
      if (!location) {
        throw new Error(`Redirect response (${response.status}) missing Location header.`);
      }
      currentUrl = parseAllowedAssetUrl(new URL(location, currentUrl).href, { allowLoopback });
      continue;
    }

    if (response.url) {
      parseAllowedAssetUrl(response.url, { allowLoopback });
    }
    return { response, finalUrl: currentUrl };
  }

  throw new Error(`Exceeded maximum redirect limit (${MAX_REDIRECTS}).`);
}

async function readResponseBytesBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers?.get?.("content-length");
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      throw new PluginAssetIntegrityError(`Downloaded plugin artifact exceeds maximum size limit (${maxBytes} bytes).`);
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new PluginAssetIntegrityError(`Downloaded plugin artifact exceeds maximum size limit (${maxBytes} bytes).`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  const rawBytes = new Uint8Array(await response.arrayBuffer());
  if (rawBytes.byteLength > maxBytes) {
    throw new PluginAssetIntegrityError(`Downloaded plugin artifact exceeds maximum size limit (${maxBytes} bytes).`);
  }
  return rawBytes;
}

function normalizeExpectedShaList(expectedSha256?: string | string[]): string[] {
  if (Array.isArray(expectedSha256)) {
    return Array.from(new Set(expectedSha256.map((s) => s.trim().toUpperCase()).filter(Boolean)));
  }
  if (typeof expectedSha256 === "string" && expectedSha256.trim()) {
    return [expectedSha256.trim().toUpperCase()];
  }
  return [];
}

export function extractPluginDllFromBytes(
  bytes: Uint8Array,
  expectedSha256?: string | string[],
): { dllBytes: Uint8Array; sha256: string } {
  if (bytes.length < 2) {
    throw new PluginAssetIntegrityError("Downloaded plugin artifact is empty.");
  }
  if (bytes.byteLength > MAX_ZIP_INSPECT_BYTES) {
    throw new PluginAssetIntegrityError(`Plugin artifact exceeds maximum size limit (${MAX_ZIP_INSPECT_BYTES} bytes).`);
  }

  let dllBytes: Uint8Array | undefined;
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    const entries = unzipSync(bytes, {
      filter: (file) =>
        isPluginDllZipEntry(file.name) && (file.originalSize === undefined || file.originalSize <= MAX_DLL_BYTES),
    });
    for (const [name, content] of Object.entries(entries)) {
      if (isPluginDllZipEntry(name)) {
        dllBytes = content;
        break;
      }
    }
    if (!dllBytes) {
      throw new PluginAssetIntegrityError(`Archive did not contain ${PLUGIN_DLL_NAME}.`);
    }
  } else {
    dllBytes = bytes;
  }

  return verifyExtractedDllBytes(dllBytes, expectedSha256);
}

function verifyExtractedDllBytes(
  dllBytes: Uint8Array,
  expectedSha256?: string | string[],
): { dllBytes: Uint8Array; sha256: string } {
  if (dllBytes.length < 2 || dllBytes[0] !== 0x4d || dllBytes[1] !== 0x5a) {
    throw new PluginAssetIntegrityError(`Artifact is not a valid PE DLL (${PLUGIN_DLL_NAME}).`);
  }

  const actualSha256 = computeBufferSha256(dllBytes);
  const expectedList = normalizeExpectedShaList(expectedSha256);
  if (expectedList.length > 0 && !expectedList.includes(actualSha256)) {
    throw new PluginAssetIntegrityError(
      `Plugin DLL SHA-256 mismatch. Expected ${expectedList.join(" or ")}, actual ${actualSha256}.`,
    );
  }

  return { dllBytes, sha256: actualSha256 };
}

function matchSig4(bytes: Uint8Array, pos: number, b0: number, b1: number, b2: number, b3: number): boolean {
  return pos >= 0 && pos + 3 < bytes.length
    && bytes[pos] === b0 && bytes[pos + 1] === b1 && bytes[pos + 2] === b2 && bytes[pos + 3] === b3;
}

function parseEocdTail(tail: Uint8Array, totalLength: number): {
  cdSize: number;
  cdOffset: number;
  eocd64Offset?: number;
} | null {
  const minIdx = Math.max(0, tail.length - 65560);
  let eocdPos = -1;
  for (let i = tail.length - 4; i >= minIdx; i -= 1) {
    if (matchSig4(tail, i, 0x50, 0x4b, 0x05, 0x06)) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0 || eocdPos + 22 > tail.length) {
    return null;
  }

  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const cdSize = dv.getUint32(eocdPos + 12, true);
  const cdOffset = dv.getUint32(eocdPos + 16, true);
  if (cdSize !== 0xffffffff && cdOffset !== 0xffffffff) {
    return { cdSize, cdOffset };
  }

  const locPos = eocdPos - 20;
  if (locPos < 0 || !matchSig4(tail, locPos, 0x50, 0x4b, 0x06, 0x07)) {
    return null;
  }
  const eocd64Offset = Number(dv.getBigUint64(locPos + 8, true));
  if (!Number.isSafeInteger(eocd64Offset) || eocd64Offset < 0 || eocd64Offset + 56 > totalLength) {
    return null;
  }
  return { cdSize, cdOffset, eocd64Offset };
}

function parseEocd64Header(buf: Uint8Array): { cdSize: number; cdOffset: number } | null {
  if (buf.length < 56 || !matchSig4(buf, 0, 0x50, 0x4b, 0x06, 0x06)) {
    return null;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cdSize = Number(dv.getBigUint64(40, true));
  const cdOffset = Number(dv.getBigUint64(48, true));
  if (!Number.isSafeInteger(cdSize) || !Number.isSafeInteger(cdOffset)) {
    return null;
  }
  return { cdSize, cdOffset };
}

interface ZipCdEntry {
  compMethod: number;
  compSize: number;
  uncompSize: number;
  fileNameLength: number;
  localHeaderOffset: number;
}

function findPluginEntryInCd(cd: Uint8Array): ZipCdEntry | null {
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  let pos = 0;
  while (pos + 46 <= cd.length) {
    if (!matchSig4(cd, pos, 0x50, 0x4b, 0x01, 0x02)) {
      break;
    }
    const compMethod = dv.getUint16(pos + 10, true);
    let compSize = dv.getUint32(pos + 20, true);
    let uncompSize = dv.getUint32(pos + 24, true);
    const fileNameLength = dv.getUint16(pos + 28, true);
    const extraLength = dv.getUint16(pos + 30, true);
    const commentLength = dv.getUint16(pos + 32, true);
    let localHeaderOffset = dv.getUint32(pos + 42, true);
    const entryEnd = pos + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > cd.length) {
      break;
    }

    const name = Buffer.from(cd.buffer, cd.byteOffset + pos + 46, fileNameLength).toString("utf8");
    if (isPluginDllZipEntry(name)) {
      if (uncompSize === 0xffffffff || compSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        let extraPos = pos + 46 + fileNameLength;
        const extraEnd = extraPos + extraLength;
        while (extraPos + 4 <= extraEnd) {
          const headerId = dv.getUint16(extraPos, true);
          const fieldSize = dv.getUint16(extraPos + 2, true);
          const fieldData = extraPos + 4;
          if (fieldData + fieldSize > extraEnd) break;
          if (headerId === 0x0001) {
            let cursor = fieldData;
            if (uncompSize === 0xffffffff && cursor + 8 <= fieldData + fieldSize) {
              uncompSize = Number(dv.getBigUint64(cursor, true));
              cursor += 8;
            }
            if (compSize === 0xffffffff && cursor + 8 <= fieldData + fieldSize) {
              compSize = Number(dv.getBigUint64(cursor, true));
              cursor += 8;
            }
            if (localHeaderOffset === 0xffffffff && cursor + 8 <= fieldData + fieldSize) {
              localHeaderOffset = Number(dv.getBigUint64(cursor, true));
            }
            break;
          }
          extraPos = fieldData + fieldSize;
        }
      }
      return { compMethod, compSize, uncompSize, fileNameLength, localHeaderOffset };
    }

    pos = entryEnd;
  }
  return null;
}

function decodePluginLocalEntry(
  localChunk: Uint8Array,
  entry: ZipCdEntry,
): { ok: true; dllBytes: Uint8Array } | { ok: false; neededLength: number } {
  if (entry.compSize < 0 || entry.compSize > MAX_DLL_BYTES || entry.uncompSize > MAX_DLL_BYTES) {
    throw new PluginAssetIntegrityError(`ZIP entry size exceeds allowed limit (${MAX_DLL_BYTES} bytes).`);
  }
  if (localChunk.length < 30 || !matchSig4(localChunk, 0, 0x50, 0x4b, 0x03, 0x04)) {
    throw new PluginAssetIntegrityError("Invalid ZIP local file header.");
  }
  const dv = new DataView(localChunk.buffer, localChunk.byteOffset, localChunk.byteLength);
  const lhNameLen = dv.getUint16(26, true);
  const lhExtraLen = dv.getUint16(28, true);
  const dataOffset = 30 + lhNameLen + lhExtraLen;
  const neededLength = dataOffset + entry.compSize;
  if (neededLength > localChunk.length) {
    return { ok: false, neededLength };
  }
  const payload = localChunk.subarray(dataOffset, neededLength);
  if (entry.compMethod === 0) {
    return { ok: true, dllBytes: Uint8Array.from(payload) };
  }
  if (entry.compMethod === 8) {
    return { ok: true, dllBytes: new Uint8Array(inflateRawSync(payload, { maxOutputLength: MAX_DLL_BYTES })) };
  }
  throw new PluginAssetIntegrityError(`Unsupported ZIP compression method: ${entry.compMethod}.`);
}

function readFdSlice(fd: number, start: number, endInclusive: number): Uint8Array {
  const length = Math.max(0, endInclusive - start + 1);
  const buf = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const n = readSync(fd, buf, totalRead, length - totalRead, start + totalRead);
    if (n <= 0) break;
    totalRead += n;
  }
  return totalRead === length ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf.subarray(0, totalRead));
}

function tryExtractPluginFromLocalZipFast(
  filePath: string,
  expectedSha256?: string | string[],
): { dllBytes: Uint8Array; sha256: string } | null {
  const stats = statSync(filePath);
  if (stats.size <= 22 || stats.size > MAX_ZIP_INSPECT_BYTES) {
    return null;
  }

  const fd = openSync(filePath, "r");
  try {
    const tailSize = Math.min(65536, stats.size);
    const tailStart = stats.size - tailSize;
    const tail = readFdSlice(fd, tailStart, stats.size - 1);
    const eocd = parseEocdTail(tail, stats.size);
    if (!eocd) return null;

    let cdSize = eocd.cdSize;
    let cdOffset = eocd.cdOffset;
    if (eocd.eocd64Offset !== undefined) {
      const eocd64 = parseEocd64Header(readFdSlice(fd, eocd.eocd64Offset, eocd.eocd64Offset + 55));
      if (!eocd64) return null;
      cdSize = eocd64.cdSize;
      cdOffset = eocd64.cdOffset;
    }

    if (cdSize <= 0 || cdSize > 32 * 1024 * 1024 || cdOffset < 0 || cdOffset + cdSize > stats.size) {
      return null;
    }

    const cd =
      cdOffset >= tailStart && cdOffset + cdSize <= stats.size
        ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
        : readFdSlice(fd, cdOffset, cdOffset + cdSize - 1);

    const entry = findPluginEntryInCd(cd);
    if (!entry) {
      throw new PluginAssetIntegrityError(`Archive did not contain ${PLUGIN_DLL_NAME}.`);
    }
    if (entry.compSize <= 0 || entry.compSize > 50 * 1024 * 1024) {
      return null;
    }

    const probeEnd = Math.min(stats.size - 1, entry.localHeaderOffset + 30 + entry.fileNameLength + 1024 + entry.compSize - 1);
    let localChunk = readFdSlice(fd, entry.localHeaderOffset, probeEnd);
    let decoded = decodePluginLocalEntry(localChunk, entry);
    if (!decoded.ok) {
      const exactEnd = entry.localHeaderOffset + decoded.neededLength - 1;
      if (exactEnd >= stats.size) return null;
      localChunk = readFdSlice(fd, entry.localHeaderOffset, exactEnd);
      decoded = decodePluginLocalEntry(localChunk, entry);
      if (!decoded.ok) return null;
    }

    return verifyExtractedDllBytes(decoded.dllBytes, expectedSha256);
  } finally {
    closeSync(fd);
  }
}

async function downloadPluginDllViaHttpRange(
  parsedUrl: URL,
  acceptedShas: string[],
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ dllBytes: Uint8Array; sha256: string } | null> {
  const { response: headRes, finalUrl } = await fetchFollowingValidatedRedirects(
    parsedUrl,
    { method: "HEAD" },
    fetchFn,
    timeoutMs,
  );
  await headRes.body?.cancel?.().catch(() => {});
  if (!headRes.ok) {
    return null;
  }

  const contentLength = Number.parseInt(headRes.headers.get("content-length") ?? "", 10);
  const acceptRanges = headRes.headers.get("accept-ranges") ?? "";
  if (!Number.isFinite(contentLength) || contentLength <= 22 || !/\bbytes\b/iu.test(acceptRanges)) {
    return null;
  }

  const fetchRange = async (start: number, endInclusive: number): Promise<Uint8Array | null> => {
    const { response: res } = await fetchFollowingValidatedRedirects(
      finalUrl,
      {
        method: "GET",
        headers: {
          Range: `bytes=${start}-${endInclusive}`,
          "Accept-Encoding": "identity",
        },
      },
      fetchFn,
      timeoutMs,
    );
    if (res.status !== 206) {
      await res.body?.cancel?.().catch(() => {});
      return null;
    }
    return readResponseBytesBounded(res, Math.min(MAX_ZIP_INSPECT_BYTES, endInclusive - start + 1 + 1024));
  };

  const tailSize = Math.min(65536, contentLength);
  const tailStart = contentLength - tailSize;
  const tail = await fetchRange(tailStart, contentLength - 1);
  if (!tail) return null;

  const eocd = parseEocdTail(tail, contentLength);
  if (!eocd) return null;

  let cdSize = eocd.cdSize;
  let cdOffset = eocd.cdOffset;
  if (eocd.eocd64Offset !== undefined) {
    const eocd64Slice = await fetchRange(eocd.eocd64Offset, Math.min(contentLength - 1, eocd.eocd64Offset + 55));
    if (!eocd64Slice) return null;
    const eocd64 = parseEocd64Header(eocd64Slice);
    if (!eocd64) return null;
    cdSize = eocd64.cdSize;
    cdOffset = eocd64.cdOffset;
  }

  if (cdSize <= 0 || cdSize > 32 * 1024 * 1024 || cdOffset < 0 || cdOffset + cdSize > contentLength) {
    return null;
  }

  const cd =
    cdOffset >= tailStart && cdOffset + cdSize <= contentLength
      ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : await fetchRange(cdOffset, cdOffset + cdSize - 1);
  if (!cd) return null;

  const entry = findPluginEntryInCd(cd);
  if (!entry) {
    throw new PluginAssetIntegrityError(`Archive did not contain ${PLUGIN_DLL_NAME}.`);
  }
  if (entry.compSize <= 0 || entry.compSize > 50 * 1024 * 1024) {
    return null;
  }

  const probeEnd = Math.min(
    contentLength - 1,
    entry.localHeaderOffset + 30 + entry.fileNameLength + 1024 + entry.compSize - 1,
  );
  let localChunk = await fetchRange(entry.localHeaderOffset, probeEnd);
  if (!localChunk) return null;
  let decoded = decodePluginLocalEntry(localChunk, entry);
  if (!decoded.ok) {
    const exactEnd = entry.localHeaderOffset + decoded.neededLength - 1;
    if (exactEnd >= contentLength) return null;
    localChunk = await fetchRange(entry.localHeaderOffset, exactEnd);
    if (!localChunk) return null;
    decoded = decodePluginLocalEntry(localChunk, entry);
    if (!decoded.ok) return null;
  }

  return verifyExtractedDllBytes(decoded.dllBytes, acceptedShas);
}

async function tryDownloadViaWindowsHelper(options: {
  url: string;
  acceptedShas: string[];
  dataDir: string;
  packageRoot?: string;
  helperExecutablePath?: string;
  timeoutMs: number;
}): Promise<{ dllBytes: Uint8Array; sha256: string } | null> {
  if (process.platform !== "win32") {
    return null;
  }
  let helperPath: string | null = options.helperExecutablePath ?? null;
  if (!helperPath) {
    try {
      helperPath = ensureRunnableHelperBinary({
        dataDir: options.dataDir,
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      });
    } catch {
      helperPath = null;
    }
  }
  if (!helperPath || !existsSync(helperPath)) {
    return null;
  }

  const tmpDir = join(options.dataDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tempOut = join(tmpDir, `fetch-dll-${randomUUID()}.dll`);
  try {
    const { stdout } = await execFileAsync(
      helperPath,
      [
        "--fetch-plugin-dll",
        "--url",
        options.url,
        "--out",
        tempOut,
        ...(options.acceptedShas.length > 0 ? ["--sha256", options.acceptedShas.join(",")] : []),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: Math.max(options.timeoutMs, 45_000),
      },
    );
    const line = stdout.trim().split(/\r?\n/u).pop() ?? "";
    if (line.startsWith("{")) {
      const parsed = JSON.parse(line) as { ok?: boolean; error?: string };
      if (parsed.ok === false) {
        if (parsed.error && /SHA-256 mismatch|Archive did not contain|not a valid/iu.test(parsed.error)) {
          throw new PluginAssetIntegrityError(parsed.error);
        }
        throw new Error(parsed.error || "Windows helper asset fetch failed.");
      }
    }
    if (!existsSync(tempOut)) {
      throw new Error("Windows helper fetch completed without output file.");
    }
    const dllBytes = new Uint8Array(readFileSync(tempOut));
    return verifyExtractedDllBytes(dllBytes, options.acceptedShas);
  } finally {
    if (existsSync(tempOut)) {
      rmSync(tempOut, { force: true });
    }
  }
}

function defaultDiscoveryCandidates(): string[] {
  const results: string[] = [];
  if (process.env.LOCALAPPDATA) {
    const hubDir = join(process.env.LOCALAPPDATA, "memoQAIHub");
    if (existsSync(hubDir)) {
      try {
        for (const entry of readdirSync(hubDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("app-")) continue;
          results.push(join(hubDir, entry.name, "resources", PLUGIN_DLL_NAME));
          results.push(join(hubDir, entry.name, "resources", "memoq-integration", PLUGIN_DLL_NAME));
        }
      } catch {
        // Ignore inaccessible app directory.
      }
    }
  }
  return results;
}

export function getPluginAssetCachePath(dataDir?: string, version = DEFAULT_PLUGIN_DLL_MANIFEST.version): string {
  const root = dataDir ?? defaultBridgeDataDir();
  return join(root, "assets", version, PLUGIN_DLL_NAME);
}

function writeAtomicCacheDll(cachePath: string, dllBytes: Uint8Array): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const temp = `${cachePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, dllBytes);
    renameSync(temp, cachePath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readHeadTwoBytes(filePath: string): [number, number] | null {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(2);
    const n = readSync(fd, buf, 0, 2, 0);
    if (n < 2) return null;
    return [buf[0] ?? 0, buf[1] ?? 0];
  } finally {
    closeSync(fd);
  }
}

function extractFromLocalZip(
  filePath: string,
  expectedSha256?: string | string[],
): { dllBytes: Uint8Array; sha256: string } {
  const fast = tryExtractPluginFromLocalZipFast(filePath, expectedSha256);
  if (fast) return fast;
  return extractPluginDllFromBytes(readFileSync(filePath), expectedSha256);
}

function inspectCandidateFile(
  filePath: string,
  source: DiscoveredDllCandidate["source"],
  acceptedShas: string[],
): DiscoveredDllCandidate | null {
  try {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) return null;
    const stats = statSync(resolved);
    if (!stats.isFile() || stats.size < 2) return null;

    const head = readHeadTwoBytes(resolved);
    const isZip = resolved.toLowerCase().endsWith(".zip") || (head !== null && head[0] === 0x50 && head[1] === 0x4b);

    if (isZip) {
      if (stats.size > MAX_ZIP_INSPECT_BYTES) return null;
      const { sha256 } = extractFromLocalZip(resolved);
      return {
        path: resolved,
        kind: "zip",
        source,
        sha256,
        sha256MatchesExpected: acceptedShas.includes(sha256),
        sizeBytes: stats.size,
      };
    }

    if (head === null || head[0] !== 0x4d || head[1] !== 0x5a) {
      return null;
    }
    const bytes = readFileSync(resolved);
    const sha256 = computeBufferSha256(bytes);
    return {
      path: resolved,
      kind: "dll",
      source,
      sha256,
      sha256MatchesExpected: acceptedShas.includes(sha256),
      sizeBytes: stats.size,
    };
  } catch {
    return null;
  }
}

export function discoverLocalPluginDllCandidates(options: {
  dataDir?: string;
  dllPath?: string;
  expectedSha256?: string;
  version?: string;
  searchDirs?: string[];
  extraFilePaths?: string[];
  includeDefaultUserDirs?: boolean;
} = {}): DiscoveredDllCandidate[] {
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const version = options.version ?? DEFAULT_PLUGIN_DLL_MANIFEST.version;
  const acceptedShas = acceptedPluginSha256s(options.expectedSha256);
  const candidates: DiscoveredDllCandidate[] = [];
  const seenFiles = new Set<string>();

  const pushCandidate = (candidate: DiscoveredDllCandidate | null) => {
    if (!candidate) return;
    const key = process.platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    candidates.push(candidate);
  };

  // 1. Explicit dllPath / env override
  const explicitPath = (options.dllPath ?? process.env.MEMOQ_PLUGIN_DLL_PATH ?? "").trim();
  if (explicitPath) {
    pushCandidate(inspectCandidateFile(explicitPath, "explicit", acceptedShas));
  }

  // 2. Local bridge cache
  const cachePath = getPluginAssetCachePath(dataDir, version);
  pushCandidate(inspectCandidateFile(cachePath, "cache", acceptedShas));

  // 3. memoQ AI Hub resources
  for (const hubCandidate of defaultDiscoveryCandidates()) {
    pushCandidate(inspectCandidateFile(hubCandidate, "memoq-ai-hub", acceptedShas));
  }

  // 4. Extra sibling file paths (e.g. memoQ Addins DLLs)
  for (const extra of options.extraFilePaths ?? []) {
    if (!extra?.trim()) continue;
    pushCandidate(inspectCandidateFile(extra, "memoq-addins", acceptedShas));
  }

  // 5. Non-recursive + 1-level memoQ subdir scan of searchDirs and default user folders
  const rawDirs = [...(options.searchDirs ?? [])];
  if (options.includeDefaultUserDirs !== false) {
    const home = homedir();
    rawDirs.push(process.cwd(), join(home, "Downloads"), join(home, "Desktop"));
  }

  const seenDirs = new Set<string>();
  for (const rawDir of rawDirs) {
    if (!rawDir?.trim()) continue;
    let resolvedDir: string;
    try {
      resolvedDir = resolve(rawDir.trim());
    } catch {
      continue;
    }
    const dirKey = process.platform === "win32" ? resolvedDir.toLowerCase() : resolvedDir;
    if (seenDirs.has(dirKey)) continue;
    seenDirs.add(dirKey);
    if (!existsSync(resolvedDir)) continue;

    try {
      const entries = readdirSync(resolvedDir, { withFileTypes: true }).slice(0, MAX_DISCOVERY_DIR_ENTRIES);
      for (const entry of entries) {
        if (entry.isFile()) {
          const lowerName = entry.name.toLowerCase();
          if (lowerName === PLUGIN_DLL_NAME.toLowerCase()) {
            pushCandidate(inspectCandidateFile(join(resolvedDir, entry.name), "local-folder", acceptedShas));
          } else if (lowerName.endsWith(".zip") && ZIP_CANDIDATE_NAME_RE.test(entry.name)) {
            pushCandidate(inspectCandidateFile(join(resolvedDir, entry.name), "local-folder", acceptedShas));
          }
          continue;
        }
        if (entry.isDirectory() && /memoq/iu.test(entry.name)) {
          const subDir = join(resolvedDir, entry.name);
          for (const rel of [
            PLUGIN_DLL_NAME,
            join("resources", PLUGIN_DLL_NAME),
            join("resources", "memoq-integration", PLUGIN_DLL_NAME),
          ]) {
            pushCandidate(inspectCandidateFile(join(subDir, rel), "local-folder", acceptedShas));
          }
        }
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  return candidates.sort((a, b) => {
    const matchDiff = Number(b.sha256MatchesExpected) - Number(a.sha256MatchesExpected);
    if (matchDiff !== 0) return matchDiff;
    return Number(b.kind === "dll") - Number(a.kind === "dll");
  });
}

export async function resolvePluginDllAsset(
  options: ResolvePluginDllOptions = {},
): Promise<ResolvedPluginDllAsset> {
  const dataDir = options.dataDir ?? defaultBridgeDataDir();
  const version = options.version ?? DEFAULT_PLUGIN_DLL_MANIFEST.version;
  const acceptedShas = acceptedPluginSha256s(options.expectedSha256);
  const expectedDisplay = acceptedShas.join(" or ");
  const cachePath = getPluginAssetCachePath(dataDir, version);

  const explicitPath = (options.dllPath ?? process.env.MEMOQ_PLUGIN_DLL_PATH ?? "").trim();
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (!existsSync(resolved)) {
      throw new Error(`Configured MEMOQ_PLUGIN_DLL_PATH does not exist: ${resolved}`);
    }
    const head = readHeadTwoBytes(resolved);
    const isZip = resolved.toLowerCase().endsWith(".zip") || (head !== null && head[0] === 0x50 && head[1] === 0x4b);
    if (isZip) {
      const extracted = extractFromLocalZip(
        resolved,
        options.allowUnverifiedLocalDev ? undefined : acceptedShas,
      );
      writeAtomicCacheDll(cachePath, extracted.dllBytes);
      return {
        path: cachePath,
        sha256: extracted.sha256,
        version,
        source: "explicit",
        verified: acceptedShas.includes(extracted.sha256),
      };
    }

    if (head === null || head[0] !== 0x4d || head[1] !== 0x5a) {
      throw new Error(`File is neither a PE DLL nor a ZIP archive containing ${PLUGIN_DLL_NAME}: ${resolved}`);
    }
    const rawBytes = readFileSync(resolved);
    const sha256 = computeBufferSha256(rawBytes);
    const verified = acceptedShas.includes(sha256);
    if (!options.allowUnverifiedLocalDev && acceptedShas.length > 0 && !verified) {
      throw new Error(`Plugin DLL SHA-256 mismatch at ${resolved}. Expected ${expectedDisplay}, actual ${sha256}.`);
    }
    return {
      path: resolved,
      sha256,
      version,
      source: "explicit",
      verified,
    };
  }

  if (existsSync(cachePath)) {
    const sha256 = computeFileSha256(cachePath);
    if (acceptedShas.length === 0 || acceptedShas.includes(sha256)) {
      return {
        path: cachePath,
        sha256,
        version,
        source: "cache",
        verified: acceptedShas.includes(sha256),
      };
    }
  }

  const discoveryPaths = [...(options.searchPaths ?? []), ...defaultDiscoveryCandidates()];
  for (const candidate of discoveryPaths) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const head = readHeadTwoBytes(candidate);
      const isZip = candidate.toLowerCase().endsWith(".zip") || (head !== null && head[0] === 0x50 && head[1] === 0x4b);
      if (isZip) {
        const extracted = extractFromLocalZip(candidate, acceptedShas);
        writeAtomicCacheDll(cachePath, extracted.dllBytes);
        return {
          path: cachePath,
          sha256: extracted.sha256,
          version,
          source: "local-discovery",
          verified: true,
        };
      }
      if (head === null || head[0] !== 0x4d || head[1] !== 0x5a) continue;
      const rawBytes = readFileSync(candidate);
      const sha256 = computeBufferSha256(rawBytes);
      if (acceptedShas.length > 0 && !acceptedShas.includes(sha256)) continue;
      writeAtomicCacheDll(cachePath, rawBytes);
      return {
        path: cachePath,
        sha256,
        version,
        source: "local-discovery",
        verified: true,
      };
    } catch {
      continue;
    }
  }

  if ((options.searchDirs && options.searchDirs.length > 0) || options.includeDefaultUserDirs === true) {
    const folderCandidates = discoverLocalPluginDllCandidates({
      dataDir,
      ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
      version,
      searchDirs: options.searchDirs ?? [],
      includeDefaultUserDirs: options.includeDefaultUserDirs === true,
    });
    for (const candidate of folderCandidates) {
      try {
        if (candidate.kind === "zip") {
          const extracted = extractFromLocalZip(candidate.path, acceptedShas);
          writeAtomicCacheDll(cachePath, extracted.dllBytes);
          return {
            path: cachePath,
            sha256: extracted.sha256,
            version,
            source: "local-discovery",
            verified: true,
          };
        }
        const rawBytes = readFileSync(candidate.path);
        const sha256 = computeBufferSha256(rawBytes);
        if (acceptedShas.length > 0 && !acceptedShas.includes(sha256)) continue;
        writeAtomicCacheDll(cachePath, rawBytes);
        return {
          path: cachePath,
          sha256,
          version,
          source: "local-discovery",
          verified: true,
        };
      } catch {
        continue;
      }
    }
  }

  if (options.allowDownload === false) {
    throw new Error(
      `Plugin DLL ${PLUGIN_DLL_NAME} is not cached locally (expected SHA-256 ${expectedDisplay}). Run memoq_setup to download or provide MEMOQ_PLUGIN_DLL_PATH.`,
    );
  }

  const rawUrl = (options.downloadUrl ?? process.env.MEMOQ_PLUGIN_DLL_URL ?? DEFAULT_PLUGIN_DLL_MANIFEST.downloadUrl).trim();
  const parsedUrl = parseAllowedAssetUrl(rawUrl);
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  let extracted: { dllBytes: Uint8Array; sha256: string } | null = null;
  let primaryError: Error | null = null;

  try {
    extracted = await downloadPluginDllViaHttpRange(parsedUrl, acceptedShas, fetchFn, timeoutMs);
    if (!extracted) {
      const { response } = await fetchFollowingValidatedRedirects(parsedUrl, { method: "GET" }, fetchFn, timeoutMs);
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`Failed to download ${PLUGIN_DLL_NAME} (${response.status} ${response.statusText}).`);
      }
      const rawBytes = await readResponseBytesBounded(response, MAX_ZIP_INSPECT_BYTES);
      extracted = extractPluginDllFromBytes(rawBytes, acceptedShas);
    }
  } catch (error: unknown) {
    if (error instanceof PluginAssetIntegrityError || error instanceof PluginAssetPolicyError) {
      throw error;
    }
    primaryError = error instanceof Error ? error : new Error(String(error));
  }

  if (!extracted && options.fetchImpl === undefined && process.platform === "win32") {
    try {
      extracted = await tryDownloadViaWindowsHelper({
        url: parsedUrl.href,
        acceptedShas,
        dataDir,
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
        ...(options.helperExecutablePath === undefined ? {} : { helperExecutablePath: options.helperExecutablePath }),
        timeoutMs,
      });
    } catch (helperError: unknown) {
      if (helperError instanceof PluginAssetIntegrityError || helperError instanceof PluginAssetPolicyError) {
        throw helperError;
      }
      const helperMsg = helperError instanceof Error ? helperError.message : String(helperError);
      const primaryMsg = primaryError?.message ?? "unknown fetch failure";
      throw new Error(
        `Unable to download ${PLUGIN_DLL_NAME} from ${parsedUrl.href}. Node fetch error: ${primaryMsg}. Windows system-proxy helper error: ${helperMsg}. Please check network/proxy access or pass a local dllPath / MEMOQ_PLUGIN_DLL_PATH.`,
      );
    }
  }

  if (!extracted) {
    const primaryMsg = primaryError?.message ?? "unknown fetch failure";
    throw new Error(
      `Unable to download ${PLUGIN_DLL_NAME} from ${parsedUrl.href}: ${primaryMsg}. Please check network/proxy access or pass a local dllPath / MEMOQ_PLUGIN_DLL_PATH.`,
    );
  }

  writeAtomicCacheDll(cachePath, extracted.dllBytes);

  return {
    path: cachePath,
    sha256: extracted.sha256,
    version,
    source: "downloaded",
    verified: acceptedShas.includes(extracted.sha256),
  };
}
