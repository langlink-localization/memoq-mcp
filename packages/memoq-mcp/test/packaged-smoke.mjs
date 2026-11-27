import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "memoq_apply_edits",
  "memoq_approve_staged",
  "memoq_clear_staged",
  "memoq_focus_segment",
  "memoq_get_active_segment",
  "memoq_get_confirmed_translations",
  "memoq_get_document_segments",
  "memoq_get_recent_mt_requests",
  "memoq_list_documents",
  "memoq_list_staged",
  "memoq_open_review",
  "memoq_qa_document",
  "memoq_setup",
  "memoq_stage_translations",
  "memoq_status",
];

const entrypoint = process.argv[2];
assert.ok(entrypoint, "Pass the installed @langlink/memoq-mcp package entrypoint.");

const tmpDir = await mkdtemp(join(tmpdir(), "langlink-memoq-mcp-smoke-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
env.MEMOQ_BRIDGE_DATA_DIR = tmpDir;
env.MEMOQ_BRIDGE_PORT = "0";

const client = new Client({ name: "langlink-memoq-mcp-package-smoke", version: "1.0.0" });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      env,
    }),
  );

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);

  const stage = tools.find((tool) => tool.name === "memoq_stage_translations");
  assert.equal(stage?.inputSchema?.properties?.items?.type, "array");

  const qa = tools.find((tool) => tool.name === "memoq_qa_document");
  assert.equal(qa?.inputSchema?.properties?.allDocuments?.type, "boolean");

  const setup = tools.find((tool) => tool.name === "memoq_setup");
  assert.equal(setup?.inputSchema?.properties?.action?.type, "string");
  assert.equal(setup?.inputSchema?.properties?.confirmed?.type, "boolean");
  assert.equal(setup?.inputSchema?.properties?.memoqRoot?.type, "string");
  assert.equal(setup?.inputSchema?.properties?.dllPath?.type, "string");

  const statusResult = await client.callTool({ name: "memoq_status", arguments: {} });
  assert.ok(!statusResult.isError, JSON.stringify(statusResult.content));
  const statusText = statusResult.content?.[0]?.text;
  assert.equal(typeof statusText, "string");
  const statusJson = JSON.parse(statusText);
  assert.equal(statusJson?.staging?.maxStaged, 100_000);

  const docsResult = await client.callTool({ name: "memoq_list_documents", arguments: {} });
  assert.ok(!docsResult.isError, JSON.stringify(docsResult.content));
  const docsJson = JSON.parse(docsResult.content[0].text);
  assert.equal(Array.isArray(docsJson.documents), true);

  console.log("Installed memoQ MCP package lists all 15 tools and executes memoq_status/memoq_list_documents.");
} finally {
  await client.close();
  const daemonFile = join(tmpDir, "daemon.json");
  if (existsSync(daemonFile)) {
    try {
      const parsed = JSON.parse(readFileSync(daemonFile, "utf8"));
      const pid = Number(parsed?.pid ?? 0);
      if (Number.isInteger(pid) && pid > 0) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          process.kill(pid, "SIGTERM");
        }
      }
    } catch {
      // Best-effort cleanup of the isolated smoke daemon.
    }
  }
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
