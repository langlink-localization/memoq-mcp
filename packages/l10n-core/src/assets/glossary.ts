import type { GlossaryEntry, GlossaryParseResult } from "./types.ts";

export interface ParseGlossaryCsvOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
}

type Delimiter = "," | "\t";

const SOURCE_HEADERS = new Set(["source", "source term", "term", "源文", "原文"]);
const TARGET_HEADERS = new Set(["target", "target term", "translation", "译文", "目标", "目标语"]);
const FORBIDDEN_HEADERS = new Set(["forbidden", "disabled", "禁用", "禁用术语", "是否禁用"]);

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectDelimiter(text: string): Delimiter {
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (char === "\n") break;
      else if (char === ",") commas += 1;
      else if (char === "\t") tabs += 1;
    }
  }
  return tabs > commas ? "\t" : ",";
}

/** RFC 4180 style reader: quoted fields, `""` escapes, newlines inside quotes. */
export function parseCsvRows(text: string, delimiter: Delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushRow = (): void => {
    row.push(field);
    field = "";
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else if (char === "\r") {
        field += "\n";
        if (text[index + 1] === "\n") index += 1;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      if (text[index + 1] !== "\n") pushRow();
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function headerIndex(row: readonly string[], aliases: ReadonlySet<string>): number {
  return row.findIndex((cell) => aliases.has(cell.trim().toLowerCase()));
}

function isTruthyFlag(value: string): boolean {
  return /^(?:true|1|yes|y|是|禁用)$/i.test(value.trim());
}

function normalizedHeader(row: readonly string[]): string[] {
  return row.map((cell) => cell.trim().toLowerCase());
}

/**
 * Parse a glossary CSV (UTF-8, optional BOM) into `GlossaryEntry`s.
 *
 * Delimiter is comma or TAB, detected from the first row. Quoted fields may contain
 * delimiters and newlines; `""` escapes a quote. When the first row names
 * `source`/`target`/`forbidden` (Chinese `源文`/`译文`/`禁用` accepted) it is treated as a
 * header; otherwise columns 1–3 are source, target and forbidden. Forbidden accepts
 * `true/1/yes/是/禁用`. Rows without both source and target are skipped with a warning.
 */
export function parseGlossaryCsv(
  text: string,
  options: ParseGlossaryCsvOptions = {},
): GlossaryParseResult {
  const content = stripBom(text);
  const delimiter = detectDelimiter(content);
  const rows = parseCsvRows(content, delimiter);
  const warnings: string[] = [];
  if (rows.length === 0) return { entries: [], warnings: ["glossary: no rows found"] };

  let sourceColumn = 0;
  let targetColumn = 1;
  let forbiddenColumn: number | undefined = 2;
  let dataRows = rows;
  const first = rows[0];
  if (first) {
    const header = normalizedHeader(first);
    const sourceIndex = headerIndex(header, SOURCE_HEADERS);
    const targetIndex = headerIndex(header, TARGET_HEADERS);
    if (sourceIndex >= 0 && targetIndex >= 0) {
      sourceColumn = sourceIndex;
      targetColumn = targetIndex;
      const forbiddenIndex = headerIndex(header, FORBIDDEN_HEADERS);
      forbiddenColumn = forbiddenIndex >= 0 ? forbiddenIndex : undefined;
      const known = new Set([sourceIndex, targetIndex]);
      if (forbiddenIndex >= 0) known.add(forbiddenIndex);
      header.forEach((cell, index) => {
        if (cell !== "" && !known.has(index)) {
          warnings.push(`glossary: ignored column "${first[index]}"`);
        }
      });
      dataRows = rows.slice(1);
    } else if (sourceIndex >= 0 || targetIndex >= 0) {
      warnings.push("glossary: header is missing a source or target column; using positional columns");
      sourceColumn = sourceIndex >= 0 ? sourceIndex : 0;
      targetColumn = targetIndex >= 0 ? targetIndex : sourceColumn === 0 ? 1 : 0;
      forbiddenColumn = undefined;
      dataRows = rows.slice(1);
    }
  }

  const entries: GlossaryEntry[] = [];
  dataRows.forEach((row, rowIndex) => {
    const position = rowIndex + 1;
    const source = (row[sourceColumn] ?? "").trim();
    const target = (row[targetColumn] ?? "").trim();
    if (source === "" && target === "") return;
    if (source === "" || target === "") {
      warnings.push(`glossary: row ${position} is missing ${source === "" ? "source" : "target"}; skipped`);
      return;
    }
    const forbiddenCell = forbiddenColumn === undefined ? "" : (row[forbiddenColumn] ?? "");
    const forbidden = isTruthyFlag(forbiddenCell);
    entries.push({
      id: `glossary-${entries.length + 1}`,
      source,
      target,
      ...(options.sourceLanguage === undefined ? {} : { sourceLanguage: options.sourceLanguage }),
      ...(options.targetLanguage === undefined ? {} : { targetLanguage: options.targetLanguage }),
      ...(forbidden ? { forbidden: true } : {}),
    });
  });
  return { entries, warnings };
}
