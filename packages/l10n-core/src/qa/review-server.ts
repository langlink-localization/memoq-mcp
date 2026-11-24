import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import ExcelJS from "exceljs";
import { escapeCsvField } from "./report.ts";
import {
  DEFAULT_REVIEW_TOOL,
  REVIEW_COLUMNS,
  REVIEW_TOTAL_BYTES,
  formatReviewTool,
  reviewOptions,
  runQaReview,
  sanitizeReviewTool,
  type ReviewReport,
  type ReviewRow,
  type ReviewToolInfo,
} from "./review-data.ts";
import { renderReviewPage } from "./review-page.ts";
import { createReviewPresentation } from "./review-presentation.ts";
import { writeReviewXlsx } from "./review-xlsx.ts";

const HOST = "127.0.0.1";
const MAX_BODY = 40 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const columnKeys = Object.keys(REVIEW_COLUMNS) as Array<keyof typeof REVIEW_COLUMNS>;

class RequestTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_BODY) throw new RequestTooLarge("本次请求超过大小限制。请减少文件或缩小导出范围。");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

function reply(response: ServerResponse, status: number, type: string, body: string | Uint8Array): void {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  reply(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

async function readUpload(request: IncomingMessage) {
  const type = request.headers["content-type"] ?? "";
  if (!type.startsWith("multipart/form-data;")) throw new Error("请选择双语文件。");
  const data = await new Response(await readBody(request), { headers: { "Content-Type": type } }).formData();
  const options = data.get("options");
  const files = data.getAll("file");
  if (typeof options !== "string" || !files.every((file) => file instanceof File)) {
    throw new Error("缺少文件或检查设置。");
  }
  if (files.reduce((size, file) => size + file.size, 0) > REVIEW_TOTAL_BYTES) {
    throw new RequestTooLarge("文件合计超过 36 MB。");
  }
  return { data, files, options: reviewOptions(JSON.parse(options)) };
}

export {
  DEFAULT_REVIEW_TOOL,
  REVIEW_COLUMNS,
  REVIEW_GROUPS,
  customFinding,
  formatReviewTool,
  sanitizeReviewTool,
  type ReviewReport,
  type ReviewRow,
  type ReviewSegment,
  type ReviewSpan,
  type ReviewToolInfo,
} from "./review-data.ts";
export { renderReviewPage } from "./review-page.ts";
export { createReviewPresentation } from "./review-presentation.ts";
export { writeReviewXlsx } from "./review-xlsx.ts";

export function validateReviewExportReport(bytes: Uint8Array): ReviewReport {
  const report = JSON.parse(new TextDecoder().decode(bytes)) as ReviewReport;
  if (!report || !Array.isArray(report.rows) || !Array.isArray(report.files) ||
      report.rows.some((row) => !row || columnKeys.some((key) => typeof row[key] !== "string")) ||
      report.files.some((file) => !file || typeof file.name !== "string" || !Number.isSafeInteger(file.segments) ||
        typeof file.incomplete !== "boolean" || (file.error !== undefined && typeof file.error !== "string"))) {
    throw new Error("导出数据无效。");
  }
  const optional: Pick<ReviewReport, "configuration" | "aiqa" | "tool"> = {};
  if (report.configuration && typeof report.configuration === "object" &&
      typeof report.configuration.aiqa === "boolean" &&
      Array.isArray(report.configuration.checks) &&
      report.configuration.checks.every((check) => typeof check === "string")) {
    optional.configuration = { aiqa: report.configuration.aiqa, checks: report.configuration.checks };
  }
  if (report.aiqa && typeof report.aiqa === "object" &&
      ["totalSegments", "completedSegments", "autoPass", "humanReview", "unavailable", "pending"]
        .every((key) => Number.isSafeInteger((report.aiqa as unknown as Record<string, unknown>)[key]))) {
    optional.aiqa = report.aiqa;
  }
  const tool = sanitizeReviewTool(report.tool);
  if (tool) optional.tool = tool;
  return { rows: report.rows, files: report.files, ...optional };
}

function csvCell(value: string): string {
  // Excel interprets some CSV strings as formulas even when quoted.
  return escapeCsvField(/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(value) ? "'" + value : value);
}

export async function buildReviewExportArtifact(
  format: "xlsx" | "csv" | "html",
  report: ReviewReport,
): Promise<{ contentType: string; body: string | Uint8Array }> {
  const toolLabel = formatReviewTool(report.tool);
  if (format === "html") {
    return { contentType: "text/html; charset=utf-8", body: renderReviewPage(report, "", false, report.tool) };
  }
  const headers = toolLabel ? [...Object.values(REVIEW_COLUMNS), "工具版本"] : Object.values(REVIEW_COLUMNS);
  if (format === "csv") {
    const lines = [
      headers.join(","),
      ...report.rows.map((row) => {
        const cells = columnKeys.map((key) => csvCell(row[key]));
        if (toolLabel) cells.push(csvCell(toolLabel));
        return cells.join(",");
      }),
    ];
    return { contentType: "text/csv; charset=utf-8", body: "\uFEFF" + lines.join("\r\n") + "\r\n" };
  }
  const bytes = await writeReviewXlsx(ExcelJS.Workbook, report.rows, createReviewPresentation(), report);
  return { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: bytes };
}

async function exportReport(response: ServerResponse, format: "xlsx" | "csv" | "html", report: ReviewReport): Promise<void> {
  response.setHeader("Content-Disposition", `attachment; filename="langlink-qa.${format}"`);
  const { contentType, body } = await buildReviewExportArtifact(format, report);
  reply(response, 200, contentType, body);
}

export interface QaReviewServer {
  url: string;
  close(): Promise<void>;
}

export async function listenQaReview(options: {
  onClose?: () => void;
  keepAlive?: boolean;
  tool?: ReviewToolInfo;
} = {}): Promise<QaReviewServer> {
  const tool = sanitizeReviewTool(options.tool) ?? DEFAULT_REVIEW_TOOL;
  let origin: string;
  let authority: string;
  let expiry: NodeJS.Timeout;
  const server = createServer((request, response) => {
    if (request.headers.host !== authority) {
      json(response, 403, { error: "请使用本机检查页面。" });
      return;
    }
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    if (request.method === "GET" && request.url === "/") {
      expiry.refresh();
      const nonce = randomBytes(16).toString("base64");
      response.setHeader("Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      reply(response, 200, "text/html; charset=utf-8", renderReviewPage(undefined, nonce, false, tool));
      return;
    }
    if (request.method !== "POST" || request.headers.origin !== origin) {
      json(response, 403, { error: "请从本机检查页面发起操作。" });
      return;
    }
    expiry.refresh();
    void (async () => {
      if (request.url === "/check") {
        const { files, options } = await readUpload(request);
        json(response, 200, await runQaReview(files, options));
        return;
      }
      const format = /^\/export\/(xlsx|csv|html)$/u.exec(request.url ?? "")?.[1] as "xlsx" | "csv" | "html" | undefined;
      if (format === undefined) {
        json(response, 404, { error: "找不到此操作。" });
        return;
      }
      await exportReport(response, format, { ...validateReviewExportReport(await readBody(request)), tool });
    })().catch((cause: unknown) => {
      if (response.destroyed || response.headersSent) return;
      response.removeHeader("Content-Disposition");
      json(response, cause instanceof RequestTooLarge ? 413 : 400, {
        error: cause instanceof Error ? cause.message : "操作失败。",
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动本机检查页面。");
  authority = `${HOST}:${address.port}`;
  origin = `http://${authority}`;
  expiry = setTimeout(() => server.close(), IDLE_TIMEOUT_MS);
  expiry.unref();
  if (!options.keepAlive) server.unref();
  server.once("close", () => { clearTimeout(expiry); options.onClose?.(); });
  return { url: origin + "/", close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let activeReview: Promise<QaReviewServer> | undefined;

export function qaReviewMessage(url: string): string {
  return `[打开双语文件检查](${url})，选择文件和规则后点击「运行检查」。也可以把链接复制到本机浏览器打开。`;
}

export async function openQaReview(options: { tool?: ReviewToolInfo } = {}): Promise<{ url: string; message: string }> {
  activeReview ??= listenQaReview({
    ...(options.tool ? { tool: options.tool } : {}),
    onClose: () => { activeReview = undefined; },
  }).catch((cause: unknown) => {
    activeReview = undefined;
    throw cause;
  });
  const { url } = await activeReview;
  return { url, message: qaReviewMessage(url) };
}
