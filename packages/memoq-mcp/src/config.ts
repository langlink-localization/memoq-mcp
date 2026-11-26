import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MCP_CLIENTS = ["codex", "claude", "workbuddy", "zcode", "trae", "agents"] as const;
export type McpClient = typeof MCP_CLIENTS[number];
export type UpdateMode = "latest" | "pinned";

export interface ClientRecipe {
  client: McpClient;
  path: string | null;
  format: "toml" | "json";
  content: string;
  notes: string[];
  updateMode: UpdateMode;
}

const SERVER_NAME = "memoq";
const PACKAGE = "@langlink/memoq-mcp";

function packageSpec(updateMode: UpdateMode, version?: string): string {
  if (updateMode === "pinned") {
    if (!version) throw new Error("--pinned requires an exact version, e.g. --pinned 0.1.0");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error("--pinned version must be exact SemVer");
    }
    return `${PACKAGE}@${version}`;
  }
  return `${PACKAGE}@latest`;
}

function stdio(updateMode: UpdateMode, version?: string, preferOnline = false): { command: string; args: string[] } {
  const args =
    preferOnline && updateMode === "latest"
      ? ["-y", "--prefer-online", packageSpec(updateMode, version)]
      : ["-y", packageSpec(updateMode, version)];
  return { command: "npx", args };
}

function updateNote(updateMode: UpdateMode): string {
  return updateMode === "latest"
    ? "Uses @latest: each new MCP process can pick up the latest release; pin with --pinned <version> for reproducibility."
    : "Uses an exact pinned version; update by changing the version in the config.";
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function workbuddyConfigPath(home: string): string | null {
  const currentDir = join(home, ".workbuddy-ai");
  const current = join(currentDir, "mcp.json");
  const legacy = join(home, ".workbuddy", "mcp.json");
  if (existsSync(legacy)) return existsSync(currentDir) ? null : legacy;
  return existsSync(current) ? current : null;
}

export function clientRecipe(
  client: McpClient,
  home = homedir(),
  updateMode: UpdateMode = "latest",
  version?: string,
  configPath?: string,
): ClientRecipe {
  const withUpdate = { updateMode };
  switch (client) {
    case "codex":
      return {
        ...withUpdate,
        client,
        path: join(home, ".codex/config.toml"),
        format: "toml",
        content: `[mcp_servers.${SERVER_NAME}]
command = "npx"
args = ["-y", "${packageSpec(updateMode, version)}"]
startup_timeout_sec = 30
tool_timeout_sec = 120
`,
        notes: [
          "Codex CLI reads this from ~/.codex/config.toml.",
          `Equivalent command: codex mcp add ${SERVER_NAME} -- npx -y ${packageSpec(updateMode, version)}`,
          "Runs locally on Windows to talk to memoQ Preview named pipe and loopback port 5271.",
          updateNote(updateMode),
        ],
      };
    case "claude":
      return {
        ...withUpdate,
        client,
        path: null,
        format: "json",
        content: json({ mcpServers: { [SERVER_NAME]: { type: "stdio", ...stdio(updateMode, version) } } }),
        notes: [
          `Add to Claude Code user scope: claude mcp add --scope user --transport stdio ${SERVER_NAME} -- npx -y ${packageSpec(updateMode, version)}`,
          "For project scope, merge this JSON into .mcp.json. This command only prints the Claude Code recipe.",
          updateNote(updateMode),
        ],
      };
    case "workbuddy":
      return {
        ...withUpdate,
        client,
        path: configPath ? resolve(configPath) : workbuddyConfigPath(home),
        format: "json",
        content: json({ mcpServers: { [SERVER_NAME]: stdio(updateMode, version, true) } }),
        notes: [
          "Use the path shown in WorkBuddy → Custom connectors → Configure MCP.",
          "If the path is different or not detected, merge the entry in WorkBuddy or pass --config-path with the displayed path.",
          "Enable the connector in WorkBuddy and call memoq_status in a new local session. If it fails to start, use Copy log on the connector.",
          updateNote(updateMode),
        ],
      };
    case "zcode":
      return {
        ...withUpdate,
        client,
        path: join(home, ".zcode/cli/config.json"),
        format: "json",
        content: json({ mcp: { servers: { [SERVER_NAME]: { ...stdio(updateMode, version), env: {} } } } }),
        notes: [
          "ZCode user config is ~/.zcode/cli/config.json with mcp.servers.",
          "Alternatively merge the generic mcpServers shape into ~/.agents/mcp.json.",
          updateNote(updateMode),
        ],
      };
    case "trae":
      return {
        ...withUpdate,
        client,
        path: null,
        format: "json",
        content: json({ mcpServers: { [SERVER_NAME]: stdio(updateMode, version) } }),
        notes: [
          "Trae manages MCP servers through its MCP settings UI; paste the JSON snippet there.",
          updateNote(updateMode),
        ],
      };
    case "agents":
      return {
        ...withUpdate,
        client,
        path: join(home, ".agents/mcp.json"),
        format: "json",
        content: json({ mcpServers: { [SERVER_NAME]: stdio(updateMode, version) } }),
        notes: ["Shared ~/.agents/mcp.json convention.", updateNote(updateMode)],
      };
  }
}

export function allRecipes(
  home = homedir(),
  updateMode: UpdateMode = "latest",
  version?: string,
): ClientRecipe[] {
  return MCP_CLIENTS.map((client) =>
    clientRecipe(client, home, updateMode, version),
  );
}

export interface WriteResult {
  client: McpClient;
  path: string;
  action: "created" | "merged" | "unchanged" | "manual";
  backup?: string;
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function readConfig(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseConfig(content: string, target: string): Record<string, unknown> {
  try {
    return objectAt(JSON.parse(content.replace(/^\uFEFF/u, "")), target);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`Invalid JSON in ${target}. Open the MCP editor to repair the config before retrying.`);
  }
}

async function mergeJson(recipe: ClientRecipe, target: string): Promise<WriteResult> {
  await mkdir(dirname(target), { recursive: true });
  const lock = `${target}.langlink-config.lock`;
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Another LangLink config write is in progress. Retry in a moment. After an interrupted install, confirm it stopped before removing the empty lock directory: ${lock}`);
  }

  let staged: string | undefined;
  try {
    const original = await readConfig(target);
    const existing = original === undefined ? {} : parseConfig(original, target);
    const next = objectAt(JSON.parse(recipe.content), recipe.client);
    const zcode = recipe.client === "zcode";
    const parent = zcode ? objectAt((existing.mcp ??= {}), "mcp") : existing;
    const key = zcode ? "servers" : "mcpServers";
    const servers = objectAt((parent[key] ??= {}), key);
    const nextParent = zcode ? objectAt(next.mcp, "mcp") : next;
    const candidate = objectAt(objectAt(nextParent[key], key)[SERVER_NAME], SERVER_NAME);
    const originalEntry = servers[SERVER_NAME];
    if (originalEntry === undefined) {
      servers[SERVER_NAME] = candidate;
    } else {
      const current = objectAt(originalEntry, SERVER_NAME);
      if (current.url !== undefined || (current.type !== undefined && current.type !== "stdio")) {
        throw new Error(`The ${SERVER_NAME} entry is not a local stdio connector. Review it in the MCP editor before replacing it.`);
      }
      if (current.command === candidate.command && JSON.stringify(current.args) === JSON.stringify(candidate.args)) {
        return { client: recipe.client, path: target, action: "unchanged" };
      }
      servers[SERVER_NAME] = { ...current, command: candidate.command, args: candidate.args };
    }

    const suffix = `${Date.now()}.${randomUUID()}`;
    const mode = original === undefined ? 0o600 : (await stat(target)).mode & 0o777;
    staged = `${target}.tmp.${suffix}`;
    await writeFile(staged, json(existing), { mode, flag: "wx" });
    if (await readConfig(target) !== original) {
      throw new Error(`Configuration changed while saving. Reopen it and retry: ${target}`);
    }
    let backup: string | undefined;
    if (original !== undefined) {
      backup = `${target}.bak.${suffix}`;
      await writeFile(backup, original, { mode: 0o600, flag: "wx" });
    }
    await rename(staged, target);
    return backup === undefined
      ? { client: recipe.client, path: target, action: "created" }
      : { client: recipe.client, path: target, action: "merged", backup };
  } finally {
    try {
      if (staged !== undefined) await rm(staged, { force: true });
    } finally {
      await rmdir(lock);
    }
  }
}

export async function writeRecipe(recipe: ClientRecipe): Promise<WriteResult> {
  if (!recipe.path) {
    return { client: recipe.client, path: "", action: "manual" };
  }
  if (recipe.format === "toml") {
    try {
      await readFile(recipe.path, "utf8");
      return { client: recipe.client, path: recipe.path, action: "manual" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(recipe.path), { recursive: true });
    await writeFile(recipe.path, recipe.content, "utf8");
    return { client: recipe.client, path: recipe.path, action: "created" };
  }
  return mergeJson(recipe, recipe.path);
}
