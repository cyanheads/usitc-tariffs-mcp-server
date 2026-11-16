/**
 * @fileoverview Behavioral checks for identifier and source-pinned reference decoding.
 * @module tests/services/reference/reference-service.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { column2Countries, verifiedEditions } from '@/services/reference/program-data.js';
import {
  assessCountry,
  listChapterReferences,
  listIdentifierReferences,
  listProgramReferences,
  listQuantityUnits,
  normalizeChapter,
  normalizeCode,
  normalizeCodePrefix,
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
  it.each([
    [[8, 10], '0101', 'Use an HTS identifier containing 8 or 10 digits.'],
    [[4, 6, 8], '0101210010', 'Use an HTS identifier containing 4, 6 or 8 digits.'],
    [[8], '010121', 'Use an HTS identifier containing 8 digits.'],
  ] as const)('names the permitted lengths %j as a disjunction', (lengths, input, message) => {
    expect(() => normalizeCode(input, lengths)).toThrowError(
      expect.objectContaining({ message, data: { reason: 'invalid_code' } }),
    );
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
  });
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    [' 61 ', '61'],
    ['01', '01'],
    ['6109', '6109'],
    ['610910', '6109.10'],
    ['6109.10', '6109.10'],
    ['61091000', '6109.10.00'],
    ['\t6109.10.00\n', '6109.10.00'],
  ])('normalizes code prefix %j to %j', (input, prefix) => {
    expect(normalizeCodePrefix(input)).toBe(prefix);
  });
});

describe('reviewed reference facts', () => {
  it('maps every country in the complete GN3(b) paragraph to its assigned ISO identifier', () => {
    expect(column2Countries).toEqual([
      ['BY', 'Republic of Belarus'],
      ['CU', 'Cuba'],
      ['KP', 'North Korea'],
      ['RU', 'Russian Federation'],
    ]);
    expect(column2Countries.map(([code]) => normalizeCountryCode(code))).toEqual([
      'BY',
      'CU',
      'KP',
      'RU',
    ]);
  });
  it('contains every GN3 symbol as a distinct literal including suffixes', () => {
    const { decoder, items: programs } = listProgramReferences();
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
    expect(programs.find((program) => program.symbol === 'S+')).toEqual({
      kind: 'program',
      symbol: 'S+',
      name: 'United States-Mexico-Canada Agreement',
      countryListCoverage: 'unknown',
    });
    expect(
      programs.every(
        (program) => Object.keys(program).join() === 'kind,symbol,name,countryListCoverage',
      ),
    ).toBe(true);
    expect(decoder).toEqual({
      sourceEdition: '2026HTSRev21',
      citation: 'General Note 3(c)(i)',
      sourceUrl:
        'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
      conditionality: 'All legal requirements of the program must be met; General Note 3(a)(iii).',
      qualificationNotice:
        'Program identification does not establish origin qualification, product eligibility, quota status, program availability or the legally applicable rate.',
    });
    expect(parseSpecialCell('Free (A)').decoder).toEqual({
      sourceEdition: decoder.sourceEdition,
      citation: decoder.citation,
      sourceUrl: decoder.sourceUrl,
      qualificationNotice: decoder.qualificationNotice,
    });
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
    const { decoder, items: units } = listQuantityUnits();
    expect(units).toHaveLength(54);
    expect(decoder).toEqual({
      sourceEdition: '2026HTSRev21',
      citation: 'General Note 3(g)',
      sourceUrl:
        'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
    });
    expect(units).toEqual(
      expect.arrayContaining([
        { kind: 'unit', symbol: 'kg', meaning: 'kilograms' },
        expect.objectContaining({ symbol: 'm²', meaning: 'square meters' }),
        expect.objectContaining({ symbol: 'C', meaning: 'Celcius' }),
        expect.objectContaining({ symbol: '¢', meaning: 'cents' }),
      ]),
    );
    expect(units.every((unit) => Object.keys(unit).join() === 'kind,symbol,meaning')).toBe(true);
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
  it.each([
    ['BY', 'listed'],
    ['CU', 'listed'],
    ['KP', 'listed'],
    ['RU', 'listed'],
    ['CN', 'not_listed'],
  ])('reports the complete pinned GN3(b) listing for %s', (country, status) => {
    const parsed = parseSpecialCell('Free (S)', country);
    expect(assessCountry(parsed, country, '2026HTSRev21')).toMatchObject({
      column2Listing: {
        status,
        citation: 'General Note 3(b)',
        sourceEdition: '2026HTSRev21',
        sourceUrl:
          'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
      },
    });
  });
  it.each(['RU', 'CN'])(
    'retains pinned provenance with unknown listing on edition mismatch for %s',
    (country) => {
      const parsed = parseSpecialCell('', country);
      expect(assessCountry(parsed, country, '2026HTSRev24')).toMatchObject({
        decoderSourceEdition: '2026HTSRev21',
        editionMatches: false,
        column2Listing: {
          status: 'unknown',
          citation: 'General Note 3(b)',
          sourceEdition: '2026HTSRev21',
          sourceUrl:
            'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
        },
        notice:
          'Column 2 listing is unknown because the current edition differs from the reviewed General Note 3(b) source. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.',
      });
    },
  );
  it('lists exactly the editions verified to carry the reviewed General Note 3 text', () => {
    expect(verifiedEditions).toEqual(['2026HTSRev22', '2026HTSRev23']);
  });
  it('keeps every reviewed-edition assessment byte-identical', () => {
    const parsed = parseSpecialCell('Free (S, S+)', 'RU');
    const pinned = {
      eligibility: 'not_determined',
      columnSelection: 'not_determined',
      membershipCoverage: 'unknown',
      decoderSourceEdition: '2026HTSRev21',
      editionMatches: true,
      recognizedSymbolCount: 2,
      qualificationNotice:
        'Program identification does not establish origin qualification, product eligibility, quota status, program availability or the legally applicable rate.',
    };
    const listing = {
      citation: 'General Note 3(b)',
      sourceEdition: '2026HTSRev21',
      sourceUrl:
        'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
    };
    const matchedNotice =
      'Column 2 listing reports only membership in the edition-pinned General Note 3(b) list. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.';
    expect(assessCountry(parsed, 'RU', '2026HTSRev21')).toEqual({
      countryCode: 'RU',
      column2Listing: { status: 'listed', ...listing },
      ...pinned,
      notice: matchedNotice,
    });
    expect(assessCountry(parsed, 'CN', '2026HTSRev21')).toEqual({
      countryCode: 'CN',
      column2Listing: { status: 'not_listed', ...listing },
      ...pinned,
      notice: matchedNotice,
    });
    expect(assessCountry(parsed, undefined, '2026HTSRev21')).toEqual({
      ...pinned,
      notice:
        'No country was requested. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.',
    });
  });
  it.each(
    ['2026HTSRev22', '2026HTSRev23'].flatMap((edition) =>
      [
        ['BY', 'listed'],
        ['CU', 'listed'],
        ['KP', 'listed'],
        ['RU', 'listed'],
        ['CN', 'not_listed'],
      ].map(([country, status]) => ({ edition, country, status })),
    ),
  )(
    'reports $country as $status for verified edition $edition without relabeling provenance',
    ({ edition, country, status }) => {
      const parsed = parseSpecialCell('Free (S)', country);
      const assessment = assessCountry(parsed, country, edition);
      expect(assessment).toEqual({
        countryCode: country,
        column2Listing: {
          status,
          citation: 'General Note 3(b)',
          sourceEdition: '2026HTSRev21',
          sourceUrl:
            'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
        },
        eligibility: 'not_determined',
        columnSelection: 'not_determined',
        membershipCoverage: 'unknown',
        decoderSourceEdition: '2026HTSRev21',
        editionMatches: true,
        recognizedSymbolCount: 1,
        notice: `Column 2 listing reports only membership in the General Note 3(b) list reviewed in 2026HTSRev21, whose text was verified unchanged in ${edition}. Special-program country membership has not been independently verified. General and Column 2 selection remain unresolved.`,
        qualificationNotice:
          'Program identification does not establish origin qualification, product eligibility, quota status, program availability or the legally applicable rate.',
      });
      expect(Object.keys(assessment)).toEqual(
        Object.keys(assessCountry(parsed, country, '2026HTSRev21')),
      );
    },
  );
  it.each(['2026HTSRev20', '2026HTSRev24', '2026htsrev23', ' 2026HTSRev23'])(
    'keeps an unverified or inexact edition name %j unknown',
    (edition) => {
      const parsed = parseSpecialCell('', 'RU');
      expect(assessCountry(parsed, 'RU', edition)).toMatchObject({
        editionMatches: false,
        column2Listing: { status: 'unknown', sourceEdition: '2026HTSRev21' },
      });
    },
  );
  it('omits listing without a requested country and rejects invalid countries', () => {
    const parsed = parseSpecialCell('');
    for (const country of [undefined, '', '  '])
      expect(assessCountry(parsed, country, '2026HTSRev21')).not.toHaveProperty('column2Listing');
    expect(assessCountry(parsed, ' ru ', '2026HTSRev21')).toMatchObject({
      countryCode: 'RU',
      column2Listing: { status: 'listed' },
    });
    expect(() => assessCountry(parsed, 'ZZ', '2026HTSRev21')).toThrowError(
      expect.objectContaining({ data: { reason: 'invalid_country' } }),
    );
  });
  it('keeps country assessment independent of recognized Special symbols and empty clauses', () => {
    for (const text of ['', 'Free (S, S+)']) {
      const parsed = parseSpecialCell(text, 'RU');
      expect(assessCountry(parsed, 'RU', '2026HTSRev21')).toMatchObject({
        countryCode: 'RU',
        eligibility: 'not_determined',
        columnSelection: 'not_determined',
        membershipCoverage: 'unknown',
        decoderSourceEdition: '2026HTSRev21',
        editionMatches: true,
        recognizedSymbolCount: text ? 2 : 0,
        notice: expect.any(String),
        qualificationNotice: expect.any(String),
      });
      expect(parsed.decoder.sourceEdition).toBe('2026HTSRev21');
      for (const program of parsed.clauses.flatMap((clause) => clause.programs))
        expect(program.countryRelation).toBe('unknown');
    }
  });
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
