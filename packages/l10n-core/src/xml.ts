import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { SaxesParser } from "saxes";

export interface XmlTextNode {
  type: "text";
  text: string;
  cdata?: boolean;
  /** Inclusive start offset in the decoded XML string (UTF-16 code units). */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface XmlElementNode {
  type: "element";
  name: string;
  local: string;
  attribs: Record<string, string>;
  namespaceUri?: string;
  namespaces?: Record<string, string>;
  /** Inclusive start offset of `<`. */
  start: number;
  /** Exclusive end offset of the open tag's `>`. */
  openEnd: number;
  /** Exclusive end offset of the inner content. */
  innerStart: number;
  /** Exclusive end offset of the inner content (start of close tag, or openEnd for empty). */
  innerEnd: number;
  /** Exclusive end offset after the close tag (or the self-closing tag). */
  end: number;
  children: XmlNode[];
}

export type XmlNode = XmlTextNode | XmlElementNode;

export function localName(name: string): string {
  const index = name.lastIndexOf(":");
  return index < 0 ? name : name.slice(index + 1);
}

export interface StructureEntry {
  path: string;
  name: string;
  attrs: Record<string, string>;
}

export interface StructureSummary {
  elements: StructureEntry[];
  count: number;
  hash: string;
}

function isElement(node: XmlNode): node is XmlElementNode {
  return node.type === "element";
}

export function parseXml(xml: string): XmlElementNode {
  const root: XmlElementNode = {
    type: "element",
    name: "#root",
    local: "#root",
    attribs: {},
    start: 0,
    openEnd: 0,
    innerStart: 0,
    innerEnd: xml.length,
    end: xml.length,
    children: [],
  };
  const stack: XmlElementNode[] = [root];
  let cdata = false;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const parent = stack[stack.length - 1];
        if (!parent) return;
        const start = parser.startIndex;
        const openEnd = parser.endIndex + 1;
        const namespaces: Record<string, string> = { xml: "http://www.w3.org/XML/1998/namespace", ...parent.namespaces };
        for (const [key, value] of Object.entries(attribs)) {
          if (key === "xmlns") namespaces[""] = decodeXmlEntities(value);
          else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = decodeXmlEntities(value);
        }
        const prefix = name.includes(":") ? name.slice(0, name.indexOf(":")) : "";
        const node: XmlElementNode = {
          type: "element",
          name,
          local: localName(name),
          attribs: { ...attribs },
          namespaceUri: namespaces[prefix] ?? "",
          namespaces,
          start,
          openEnd,
          innerStart: openEnd,
          innerEnd: openEnd,
          end: openEnd,
          children: [],
        };
        parent.children.push(node);
        stack.push(node);
      },
      onclosetag() {
        const node = stack.pop();
        if (!node || node === root) return;
        const closeStart = parser.startIndex;
        node.innerEnd = closeStart > node.openEnd ? closeStart : node.openEnd;
        node.end = Math.max(node.openEnd, parser.endIndex + 1);
      },
      ontext(text) {
        const parent = stack[stack.length - 1];
        if (!parent) return;
        parent.children.push({
          type: "text",
          text,
          ...(cdata ? { cdata: true } : {}),
          start: parser.startIndex,
          end: parser.endIndex + 1,
        });
      },
      oncdatastart() { cdata = true; },
      oncdataend() { cdata = false; },
    },
    {
      xmlMode: true,
      decodeEntities: false,
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
      recognizeSelfClosing: true,
    },
  );

  parser.write(xml);
  parser.end();
  return root;
}

/** Strict well-formedness check. Entities/DTD are not resolved; network access never happens. */
export function validateXml(xml: string, namespaces = false): void {
  const parser = new SaxesParser({ xmlns: namespaces });
  let error: Error | undefined;
  parser.on("error", (value: Error) => {
    error = value;
  });
  try {
    parser.write(xml).close();
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  if (error) throw new Error(`Invalid XML: ${error.message}`);
}

export function elementChildren(node: XmlElementNode): XmlElementNode[] {
  return node.children.filter(isElement);
}

export function descendants(
  node: XmlElementNode,
  predicate: (candidate: XmlElementNode) => boolean = () => true,
): XmlElementNode[] {
  const result: XmlElementNode[] = [];
  const walk = (parent: XmlElementNode): void => {
    for (const child of parent.children) {
      if (!isElement(child)) continue;
      if (predicate(child)) result.push(child);
      walk(child);
    }
  };
  walk(node);
  return result;
}

export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g,
    (_match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (dec !== undefined) return String.fromCodePoint(Number.parseInt(dec, 10));
      switch (named) {
        case "amp": return "&";
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return '"';
        case "apos": return "'";
        default: return _match;
      }
    },
  );
}

export function textOf(node: XmlElementNode): string {
  let value = "";
  for (const child of node.children) {
    value += child.type === "text" ? child.cdata ? child.text : decodeXmlEntities(child.text) : textOf(child);
  }
  return value;
}


/** Ordered local names of all inline elements inside `node` (excluding `node`). */
export function elementSignature(node: XmlElementNode): string[] {
  return descendants(node).map((element) => element.local);
}

export function collectTextNodes(node: XmlElementNode): XmlTextNode[] {
  const result: XmlTextNode[] = [];
  const walk = (parent: XmlElementNode): void => {
    for (const child of parent.children) {
      if (child.type === "text") result.push(child);
      else walk(child);
    }
  };
  walk(node);
  return result;
}

export function parseFragment(content: string): XmlElementNode {
  validateXml(`<fragment>${content}</fragment>`);
  const root = parseXml(`<fragment>${content}</fragment>`);
  const fragment = elementChildren(root)[0];
  if (!fragment) throw new Error("Fragment root missing");
  return fragment;
}

export function fragmentSignature(content: string): string[] {
  return elementSignature(parseFragment(content));
}

export function structureSummary(xml: string): StructureSummary {
  const root = parseXml(xml);
  const elements: StructureEntry[] = [];
  const walk = (node: XmlElementNode, path: string): void => {
    let index = 0;
    for (const child of node.children) {
      if (!isElement(child)) continue;
      const childPath = `${path}/${child.local}[${index}]`;
      const attrs = Object.fromEntries(
        Object.entries(child.attribs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      elements.push({ path: childPath, name: child.local, attrs });
      walk(child, childPath);
      index += 1;
    }
  };
  walk(root, "");
  const serialized = JSON.stringify(elements);
  return {
    elements,
    count: elements.length,
    hash: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
