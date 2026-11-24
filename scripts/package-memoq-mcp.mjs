import { build } from "esbuild";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const FORBIDDEN_PROPRIETARY_BINARIES = [
  "memoq.addins.common.dll",
  "memoq.mtinterfaces.dll",
  "memoq.ai.hub.plugin.dll",
  "memoq.addinsigner.exe",
];

function listTarEntriesFromTgz(tgzPath) {
  const tar = gunzipSync(readFileSync(tgzPath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    if (fullName) entries.push(fullName);
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/u, "").trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const dataBlocks = Number.isFinite(size) && size > 0 ? Math.ceil(size / 512) * 512 : 0;
    offset += 512 + dataBlocks;
  }
  return entries;
}

const root = resolve(import.meta.dirname, "..");
const packageDir = join(root, "packages/memoq-mcp");
const helperExe = join(root, "packages/memoq-bridge/bin/MemoQ.Bridge.Helper.exe");
const outDir = join(packageDir, "dist-package");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "dist"), { recursive: true });
mkdirSync(join(outDir, "bin"), { recursive: true });

if (existsSync(helperExe)) {
  cpSync(helperExe, join(outDir, "bin/MemoQ.Bridge.Helper.exe"));
} else if (process.platform === "win32") {
  throw new Error(
    `Missing built helper binary at ${helperExe}. Run scripts/build-memoq-helper.ps1 before packaging.`,
  );
}

const { metafile } = await build({
  entryPoints: [join(packageDir, "src/server.ts")],
  outfile: join(outDir, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The SDK converts Zod schemas at runtime. Bundle them together so npm's
  // dependency layout cannot give schema authors and the SDK different Zod versions.
  banner: {
    js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
  },
  external: [
    "exceljs",
    "fflate",
    "htmlparser2",
    "saxes",
  ],
  sourcemap: true,
  metafile: true,
  logLevel: "silent",
});

const bundledDependencies = new Set(
  Object.keys(metafile.inputs).flatMap((file) => {
    const manifestRoot = resolve(file)
      .replaceAll("\\", "/")
      .match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//u)?.[1];
    return manifestRoot ? [manifestRoot] : [];
  }),
);
const notices = [...bundledDependencies].sort().map((directory) => {
  const { name, version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"]
    .map((candidate) => join(directory, candidate))
    .find((candidate) => existsSync(candidate));
  const licenseText = licenseFile ? readFileSync(licenseFile, "utf8").trim() : "See package repository for license.";
  return `${name}@${version}\n\n${licenseText}`;
});
writeFileSync(join(outDir, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n") + "\n");

cpSync(join(root, "LICENSE"), join(outDir, "LICENSE"));
cpSync(join(packageDir, "README.md"), join(outDir, "README.md"));
cpSync(join(packageDir, "skills"), join(outDir, "skills"), { recursive: true });

const source = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    {
      name: source.name,
      version: source.version,
      private: false,
      type: "module",
      description: source.description,
      license: "MIT",
      repository: source.repository,
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
      engines: { node: ">=22" },
      main: "dist/index.js",
      bin: { "langlink-memoq-mcp": "dist/index.js" },
      files: ["dist", "bin", "skills", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
      dependencies: {
        exceljs: "^4.4.0",
        fflate: "^0.8.3",
        htmlparser2: "^12.0.0",
        saxes: "^6.0.0",
      },
    },
    null,
    2,
  ) + "\n",
);

const output = execSync("npm pack --silent", { cwd: outDir, encoding: "utf8" }).trim();
const tgzPath = join(outDir, output);
const entries = listTarEntriesFromTgz(tgzPath);

for (const entry of entries) {
  const lower = entry.toLowerCase();
  for (const forbidden of FORBIDDEN_PROPRIETARY_BINARIES) {
    if (lower.includes(forbidden)) {
      throw new Error(`Compliance violation: proprietary memoQ binary "${entry}" found in ${tgzPath}`);
    }
  }
}

if (process.platform === "win32" && !entries.includes("package/bin/MemoQ.Bridge.Helper.exe")) {
  throw new Error(`Expected package/bin/MemoQ.Bridge.Helper.exe in ${tgzPath}`);
}

console.log(tgzPath);
