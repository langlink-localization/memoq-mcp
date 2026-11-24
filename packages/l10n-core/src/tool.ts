import * as z from "zod/v4";

type Shape = Record<string, z.ZodType>;

export const LOCAL_READ = { readOnlyHint: true, openWorldHint: false } as const;
export const LOCAL_WRITE = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
} as const;

export function defineSharedTool<Inputs extends Shape, Result>(
  name: string,
  config: {
    title: string;
    description: string;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint: boolean;
    };
    inputSchema: Inputs;
    outputSchema?: Shape;
  },
  run: (args: z.output<z.ZodObject<Inputs>>, signal?: AbortSignal) => Result | Promise<Result>,
) {
  const inputSchema = z.strictObject(config.inputSchema);
  return {
    name,
    ...config,
    inputSchema,
    async execute(args: unknown, signal?: AbortSignal): Promise<Result> {
      signal?.throwIfAborted();
      return run(inputSchema.parse(args), signal);
    },
  };
}

export type SharedTool = ReturnType<typeof defineSharedTool>;

export function definePlatformJobTool(
  name: string,
  createJob: (
    documentId: string,
    input: { type: "translate" | "polish" | "aiqa" | "check"; segmentIds: string[]; model?: string; instruction?: string },
    options: { idempotencyKey: string; signal?: AbortSignal },
  ) => Promise<{ jobId: string }>,
) {
  return defineSharedTool(name, {
    title: "Start platform QA or suggestion job",
    annotations: { ...LOCAL_WRITE, idempotentHint: true },
    description: "Start a revision-safe platform QA or suggestion job for selected segments. Reuse the idempotency key and inputs for an identical retry.",
    inputSchema: {
      documentId: z.string(), type: z.enum(["translate", "polish", "aiqa", "check"]),
      segmentIds: z.array(z.string()).min(1).max(5000), model: z.string().optional(),
      instruction: z.string().max(2000).optional(), idempotencyKey: z.string().max(128),
    },
    outputSchema: { jobId: z.string() },
  }, ({ documentId, idempotencyKey, type, segmentIds, model, instruction }, signal) => createJob(
    documentId, { type, segmentIds, ...(model ? { model } : {}), ...(instruction ? { instruction } : {}) },
    { idempotencyKey, ...(signal ? { signal } : {}) },
  ));
}

/** DSH's raw registry accepts a JSON Schema and a validated execution callback. */
export function dshJsonTool(tool: SharedTool) {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(tool.inputSchema, { io: "input", target: "draft-7" });
  return {
    name: tool.name,
    description: tool.description,
    parameters: parameters as Record<string, unknown>,
    output: {
      schema: { type: "string" as const },
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: String(value) }],
    },
    async execute(args: unknown, exec?: { signal?: AbortSignal }) {
      const value = await tool.execute(args, exec?.signal);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}
