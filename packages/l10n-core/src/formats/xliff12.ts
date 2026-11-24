import type { Document, DocumentFile, Segment, SdlSegmentState } from "../model.ts";
import {
  type XmlElementNode,
  elementChildren,
  descendants,
  elementSignature,
  parseXml,
  textOf,
  validateXml,
} from "../xml.ts";

import { inlineCodeSignatures, inlineText } from "./inline.ts";

const SDL_NAMESPACE = "http://sdl.com/FileTypes/SdlXliff/1.0";
const SDL_DATATYPE = "x-sdlfilterframework2";

function attr(node: XmlElementNode, name: string): string | undefined {
  return node.attribs[name];
}

function isSegMrk(node: XmlElementNode): boolean {
  return node.local === "mrk" && node.attribs.mtype === "seg";
}

function sdlElement(segDefs: XmlElementNode | undefined, mid?: string): XmlElementNode | undefined {
  const nodes = segDefs ? elementChildren(segDefs).filter((node) => node.local === "seg" && node.namespaceUri === SDL_NAMESPACE) : [];
  const matches = mid === undefined ? nodes : nodes.filter((node) => node.attribs.id === mid);
  return matches.length === 1 ? matches[0] : undefined;
}

function sdlState(seg: XmlElementNode | undefined): SdlSegmentState | undefined {
  if (!seg) return undefined;
  const state: SdlSegmentState = {};
  const mapping: Array<[keyof SdlSegmentState, string]> = [
    ["id", "id"],
    ["conf", "conf"],
    ["origin", "origin"],
    ["percent", "percent"],
    ["textMatch", "text-match"],
    ["locked", "locked"],
  ];
  for (const [key, source] of mapping) {
    const value = seg.attribs[source];
    if (value !== undefined) state[key] = value;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

function makeSegment(
  fileIndex: number,
  unitId: string,
  segmentIndex: number,
  ordinal: number,
  sourceContainer: XmlElementNode | undefined,
  targetContainer: XmlElementNode | undefined,
  mid: string | undefined,
  sdl: SdlSegmentState | undefined,
  sdlNode: XmlElementNode | undefined,
  xml: string,
  warnings: string[],
): Segment {
  const sourceTags = sourceContainer ? elementSignature(sourceContainer) : [];
  const targetTags = targetContainer ? elementSignature(targetContainer) : [];
  const id = `${fileIndex}:${unitId}:${mid ?? segmentIndex}`;
  if (!targetContainer) warnings.push(`${id}: target missing`);
  if (sourceContainer && targetContainer && JSON.stringify(inlineCodeSignatures(sourceContainer).sort()) !== JSON.stringify(inlineCodeSignatures(targetContainer).sort())) {
    warnings.push(`${id}: source/target inline tag signature differs`);
  }
  return {
    id,
    index: ordinal,
    location: { fileIndex, unitId, ...(mid === undefined ? {} : { mid }), segmentIndex },
    sourceInner: sourceContainer ? xml.slice(sourceContainer.innerStart, sourceContainer.innerEnd) : "",
    targetInner: targetContainer ? xml.slice(targetContainer.innerStart, targetContainer.innerEnd) : "",
    sourceText: sourceContainer ? inlineText(sourceContainer) : "",
    targetText: targetContainer ? inlineText(targetContainer) : "",
    sourceTags,
    targetTags,
    targetRange: targetContainer
      ? { start: targetContainer.innerStart, end: targetContainer.innerEnd }
      : null,
    ...(sourceContainer === undefined ? {} : { sourceNode: sourceContainer }),
    ...(targetContainer === undefined ? {} : { targetNode: targetContainer }),
    ...(sdlNode === undefined ? {} : { sdlNode }),
    ...(sdl === undefined ? {} : { sdl }),
  };
}

export interface ParseOptions {
  filename?: string;
}

export function parseXliff(xml: string, options: ParseOptions = {}): Document {
  validateXml(xml, true);
  const root = elementChildren(parseXml(xml))[0];
  if (!root || root.local !== "xliff") throw new Error("Not an XLIFF document");
  const version = attr(root, "version") ?? "";
  const isXliff2 = version === "2.0" || version === "2.1";
  if (version !== "1.2" && !isXliff2) throw new Error("Unsupported XLIFF version: " + (version || "(missing)") + "; supported: 1.2, 2.0 and 2.1");
  const namespace = root.namespaceUri ?? "";
  const expected = isXliff2 ? "urn:oasis:names:tc:xliff:document:2.0" : "urn:oasis:names:tc:xliff:document:1.2";
  if (namespace !== "" && namespace !== expected) throw new Error("Unsupported XLIFF namespace: " + namespace);
  const core = (node: XmlElementNode, local: string) => node.local === local && (node.namespaceUri ?? "") === namespace;
  const children = (node: XmlElementNode, local: string) => elementChildren(node).filter((child) => core(child, local));
  const files: DocumentFile[] = [], segments: Segment[] = [], warnings: string[] = [];
  const filename = options.filename?.toLowerCase() ?? "";
  const hasSdl = descendants(root).some((node) => node.namespaceUri === SDL_NAMESPACE);
  let format: Document["format"] = version === "2.1" ? "xliff21" : isXliff2 ? "xliff20"
    : filename.endsWith(".mqxliff") ? "mqxliff" : hasSdl || filename.endsWith(".sdlxliff") ? "sdlxliff" : "xliff12";
  const ids = new Map<string, Segment>();
  children(root, "file").forEach((fileNode, fileIndex) => {
    const datatype = attr(fileNode, "datatype");
    if (!isXliff2 && datatype === SDL_DATATYPE) format = "sdlxliff";
    files.push({
      index: fileIndex,
      sourceLanguage: attr(fileNode, isXliff2 ? "srcLang" : "source-language") ?? attr(root, isXliff2 ? "srcLang" : "source-language") ?? "",
      targetLanguage: attr(fileNode, isXliff2 ? "trgLang" : "target-language") ?? attr(root, isXliff2 ? "trgLang" : "target-language") ?? "",
      ...(datatype === undefined ? {} : { datatype }),
    });
    let unitIndex = 0;
    const inherited = (node: XmlElementNode, parent: boolean) => node.attribs.translate === "no" ? false : node.attribs.translate === "yes" ? true : parent;
    const walk = (parent: XmlElementNode, translate: boolean): void => {
      for (const unit of elementChildren(parent)) {
        if (core(unit, "group") || core(unit, "body")) { walk(unit, core(unit, "group") ? inherited(unit, translate) : translate); continue; }
        if (!core(unit, isXliff2 ? "unit" : "trans-unit")) continue;
        const unitId = attr(unit, "id") ?? "unit-" + unitIndex; unitIndex += 1;
        const mayTranslate = inherited(unit, translate);
        const data: Record<string, string> = Object.create(null);
        const duplicateData = new Set<string>();
        for (const original of children(unit, "originalData")) for (const node of children(original, "data")) {
          const id = node.attribs.id;
          if (!id) continue;
          if (Object.hasOwn(data, id)) duplicateData.add(id);
          else data[id] = textOf(node);
        }
        for (const id of duplicateData) { delete data[id]; warnings.push(fileIndex + ":" + unitId + ": ambiguous originalData reference " + id); }
        const segDefs = elementChildren(unit).find((node) => node.local === "seg-defs" && node.namespaceUri === SDL_NAMESPACE);
        const push = (source: XmlElementNode | undefined, target: XmlElementNode | undefined, mid: string | undefined, index: number, reason?: string) => {
          const sdlNode = sdlElement(segDefs, mid), sdl = sdlState(sdlNode);
          const segment = makeSegment(fileIndex, unitId, index, segments.length, source, target, mid, sdl, sdlNode, xml, warnings);
          if (Object.keys(data).length) segment.originalData = data;
          const markup = target && /<!\[CDATA\[|<!--|<\?/.test(segment.targetInner);
          const ambiguousSdl = segDefs && elementChildren(segDefs).some((node) => node.local === "seg" && node.namespaceUri === SDL_NAMESPACE) && !sdlNode;
          const readOnly = reason ?? (!mayTranslate ? "translate=no" : ambiguousSdl ? "SDL segment state cannot be mapped uniquely" : ["true", "yes", "1"].includes(sdl?.locked ?? "") ? "SDL segment locked" : markup ? "CDATA, comments or processing instructions require lossless read-only handling" : undefined);
          if (readOnly) { segment.readOnlyReason = readOnly; warnings.push(segment.id + ": read-only: " + readOnly); }
          const existing = ids.get(segment.id);
          if (existing) {
            existing.readOnlyReason = "ambiguous segment identity";
            segment.readOnlyReason = "ambiguous segment identity";
            do { segment.id += ":duplicate:" + segment.index; } while (ids.has(segment.id));
            warnings.push(existing.id + ": ambiguous segment identity; read-only");
          }
          ids.set(segment.id, segment); segments.push(segment);
        };
        if (isXliff2) {
          const nodes = children(unit, "segment");
          if (!nodes.length) warnings.push(fileIndex + ":" + unitId + ": unit has no supported segment");
          nodes.forEach((node, index) => push(children(node, "source")[0], children(node, "target")[0], attr(node, "id") ?? "seg-" + index, index,
            children(node, "source").length > 1 || children(node, "target").length > 1 ? "ambiguous source/target containers" : undefined));
          continue;
        }
        const source = children(unit, "source")[0], target = children(unit, "target")[0], segSource = children(unit, "seg-source")[0];
        const sourceMrks = segSource ? descendants(segSource, (node) => core(node, "mrk") && isSegMrk(node)) : [];
        if (sourceMrks.length) {
          const targetMrks = target ? descendants(target, (node) => core(node, "mrk") && isSegMrk(node)) : [];
          sourceMrks.forEach((mrk, index) => {
            const mid = attr(mrk, "mid");
            const sourceMatches = sourceMrks.filter((node) => node.attribs.mid === mid);
            const matches = mid ? targetMrks.filter((node) => node.attribs.mid === mid) : [];
            const whole = sourceMrks.length === 1 && !targetMrks.length ? target : undefined;
            const unique = mid !== undefined && sourceMatches.length === 1 && matches.length === 1;
            const mapped = unique ? matches[0] : whole;
            push(mrk, mapped, mid, index, !mapped || (sourceMrks.length > 1 && (!mid || sourceMatches.length !== 1)) ? "segmented target cannot be mapped uniquely by mid" : undefined);
          });
        } else if (source || target || segSource) push(source ?? segSource, target, undefined, 0,
          children(unit, "source").length > 1 || children(unit, "target").length > 1 ? "ambiguous source/target containers" : undefined);
        else warnings.push(fileIndex + ":" + unitId + ": no source/target");
      }
    };
    if (isXliff2) walk(fileNode, inherited(fileNode, true));
    else for (const body of children(fileNode, "body")) walk(body, true);
  });
  const ranged = segments.filter((segment) => segment.targetRange).sort((a, b) => a.targetRange!.start - b.targetRange!.start || b.targetRange!.end - a.targetRange!.end);
  let previous: Segment | undefined;
  for (const segment of ranged) {
    if (previous && (segment.targetRange!.start < previous.targetRange!.end || segment.targetRange!.start === previous.targetRange!.start)) {
      previous.readOnlyReason = segment.readOnlyReason = "overlapping target containers";
      warnings.push(segment.id + ": overlapping target containers; read-only");
    }
    if (!previous || segment.targetRange!.end > previous.targetRange!.end) previous = segment;
  }
  return { format, version, files, segments, warnings, xml };
}

export function targetTagSignature(segment: Segment): string[] {
  return segment.targetTags;
}
