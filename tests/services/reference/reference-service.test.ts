/**
 * @fileoverview Behavioral checks for identifier and source-pinned reference decoding.
 * @module tests/services/reference/reference-service.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  assessCountry,
  listChapterReferences,
  listIdentifierReferences,
  listProgramReferences,
  listQuantityUnits,
  normalizeChapter,
  normalizeCode,
  normalizeCountryCode,
  normalizeSearchQuery,
  parseSpecialCell,
} from '@/services/reference/reference-service.js';

describe('HTS identifiers and countries', () => {
  it.each([
    ['0101', '0101', 4],
    ['010121', '0101.21', 6],
    ['01012100', '0101.21.00', 8],
    [' 0101210010 ', '0101.21.00.10', 10],
    ['0101.21.0010', '0101.21.00.10', 10],
  ])('normalizes %s without dropping leading zeros', (input, code, length) => {
    expect(normalizeCode(String(input))).toEqual({
      code,
      length,
      chapter: '01',
      heading: '0101',
      digits: String(code).replaceAll('.', ''),
    });
  });
  it.each([
    '010',
    '01010',
    '0101010',
    '010101010',
    '01010101010',
    '01.01',
    '0101..21',
    '0101-21',
    '0101.2100',
    '0101.21.0',
    '0101.21.00000',
    '0101 21',
    '+010121',
    '０１０１',
  ])('rejects malformed identifier %s', (input) => {
    expect(() => normalizeCode(input)).toThrowError(
      expect.objectContaining({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_code' },
      }),
    );
  });
  it('enforces caller-selected precision', () => {
    expect(() => normalizeCode('010121', [8, 10])).toThrowError(
      expect.objectContaining({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_code' },
      }),
    );
    expect(normalizeCode('01012100', [8, 10]).length).toBe(8);
  });
  it('normalizes chapter boundaries and keeps reserved chapter 77 valid', () => {
    expect(['1', ' 09 ', '77', '99'].map(normalizeChapter)).toEqual(['01', '09', '77', '99']);
    for (const input of ['0', '00', '100', '1.0', '-1', ''])
      expect(() => normalizeChapter(input)).toThrowError(
        expect.objectContaining({ data: { reason: 'invalid_code' } }),
      );
  });
  it('accepts assigned ISO identifiers and omits blank optional countries', () => {
    expect(normalizeCountryCode()).toBeUndefined();
    expect(normalizeCountryCode('  ')).toBeUndefined();
    expect(normalizeCountryCode(' ca ')).toBe('CA');
    expect(normalizeCountryCode('tw')).toBe('TW');
    expect(normalizeCountryCode('aq')).toBe('AQ');
    for (const country of ['USA', 'United States', 'UK', 'EU', 'ZZ', 'XK', '12'])
      expect(() => normalizeCountryCode(country)).toThrowError(
        expect.objectContaining({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_country' },
        }),
      );
  });
  it('normalizes a complete numeric query while preserving commodity wording', () => {
    expect(normalizeSearchQuery(' 0101210010 ')).toBe('0101.21.00.10');
    expect(normalizeSearchQuery(' lithium-ion 8507 batteries ')).toBe('lithium-ion 8507 batteries');
    expect(normalizeSearchQuery('8507.6')).toBe('8507.6');
    expect(() => normalizeSearchQuery(' ')).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
    );
  });
});

describe('reviewed reference facts', () => {
  it('contains every GN3 symbol as a distinct literal including suffixes', () => {
    const programs = listProgramReferences();
    expect(programs.map((program) => program.symbol)).toEqual([
      'A',
      'A*',
      'A+',
      'AU',
      'B',
      'BH',
      'C',
      'CL',
      'D',
      'E',
      'E*',
      'IL',
      'JO',
      'JP',
      'K',
      'P',
      'P+',
      'L',
      'R',
      'MA',
      'SG',
      'OM',
      'PE',
      'KR',
      'CO',
      'PA',
      'NP',
      'S',
      'S+',
    ]);
    expect(programs.find((program) => program.symbol === 'S+')).toMatchObject({
      name: 'United States-Mexico-Canada Agreement',
      citation: 'General Note 3(c)(i)',
      sourceEdition: '2026HTSRev21',
      countryListCoverage: 'unknown',
    });
    expect(programs.every((program) => program.sourceUrl.includes('release=2026HTSRev21'))).toBe(
      true,
    );
  });
  it('publishes all 99 chapter navigation labels with reserved and source spelling intact', () => {
    const chapters = listChapterReferences();
    expect(chapters.map((chapter) => chapter.chapter)).toEqual(
      Array.from({ length: 99 }, (_, index) => String(index + 1).padStart(2, '0')),
    );
    expect(chapters.find((chapter) => chapter.chapter === '77')).toMatchObject({
      label: '(Reserved for possible future use)',
      reserved: true,
      section: 'Section XV',
    });
    expect(chapters.filter((chapter) => chapter.reserved)).toHaveLength(1);
    expect(chapters.find((chapter) => chapter.chapter === '09')).toMatchObject({
      label: 'Coffee, tea, maté and spices',
      labelSource: 'published_application_navigation',
      capturedAt: '2026-10-25',
    });
    expect(chapters.find((chapter) => chapter.chapter === '15')!.label).toContain('microvial');
  });
  it('retains published GN3 units and distinguishes code precision semantics', () => {
    const units = listQuantityUnits();
    expect(units).toHaveLength(54);
    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: 'kg',
          meaning: 'kilograms',
          citation: 'General Note 3(g)',
        }),
        expect.objectContaining({ symbol: 'm²', meaning: 'square meters' }),
        expect.objectContaining({ symbol: 'C', meaning: 'Celcius' }),
        expect.objectContaining({ symbol: '¢', meaning: 'cents' }),
      ]),
    );
    expect(listIdentifierReferences().map(({ name, digits }) => [name, digits])).toEqual([
      ['heading', 4],
      ['subheading', 6],
      ['rate_line', 8],
      ['statistical_number', 10],
      ['chapter_99', 2],
    ]);
  });
});

describe('Special clause interpretation', () => {
  it('preserves exact source slices and each suffix across multiple balanced clauses', () => {
    const text = 'Free (A*, A+, E*, P+, S+) 2.5% (AU, JP)';
    const parsed = parseSpecialCell(text, 'CA');
    expect(parsed.parseCoverage).toBe('complete');
    expect(parsed.publishedText).toBe(text);
    expect(parsed.clauses.map((clause) => clause.rateText)).toEqual(['Free', '2.5%']);
    expect(parsed.clauses.map((clause) => clause.text).join('') + parsed.unparsedText).toBe(text);
    expect(parsed.clauses[0]!.programs.map((program) => program.symbol)).toEqual([
      'A*',
      'A+',
      'E*',
      'P+',
      'S+',
    ]);
    for (const clause of parsed.clauses) {
      expect(text.slice(clause.start, clause.end)).toBe(clause.text);
      expect(
        clause.programs.every(
          (program) =>
            program.countryRelation === 'unknown' && program.countryListCoverage === 'unknown',
        ),
      ).toBe(true);
    }
  });
  it.each([
    'Free (A',
    'Free ((A))',
    'Free (A) trailing qualification',
    'Free ) (A)',
    'Free (A; AU)',
    'See note 3(a)',
  ])('retains unmatched or unsupported text in %s', (text) => {
    const parsed = parseSpecialCell(text);
    expect(parsed.parseCoverage).toBe('partial');
    expect(parsed.publishedText).toBe(text);
    expect(parsed.clauses.map((clause) => clause.text).join('') + parsed.unparsedText).toBe(text);
  });
  it('keeps unknown symbols without inventing names or country membership', () => {
    const parsed = parseSpecialCell('Free (ZZ, A)', 'US');
    expect(parsed.parseCoverage).toBe('partial');
    expect(parsed.clauses[0]!.programs[0]).toMatchObject({
      symbol: 'ZZ',
      recognized: false,
      countryRelation: 'unknown',
      countryListCoverage: 'unknown',
    });
    expect(parsed.referenceFollowUp).toEqual({
      tool: 'usitc_list_reference',
      arguments: { topic: 'spi' },
    });
    expect(parsed.decoder).toMatchObject({
      sourceEdition: '2026HTSRev21',
      citation: 'General Note 3(c)(i)',
      sourceUrl:
        'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
    });
    expect(parsed.clauses[0]!.programs[0]).not.toHaveProperty('name');
    expect(parseSpecialCell('Free (A)').clauses[0]!.programs[0]!.countryRelation).toBe(
      'not_requested',
    );
  });
  it('pins the decoder edition and leaves eligibility and column selection unresolved', () => {
    const parsed = parseSpecialCell('Free (S, S+)', 'CA');
    expect(assessCountry(parsed, 'ca', 'another-edition')).toMatchObject({
      countryCode: 'CA',
      eligibility: 'not_determined',
      columnSelection: 'not_determined',
      membershipCoverage: 'unknown',
      decoderSourceEdition: '2026HTSRev21',
      editionMatches: false,
      recognizedSymbolCount: 2,
    });
    expect(assessCountry(parsed, undefined, '2026HTSRev21')).toMatchObject({
      editionMatches: true,
    });
    expect(assessCountry(parsed, undefined, '2026HTSRev21')).not.toHaveProperty('countryCode');
  });
});
