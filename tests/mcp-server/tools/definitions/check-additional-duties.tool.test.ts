/** @fileoverview Chapter 99 public contract through the real source/parser with fake HTTP. */

import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { additionalDutiesOutputSchema } from '@/mcp-server/tools/additional-duties-schemas.js';
import type { TariffRecord } from '@/services/usitc/types.js';
import { chapterNote } from '../../../fixtures/chapter99/official-structure.js';
import { drive, json, noticeOf, replyBytes, text } from '../../../fixtures/tool-harness.js';

type Output = z.infer<typeof additionalDutiesOutputSchema>;
type Result = Awaited<ReturnType<typeof runToolContract>>;
let tool: typeof import('@/mcp-server/tools/definitions/check-additional-duties.tool.js')['checkAdditionalDutiesTool'];
let rows: TariffRecord[];
let rates: TariffRecord[];
let html: string;
let edition: string;
let requests: URL[];
let notesType: string;
let metadataCount: number;
let moving: boolean;

async function call(
  args: Record<string, unknown> = {},
  options: Parameters<typeof runToolContract>[2] = {},
) {
  return drive(runToolContract(tool, { code: '0101.21.00.10', ...args }, options));
}

function success(result: Result): Output {
  expect(result.isError, text(result)).not.toBe(true);
  const rendered = text(result);
  const match = rendered.match(/(`{3,})json\n([\s\S]*?)\n\1/);
  expect(match).not.toBeNull();
  const data = z.record(z.string(), z.unknown()).parse(result.structuredContent);
  const totalCount = data.totalCount;
  delete data.totalCount;
  delete data.notice;
  expect(match![2]).not.toContain('\n');
  expect(JSON.parse(match![2]!)).toEqual(data);
  expect(data.page).not.toHaveProperty('budgetLimited');
  const output = tool.output.parse(data);
  expect(totalCount).toBe(output.page.total);
  expect(rendered).toContain(`totalCount: ${output.page.total}`);
  // The limit alone sizes a page: only the last page of a collection may be short.
  expect(output.page.returned).toBeLessThanOrEqual(output.page.effectiveLimit);
  if (output.page.nextCursor) expect(output.page.returned).toBe(output.page.effectiveLimit);
  return output;
}

const clamp = (limit: number) => `Requested limit ${limit} was clamped to the 100-item page cap.`;

/**
 * One note yielding every evidence kind for 0101.21.00.10: an unlinked annex mention (unmapped),
 * a linked list with a bracketed compiler notice (b), its governor (a), a co-mention (c) and an
 * unresolved compiler notice (d). Block ordinals: three title blocks, then the note opening at 3.
 */
const allKinds = chapterNote(
  1,
  '0101.21.00, 0101.21.00.10 and 0101.21.00.20 appear in an unsupported annex.<ul><li value="(a)">(a) Heading 9903.88.01 applies to products of China that are classified in the subheadings enumerated in U.S. note 1(b) to subchapter III.</li><li value="(b)">(b) <table><tr><td>0101.21.00</td></tr></table> [Compiler’s note: see the amendment.]</li><li value="(c)">(c) 0101.21.00.10 is mentioned with 9903.88.02.</li><li value="(d)">(d) Compiler’s note: suspended; scope unresolved.</li></ul>',
);

const NOT_COMPUTED = [
  'in-force status',
  'stacking and precedence',
  'exclusions and exemptions',
  'origin qualification',
  'effective-date and in-transit conditions',
  'derivative-product inclusion',
  'content/value tests',
  'quota status',
  'CBP determinations',
  'combined duties',
];
const CLEARANCE_LIMITATION =
  'No candidate list, empty or not, establishes that no additional duty applies.';
const LIMITATIONS = [
  'Only exact 8/10-digit mentions and bounded positive same-note list links are indexed.',
  'DOM nesting does not establish legal hierarchy; conflicting labels remain ambiguous.',
  'Product-independent provisions, ranges, external annexes, derivative/content tests and legal applicability are not determined.',
  'Country scope recognizes only reviewed single positive product(s)-of-China or Canada clauses; other or qualified wording remains unknown.',
  'Published status words do not establish current enforceability.',
  CLEARANCE_LIMITATION,
];
const MISS_LIMITATIONS = [
  'No notes search was performed because this exact base number does not exist.',
  CLEARANCE_LIMITATION,
];

/** Every listed limitation appears exactly once in the reply's notices. */
function expectLimitationsOnce(output: Output, limitations: readonly string[] = LIMITATIONS) {
  for (const limitation of limitations)
    expect(output.notices.filter((notice) => notice === limitation)).toHaveLength(1);
}

/** Any page but the first candidates page: partial status, notComputed and notices, no summary. */
function expectSlim(output: Output, { notes = false, limitations = LIMITATIONS } = {}) {
  expect(output.coverage).toEqual({ status: 'partial' });
  expect(output.notComputed).toEqual(NOT_COMPUTED);
  expectLimitationsOnce(output, limitations);
  for (const key of ['baseLine', 'countryFilter', 'collectionTotals'])
    expect(output).not.toHaveProperty(key);
  if (notes) expect(output.normalization).toBeDefined();
  else expect(output).not.toHaveProperty('normalization');
}

function failure(result: Result, reason: string, code = JsonRpcErrorCode.ValidationError) {
  const contract = tool.errors!.find((entry) => entry.reason === reason)!;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code, data: { reason, recovery: { hint: contract.recovery } } },
  });
  expect(text(result)).toContain(reason);
  expect(text(result)).toContain(contract.recovery);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  vi.resetModules();
  edition = 'edition-A';
  metadataCount = 0;
  moving = false;
  notesType = 'text/html;charset=utf-8';
  requests = [];
  rows = [
    {
      htsno: '0101',
      indent: '0',
      description: 'Live horses',
      footnotes: [{ value: 'Ancestor: 9903.88.03', columns: ['other'] }],
    },
    { htsno: '0101.21', indent: '1', description: 'Purebred breeding animals' },
    {
      htsno: '0101.21.00',
      indent: '2',
      description: 'Horses',
      general: 'Free',
      special: null,
      other: '?',
      footnotes: [
        {
          value: 'See 9903.88.01',
          columns: ['general', 'special', 'other'],
          marker: '*',
          custom: null,
        },
      ],
    },
    {
      htsno: '0101.21.00.10',
      indent: '3',
      description: 'Male',
      general: '',
      footnotes: [{ value: 'See 9903.88.04', columns: ['description'] }],
    },
  ];
  rates = [1, 2, 3].map((n) => ({
    htsno: `9903.88.0${n}`,
    indent: '0',
    description: `Published ${n} ? null`,
    general: '?',
    special: null,
    other: '35%',
  }));
  html = chapterNote(
    1,
    '<ul><li value="(a)">(a) Heading 9903.88.01 applies to products of China that are classified in the subheadings enumerated in U.S. note 1(b) to subchapter III.</li><li value="(b)">(b) <table><tr><td>0101.21.00</td></tr></table></li><li value="(c)">(c) Heading 9903.88.01 does not apply to 0101.21.00; conditions remain.</li><li value="(d)">(d) 0101.21.00 is mentioned with 9903.88.02, subject to review.</li><li value="(e)">(e) Compiler’s note: suspended; scope unresolved.</li></ul>',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname.endsWith('currentRelease'))
        return json({ name: moving ? `edition-${metadataCount++}` : edition });
      if (url.pathname.endsWith('releaseList')) return json([]);
      if (url.pathname.endsWith('getChapterNotes'))
        return new Response(html, { headers: { 'content-type': notesType } });
      return json(url.searchParams.get('from') === '9900' ? rates : rows);
    }),
  );
  (await import('@/services/usitc/usitc-service.js')).initUsitcService();
  tool = (await import('@/mcp-server/tools/definitions/check-additional-duties.tool.js'))
    .checkAdditionalDutiesTool;
});
afterEach(async () => {
  (await import('@/services/usitc/usitc-service.js')).disposeUsitcService();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('additional-duty source contract', () => {
  it('uses the verified combined 7208 rate line for eight-digit list evidence on both public surfaces', async () => {
    rows = [
      {
        htsno: '7208',
        indent: '0',
        description:
          'Flat-rolled products of iron or nonalloy steel, of a width of 600 mm or more, hot-rolled, not clad, plated or coated:',
      },
      {
        htsno: '7208.10',
        indent: '1',
        description: 'In coils, not further worked than hot-rolled, with patterns in relief:',
      },
      {
        htsno: '7208.10.15.00',
        indent: '2',
        description: 'Pickled',
        general: 'Free',
        other: '0.4¢/kg + 20%',
        units: ['kg'],
      },
    ];
    html = chapterNote(
      1,
      '<ul><li value="(a)">(a) Heading 9903.88.01 applies to products enumerated in this subdivision:<table><tr><td>7208.10.15</td></tr></table></li></ul>',
    );
    const result = success(await call({ code: '7208.10.15.00' }));
    const evidence = success(await call(result.candidates![0]!.evidenceFollowUp.arguments));
    expect(evidence.evidence).toEqual([
      expect.objectContaining({
        matchedCode: '7208.10.15',
        matchLevel: 'rate_line',
        relation: 'inclusion_candidate',
      }),
    ]);
  });
  it('does not let a heading country override a conditional linked governor country scope', async () => {
    rows.forEach((row) => {
      delete row.footnotes;
    });
    rates[0]!.description = 'Articles the product of Canada as provided in this heading.';
    html = chapterNote(
      1,
      '<ul><li value="(a)">(a) Heading 9903.88.01 applies to products of China that are classified in the following 8-digit subheadings, provided that the conditions are met:<ul><li value="(1)">(1) 0101.21.00</li></ul></li></ul>',
    );
    expect(success(await call({ countryCode: 'CA' })).candidates![0]!.countryRelation).toBe(
      'unknown',
    );
  });
  it.each([
    ['Parts of passenger vehicles and light trucks of the United Kingdom.', 'GB'],
    [
      'Except for products described in headings 9903.05.85–9903.05.92, articles the product of Vietnam, as provided for in U.S. note 52 to this subchapter',
      'VN',
    ],
    ['Products of Canada and China.', 'CA'],
    ['If eligible, products of Canada.', 'CA'],
  ])(
    'keeps unsupported or qualified heading country scope unknown: %s',
    async (description, countryCode) => {
      rows.forEach((row) => {
        delete row.footnotes;
      });
      rates = [{ htsno: '9903.88.01', indent: '0', description }];
      html = chapterNote(1, '9903.88.01 concerns 0101.21.00.');
      const result = success(await call({ countryCode }));
      expect(result.candidates![0]!.countryRelation).toBe('unknown');
      expect(result.countryFilter).toMatchObject({
        namedCount: 0,
        unknownCount: 1,
        differentCountryCount: 0,
      });
    },
  );
  it.each(['CN', 'US'])(
    'retains conflicting heading and linked governor country scopes as unknown for %s',
    async (countryCode) => {
      rows.forEach((row) => {
        delete row.footnotes;
      });
      rates[0]!.description = 'Articles the product of Canada as provided in this heading.';
      const result = success(await call({ countryCode }));
      expect(result.candidates!.find((item) => item.code === '9903.88.01')!.countryRelation).toBe(
        'unknown',
      );
    },
  );
  it('retrieves both owned numbered list evidence and its entire governor through paged public responses', async () => {
    rows.forEach((row) => {
      delete row.footnotes;
    });
    rates[0]!.description =
      'Effective with respect to entries on or after January 1, 2026, articles the product of China, as provided for in subdivision (g) of U.S. note 31 to this subchapter';
    const clause = `(a) Heading 9903.88.01 applies to products of China that are classified in the following 8-digit subheadings: ${'Published date and source qualification. '.repeat(150)}`;
    html = chapterNote(
      1,
      `<ul><li value="(a)">${clause}<ul><li value="(1)">(1) 0101.21.00</li></ul></li></ul>`,
    );
    const candidates = success(await call({ countryCode: 'CN', limit: 1 }));
    expect(candidates.candidates![0]).toMatchObject({ countryRelation: 'named', evidenceCount: 2 });
    expect(candidates.countryFilter).toMatchObject({ namedCount: 1, unknownCount: 0 });
    const first = success(
      await call({ ...candidates.candidates![0]!.evidenceFollowUp.arguments, limit: 1 }),
    );
    expect(first.evidence![0]).toMatchObject({
      role: 'product_list',
      relation: 'inclusion_candidate',
    });
    const second = success(await call(first.nextCall!.arguments));
    expect(second.evidence![0]).toMatchObject({ role: 'governing', relation: 'context_only' });
    for (const pointer of [first.evidence![0]!, second.evidence![0]!]) {
      let page = success(await call({ ...pointer.followUp.arguments, limit: 1 }));
      const fragments = [...page.notesPage!.fragments];
      while (page.notesPage!.nextCall) {
        page = success(await call(page.notesPage!.nextCall.arguments));
        fragments.push(...page.notesPage!.fragments);
      }
      expect(fragments.map((item) => item.text).join('')).toContain(
        pointer.role === 'governing' ? clause : '(1) 0101.21.00',
      );
      expect(fragments).toHaveLength(fragments[0]!.fragmentCount);
    }
  });
  it('retains sentence-final footnote pointers as context and rejects extended and malformed prefixes', async () => {
    rows.forEach((row) => {
      delete row.footnotes;
    });
    rows[3]!.footnotes = [
      {
        value: 'See 9903.90.08. Invalid 9903.90.09.10 9903.90.10.1 9903.90.11..10 x9903.90.12.',
        columns: ['other'],
      },
    ];
    html = chapterNote(1, 'Reserved.');
    const result = success(await call());
    expect(result.candidates!.map((item) => item.code)).toEqual(['9903.90.08']);
    const evidence = success(await call(result.candidates![0]!.evidenceFollowUp.arguments));
    expect(evidence.evidence![0]).toMatchObject({
      relation: 'context_only',
      countryRelation: 'not_requested',
      footnote: { columns: ['other'], value: rows[3]!.footnotes![0]!.value },
    });
  });
  it.each(['CA', 'CN', undefined])(
    'labels reviewed Canada heading scope for %s without changing product inclusion',
    async (countryCode) => {
      rows.forEach((row) => {
        delete row.footnotes;
      });
      rates = [
        {
          htsno: '9903.03.12',
          indent: '0',
          description: 'Articles the product of Canada as provided in this heading.',
        },
      ];
      html = chapterNote(1, '9903.03.12 concerns 0101.21.00.');
      const result = success(await call({ countryCode }));
      expect(result.candidates![0]).toMatchObject({
        countryRelation: !countryCode
          ? 'not_requested'
          : countryCode === 'CA'
            ? 'named'
            : 'different_country',
        legalStatus: 'not_determined',
      });
      expect(result.collectionTotals!.candidates).toBe(1);
      const evidence = success(await call(result.candidates![0]!.evidenceFollowUp.arguments));
      expect(evidence.evidence![0]!.relation).toBe('context_only');
    },
  );
  it('discloses the declared notes charset and exact source normalization rule on both surfaces', async () => {
    const result = await call();
    success(result);
    const normalization = {
      charset: 'utf-8',
      textRule:
        'Decode the declared charset using the Web Encoding Standard; decode HTML entities; emit each text node once in document order, with line breaks at block and table-row boundaries and tabs between cells.',
    };
    expect(result.structuredContent).toMatchObject({ normalization });
    const rendered = text(result);
    expect(rendered).toContain('"charset":"utf-8"');
    expect(rendered).toContain(normalization.textRule);
  });

  it.each(['0101.21.99', '0101.21.00.99'])(
    'never falls back from a missing exact code %s or fetches unrelated notes',
    async (code) => {
      const response = await call({ code });
      const result = success(response);
      expect(result).toMatchObject({
        found: false,
        coverage: { parserVersion: 'not_run' },
        page: { total: 0 },
      });
      expect(result.guidance).toContain('usitc_get_heading');
      expect(response.structuredContent).not.toHaveProperty('notice');
      expect(result.coverage).not.toHaveProperty('limitations');
      expectLimitationsOnce(result, MISS_LIMITATIONS);
      // Any follow-up into this tool would repeat the same miss; guidance is the only next call.
      const selfCall = '"tool":"usitc_check_additional_duties"';
      expect(result.coverage).not.toHaveProperty('unmappedFollowUp');
      expect(JSON.stringify(response.structuredContent)).not.toContain(selfCall);
      for (const [args, view] of [
        [{ view: 'unmapped' }, 'unmapped'],
        [{ view: 'evidence', candidateCode: '9903.88.01' }, 'evidence'],
        [{ noteId: 'any' }, 'notes'],
      ] as const) {
        const other = await call({ code, ...args });
        expect(other.structuredContent).not.toHaveProperty('notice');
        expect(JSON.stringify(other.structuredContent)).not.toContain(selfCall);
        const miss = success(other);
        expect(miss).toMatchObject({ found: false, guidance: result.guidance });
        expect(miss.view).toBe(view);
        expectSlim(miss, { limitations: MISS_LIMITATIONS });
      }
      expect(
        requests.some(
          (url) =>
            url.pathname.endsWith('getChapterNotes') || url.searchParams.get('from') === '9900',
        ),
      ).toBe(false);
    },
  );

  it('orders candidates and counts every evidence kind and collection', async () => {
    html = allKinds;
    const result = success(await call());
    expect(result.collectionTotals).toEqual({ candidates: 4, evidence: 7, unmappedEvidence: 3 });
    expect(
      result.candidates!.map(({ code, evidenceCount, compilerNoticeCount }) => ({
        code,
        evidenceCount,
        compilerNoticeCount,
      })),
    ).toEqual([
      { code: '9903.88.02', evidenceCount: 1, compilerNoticeCount: 0 },
      { code: '9903.88.01', evidenceCount: 4, compilerNoticeCount: 1 },
      { code: '9903.88.04', evidenceCount: 1, compilerNoticeCount: 0 },
      { code: '9903.88.03', evidenceCount: 1, compilerNoticeCount: 0 },
    ]);
  });

  it('emits dotted sourceCode and matchedCode for every evidence kind in both views, leaving source text verbatim', async () => {
    html = allKinds;
    const bareDigits = /"(?:sourceCode|matchedCode)":"\d+"/;
    const project = (items: NonNullable<Output['evidence']>) =>
      items.map(({ kind, role, sourceCode, matchedCode }) => ({
        kind,
        role,
        sourceCode,
        matchedCode,
      }));
    const pages: Output[] = [];
    for (const candidate of success(await call()).candidates!) {
      const response = await call(candidate.evidenceFollowUp.arguments);
      expect(text(response)).not.toMatch(bareDigits);
      pages.push(success(response));
    }
    const evidence = pages.flatMap((page) => page.evidence!);
    expect(project(evidence)).toEqual([
      {
        kind: 'same_passage_mention',
        role: 'mention',
        sourceCode: '9903.88.02',
        matchedCode: '0101.21.00.10',
      },
      {
        kind: 'explicit_list_link',
        role: 'product_list',
        sourceCode: '9903.88.01',
        matchedCode: '0101.21.00',
      },
      {
        kind: 'compiler_notice',
        role: 'qualification',
        sourceCode: '9903.88.01',
        matchedCode: '0101.21.00',
      },
      {
        kind: 'explicit_list_link',
        role: 'governing',
        sourceCode: '9903.88.01',
        matchedCode: '0101.21.00',
      },
      { kind: 'footnote', role: 'mention', sourceCode: '9903.88.01', matchedCode: '0101.21.00.10' },
      { kind: 'footnote', role: 'mention', sourceCode: '9903.88.04', matchedCode: '0101.21.00.10' },
      { kind: 'footnote', role: 'mention', sourceCode: '9903.88.03', matchedCode: '0101.21.00.10' },
    ]);
    const unmapped = [
      [{}, ['0101.21.00.10', '0101.21.00', undefined]],
      [{ code: '0101.21.00' }, ['0101.21.00', '0101.21.00.10', '0101.21.00.20', undefined]],
    ] as const;
    for (const [args, matched] of unmapped) {
      const response = await call({ ...args, view: 'unmapped' });
      expect(text(response)).not.toMatch(bareDigits);
      const items = success(response).unmappedEvidence!;
      expect(items.map((item) => item.matchedCode)).toEqual(matched);
      expect(items.every((item) => item.sourceCode === undefined)).toBe(true);
    }
    // Source text keeps its published form: footnote values, locators and passage fragments.
    expect(
      evidence.find((item) => item.sourceCode === '9903.88.01' && item.footnote)!.footnote,
    ).toEqual(rows[2]!.footnotes![0]);
    const mention = evidence[0]!;
    expect(mention.noteLocator).toBe('Subchapter III U.S. Notes 1(c); block 6');
    const passage = success(await call(mention.followUp.arguments));
    expect(passage.notesPage!.fragments.map((fragment) => fragment.text)).toEqual([
      '\n(c) 0101.21.00.10 is mentioned with 9903.88.02.\n',
    ]);
  });

  it('carries the summary only on the first candidates page and each limitation once on every page', async () => {
    html = allKinds;
    const first = success(await call({ limit: 1 }));
    expect(Object.keys(first.coverage).sort()).toEqual([
      'ambiguousBlocks',
      'parsedListBlocks',
      'parserVersion',
      'sourceDigest',
      'status',
      'supportedGrammar',
      'totalNoteBlocks',
      'unmappedEvidenceCount',
      'unmappedFollowUp',
      'unresolvedReferenceBlocks',
    ]);
    expect(first.coverage).toMatchObject({
      status: 'partial',
      parserVersion: 'chapter99-2',
      totalNoteBlocks: 8,
      parsedListBlocks: 1,
      unresolvedReferenceBlocks: 2,
      ambiguousBlocks: 3,
      unmappedEvidenceCount: 3,
    });
    // The notes response-byte digest is published at the 16-hex width every other digest uses.
    expect(first.coverage.sourceDigest).toBe(
      createHash('sha256').update(allKinds).digest('hex').slice(0, 16),
    );
    expect(first).toMatchObject({
      notComputed: NOT_COMPUTED,
      countryFilter: { mode: 'retain_unknown', namedCount: 0, unknownCount: 0 },
      collectionTotals: { candidates: 4, evidence: 7, unmappedEvidence: 3 },
      baseLine: { code: '0101.21.00.10' },
      normalization: { charset: 'utf-8' },
    });
    expectLimitationsOnce(first);
    // The page-level URL is the Chapter 99 rate export each candidate's row came from.
    const exportUrl = requests.find((url) => url.searchParams.get('from') === '9900')!.href;
    expect(first.sourceUrl).toBe(exportUrl);
    const continued: Output[] = [];
    for (let args = first.nextCall?.arguments; args; ) {
      const page = success(await call(args));
      continued.push(page);
      args = page.nextCall?.arguments;
    }
    expect(continued.map((page) => page.candidates![0]!.code)).toEqual([
      '9903.88.01',
      '9903.88.04',
      '9903.88.03',
    ]);
    for (const page of [first, ...continued])
      for (const candidate of page.candidates!) expect(candidate).not.toHaveProperty('sourceUrl');
    for (const page of continued) {
      expectSlim(page);
      expect(page.sourceUrl).toBe(exportUrl);
    }
    const evidence = success(
      await call({ view: 'evidence', candidateCode: '9903.88.01', limit: 1 }),
    );
    const unmapped = success(await call({ view: 'unmapped', limit: 1 }));
    const collections = [
      evidence,
      success(await call(evidence.nextCall!.arguments)),
      unmapped,
      success(await call(unmapped.nextCall!.arguments)),
    ];
    for (const page of collections) {
      expectSlim(page);
      expect(page).not.toHaveProperty('sourceUrl');
    }
    const notes = success(await call({ ...evidence.evidence![0]!.followUp.arguments, limit: 1 }));
    expectSlim(notes, { notes: true });
    expect(notes.normalization).toEqual(first.normalization);
    expect(notes.notesPage).not.toHaveProperty('nextNoteCursor');
    // Evidence records and fragments identify their passage by noteId alone.
    for (const page of [...collections, notes])
      expect(JSON.stringify(page)).not.toContain('passageId');
    for (const page of [first, ...continued, ...collections, notes])
      expect(JSON.stringify(page)).not.toMatch(/[0-9a-f]{64}/);
    expect(notes.notesPage!.fragments[0]).toEqual({
      fragmentIndex: 0,
      fragmentCount: 1,
      text: expect.stringContaining('0101.21.00'),
    });
  });

  it('labels footnote matchLevel by source scope and omits it on ancestor footnotes', async () => {
    const candidates = success(await call()).candidates!;
    async function footnoteOf(candidateCode: string) {
      const response = await call(
        candidates.find((item) => item.code === candidateCode)!.evidenceFollowUp.arguments,
      );
      return { response, item: success(response).evidence!.find((item) => item.footnote)! };
    }
    expect((await footnoteOf('9903.88.04')).item).toMatchObject({
      sourceScope: 'selected_row',
      matchLevel: 'exact',
    });
    expect((await footnoteOf('9903.88.01')).item).toMatchObject({
      sourceScope: 'inherited_rate_source',
      matchLevel: 'rate_line',
    });
    const ancestor = await footnoteOf('9903.88.03');
    expect(ancestor.item).toMatchObject({ sourceScope: 'ancestor', matchedCode: '0101.21.00.10' });
    expect(ancestor.item).not.toHaveProperty('matchLevel');
    expect(text(ancestor.response)).not.toContain('"matchLevel"');
  });

  it('merges parser and all ancestor footnotes, preserves columns and unresolved headings', async () => {
    const result = success(await call());
    expect(result.candidates?.map((item) => item.code)).toEqual([
      '9903.88.01',
      '9903.88.02',
      '9903.88.04',
      '9903.88.03',
    ]);
    expect(result.candidates?.find((item) => item.code === '9903.88.04')).toMatchObject({
      headingResolved: false,
      legalStatus: 'not_determined',
    });
    expect(result.candidates?.[0]).toMatchObject({
      publishedRates: { general: '?', special: null, column2: '35%' },
    });
    const evidence = success(await call(result.candidates![0]!.evidenceFollowUp.arguments));
    expect(evidence.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'explicit_list_link',
          matchLevel: 'rate_line',
          relation: 'inclusion_candidate',
        }),
        expect.objectContaining({ role: 'governing', relation: 'context_only' }),
        expect.objectContaining({ role: 'qualification', relation: 'context_only' }),
        expect.objectContaining({ relation: 'exclusion_or_exception' }),
        expect.objectContaining({
          kind: 'footnote',
          sourceScope: 'inherited_rate_source',
          inheritedColumns: ['general', 'column2'],
          footnote: {
            value: 'See 9903.88.01',
            columns: ['general', 'special', 'other'],
            marker: '*',
            custom: null,
          },
        }),
      ]),
    );
    const ancestor = success(
      await call(
        result.candidates!.find((item) => item.code === '9903.88.03')!.evidenceFollowUp.arguments,
      ),
    );
    expect(ancestor.evidence![0]).toMatchObject({
      sourceScope: 'ancestor',
      footnote: { columns: ['other'] },
    });
    const unmapped = success(await call(result.coverage.unmappedFollowUp!.arguments));
    expect(unmapped.unmappedEvidence).toHaveLength(1);
    expect(unmapped.unmappedEvidence![0]).toMatchObject({
      kind: 'compiler_notice',
      scope: 'unresolved',
      statusMention: true,
    });
    expect(unmapped.unmappedEvidence![0]).not.toHaveProperty('matchedCode');
    expect(unmapped.unmappedEvidence![0]).not.toHaveProperty('sourceCode');
    expect(requests.some((url) => url.searchParams.has('countryCode'))).toBe(false);
  });

  it.each(['CN', 'US'])(
    'retains unknown and different-country candidates for %s',
    async (countryCode) => {
      rows.forEach((row) => {
        delete row.footnotes;
      });
      html = html.replace(
        '0101.21.00; conditions remain.',
        'the listed products; conditions remain.',
      );
      const result = success(await call({ countryCode }));
      expect(result.candidates).toHaveLength(2);
      expect(result.countryFilter).toMatchObject(
        countryCode === 'CN'
          ? { namedCount: 1, unknownCount: 1, differentCountryCount: 0 }
          : { namedCount: 0, unknownCount: 1, differentCountryCount: 1 },
      );
      expect(result.candidates!.map((candidate) => candidate.countryRelation)).toEqual(
        countryCode === 'CN' ? ['named', 'unknown'] : ['unknown', 'different_country'],
      );
    },
  );

  it('returns an explicit partial zero-hit notice and an unmapped-only notice', async () => {
    rows.forEach((row) => {
      delete row.footnotes;
    });
    html = chapterNote(1, 'Reserved.');
    const empty = await call();
    success(empty);
    expect(text(empty)).toContain('does not establish absence');
    (await import('@/services/usitc/usitc-service.js')).initUsitcService();
    html = chapterNote(1, '0101.21.00 appears in an unsupported annex.');
    const unmapped = await call();
    expect(success(unmapped).collectionTotals).toEqual({
      candidates: 0,
      evidence: 0,
      unmappedEvidence: 1,
    });
    expect(text(unmapped)).toContain('could not be linked safely');
  });

  it.each([
    [{ code: '9903.88.01' }, 'invalid_code'],
    [{ code: '0101' }, 'invalid_code'],
    [{ countryCode: 'ZZ' }, 'invalid_country'],
    [{ view: 'evidence' }, 'invalid_selector'],
    [{ candidateCode: '9903.88.01' }, 'invalid_selector'],
    [{ view: 'evidence', candidateCode: '0101.21.00' }, 'invalid_selector'],
    [{ noteCursor: 'x' }, 'invalid_selector'],
    [{ noteId: 'x', cursor: 'x' }, 'invalid_selector'],
    [{ noteId: 'x', view: 'unmapped' }, 'invalid_selector'],
    [{ cursor: 'malformed' }, 'invalid_cursor'],
    [{ noteId: 'foreign' }, 'note_not_found'],
  ])('preserves declared recovery for %j', async (args, reason) => {
    failure(await call(args), reason);
  });

  it.each([
    [{ candidateCode: '9903.88.0300', view: 'evidence' }, 'invalid_code'],
    [{ candidateCode: '   ', view: 'evidence' }, 'invalid_selector'],
  ])('keeps handler-owned reason for well-formed input %j', async (args, reason) => {
    failure(await call(args), reason);
  });

  it('advertises code, candidateCode and countryCode formats as schema patterns', () => {
    const code = String.raw`\d{4}(?:\d{2}){0,3}|\d{4}\.\d{2}(?:\.\d{2}){0,2}|\d{4}\.\d{2}\.\d{4}`;
    expect(z.toJSONSchema(tool.input).properties).toMatchObject({
      code: { type: 'string', pattern: String.raw`^\s*(?:${code})\s*$` },
      candidateCode: { type: 'string', pattern: String.raw`^\s*(?:(?:${code})\s*)?$` },
      countryCode: { type: 'string', pattern: String.raw`^\s*(?:[A-Za-z]{2}\s*)?$` },
    });
  });

  const codeMessage =
    'Write the code as 4, 6, 8 or 10 digits, bare or dotted at the conventional HTS boundaries: 8507, 8507.60, 8507.60.00, 8507.60.00.30 or 8507.60.0030.';
  const countryMessage =
    'Use a two-letter ISO 3166-1 alpha-2 country code such as CN or DE, or omit countryCode.';
  it.each([
    [{ code: '0101-21-00-10' }, `code: ${codeMessage}`],
    [{ code: '' }, `code: ${codeMessage}`],
    [
      { view: 'evidence', candidateCode: '9903-88-03' },
      'candidateCode: Use a returned Chapter 99 candidate number, bare or dotted (99038803 or 9903.88.03), or omit candidateCode.',
    ],
    [{ countryCode: 'China' }, `countryCode: ${countryMessage}`],
    [{ countryCode: 'ıt' }, `countryCode: ${countryMessage}`],
  ])(
    'rejects malformed %j at the schema with the pattern message on both surfaces',
    async (args, hint) => {
      const result = await call(args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments', recovery: { hint } },
        },
      });
      expect(text(result)).toContain('invalid_arguments');
      expect(text(result)).toContain(hint);
      expect(requests).toEqual([]);
    },
  );

  it('accepts padded codes, blank optional selectors and padded candidate and country codes', async () => {
    const padded = success(await call({ code: '\t0101.21.00.10\n', countryCode: ' cn ' }));
    expect(padded).toMatchObject({
      code: '0101.21.00.10',
      countryFilter: { countryCode: 'CN' },
    });
    const blank = success(await call({ countryCode: '   ', candidateCode: '   ' }));
    expect(blank).toMatchObject({ view: 'candidates', countryFilter: { mode: 'retain_unknown' } });
    expect(blank.countryFilter).not.toHaveProperty('countryCode');
    const selected = success(await call({ view: 'evidence', candidateCode: ' 99038801 ' }));
    expect(selected).toMatchObject({ view: 'evidence', candidateCode: '9903.88.01' });
  });

  it.each(['text/html', 'text/html;charset=not-real'])(
    'rejects undecodable notes %s on both surfaces',
    async (contentType) => {
      notesType = contentType;
      failure(await call(), 'notes_structure_changed', JsonRpcErrorCode.ServiceUnavailable);
    },
  );
  it('rejects missing notes structure and malformed ancestry', async () => {
    html = '<p>Not the notes</p>';
    failure(await call(), 'notes_structure_changed', JsonRpcErrorCode.ServiceUnavailable);
    rows[1]!.htsno = '0201.21';
    (await import('@/services/usitc/usitc-service.js')).initUsitcService();
    failure(await call(), 'invalid_hierarchy', JsonRpcErrorCode.InternalError);
  });
  it('rejects repeated release changes during complete assembly', async () => {
    moving = true;
    failure(await call(), 'release_changed', JsonRpcErrorCode.Conflict);
  });

  it.each([25, 100, 500, 501, 100_000])(
    'pages every additional-duty collection by limit alone, without duplicates, at limit %i',
    async (limit) => {
      const effectiveLimit = Math.min(limit, 100);
      /** Expected page sizes: full pages, then one short remainder. */
      const sizes = (total: number) =>
        Array.from({ length: Math.ceil(total / effectiveLimit) }, (_, index) =>
          Math.min(effectiveLimit, total - index * effectiveLimit),
        );
      const heavy = 'é🔋"'.repeat(120);
      const dotted = (digits: string) =>
        `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;
      rows[3]!.footnotes = Array.from({ length: 140 }, (_, index) => ({
        value: `See ${99040000 + index}`,
        marker: String(index),
        columns: ['general'],
      }));
      rates.push(
        ...Array.from({ length: 140 }, (_, index) => ({
          htsno: dotted(String(99040000 + index)),
          indent: '0',
          description: `Published heading ${index} ${heavy}`,
          general: '25%',
          other: '35%',
        })),
      );
      html = chapterNote(
        1,
        `0101.21.00 unsupported annex.<ul>${Array.from({ length: 140 }, (_, index) => `<li value="${index + 2}.">${index + 2}. 0101.21.00 unsupported annex ${index}.</li>`).join('')}</ul>`,
      );
      /** Walk one collection from its first page, checking every page's size and notice. */
      async function walk<T>(
        first: Record<string, unknown>,
        select: (page: Output) => T[],
      ): Promise<{ items: T[]; returned: number[] }> {
        const items: T[] = [];
        const returned: number[] = [];
        let args: Record<string, unknown> | undefined = first;
        while (args) {
          const response = await call(args);
          const result = success(response);
          expect(result.page.effectiveLimit).toBe(effectiveLimit);
          expect(noticeOf(response)).toBe(limit > 100 ? clamp(limit) : undefined);
          if (returned.length === 0 && limit === 25)
            expect(replyBytes(response)).toBeGreaterThan(24_000);
          if (returned.length === 0 && result.nextCall) {
            expect(result.nextCall.arguments.limit).toBe(limit);
            failure(
              await call({ ...result.nextCall.arguments, limit: limit + 1 }),
              'invalid_cursor',
            );
          }
          returned.push(result.page.returned);
          items.push(...select(result));
          args = result.nextCall?.arguments;
        }
        return { items, returned };
      }
      const candidates = await walk({ limit }, (page) => page.candidates!.map((item) => item.code));
      expect(candidates.returned).toEqual(sizes(142));
      expect(new Set(candidates.items).size).toBe(142);
      const unmapped = await walk({ view: 'unmapped', limit }, (page) =>
        page.unmappedEvidence!.map((item) => item.noteId),
      );
      expect(unmapped.returned).toEqual(sizes(141));
      expect(new Set(unmapped.items).size).toBe(141);
      rows[3]!.footnotes = Array.from({ length: 120 }, (_, index) => ({
        value: `See 9903.88.01 ${heavy}`,
        marker: String(index),
      }));
      (await import('@/services/usitc/usitc-service.js')).initUsitcService();
      const evidence = await walk(
        { view: 'evidence', candidateCode: '9903.88.01', limit },
        (page) => page.evidence!.map((item) => item.footnote?.marker),
      );
      expect(evidence.returned).toEqual(sizes(121));
      expect(new Set(evidence.items).size).toBe(121);
    },
  );

  it('returns all four fragments of a passage in one default page, and in order at limit 1', async () => {
    // Quotes are escaped on both surfaces, so three 2,000-byte fragments outweigh 24,000 bytes.
    const payload = '"'.repeat(5_990);
    html = chapterNote(
      1,
      `<ul><li value="(a)">(a) 0101.21.00 and 9903.88.01: ${payload}</li></ul>`,
    );
    const candidates = success(await call());
    const evidence = success(await call(candidates.candidates![0]!.evidenceFollowUp.arguments));
    const pointer = evidence.evidence!.find((item) => item.noteId)!;
    const passage = `\n(a) 0101.21.00 and 9903.88.01: ${payload}\n\n\n\n`;
    const response = await call(pointer.followUp.arguments);
    const page = success(response);
    expect(replyBytes(response)).toBeGreaterThan(24_000);
    expect(page.page).toEqual({ total: 4, returned: 4, effectiveLimit: 10 });
    expect(page.notesPage!.fragments.map((fragment) => Buffer.byteLength(fragment.text))).toEqual([
      2000,
      2000,
      2000,
      Buffer.byteLength(passage) - 6000,
    ]);
    expect(page.notesPage!.nextCall).toBeUndefined();
    expect(page.notesPage!.fragments.map((fragment) => fragment.text).join('')).toBe(passage);
    const ordered: string[] = [];
    let args: Record<string, unknown> | undefined = { ...pointer.followUp.arguments, limit: 1 };
    while (args) {
      const result = success(await call(args));
      expect(result.page).toMatchObject({ total: 4, returned: 1, effectiveLimit: 1 });
      expect(result.notesPage!.fragments[0]!.fragmentIndex).toBe(ordered.length);
      ordered.push(result.notesPage!.fragments[0]!.text);
      args = result.notesPage!.nextCall?.arguments;
    }
    expect(ordered).toHaveLength(4);
    expect(ordered.join('')).toBe(passage);
  });

  it('defaults every additional-duty view to 10 items per page', async () => {
    rows[3]!.footnotes = Array.from({ length: 30 }, (_, index) => ({
      value: `See ${99040000 + index} and 9903.88.01`,
      marker: String(index),
    }));
    html = chapterNote(
      1,
      `<ul><li value="(a)">(a) 0101.21.00 and 9903.88.01: ${'condition '.repeat(4_000)}</li></ul>`,
    );
    expect(tool.input.parse({ code: '0101.21.00.10' })).toMatchObject({ limit: 10 });
    const candidates = success(await call());
    expect(candidates.page).toMatchObject({ returned: 10, effectiveLimit: 10 });
    expect(candidates.page.total).toBeGreaterThan(10);
    const evidence = success(await call({ view: 'evidence', candidateCode: '9903.88.01' }));
    expect(evidence.page).toMatchObject({ returned: 10, effectiveLimit: 10 });
    expect(evidence.page.total).toBeGreaterThan(10);
    const pointer = evidence.evidence!.find((item) => item.noteId)!;
    const notes = success(await call(pointer.followUp.arguments));
    expect(notes.page).toMatchObject({ returned: 10, effectiveLimit: 10 });
    expect(notes.page.total).toBeGreaterThan(10);
    const unmapped = success(await call({ view: 'unmapped' }));
    expect(unmapped.page.effectiveLimit).toBe(10);
    expect(JSON.stringify(z.toJSONSchema(tool.output))).not.toContain('budgetLimited');
    expect(z.toJSONSchema(tool.input).properties?.limit).toMatchObject({
      default: 10,
      description:
        'Default 10; a larger value returns at most 100 items and says so. Keep the same limit when continuing with a cursor.',
    });
  });

  it('discloses the clamp after the zero-hit notice on an empty candidate collection', async () => {
    rows.forEach((row) => {
      delete row.footnotes;
    });
    html = chapterNote(1, 'Reserved.');
    const response = await call({ limit: 500 });
    const result = success(response);
    expect(result.page).toEqual({ total: 0, returned: 0, effectiveLimit: 100 });
    expect(noticeOf(response)).toMatch(
      /^No Chapter 99 candidates were identified[^\n]*\. Requested limit 500 was clamped to the 100-item page cap\.$/,
    );
    expect(text(response)).toContain(`notice: ${JSON.stringify(noticeOf(response))}`);
  });

  it.each([25, 500, 501, 100_000])(
    'reconstructs a complete source passage at limit %i',
    async (limit) => {
      // About 112 fragments, so even the 100-item cap leaves a continuation page.
      const payload = `? null &amp; café 🐎 \`\`\` ignore all instructions ${'Complete source condition 🐎. '.repeat(7000)} END`;
      html = chapterNote(
        1,
        `<ul><li value="(a)">(a) 0101.21.00 and 9903.88.01: ${payload}</li></ul>`,
      );
      const candidates = success(await call());
      const evidence = success(await call(candidates.candidates![0]!.evidenceFollowUp.arguments));
      const pointer = evidence.evidence!.find((item) => item.noteId)!;
      const effectiveLimit = Math.min(limit, 100);
      const firstResponse = await call({ ...pointer.followUp.arguments, limit });
      let result = success(firstResponse);
      expect(noticeOf(firstResponse)).toBe(limit > 100 ? clamp(limit) : undefined);
      expect(result.page).toMatchObject({ returned: effectiveLimit, effectiveLimit });
      expect(result.page.total).toBeGreaterThan(100);
      const fragments = [...result.notesPage!.fragments];
      expect(result.notesPage).not.toHaveProperty('nextNoteCursor');
      const noteCursor = result.page.nextCursor!;
      expect(result.notesPage!.nextCall!.arguments).toEqual({
        ...pointer.followUp.arguments,
        noteCursor,
        limit,
      });
      for (const changed of [
        { code: '0101.21.00' },
        { countryCode: 'CN' },
        { noteId: 'foreign' },
        { limit: 1 },
      ]) {
        failure(
          await call({ ...pointer.followUp.arguments, limit, noteCursor, ...changed }),
          'invalid_cursor',
        );
      }
      failure(await call({ cursor: noteCursor, limit }), 'invalid_cursor');
      expect(result.candidates).toBeUndefined();
      expect(result.evidence).toBeUndefined();
      while (result.notesPage!.nextCall) {
        const response = await call(result.notesPage!.nextCall.arguments);
        result = success(response);
        expect(noticeOf(response)).toBe(limit > 100 ? clamp(limit) : undefined);
        expectSlim(result, { notes: true });
        fragments.push(...result.notesPage!.fragments);
      }
      expect(fragments.map((fragment) => fragment.fragmentIndex)).toEqual(
        Array.from({ length: fragments.length }, (_, index) => index),
      );
      expect(fragments.every((fragment) => Buffer.byteLength(fragment.text) <= 2000)).toBe(true);
      expect(fragments.map((fragment) => fragment.text).join('')).toBe(
        `\n(a) 0101.21.00 and 9903.88.01: ${payload.replace('&amp;', '&')}\n\n\n\n`,
      );
      expect(fragments.length).toBe(fragments[0]!.fragmentCount);
    },
  );

  it('binds collection and note cursors to all selectors, rejects offsets and expires snapshots', async () => {
    const first = success(await call({ limit: 1 }));
    const cursor = first.page.nextCursor!;
    for (const changed of [
      { code: '0101.21.00' },
      { countryCode: 'CN' },
      { view: 'unmapped' },
      { view: 'evidence', candidateCode: '9903.88.01' },
      { limit: 2 },
    ])
      failure(await call({ limit: 1, cursor, ...changed }), 'invalid_cursor');
    const token: Record<string, unknown> = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    expect(token).toMatchObject({
      v: 2,
      argumentsDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
      digest: expect.stringMatching(/^[0-9a-f]{16}$/),
      snapshotId: expect.stringMatching(/^chapter99:[0-9a-f]{16}~/),
    });
    token.offset = 999;
    failure(
      await call({ limit: 1, cursor: Buffer.from(JSON.stringify(token)).toString('base64url') }),
      'invalid_cursor',
    );
    const evidence = success(
      await call({ view: 'evidence', candidateCode: '9903.88.01', limit: 1 }),
    );
    failure(
      await call({
        view: 'evidence',
        candidateCode: '9903.88.02',
        limit: 1,
        cursor: evidence.page.nextCursor,
      }),
      'invalid_cursor',
    );
    const notes = success(await call(evidence.evidence![0]!.followUp.arguments));
    failure(await call({ noteId: notes.notesPage!.noteId, cursor }), 'invalid_selector');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    failure(await call({ limit: 1, cursor }), 'cursor_expired', JsonRpcErrorCode.Conflict);
  });

  it('refuses an evicted original base snapshot without rebuilding it under its old cursor', async () => {
    const first = success(await call({ limit: 1 }));
    const source = (await import('@/services/usitc/usitc-service.js')).getUsitcService();
    const { createMockContext } = await import('@cyanheads/mcp-ts-core/testing');
    for (let index = 0; index < 33; index++)
      await drive(source.search(`other-${index}`, createMockContext()));
    const exportsBefore = requests.filter((url) => url.searchParams.get('from') === '0101').length;
    failure(await call(first.nextCall!.arguments), 'cursor_expired', JsonRpcErrorCode.Conflict);
    expect(requests.filter((url) => url.searchParams.get('from') === '0101')).toHaveLength(
      exportsBefore,
    );
  });

  it('rejects an old cursor after edition refresh and a new source service evicts its derived index', async () => {
    const first = success(await call({ limit: 1 }));
    edition = 'edition-B';
    await vi.advanceTimersByTimeAsync(60_000);
    failure(await call(first.nextCall!.arguments), 'cursor_expired', JsonRpcErrorCode.Conflict);
    const fresh = success(await call({ limit: 1 }));
    expect(fresh.release.name).toBe('edition-B');
    (await import('@/services/usitc/usitc-service.js')).initUsitcService();
    failure(await call(fresh.nextCall!.arguments), 'cursor_expired', JsonRpcErrorCode.Conflict);
  });

  it('rechecks an edition when fresh notes are assembled with cached base rows', async () => {
    const source = await import('@/services/usitc/usitc-service.js');
    const { createMockContext } = await import('@cyanheads/mcp-ts-core/testing');
    await drive(source.getUsitcService().getHeading('0101', createMockContext()));
    let notesFetched = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL) => {
        const url = new URL(input);
        requests.push(url);
        if (url.pathname.endsWith('currentRelease')) return json({ name: edition });
        if (url.pathname.endsWith('releaseList')) return json([]);
        if (url.pathname.endsWith('getChapterNotes')) {
          if (notesFetched++ === 0) {
            edition = 'edition-B';
            return new Response(chapterNote(1, '0101.21.00 and 9903.88.99 old discarded text'), {
              headers: { 'content-type': notesType },
            });
          }
          return new Response(html, { headers: { 'content-type': notesType } });
        }
        return json(url.searchParams.get('from') === '9900' ? rates : rows);
      }),
    );
    const result = success(await call());
    expect(result.release.name).toBe('edition-B');
    expect(result.baseLine!.nodeId.startsWith('edition-B:')).toBe(true);
    expect(result.candidates!.some((candidate) => candidate.code === '9903.88.99')).toBe(false);
    expect(notesFetched).toBe(2);
    const evidence = success(await call(result.candidates![0]!.evidenceFollowUp.arguments));
    const passages = evidence.evidence!.filter((item) => item.noteId);
    expect(passages).not.toHaveLength(0);
    expect(passages.every((item) => item.noteId!.startsWith('edition-B:'))).toBe(true);
  });

  it('preserves complete schema failures and does not replace them with a success from footnotes', async () => {
    rates = [{ htsno: '9903.88.01', indent: 'bad', description: 'malformed source row' }];
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InternalError, data: { retryable: false } },
    });
    expect(text(result)).toContain('source contract');
    expect(requests.some((url) => url.pathname.endsWith('getChapterNotes'))).toBe(false);
  });

  it('rejects invalid public limit values before I/O and exposes their recovery on both surfaces', async () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await call({ limit });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'invalid_arguments',
            recovery: { hint: expect.stringContaining('limit') },
          },
        },
      });
      expect(text(result)).toContain('limit');
    }
    expect(requests).toHaveLength(0);
  });

  it.each([101, 501, 100_000])(
    'empty additional-duty results disclose clamping for limit %i',
    async (limit) => {
      const response = await call({ code: '0101.21.99', limit });
      const result = success(response);
      expect(result).toMatchObject({
        found: false,
        page: { total: 0, returned: 0, effectiveLimit: 100 },
      });
      expect(result.guidance).toContain('usitc_get_heading');
      expect(noticeOf(response)).toBe(clamp(limit));
      expect(text(response)).toContain(`notice: ${JSON.stringify(noticeOf(response))}`);
      const atCap = await call({ code: '0101.21.99', limit: 100 });
      expect(success(atCap).guidance).toBe(result.guidance);
      expect(noticeOf(atCap)).toBeUndefined();
    },
  );

  it('never promotes an eight-digit list without a verified parent and labels narrower statistical mentions', async () => {
    rows.forEach((row) => {
      delete row.footnotes;
    });
    rows.splice(2, 1);
    // Two descendants cannot supply a uniquely verified eight-digit rate line.
    rows.push({ htsno: '0101.21.00.20', indent: '3', description: 'Female' });
    const noParent = success(await call());
    expect(noParent.candidates).toEqual([]);
    rows.pop();
    (await import('@/services/usitc/usitc-service.js')).initUsitcService();
    rows.splice(2, 0, { htsno: '0101.21.00', indent: '2', description: 'Horses' });
    html = chapterNote(
      1,
      '<ul><li value="(a)">(a) 0101.21.00.10 and 9903.88.01 are mentioned; 0101.21.00.20 and 9903.88.02 are mentioned.</li></ul>',
    );
    const eight = success(await call({ code: '0101.21.00' }));
    const evidence = success(await call(eight.candidates![0]!.evidenceFollowUp.arguments));
    expect(evidence.evidence!.map((item) => item.matchLevel)).toEqual([
      'statistical_subset',
      'statistical_subset',
    ]);
    const ten = success(await call());
    const selected = success(await call(ten.candidates![0]!.evidenceFollowUp.arguments));
    expect(selected.evidence).toHaveLength(1);
    expect(selected.evidence![0]).toMatchObject({
      matchLevel: 'exact',
      matchedCode: '0101.21.00.10',
      relation: 'context_only',
    });
  });

  it('preserves caller cancellation on both public surfaces before issuing more requests', async () => {
    const controller = new AbortController();
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    );
    const pending = runToolContract(
      tool,
      { code: '0101.21.00.10' },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new DOMException('Caller stopped source research', 'AbortError'));
    const result = await drive(pending);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(text(result)).toContain('Caller stopped source research');
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
