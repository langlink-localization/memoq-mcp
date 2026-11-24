import { elementChildren, parseXml, textOf, validateXml, type XmlElementNode } from "../xml.ts";
import { languageMatches, normalizeLanguage } from "./tmx.ts";
import type { GlossaryEntry, GlossaryParseResult } from "./types.ts";

export interface ParseTbxOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
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

function langSetLanguage(langSet: XmlElementNode): string {
  return langSet.attribs["xml:lang"] ?? langSet.attribs.lang ?? "";
}

/** Prefer exact language tags, then base-language matches. */
function findLangSet(
  langSets: readonly XmlElementNode[],
  language: string,
): XmlElementNode | undefined {
  const wanted = normalizeLanguage(language);
  const exact = langSets.find((langSet) => normalizeLanguage(langSetLanguage(langSet)) === wanted);
  if (exact) return exact;
  return langSets.find((langSet) => languageMatches(langSetLanguage(langSet), language));
}

function termOf(langSet: XmlElementNode): string | undefined {
  const tig = findChild(langSet, "tig");
  if (!tig) return undefined;
  const term = findDescendant(tig, "term");
  const text = term ? textOf(term).trim() : "";
  return text === "" ? undefined : text;
}

/** TBX-Basic/Minis mark forbidden terms with administrativeStatus=forbiddenTerm. */
function isForbiddenLangSet(langSet: XmlElementNode): boolean {
  const walk = (parent: XmlElementNode): boolean => {
    for (const child of elementChildren(parent)) {
      if (child.local === "descrip" || child.local === "termNote") {
        const type = (child.attribs.type ?? child.attribs.name ?? "").trim().toLowerCase();
        const value = textOf(child).trim().toLowerCase();
        if (type === "administrativestatus" && /forbidden|deprecated/u.test(value)) return true;
        if (type === "forbidden" && /^(?:true|yes|1)$/u.test(value)) return true;
      }
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(langSet);
}

function preferredLanguageOrder(langSets: readonly XmlElementNode[]): string[] {
  const seen: string[] = [];
  for (const langSet of langSets) {
    const language = langSetLanguage(langSet);
    if (language !== "" && !seen.some((item) => normalizeLanguage(item) === normalizeLanguage(language))) {
      seen.push(language);
    }
  }
  return seen;
}

/**
 * Parse TBX-Basic / TBX-Minis glossary files into `GlossaryEntry`s.
 *
 * Every `termEntry` contributes one entry: the source term comes from the
 * `langSet` matching `options.sourceLanguage` (or the first language declared in
 * the file), the target from `options.targetLanguage` (or the first different
 * language). Language tags are compared case-insensitively with `_`/`-` folding
 * and base-language fallback. `administrativeStatus=forbiddenTerm` marks an
 * entry as forbidden. Entries missing either side are skipped with a warning.
 *
 * Throws on malformed XML or a document without a `<tbx>` root.
 */
export function parseTbx(xml: string, options: ParseTbxOptions = {}): GlossaryParseResult {
  const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  validateXml(source);
  const document = parseXml(source);
  const root = elementChildren(document).find((child) => child.local === "tbx");
  if (!root) throw new Error("Not a TBX document: missing <tbx> root element");

  const warnings: string[] = [];
  const body = findChild(root, "body");
  if (!body) {
    warnings.push("TBX: missing <body> element; no entries parsed");
    return { entries: [], warnings };
  }

  const termEntries = elementChildren(body).filter((child) => child.local === "termEntry");
  if (termEntries.length === 0) {
    warnings.push("TBX: no <termEntry> elements found");
    return { entries: [], warnings };
  }

  const declared = preferredLanguageOrder(
    termEntries.flatMap((entry) => elementChildren(entry).filter((child) => child.local === "langSet")),
  );
  const sourceLanguage = options.sourceLanguage ?? declared[0];
  if (sourceLanguage === undefined) {
    warnings.push("TBX: source language could not be determined; no entries parsed");
    return { entries: [], warnings };
  }
  const targetLanguage =
    options.targetLanguage ??
    declared.find(
      (language) =>
        !languageMatches(language, sourceLanguage) &&
        normalizeLanguage(language) !== normalizeLanguage(sourceLanguage),
    );
  if (targetLanguage === undefined) {
    warnings.push("TBX: target language could not be determined; no entries parsed");
    return { entries: [], warnings };
  }

  const entries: GlossaryEntry[] = [];
  for (const [index, termEntry] of termEntries.entries()) {
    const label = termEntry.attribs.id ?? `#${index + 1}`;
    const langSets = elementChildren(termEntry).filter((child) => child.local === "langSet");
    const sourceLangSet = findLangSet(langSets, sourceLanguage);
    const targetLangSet = findLangSet(langSets, targetLanguage);
    if (!sourceLangSet) {
      warnings.push(`TBX: termEntry ${label} has no langSet for source language "${sourceLanguage}"; skipped`);
      continue;
    }
    if (!targetLangSet) {
      warnings.push(`TBX: termEntry ${label} has no langSet for target language "${targetLanguage}"; skipped`);
      continue;
    }
    const sourceTerm = termOf(sourceLangSet);
    const targetTerm = termOf(targetLangSet);
    if (sourceTerm === undefined || targetTerm === undefined) {
      warnings.push(`TBX: termEntry ${label} has no <term> text on one side; skipped`);
      continue;
    }
    entries.push({
      id: `tbx-${entries.length + 1}`,
      source: sourceTerm,
      target: targetTerm,
      sourceLanguage,
      targetLanguage,
      ...(isForbiddenLangSet(sourceLangSet) || isForbiddenLangSet(targetLangSet)
        ? { forbidden: true }
        : {}),
    });
  }
  return { entries, warnings };
}
