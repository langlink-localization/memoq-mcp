import type { Segment } from "../model.ts";
import { decodeXmlEntities, elementChildren, parseXml, textOf, validateXml, type XmlElementNode, type XmlNode } from "../xml.ts";

function container(node: XmlElementNode, namespace: string): boolean {
  return (node.namespaceUri ?? "") === namespace && ["g", "pc", "mrk"].includes(node.local)
    && node.attribs.translate !== "no" && node.attribs.mtype !== "protected";
}

/** memoQ special-character codes, including the native XML payload inside ph. */
export function inlineCharacter(node: XmlElementNode): string | undefined {
  const read = (candidate: XmlElementNode): string | undefined => {
    if (candidate.local !== "ch" || !["MQXliff", "http://www.memoq.com/namespace"].includes(candidate.namespaceUri ?? "")) return undefined;
    const value = candidate.attribs.val;
    return value === undefined ? undefined : decodeXmlEntities(value);
  };
  const direct = read(node);
  if (direct !== undefined) return direct;
  if (node.local !== "ph" || !["", "urn:oasis:names:tc:xliff:document:1.2", "urn:oasis:names:tc:xliff:document:2.0"].includes(node.namespaceUri ?? "")) return undefined;
  const elements = elementChildren(node);
  if (elements.length === 1 && node.children.every((child) => child.type === "element" || !child.text.trim())) return read(elements[0]!);
  if (elements.length) return undefined;
  const payload = textOf(node);
  if (payload.length > 4096 || !payload.trim().startsWith("<")) return undefined;
  try {
    const context = { ...node, namespaces: { mq: "http://www.memoq.com/namespace", ...node.namespaces } };
    const root = fragment(payload, context).root;
    const codes = elementChildren(root);
    if (codes.length !== 1 || !root.children.every((child) => child.type === "element" || !child.text.trim())) return undefined;
    return read(codes[0]!);
  } catch { return undefined; }
}

function characterDisplay(value: string): string {
  return value.replaceAll("\r\n", "↵").replaceAll("\r", "↵").replaceAll("\n", "↵").replaceAll("\t", "→").replaceAll(" ", "·").replaceAll("\u00a0", "⍽");
}

/** Visible linguistic content excludes the payload of opaque native codes. */
export function inlineText(root: XmlElementNode, onPart?: (text: string, node: XmlNode) => void): string {
  const namespace = root.namespaceUri ?? "";
  const walk = (node: XmlElementNode): string => node.children.map((child) => {
    if (child.type === "element" && container(child, namespace)) return walk(child);
    const text = child.type === "element" ? inlineCharacter(child) ?? ""
      : child.cdata ? child.text : decodeXmlEntities(child.text);
    onPart?.(text, child);
    return text;
  }).join("");
  return walk(root);
}

/** Read-only label. Original XML remains the only code identity. */
export function inlineDisplay(node: XmlElementNode, data: Record<string, string> = {}): string {
  const character = inlineCharacter(node);
  if (character !== undefined) return `${characterDisplay(character) || "∅"}${node.attribs.id ? ` #${decodeXmlEntities(node.attribs.id)}` : ""}`;
  for (const key of ["disp", "equiv-text", "equiv"]) {
    const value = node.attribs[key]?.trim();
    if (value) return decodeXmlEntities(value);
  }
  if (["g", "pc", "mrk"].includes(node.local)) {
    const value = textOf(node).trim();
    if (value) return value;
  }
  const native = textOf(node).trim();
  if (native) return native;
  const reference = node.attribs.dataRef;
  if (reference && Object.hasOwn(data, reference)) return data[reference]!;
  const start = node.attribs.dispStart ?? data[node.attribs.dataRefStart ?? ""];
  const end = node.attribs.dispEnd ?? data[node.attribs.dataRefEnd ?? ""];
  if (start || end) return [start, end].filter(Boolean).join(" … ");
  const id = node.attribs.id ?? node.attribs.rid ?? node.attribs.startRef ?? reference;
  return id ? `${node.local} #${id}` : node.local;
}

interface Code { raw: string; node: XmlElementNode; close: boolean }
function editIdentity(code: Code): string {
  const bindings: unknown[] = [];
  const walk = (node: XmlElementNode, children: boolean) => {
    bindings.push([node.name, node.namespaceUri ?? "", Object.keys(node.attribs).filter((name) => name.includes(":") && !name.startsWith("xmlns:")).sort().map((name) => [name, node.namespaces?.[name.split(":")[0]!] ?? ""])]);
    if (children) for (const child of elementChildren(node)) walk(child, true);
  };
  walk(code.node, code.raw.length === code.node.end - code.node.start);
  return JSON.stringify([code.raw, bindings]);
}
function codeIdentity(node: XmlElementNode, native = true, namespace = node.namespaceUri ?? ""): string {
  const identity = ["id", "rid", "startRef", "dataRef", "dataRefStart", "dataRefEnd", "pos"].map((key) => [key, node.attribs[key] ?? null]);
  return JSON.stringify([node.namespaceUri ?? "", node.local, identity,
    native && !container(node, namespace) ? inlineCharacter(node) ?? textOf(node) : ""]);
}

/** QA compares code identities, allowing translated container text and legitimate reordering. */
export function inlineCodeSignatures(root: XmlElementNode): string[] {
  const result: string[] = [], namespace = root.namespaceUri ?? "";
  const walk = (parent: XmlElementNode) => {
    for (const node of elementChildren(parent)) {
      result.push(codeIdentity(node, true, namespace));
      if (container(node, namespace)) walk(node);
    }
  };
  walk(root);
  return result;
}

function fragment(content: string, context: XmlElementNode): { root: XmlElementNode; xml: string } {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const ns = Object.entries(context.namespaces ?? {}).filter(([prefix]) => prefix !== "xml")
    .map(([prefix, value]) => ` xmlns${prefix ? `:${prefix}` : ""}="${escape(value)}"`).join("");
  let prefix = "workbench";
  while (Object.hasOwn(context.namespaces ?? {}, prefix)) prefix += "_";
  const uri = context.namespaceUri ?? "";
  const name = uri ? `${prefix}:wrapper` : "wrapper";
  const binding = uri ? ` xmlns:${prefix}="${escape(uri)}"` : "";
  const xml = `<${name}${ns}${binding}>${content}</${name}>`;
  validateXml(xml, true);
  return { root: elementChildren(parseXml(xml))[0]!, xml };
}

export function inlineFragmentText(segment: Segment, content: string): string {
  if (!segment.targetNode) throw new Error("target node not available");
  return inlineText(fragment(content, segment.targetNode).root);
}

/** Empty targets may be populated with the unchanged source codes. */
export function usesSourceTagInventory(segment: Segment): boolean {
  return segment.targetTags.length === 0 && segment.targetInner.trim() === "" && segment.sourceTags.length > 0 && segment.sourceNode !== undefined;
}
function codes(root: XmlElementNode, xml: string): Code[] {
  const result: Code[] = [];
  const namespace = root.namespaceUri ?? "";
  const walk = (parent: XmlElementNode) => {
    for (const child of elementChildren(parent)) {
      if (container(child, namespace) && child.openEnd !== child.end) {
        result.push({ raw: xml.slice(child.start, child.openEnd), node: child, close: false });
        walk(child);
        result.push({ raw: xml.slice(child.innerEnd, child.end), node: child, close: true });
      } else result.push({ raw: xml.slice(child.start, child.end), node: child, close: false });
    }
  };
  walk(root);
  return result;
}

/** Visible boundaries of the same parsed codes used by the order check. */
export function inlineCodeLocations(root: XmlElementNode) {
  const namespace = root.namespaceUri ?? "";
  return codes(root, "").map(({ node, close }) => ({
    key: (close ? "/" : "") + codeIdentity(node, true, namespace),
    start: (close ? node.innerEnd : node.start) - root.innerStart,
    end: (close || !container(node, namespace) ? node.end : node.openEnd) - root.innerStart,
  }));
}

/** The same validation is used before save and at final export. No reserialization. */
export function validateInlineEdit(segment: Segment, content: string): void {
  if (content === segment.targetInner) return;
  if (segment.readOnlyReason) throw new Error(`segment is read-only: ${segment.readOnlyReason}`);
  if (!segment.targetNode) throw new Error("target node not available");
  if (/<!\[CDATA\[|<!--|<\?/.test(content)) throw new Error("XML metadata cannot be introduced by a text edit");
  const seeded = usesSourceTagInventory(segment);
  const old = fragment(seeded ? segment.sourceInner : segment.targetInner, seeded ? segment.sourceNode! : segment.targetNode);
  const next = fragment(content, segment.targetNode);
  const original = codes(old.root, old.xml), edited = codes(next.root, next.xml);
  const queues = new Map<string, number[]>();
  original.forEach((code, i) => { const key = editIdentity(code), q = queues.get(key) ?? []; q.push(i); queues.set(key, q); });
  const order = edited.map((code) => {
    const index = queues.get(editIdentity(code))?.shift();
    if (index === undefined) throw new Error("inline code identity, attributes or protected payload changed");
    return index;
  });
  if (order.length !== original.length || [...queues.values()].some((queue) => queue.length)) throw new Error("inline codes cannot be added or removed");
  if (order.every((value, i) => value === i)) return;
  // Source editing hints remain binding even when a CAT omits them from target codes.
  const source = segment.sourceNode ? fragment(segment.sourceInner, segment.sourceNode) : undefined;
  const sourceCodes = source ? codes(source.root, source.xml).filter((code) => !code.close) : [];
  validateCodeOrder(original, order, sourceCodes, old.root.namespaceUri ?? "");
}

/** Compare existing target code order against source pairing and editing hints. */
export function inlineCodeOrderError(source: XmlElementNode, target: XmlElementNode): string | undefined {
  const sourceCodes = codes(source, ""), targetCodes = codes(target, "");
  const namespace = source.namespaceUri ?? "";
  const positions = new Map<string, number[]>();
  const key = (code: Code) => (code.close ? "/" : "") + codeIdentity(code.node, true, namespace);
  sourceCodes.forEach((code, index) => {
    const identity = key(code), group = positions.get(identity) ?? [];
    group.push(index);
    positions.set(identity, group);
  });
  const order = targetCodes.map((code) => positions.get(key(code))?.shift() ?? -1);
  if (sourceCodes.length !== order.length || order.includes(-1)) return undefined;
  try {
    validateCodeOrder(sourceCodes, order, sourceCodes.filter((code) => !code.close), namespace);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "标签顺序无效";
  }
}

function validateCodeOrder(original: Code[], order: number[], sourceCodes: Code[], namespace: string): void {
  if (order.every((value, i) => value === i)) return;
  const hintFor = (code: Code): string | undefined => {
    if ((code.node.namespaceUri ?? "") !== namespace) return undefined;
    const matches = sourceCodes.filter((item) => codeIdentity(item.node, false) === codeIdentity(code.node, false));
    const sourceHint = matches.find((item) => ["no", "firstNo"].includes(item.node.attribs.canReorder ?? ""))?.node.attribs.canReorder;
    if (sourceHint && matches.length !== 1) throw new Error("ambiguous source editing hints require original code order");
    return code.node.attribs.canReorder === "no" || sourceHint === "no" ? "no"
      : code.node.attribs.canReorder === "firstNo" || sourceHint === "firstNo" ? "firstNo" : undefined;
  };
  const position = new Map(order.map((value, i) => [value, i]));
  const stack: number[] = [], pairs: Array<[number, number]> = [];
  let fixedOrder = false;
  for (let i = 0; i < original.length; i++) {
    const code = original[i]!, node = code.node;
    if (code.close || (node.namespaceUri ?? "") !== namespace) continue;
    const name = node.local;
    if (node.attribs.isolated === "yes" || node.attribs.isolated === "true") fixedOrder = true;
    if (["bpt", "bx", "sc", "sm"].includes(name)) stack.push(i);
    if (["ept", "ex", "ec", "em"].includes(name)) {
      const start = stack.pop(), open = start === undefined ? undefined : original[start]!.node;
      const opener = { ept: "bpt", ex: "bx", ec: "sc", em: "sm" }[name];
      const matches = open && open.local === opener && (["ec", "em"].includes(name)
        ? node.attribs.startRef === open.attribs.id && node.attribs.startRef !== undefined
        : node.attribs.rid !== undefined || open.attribs.rid !== undefined ? node.attribs.rid === open.attribs.rid : true);
      if (!matches || start === undefined) fixedOrder = true;
      else pairs.push([start, i]);
    }
  }
  if (stack.length) fixedOrder = true;
  // Existing overlapping/cross-segment codes remain editable without inventing a local pairing.
  if (fixedOrder) throw new Error("isolated, overlapping or incomplete codes must retain their original order");
  const active: number[] = [];
  const ends = new Map(pairs.map(([start, end]) => [end, start]));
  const starts = new Set(pairs.map(([start]) => start));
  for (const index of order) {
    if (starts.has(index)) active.push(index);
    if (ends.has(index) && active.pop() !== ends.get(index)) throw new Error("inline code pairs are crossed or reversed");
  }
  const logical = original.map((code, index) => ({ code, index })).filter(({ code }) => !code.close);
  let group: number[] = [];
  const groups: number[][] = [];
  for (const { code, index } of logical) {
    const hint = hintFor(code);
    if (hint === "firstNo") { group = [index]; groups.push(group); }
    else if (hint === "no") {
      if (!group.length) throw new Error("non-reorderable codes must retain their original order");
      group.push(index);
    } else group = [];
  }
  const logicalOrder = order.filter((index) => !original[index]!.close);
  for (const members of groups) {
    const start = logicalOrder.indexOf(members[0]!);
    if (members.some((index, offset) => logicalOrder[start + offset] !== index)) throw new Error("non-reorderable code sequence was split or reordered");
  }
  // Container hints also protect their closing boundary.
  for (const { code, index } of logical) {
    if (hintFor(code) === "no" && ["g", "pc", "mrk"].includes(code.node.local)) {
      if (position.get(index) !== index) throw new Error("non-reorderable container moved");
    }
  }
}
