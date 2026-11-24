import * as z from "zod/v4";
import { defineSharedTool, LOCAL_READ } from "../tool.ts";

export function createAssetServiceTool(name: string, baseUrl: URL | undefined) {
  return defineSharedTool(name, {
    title: "Read company localization assets",
    description: "Read the configured company asset service. Choose health for availability, glossary for terminology, or tm for translation memory.",
    annotations: LOCAL_READ,
    inputSchema: {
      view: z.enum(["health", "glossary", "tm"]).optional().describe("Asset view. Defaults to health."),
      maxEntries: z.number().int().min(1).optional().describe("Maximum entries returned. Defaults to 100."),
    },
  }, async ({ view = "health", maxEntries = 100 }, signal) => {
    if (!baseUrl) throw new Error("Asset endpoint is not configured.");
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(new URL(view, baseUrl), {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Asset service returned ${response.status}.`);
    const value = await response.json();
    if (view !== "health" && Array.isArray(value?.entries)) {
      return { ...value, entries: value.entries.slice(0, maxEntries), total: value.entries.length };
    }
    return value;
  });
}
