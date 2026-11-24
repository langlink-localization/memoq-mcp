/**
 * Check workflow (Phase 1a): glossary matching + deterministic QA.
 *
 * Parsing of TMX/glossary is the caller's responsibility (spec §6.3:
 * `l10n_inspect` -> `l10n_match_terms` -> `l10n_qa`); this module receives
 * already-parsed assets so it stays pure and testable.
 */

import type { TermMatchOptions } from "../assets/types.ts";
import type { GlossaryEntry, TmEntry } from "../assets/types.ts";
import { matchTerms } from "../assets/term-matcher.ts";
import type { Document, Segment } from "../model.ts";
import { runDeterministicChecks } from "../qa/rules.ts";
import type {
  QaCheckOptions,
  QaResult,
  QaTermHits,
  QaLocaleOptions,
  QaUntranslatedCopyOptions,
} from "../qa/types.ts";

export interface CheckDocumentOptions {
  glossary?: readonly GlossaryEntry[];
  /** Reserved for Phase 2 semantic checks; deterministic QA does not use it. */
  tmEntries?: readonly TmEntry[];
  /** Restrict the deterministic rule set (defaults to the spec default set). */
  enabledRules?: readonly string[];
  /** UNTRANSLATED_COPY whitelist and short-segment policy. */
  untranslatedCopy?: QaUntranslatedCopyOptions;
  /** Locale-aware refinements for language-variant rules. */
  locale?: QaLocaleOptions;
}

export interface CheckDocumentResult {
  qa: QaResult;
  /** Term hits used by the QA rules, keyed by segment id (empty when no glossary). */
  segmentTermHits: Map<string, QaTermHits>;
}

function termMatchOptions(document: Document, segment: Segment): TermMatchOptions {
  const file = document.files[segment.location.fileIndex];
  const options: TermMatchOptions = {};
  if (file?.sourceLanguage) options.sourceLanguage = file.sourceLanguage;
  if (file?.targetLanguage) options.targetLanguage = file.targetLanguage;
  return options;
}

/**
 * Match terms for every segment (source and target side), then run the
 * deterministic QA rules once with the resulting term hits.
 */
export function checkDocument(
  document: Document,
  options: CheckDocumentOptions = {},
): CheckDocumentResult {
  const glossary = options.glossary ?? [];
  const segmentTermHits = new Map<string, QaTermHits>();

  if (glossary.length > 0) {
    for (const segment of document.segments) {
      const termOptions = termMatchOptions(document, segment);
      const sourceMatches = matchTerms(segment.sourceText, glossary, termOptions);
      const targetMatches = matchTerms(segment.targetText, glossary, termOptions);
      segmentTermHits.set(segment.id, {
        source: sourceMatches.hits,
        target: targetMatches.hits,
      });
    }
  }

  const qaOptions: QaCheckOptions = {
    ...(options.glossary === undefined ? {} : { glossary: options.glossary }),
    ...(segmentTermHits.size === 0 ? {} : { segmentTermHits }),
    ...(options.enabledRules === undefined ? {} : { enabledRules: options.enabledRules }),
    ...(options.untranslatedCopy === undefined ? {} : { untranslatedCopy: options.untranslatedCopy }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  };
  const qa = runDeterministicChecks(document.segments, qaOptions);
  return { qa, segmentTermHits };
}
