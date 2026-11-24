import { elementChildren, parseXml, textOf, validateXml, type XmlElementNode } from "../xml.ts";
import type { TmContext, TmEntry, TmParseResult } from "./types.ts";

export interface ParseTmxOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
}

const CONTEXT_PRE = "x-context-pre";
const CONTEXT_NEXT = "x-context-next";

/** Canonical form used for language comparison: `en_US` -> `en-us`. */
export function normalizeLanguage(language: string): string {
  return language.trim().replace(/_/g, "-").toLowerCase();
}

/**
 * True when the TMX language tag `actual` satisfies `wanted`.
 * `en` matches `en-US` (base language fallback); region/variant mismatches never match.
 */
export function languageMatches(actual: string, wanted: string): boolean {
  const normalizedActual = normalizeLanguage(actual);
  const normalizedWanted = normalizeLanguage(wanted);
  if (normalizedActual === normalizedWanted) return true;
  return normalizedActual.split("-")[0] === normalizedWanted.split("-")[0];
}

function findChild(parent: XmlElementNode, local: string): XmlElementNode | undefined {
  return elementChildren(parent).find((child) => child.local === local);
}

function findDescendant(parent: XmlElementNode, local: string): XmlElementNode | undefined {
  for (const child of elementChildren(parent)) {
    if (child.local === local) return child;
    const nested = findDescendant(child, local);
    if (nested) return nested;
  }
  return undefined;
}

function tuvLanguage(tuv: XmlElementNode): string {
  return tuv.attribs["xml:lang"] ?? tuv.attribs.lang ?? "";
}

/** Prefer exact tag matches, then base-language matches. */
function findTuv(
  tuvs: readonly XmlElementNode[],
  language: string,
  excluded?: XmlElementNode,
): XmlElementNode | undefined {
  const wanted = normalizeLanguage(language);
  const candidates = tuvs.filter((tuv) => tuv !== excluded);
  const exact = candidates.find((tuv) => normalizeLanguage(tuvLanguage(tuv)) === wanted);
  if (exact) return exact;
  const wantedBase = wanted.split("-")[0];
  return candidates.find((tuv) => normalizeLanguage(tuvLanguage(tuv)).split("-")[0] === wantedBase);
}

function tuvText(tuv: XmlElementNode): string | undefined {
  const seg = findDescendant(tuv, "seg");
  return seg ? textOf(seg).trim() : undefined;
}

/** First language tag seen in the file; used only when nothing else declares the source. */
function firstLanguage(tus: readonly XmlElementNode[]): string | undefined {
  for (const tu of tus) {
    for (const tuv of elementChildren(tu).filter((child) => child.local === "tuv")) {
      const language = tuvLanguage(tuv);
      if (language !== "") return language;
    }
  }
  return undefined;
}

/** First language that is not the source language; `xml:lang` order is not trusted. */
function inferTargetLanguage(
  tus: readonly XmlElementNode[],
  sourceLanguage: string,
): string | undefined {
  for (const tu of tus) {
    for (const tuv of elementChildren(tu).filter((child) => child.local === "tuv")) {
      const language = tuvLanguage(tuv);
      if (language !== "" && !languageMatches(language, sourceLanguage)) return language;
    }
  }
  return undefined;
}

function readProps(tu: XmlElementNode): XmlElementNode[] {
  const props: XmlElementNode[] = [];
  const walk = (parent: XmlElementNode): void => {
    for (const child of elementChildren(parent)) {
      if (child.local === "prop") props.push(child);
      else walk(child);
    }
  };
  walk(tu);
  return props;
}

function parseContext(props: readonly XmlElementNode[]): TmContext | undefined {
  let previousSource: string | undefined;
  let nextSource: string | undefined;
  for (const prop of props) {
    const type = (prop.attribs.type ?? prop.attribs.name ?? "").toLowerCase();
    const value = textOf(prop).trim();
    if (value === "") continue;
    if (type === CONTEXT_PRE) previousSource = value;
    else if (type === CONTEXT_NEXT) nextSource = value;
  }
  if (previousSource === undefined && nextSource === undefined) return undefined;
  return {
    ...(previousSource === undefined ? {} : { previousSource }),
    ...(nextSource === undefined ? {} : { nextSource }),
  };
}

function readProperties(props: readonly XmlElementNode[]): Record<string, string> | undefined {
  const properties: Record<string, string> = {};
  let count = 0;
  for (const prop of props) {
    const propType = (prop.attribs.type ?? prop.attribs.name ?? "").toLowerCase();
    if (propType === CONTEXT_PRE || propType === CONTEXT_NEXT) continue;
    const baseKey = (prop.attribs.type ?? prop.attribs.name ?? "").trim() || `prop-${count + 1}`;
    const value = textOf(prop).trim();
    if (value === "") continue;
    let key = baseKey;
    for (let suffix = 2; key in properties; suffix += 1) key = `${baseKey}#${suffix}`;
    properties[key] = value;
    count += 1;
  }
  return count === 0 ? undefined : properties;
}

/**
 * Parse TMX 1.4b into `TmEntry`s.
 *
 * The source/target `tuv` are chosen by `options.sourceLanguage`/`options.targetLanguage`
 * (falling back to `<header srclang>` and, when one side is still unknown, the first
 * `tu` with at least two different `tuv` languages). Language tags are compared
 * case-insensitively with `_`/`-` folding and base-language fallback. A `tu` without a
 * `tuv` for a required side is skipped with a warning instead of guessing.
 *
 * Standard TMX has no native context field: `prop type="x-context-pre|next"` is mapped
 * to `entry.context`; every other `prop` is kept verbatim in `entry.properties`.
 * `creationdate` (or `changedate`) is exposed as `entry.lastModified`.
 *
 * Throws on malformed XML.
 */
export function parseTmx(xml: string, options: ParseTmxOptions = {}): TmParseResult {
  const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  validateXml(source);
  const document = parseXml(source);
  const root = elementChildren(document).find((child) => child.local === "tmx");
  if (!root) throw new Error("Not a TMX document: missing <tmx> root element");

  const warnings: string[] = [];
  const header = findChild(root, "header");
  const body = findChild(root, "body");
  if (!body) {
    warnings.push("TMX: missing <body> element; no entries parsed");
    return { entries: [], warnings };
  }

  const tus = elementChildren(body).filter((child) => child.local === "tu");
  const sourceLanguage =
    options.sourceLanguage ?? header?.attribs.srclang ?? firstLanguage(tus);
  if (sourceLanguage === undefined) {
    warnings.push("TMX: source language could not be determined; no entries parsed");
    return { entries: [], warnings };
  }
  const targetLanguage = options.targetLanguage ?? inferTargetLanguage(tus, sourceLanguage);
  if (targetLanguage === undefined) {
    warnings.push("TMX: target language could not be determined; no entries parsed");
    return { entries: [], warnings };
  }

  const entries: TmEntry[] = [];
  for (const [index, tu] of tus.entries()) {
    const label = tu.attribs.tuid ?? tu.attribs.id ?? `#${index + 1}`;
    const tuvs = elementChildren(tu).filter((child) => child.local === "tuv");
    const sourceTuv = findTuv(tuvs, sourceLanguage);
    const targetTuv = findTuv(tuvs, targetLanguage, sourceTuv);
    if (!sourceTuv) {
      warnings.push(`TMX: tu ${label} has no tuv for source language "${sourceLanguage}"; skipped`);
      continue;
    }
    if (!targetTuv) {
      warnings.push(`TMX: tu ${label} has no tuv for target language "${targetLanguage}"; skipped`);
      continue;
    }
    const sourceText = tuvText(sourceTuv);
    const targetText = tuvText(targetTuv);
    if (!sourceText || !targetText) {
      warnings.push(`TMX: tu ${label} has no <seg> text; skipped`);
      continue;
    }

    const props = readProps(tu);
    const context = parseContext(props);
    const properties = readProperties(props);
    const lastModified = tu.attribs.creationdate ?? tu.attribs.changedate;
    entries.push({
      id: label,
      source: sourceText,
      target: targetText,
      sourceLanguage,
      targetLanguage,
      origin: "tm",
      ...(context === undefined ? {} : { context }),
      ...(lastModified === undefined ? {} : { lastModified }),
      ...(properties === undefined ? {} : { properties }),
    });
  }
  return { entries, warnings };
}

export interface TmMergeResult {
  entries: TmEntry[];
  /** Number of duplicate entries dropped across the inputs. */
  duplicates: number;
}

function mergeKey(entry: TmEntry): string {
  const normalize = (value: string): string =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const context = entry.context;
  return [
    normalizeLanguage(entry.sourceLanguage),
    normalizeLanguage(entry.targetLanguage),
    normalize(entry.source),
    normalize(entry.target),
    normalize(context?.previousSource ?? ""),
    normalize(context?.nextSource ?? ""),
  ].join("\u0000");
}

/**
 * Merge parsed TM entry lists, dropping duplicates.
 *
 * Two entries are duplicates when source/target languages, normalized
 * source/target text and TMX context (`x-context-pre`/`x-context-next`) match.
 * The first occurrence wins so caller order (e.g. project TM before global TM)
 * is the tie-breaker.
 */
export function mergeTmEntries(...inputs: ReadonlyArray<readonly TmEntry[]>): TmMergeResult {
  const entries: TmEntry[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const input of inputs) {
    for (const entry of input) {
      const key = mergeKey(entry);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  return { entries, duplicates };
}
