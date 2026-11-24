import type { TmEntry, TmMatch, TmMatchOptions } from "./types.ts";
import { matchTm, normalizeText } from "./tm-matcher.ts";

export interface TmIndexOptions {
  /** Maximum candidate entries scored for one query; default 5000. */
  maxCandidates?: number;
}

interface SerializedTmIndex {
  version: 1;
  entries: TmEntry[];
}

/**
 * Small deterministic TM index for Phase 2:
 * - exact lookup by normalized source text;
 * - fuzzy prefilter by normalized character-length ratio;
 * - final scoring reuses matchTm (single source of truth for thresholds/penalties).
 */
export class TmIndex {
  readonly entries: readonly TmEntry[];
  private readonly exact = new Map<string, number[]>();
  private readonly lengths: number[] = [];
  private readonly maxCandidates: number;

  constructor(entries: readonly TmEntry[], options: TmIndexOptions = {}) {
    this.entries = [...entries];
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 5000);
    this.entries.forEach((entry, index) => {
      const key = normalizeText(entry.source);
      const bucket = this.exact.get(key);
      if (bucket) bucket.push(index);
      else this.exact.set(key, [index]);
      this.lengths.push(key.length);
    });
  }

  get size(): number {
    return this.entries.length;
  }

  query(sourceText: string, options: TmMatchOptions = {}): TmMatch[] {
    if (this.entries.length === 0) return [];
    const normalized = normalizeText(sourceText);
    const exact = this.exact.get(normalized);
    if (exact && exact.length > 0) {
      const exactEntries = exact.map((index) => this.entries[index]).filter((entry) => entry !== undefined);
      const exactMatches = matchTm(exactEntries, sourceText, { ...options, maxMatches: options.maxMatches ?? 3 });
      if (exactMatches.some((match) => match.matchRate >= 100)) return exactMatches;
    }

    const length = normalized.length;
    const ratio = 0.4;
    const minimum = Math.floor(length * ratio);
    const maximum = Math.ceil(length / ratio);
    const candidates: TmEntry[] = [];
    for (let index = 0; index < this.entries.length; index += 1) {
      const candidateLength = this.lengths[index] ?? 0;
      if (candidateLength < minimum || candidateLength > maximum) continue;
      const entry = this.entries[index];
      if (entry !== undefined) candidates.push(entry);
      if (candidates.length >= this.maxCandidates) break;
    }
    return matchTm(candidates, sourceText, options);
  }

  toJSON(): SerializedTmIndex {
    return { version: 1, entries: [...this.entries] };
  }

  static fromJSON(value: unknown, options: TmIndexOptions = {}): TmIndex {
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { version?: unknown }).version !== 1 ||
      !Array.isArray((value as { entries?: unknown }).entries)
    ) {
      throw new Error("invalid serialized TM index");
    }
    const entries = (value as SerializedTmIndex).entries;
    return new TmIndex(entries, options);
  }
}

export function createTmIndex(entries: readonly TmEntry[], options: TmIndexOptions = {}): TmIndex {
  return new TmIndex(entries, options);
}
