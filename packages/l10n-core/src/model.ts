import type { XmlElementNode } from "./xml.ts";

export type DocumentFormat = "xliff12" | "xliff20" | "xliff21" | "sdlxliff" | "mqxliff";

export interface DocumentFile {
  index: number;
  sourceLanguage: string;
  targetLanguage: string;
  datatype?: string;
}

export interface SegmentLocation {
  fileIndex: number;
  unitId: string;
  mid?: string;
  segmentIndex: number;
}

export interface SdlSegmentState {
  id?: string;
  conf?: string;
  origin?: string;
  percent?: string;
  textMatch?: string;
  locked?: string;
}

export interface Segment {
  id: string;
  index: number;
  location: SegmentLocation;
  sourceInner: string;
  targetInner: string;
  sourceText: string;
  targetText: string;
  sourceTags: string[];
  targetTags: string[];
  /** Range of the target inner content in the original XML string. */
  targetRange: { start: number; end: number } | null;
  /** Parsed source container node (for source-side inline tag layout); not serialized. */
  sourceNode?: XmlElementNode;
  /** Parsed target container node (for text-node level edits); not serialized. */
  targetNode?: XmlElementNode;
  /** Parsed seg-defs/sdl:seg element (for SDLXLIFF state write-back); not serialized. */
  sdlNode?: XmlElementNode;
  sdl?: SdlSegmentState;
  /** Original-data references are scoped to this unit, never the whole document. */
  originalData?: Record<string, string>;
  /** Present when content must be retained but cannot safely be modified. */
  readOnlyReason?: string;
}

export interface Document {
  format: DocumentFormat;
  version: string;
  files: DocumentFile[];
  segments: Segment[];
  warnings: string[];
  /** Original decoded XML string, unchanged. */
  xml: string;
}

export interface PatchEdit {
  /** Raw inner XML for segments that contain inline tags; plain text is escaped when `xml` is false. */
  content: string;
  /** Set true only when content is already a valid XML fragment (tags preserved). */
  xml?: boolean;
}

export interface PatchResult {
  xml: string;
  applied: number;
  errors: Array<{ segmentId: string; message: string }>;
}
