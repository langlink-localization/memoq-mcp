import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

export function clientRecipe(
  client: McpClient,
  home = homedir(),
  updateMode: UpdateMode = "latest",
  version?: string,
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
        path: join(home, ".workbuddy/mcp.json"),
        format: "json",
        content: json({ mcpServers: { [SERVER_NAME]: stdio(updateMode, version, true) } }),
        notes: ["WorkBuddy also exposes MCP configuration in its Connectors UI.", updateNote(updateMode)],
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

async function mergeJson(recipe: ClientRecipe, target: string): Promise<WriteResult> {
  let existing: Record<string, unknown> = {};
  let exists = false;
  try {
    existing = objectAt(JSON.parse(await readFile(target, "utf8")), target);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    const backup = `${target}.bak.${Date.now()}`;
    await copyFile(target, backup);
    if (recipe.client === "zcode" || recipe.client === "workbuddy" || recipe.client === "agents") {
      const path = recipe.client === "zcode" ? ["mcp", "servers"] : ["mcpServers"];
      let node = existing;
      for (const key of path.slice(0, -1)) {
        node = objectAt((node[key] ??= {}), key);
      }
      const servers = objectAt((node[path[path.length - 1]!] ??= {}), path[path.length - 1]!);
      const next = objectAt(JSON.parse(recipe.content), recipe.client);
      const nextServers =
        recipe.client === "zcode"
          ? objectAt(objectAt(next.mcp, "mcp").servers, "servers")
          : objectAt(next.mcpServers, "mcpServers");
      const candidate = nextServers[SERVER_NAME];
      if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(candidate)) {
        return { client: recipe.client, path: target, action: "unchanged" };
      }
      servers[SERVER_NAME] = candidate;
      await writeFile(target, json(existing), "utf8");
      return { client: recipe.client, path: target, action: "merged", backup };
    }
    throw new Error(`refusing to rewrite existing non-JSON config: ${target}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, recipe.content, "utf8");
  return { client: recipe.client, path: target, action: "created" };
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
