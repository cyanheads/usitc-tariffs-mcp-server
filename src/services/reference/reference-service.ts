/**
 * @fileoverview Pure identifier normalization and edition-pinned HTS reference decoding.
 * @module services/reference/reference-service
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { chapterLabelsSource, chapterSections } from './chapter-data.js';
import { isoCountryCodes } from './iso-countries.js';
import {
  column2Countries,
  decoderSourceEdition,
  generalNote3Url,
  programNames,
  qualificationNotice,
  quantityUnitNames,
  verifiedEditions,
} from './program-data.js';

/** A supported HTS classification precision, measured in digits. */
export type CodeLength = 4 | 6 | 8 | 10;
/** Canonical dotted identifier plus digits used for exact containment comparisons. */
export interface NormalizedCode {
  chapter: string;
  code: string;
  digits: string;
  heading: string;
  length: CodeLength;
}

/** Bare 4/6/8/10 digits, or dots at the conventional boundaries (including NNNN.NN.NNNN). */
const CODE_ALTERNATION = String.raw`\d{4}(?:\d{2}){0,3}|\d{4}\.\d{2}(?:\.\d{2}){0,2}|\d{4}\.\d{2}\.\d{4}`;
const CODE_FORM = new RegExp(`^(?:${CODE_ALTERNATION})$`);

/**
 * A schema pattern and the message a caller receives when input fails it. `\s` matches exactly
 * what `trim()` removes, so each pattern admits the outer whitespace the normalizers strip. JSON
 * Schema carries no regex flags, so letter classes spell out both cases. Optional forms nest the
 * trailing `\s*` inside the optional group so no two whitespace runs compete for the same input.
 */
export interface InputPattern {
  readonly message: string;
  readonly pattern: RegExp;
}
/** Required `code` on the heading, duty and additional-duty tools; handlers keep per-tool lengths. */
export const CODE_INPUT: InputPattern = {
  pattern: new RegExp(String.raw`^\s*(?:${CODE_ALTERNATION})\s*$`),
  message:
    'Write the code as 4, 6, 8 or 10 digits, bare or dotted at the conventional HTS boundaries: 8507, 8507.60, 8507.60.00, 8507.60.00.30 or 8507.60.0030.',
};
/** Optional `candidateCode`; blank means omitted, and the handler keeps the Chapter 99 checks. */
export const CANDIDATE_CODE_INPUT: InputPattern = {
  pattern: new RegExp(String.raw`^\s*(?:(?:${CODE_ALTERNATION})\s*)?$`),
  message:
    'Use a returned Chapter 99 candidate number, bare or dotted (99038803 or 9903.88.03), or omit candidateCode.',
};
/** Optional `countryCode`; blank means omitted, and the handler keeps ISO assignment. */
export const COUNTRY_INPUT: InputPattern = {
  pattern: /^\s*(?:[A-Za-z]{2}\s*)?$/,
  message:
    'Use a two-letter ISO 3166-1 alpha-2 country code such as CN or DE, or omit countryCode.',
};
/** Browse `chapter`; the handler keeps the 01–99 range. */
export const CHAPTER_INPUT: InputPattern = {
  pattern: /^\s*\d{1,2}\s*$/,
  message: 'Use a chapter number from 01 through 99, written as one or two digits (8, 08 or 85).',
};
/** Search `query`: at least one non-whitespace character. */
export const QUERY_INPUT: InputPattern = {
  pattern: /\S/,
  message: 'Supply nonblank commodity text or an HTS code prefix.',
};
/** Optional search `codePrefix`: a two-digit chapter or a 4/6/8-digit code; blank means omitted. */
export const CODE_PREFIX_INPUT: InputPattern = {
  pattern: /^\s*(?:(?:\d{2}|\d{4}(?:\d{2}){0,2}|\d{4}\.\d{2}(?:\.\d{2})?)\s*)?$/,
  message:
    'Use a two-digit chapter or a four-, six- or eight-digit code, bare or dotted (61, 6109, 6109.10 or 6109.10.00), or omit codePrefix.',
};

const SPI_CITATION = 'General Note 3(c)(i)';
const column2CountryCodes: ReadonlySet<string> = new Set(column2Countries.map(([code]) => code));

/** Normalize only complete conventional identifiers; never remove arbitrary punctuation. */
export function normalizeCode(
  input: string,
  allowedLengths: readonly CodeLength[] = [4, 6, 8, 10],
): NormalizedCode {
  const value = input.trim();
  if (!CODE_FORM.test(value)) {
    throw validationError('Use 4, 6, 8 or 10 digits with conventional HTS dot boundaries.', {
      reason: 'invalid_code',
    });
  }
  const digits = value.replaceAll('.', '');
  const length = digits.length;
  if (
    (length !== 4 && length !== 6 && length !== 8 && length !== 10) ||
    !allowedLengths.includes(length)
  ) {
    const last = allowedLengths.at(-1);
    const lengths =
      allowedLengths.length > 1 ? `${allowedLengths.slice(0, -1).join(', ')} or ${last}` : last;
    throw validationError(`Use an HTS identifier containing ${lengths} digits.`, {
      reason: 'invalid_code',
    });
  }
  const suffix = digits.slice(4).match(/\d{2}/g);
  return {
    code: [digits.slice(0, 4), ...(suffix ?? [])].join('.'),
    digits,
    length,
    chapter: digits.slice(0, 2),
    heading: digits.slice(0, 4),
  };
}

/** Canonical chapter (`61`) or 4/6/8-digit code (`6109.10`) prefix; blank means omitted. */
export function normalizeCodePrefix(input?: string): string | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  return /^\d{2}$/.test(value) ? value : normalizeCode(value, [4, 6, 8]).code;
}

/** Chapters are strings in 01–99, including reserved chapters. */
export function normalizeChapter(input: string): string {
  const value = input.trim();
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 99) {
    throw validationError('Use a chapter number from 01 through 99.', { reason: 'invalid_code' });
  }
  return value.padStart(2, '0');
}

/** Blank optional country input is omitted; names, aliases and unassigned codes are rejected. */
export function normalizeCountryCode(input?: string): string | undefined {
  const value = input?.trim().toUpperCase();
  if (!value) return undefined;
  if (!isoCountryCodes.has(value))
    throw validationError('Use an assigned ISO 3166-1 alpha-2 country code.', {
      reason: 'invalid_country',
    });
  return value;
}

/** Preserve commodity language unless the entire search is a supported HTS identifier. */
export function normalizeSearchQuery(input: string): string {
  const value = input.trim();
  if (CODE_FORM.test(value)) return normalizeCode(value).code;
  return value;
}

/** A symbol's name is decoded independently of country-list verification. */
export interface ProgramReference {
  countryListCoverage: 'unknown';
  kind: 'program';
  name: string;
  symbol: string;
}
const programs: readonly ProgramReference[] = programNames.map(([symbol, name]) => ({
  kind: 'program',
  symbol,
  name,
  countryListCoverage: 'unknown',
}));
const programBySymbol = new Map(programs.map((program) => [program.symbol, program]));

/**
 * Complete reviewed symbol decoder; no country relationship has been independently verified.
 * Citation, source and qualification text apply to every symbol and are stated once in `decoder`.
 */
export function listProgramReferences() {
  return {
    decoder: {
      sourceEdition: decoderSourceEdition,
      citation: SPI_CITATION,
      sourceUrl: generalNote3Url,
      conditionality: 'All legal requirements of the program must be met; General Note 3(a)(iii).',
      qualificationNotice,
    },
    items: programs,
  };
}

/**
 * Published GN3(g) abbreviations; superscript exponents are represented as Unicode superscripts.
 * Citation and source apply to every unit and are stated once in `decoder`.
 */
export function listQuantityUnits() {
  return {
    decoder: {
      sourceEdition: decoderSourceEdition,
      citation: 'General Note 3(g)',
      sourceUrl: generalNote3Url,
    },
    items: quantityUnitNames.map(([symbol, meaning]) => ({
      kind: 'unit' as const,
      symbol,
      meaning,
    })),
  };
}

/** Published application navigation labels, retaining their source spelling and capture provenance. */
export function listChapterReferences() {
  return chapterSections.flatMap((section) =>
    section.chapters.map((chapter) => ({
      kind: 'chapter' as const,
      chapter: normalizeChapter(chapter.title.slice(8)),
      label: chapter.label,
      section: section.title.replace(/:$/, ''),
      sectionLabel: section.label,
      reserved: chapter.title === 'Chapter 77',
      sourceUrl: chapterLabelsSource,
      capturedAt: '2026-10-25',
      labelSource: 'published_application_navigation' as const,
      scheduleUrl: 'https://hts.usitc.gov/',
    })),
  );
}

/** Identifier, inheritance and evidence semantics needed to interpret tariff responses. */
export function listIdentifierReferences() {
  return [
    {
      kind: 'identifier' as const,
      name: 'heading',
      digits: 4,
      format: 'NNNN',
      meaning: 'A heading; indentation, including unnumbered rows, establishes ancestry.',
    },
    {
      kind: 'identifier' as const,
      name: 'subheading',
      digits: 6,
      format: 'NNNN.NN',
      meaning: 'A six-digit classification subheading.',
    },
    {
      kind: 'identifier' as const,
      name: 'rate_line',
      digits: 8,
      format: 'NNNN.NN.NN',
      meaning: 'A U.S. rate line; preserve leading zeros and published duty columns.',
    },
    {
      kind: 'identifier' as const,
      name: 'statistical_number',
      digits: 10,
      format: 'NNNN.NN.NN.NN',
      meaning:
        'A statistical number; NNNN.NN.NNNN is also accepted. Blank rate columns inherit only from the matching eight-digit ancestor; an absent ancestor rate remains unpublished.',
    },
    {
      kind: 'identifier' as const,
      name: 'chapter_99',
      digits: 2,
      format: '99',
      meaning:
        'Additional-duty evidence is partial; a code mention or an empty candidate list does not determine applicability, enforceability or combined duties.',
    },
  ];
}

/** Published symbol annotation; an unknown symbol is retained without an invented program name. */
export interface SpecialProgram {
  countryListCoverage: 'unknown';
  countryRelation: 'unknown' | 'not_requested';
  name?: string;
  recognized: boolean;
  symbol: string;
}
/** A parsed clause retains the exact source slice as well as its rate text and symbols. */
export interface SpecialClause {
  end: number;
  programs: SpecialProgram[];
  rateText: string;
  start: number;
  text: string;
}
/** All source text remains available, including portions outside the supported clause grammar. */
export interface ParsedSpecial {
  clauses: SpecialClause[];
  decoder: {
    sourceEdition: string;
    citation: string;
    sourceUrl: string;
    qualificationNotice: string;
  };
  parseCoverage: 'complete' | 'partial';
  publishedText: string;
  referenceFollowUp: { tool: 'usitc_list_reference'; arguments: { topic: 'spi' } };
  unparsedText: string;
}

/** Parse balanced top-level comma-separated SPI lists; rates remain unevaluated source strings. */
export function parseSpecialCell(publishedText: string, countryCode?: string): ParsedSpecial {
  const country = normalizeCountryCode(countryCode);
  const clauses: SpecialClause[] = [];
  let depth = 0;
  let groupStart = -1;
  let consumed = 0;
  let recognizedAll = true;
  for (let index = 0; index < publishedText.length; index++) {
    const character = publishedText[index];
    if (character === '(') {
      if (depth === 0) groupStart = index;
      depth++;
    }
    if (character !== ')' || depth === 0) continue;
    depth--;
    if (depth !== 0) continue;
    const group = publishedText.slice(groupStart + 1, index);
    const prefix = publishedText.slice(consumed, groupStart);
    if (
      !/^\s*[A-Z]{1,3}[+*]?\s*(?:,\s*[A-Z]{1,3}[+*]?\s*)*$/.test(group) ||
      !prefix.trim() ||
      /[()]/.test(prefix)
    )
      continue;
    const symbols = group.split(',').map((symbol) => symbol.trim());
    const annotations = symbols.map((symbol): SpecialProgram => {
      const program = programBySymbol.get(symbol);
      if (!program) recognizedAll = false;
      return {
        symbol,
        recognized: program !== undefined,
        ...(program ? { name: program.name } : {}),
        countryRelation: country ? 'unknown' : 'not_requested',
        countryListCoverage: 'unknown',
      };
    });
    clauses.push({
      text: publishedText.slice(consumed, index + 1),
      rateText: prefix.trim(),
      programs: annotations,
      start: consumed,
      end: index + 1,
    });
    consumed = index + 1;
  }
  const unparsedText = publishedText.slice(consumed);
  return {
    publishedText,
    clauses,
    decoder: {
      sourceEdition: decoderSourceEdition,
      citation: SPI_CITATION,
      sourceUrl: generalNote3Url,
      qualificationNotice,
    },
    referenceFollowUp: { tool: 'usitc_list_reference', arguments: { topic: 'spi' } },
    unparsedText,
    parseCoverage: !unparsedText.trim() && recognizedAll ? 'complete' : 'partial',
  };
}

/** Country comparison never selects a column or asserts preference eligibility. */
export function assessCountry(
  special: Pick<ParsedSpecial, 'clauses'>,
  countryCode: string | undefined,
  releaseName: string,
) {
  const country = normalizeCountryCode(countryCode);
  const verified = verifiedEditions.includes(releaseName);
  const editionMatches = releaseName === decoderSourceEdition || verified;
  return {
    ...(country ? { countryCode: country } : {}),
    ...(country
      ? {
          column2Listing: {
            status: !editionMatches
              ? ('unknown' as const)
              : column2CountryCodes.has(country)
                ? ('listed' as const)
                : ('not_listed' as const),
            citation: 'General Note 3(b)',
            sourceEdition: decoderSourceEdition,
            sourceUrl: generalNote3Url,
          },
        }
      : {}),
    eligibility: 'not_determined' as const,
    columnSelection: 'not_determined' as const,
    membershipCoverage: 'unknown' as const,
    decoderSourceEdition,
    editionMatches,
    recognizedSymbolCount: special.clauses
      .flatMap((clause) => clause.programs)
      .filter((program) => program.recognized).length,
    notice: country
      ? verified
        ? `Column 2 listing reports only membership in the General Note 3(b) list reviewed in ${decoderSourceEdition}, whose text was verified unchanged in ${releaseName}. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.`
        : editionMatches
          ? 'Column 2 listing reports only membership in the edition-pinned General Note 3(b) list. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.'
          : 'Column 2 listing is unknown because the current edition differs from the reviewed General Note 3(b) source. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.'
      : 'No country was requested. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.',
    qualificationNotice,
  };
}
