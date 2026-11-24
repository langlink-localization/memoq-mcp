import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    mkdirSync(join(home, ".workbuddy"), { recursive: true });
    writeFileSync(
      join(home, ".workbuddy/mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "echo" } } }, null, 2),
      "utf8",
    );
    const workbuddy = clientRecipe("workbuddy", home);
    const first = await writeRecipe(workbuddy);
    assert.equal(first.action, "merged");
    assert.ok(first.backup);
    const merged = JSON.parse(readFileSync(join(home, ".workbuddy/mcp.json"), "utf8"));
    assert.deepEqual(merged.mcpServers.other, { command: "echo" });
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

    assert.ok(readdirSync(join(home, ".workbuddy")).some((f) => f.startsWith("mcp.json.bak.")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
