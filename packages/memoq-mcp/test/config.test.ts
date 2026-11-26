import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allRecipes, clientRecipe, writeRecipe } from "../src/config.ts";

test("allRecipes covers every client and defaults to @latest", () => {
  const recipes = allRecipes("/tmp/home");
  assert.deepEqual(
    recipes.map((r) => r.client),
    ["codex", "claude", "workbuddy", "zcode", "trae", "agents"],
  );
  for (const r of recipes) {
    assert.ok(r.content.includes("@langlink/memoq-mcp@latest"), r.client);
    assert.equal(r.updateMode, "latest");
  }
});

test("pinned mode emits an exact SemVer package spec", () => {
  const recipe = clientRecipe("workbuddy", "/tmp/home", "pinned", "0.1.0");
  assert.ok(recipe.content.includes("@langlink/memoq-mcp@0.1.0"));
  assert.throws(() => clientRecipe("workbuddy", "/tmp/home", "pinned"), /--pinned requires/);
  assert.throws(() => clientRecipe("workbuddy", "/tmp/home", "pinned", "latest"), /SemVer/);
});

test("writeRecipe merges JSON configs safely, preserves peers, creates backup, and is idempotent", async () => {
  const home = mkdtempSync(join(tmpdir(), "memoq-mcp-cfg-"));
  try {
    const configDir = join(home, ".workbuddy-ai");
    const configPath = join(configDir, "mcp.json");
    const env = { MEMOQ_BRIDGE_PORT: "5272" };
    mkdirSync(configDir);
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: {
        langlink: { command: "node" },
        memoq: { command: "old", args: ["old"], env, timeout: 65000 },
      } }, null, 2),
      "utf8",
    );
    const workbuddy = clientRecipe("workbuddy", home);
    assert.equal(workbuddy.path, configPath);
    const first = await writeRecipe(workbuddy);
    assert.equal(first.action, "merged");
    assert.ok(first.backup);
    const merged = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(merged.mcpServers.langlink, { command: "node" });
    assert.deepEqual(merged.mcpServers.memoq.env, env);
    assert.equal(merged.mcpServers.memoq.timeout, 65000);
    assert.deepEqual(merged.mcpServers.memoq.args, ["-y", "--prefer-online", "@langlink/memoq-mcp@latest"]);

    const second = await writeRecipe(workbuddy);
    assert.equal(second.action, "unchanged");

    const codex = clientRecipe("codex", home);
    assert.equal((await writeRecipe(codex)).action, "created");
    assert.equal((await writeRecipe(codex)).action, "manual");

    const zcode = clientRecipe("zcode", home);
    assert.equal((await writeRecipe(zcode)).action, "created");
    const zcodeJson = JSON.parse(readFileSync(join(home, ".zcode/cli/config.json"), "utf8"));
    assert.deepEqual(zcodeJson.mcp.servers.memoq.args, ["-y", "@langlink/memoq-mcp@latest"]);

    const trae = clientRecipe("trae", home);
    assert.equal((await writeRecipe(trae)).action, "manual");
    const claude = clientRecipe("claude", home);
    assert.deepEqual(JSON.parse(claude.content).mcpServers.memoq, {
      type: "stdio", command: "npx", args: ["-y", "@langlink/memoq-mcp@latest"],
    });
    assert.equal((await writeRecipe(claude)).action, "manual");

    assert.equal(readdirSync(configDir).filter((f) => f.startsWith("mcp.json.bak.")).length, 1);
    assert.equal(existsSync(join(home, ".workbuddy")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("WorkBuddy falls back to the editor when no single config can be identified", async () => {
  const home = mkdtempSync(join(tmpdir(), "memoq-mcp-path-"));
  try {
    const current = join(home, ".workbuddy-ai", "mcp.json");
    const legacy = join(home, ".workbuddy", "mcp.json");
    assert.equal((await writeRecipe(clientRecipe("workbuddy", home))).action, "manual");
    assert.equal(existsSync(join(home, ".workbuddy")), false);

    // A user who has checked Configure MCP can use its exact path on a clean install.
    const explicit = clientRecipe("workbuddy", home, "latest", undefined, current);
    assert.equal((await writeRecipe(explicit)).action, "created");
    mkdirSync(join(home, ".workbuddy"));
    writeFileSync(legacy, '{"mcpServers":{}}');
    assert.equal((await writeRecipe(clientRecipe("workbuddy", home))).action, "manual");
    assert.equal((await writeRecipe(explicit)).action, "unchanged");
    assert.equal(readFileSync(legacy, "utf8"), '{"mcpServers":{}}');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
