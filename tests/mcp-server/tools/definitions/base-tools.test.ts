/** @fileoverview Five public tariff contracts exercised through the real service and fake HTTP. */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TariffRecord } from '@/services/usitc/types.js';
import { baseRows } from '../../../fixtures/tariffs/base-rows.js';

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

let rows: TariffRecord[];
let edition: string;
let releaseRecords: Array<Record<string, unknown>>;
let requests: URL[];
let releaseReadTimes: string[];
let changingEdition: number | undefined;
let tools: Awaited<ReturnType<typeof loadTools>>;

async function loadTools() {
  const [search, heading, browse, duty, reference] = await Promise.all([
    import('@/mcp-server/tools/definitions/search-hts.tool.js'),
    import('@/mcp-server/tools/definitions/get-heading.tool.js'),
    import('@/mcp-server/tools/definitions/browse-chapter.tool.js'),
    import('@/mcp-server/tools/definitions/lookup-duty-rate.tool.js'),
    import('@/mcp-server/tools/definitions/list-reference.tool.js'),
  ]);
  return {
    search: search.searchHtsTool,
    heading: heading.getHeadingTool,
    browse: browse.browseChapterTool,
    duty: duty.lookupDutyRateTool,
    reference: reference.listReferenceTool,
  };
}

async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const observed = promise
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  for (let index = 0; index < 50 && !settled; index++) await vi.advanceTimersByTimeAsync(1000);
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}

function text(result: CallToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function assertTwin(result: CallToolResult): void {
  expect(result.isError).not.toBe(true);
  const rendered = text(result);
  const match = rendered.match(/(`{3,})json\n([\s\S]*?)\n\1/);
  expect(match).not.toBeNull();
  const parsed: unknown = JSON.parse(match![2]!);
  const {
    totalCount: _totalCount,
    notice: _notice,
    ...structured
  } = z.record(z.string(), z.unknown()).parse(result.structuredContent);
  expect(parsed).toEqual(structured);
  expect(rendered).toContain('[Source](<https://hts.usitc.gov/');
}

function assertError(
  result: CallToolResult,
  reason: string,
  recovery: string,
  code?: number,
): void {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { ...(code !== undefined && { code }), data: { reason, recovery: { hint: recovery } } },
  });
  expect(text(result)).toContain(reason);
  expect(text(result)).toContain(recovery);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  vi.resetModules();
  rows = structuredClone(baseRows);
  edition = 'edition-A';
  releaseRecords = [
    { name: 'edition-A', description: null, releaseStartDate: null, custom: { preserved: true } },
    { name: 'edition-old', title: 'Old publication', target: 'archive' },
  ];
  requests = [];
  releaseReadTimes = [];
  changingEdition = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname.endsWith('releaseList')) releaseReadTimes.push(new Date().toISOString());
      expect(url.origin).toBe('https://hts.usitc.gov');
      const body = url.pathname.endsWith('currentRelease')
        ? { name: changingEdition === undefined ? edition : `transition-${changingEdition++}` }
        : url.pathname.endsWith('releaseList')
          ? releaseRecords
          : rows;
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const service = await import('@/services/usitc/usitc-service.js');
  service.initUsitcService();
  tools = await loadTools();
});

afterEach(async () => {
  (await import('@/services/usitc/usitc-service.js')).disposeUsitcService();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('base tariff tool contracts', () => {
  it.each([
    ['2026HTSRev21', 'listed'],
    ['2026HTSRev22', 'unknown'],
  ])('preserves GN3(b) listing and provenance on both surfaces for %s', async (release, status) => {
    edition = release;
    const response = await drive(
      runToolContract(tools.duty, { code: '8507600010', countryCode: 'RU' }),
    );
    assertTwin(response);
    expect(tools.duty.output.parse(response.structuredContent).countryAssessment).toMatchObject({
      countryCode: 'RU',
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
    });
  });

  it('omits the GN3(b) comparison without country input on both surfaces', async () => {
    edition = '2026HTSRev21';
    const response = await drive(runToolContract(tools.duty, { code: '8507600010' }));
    assertTwin(response);
    expect(
      tools.duty.output.parse(response.structuredContent).countryAssessment,
    ).not.toHaveProperty('column2Listing');
  });

  it('resolves a combined row and exposes source identity on both duty surfaces', async () => {
    rows = [
      { htsno: '8505', indent: '0', description: 'Root' },
      { htsno: '8505.90.75.01', indent: '1', description: 'Combined source', general: 'Free' },
    ];
    const response = await drive(runToolContract(tools.duty, { code: '85059075' }));
    assertTwin(response);
    expect(tools.duty.output.parse(response.structuredContent)).toMatchObject({
      found: true,
      code: '8505.90.75',
      row: { htsno: '8505.90.75.01', sourceOrdinal: 1, rateLineCode: '8505.90.75' },
      resolvedRates: {
        general: { text: 'Free', sourceHtsno: '8505.90.75.01', state: 'published' },
      },
    });
    const miss = await drive(runToolContract(tools.duty, { code: '8505907599' }));
    assertTwin(miss);
    expect(tools.duty.output.parse(miss.structuredContent)).toMatchObject({ found: false });
  });

  it('keeps section source metadata separate and preserves grouping through continuation', async () => {
    rows = [
      { indent: '2', superior: 'true', description: 'I. PRIMARY FORMS' },
      { htsno: '3901', indent: '0', description: 'First heading' },
      { htsno: '3901.10.00.00', indent: '1', description: 'Combined', general: 'Free' },
    ];
    const heading = await drive(runToolContract(tools.heading, { code: '3901', limit: 1 }));
    assertTwin(heading);
    const first = tools.heading.output.parse(heading.structuredContent);
    expect(first.sections).toMatchObject([
      { sourceOrdinal: 0, description: 'I. PRIMARY FORMS', superior: 'true' },
    ]);
    expect(first.nodes[0]).toMatchObject({ htsno: '3901', sourceOrdinal: 1 });
    expect(first.nodes[0]).not.toHaveProperty('parentId');
    const next = await drive(
      runToolContract(tools.heading, { code: '3901', limit: 1, cursor: first.page.nextCursor }),
    );
    assertTwin(next);
    expect(tools.heading.output.parse(next.structuredContent)).toMatchObject({
      sections: first.sections,
      nodes: [{ htsno: '3901.10.00.00' }],
      page: { total: 2, returned: 1 },
    });
    rows.push(
      { indent: '1', superior: 'true', description: 'II. WASTE AND SCRAP' },
      { htsno: '3902', indent: '0', description: 'Second heading' },
    );
    const browse = await drive(runToolContract(tools.browse, { chapter: '39', limit: 1 }));
    assertTwin(browse);
    const page = tools.browse.output.parse(browse.structuredContent);
    expect(page.headings).toEqual([
      {
        code: '3901',
        description: 'First heading',
        rateLineCount: 1,
        statisticalLineCount: 1,
        subchapter: 'I. PRIMARY FORMS',
      },
    ]);
    const continuation = await drive(
      runToolContract(tools.browse, { chapter: '39', limit: 1, cursor: page.page.nextCursor }),
    );
    assertTwin(continuation);
    expect(tools.browse.output.parse(continuation.structuredContent).headings).toEqual([
      {
        code: '3902',
        description: 'Second heading',
        rateLineCount: 0,
        statisticalLineCount: 0,
        subchapter: 'II. WASTE AND SCRAP',
      },
    ]);
  });
  it('advertises all five operations as read-only, idempotent and open-world', () => {
    for (const definition of Object.values(tools))
      expect(definition.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
  });

  it('search preserves every source field and leaves flat statistical cells unresolved', async () => {
    const response = await drive(runToolContract(tools.search, { query: ' battery ', cursor: '' }));
    assertTwin(response);
    const result = tools.search.output.parse(response.structuredContent);
    expect(result).toMatchObject({
      query: 'battery',
      context: 'flat_search_matches',
      page: { total: 9, returned: 9 },
    });
    expect(response.structuredContent).toHaveProperty('totalCount', 9);
    expect(text(response)).toContain('totalCount: 9');
    expect(result.rows[2]).toMatchObject({
      ratesResolved: false,
      publishedRates: { general: '3.4%', special: 'Free (A*, AU) 2% (ZZ)', column2: '35%' },
      units: ['No.'],
      quotaQuantity: null,
      additionalDuties: 'one',
      addiitionalDuties: 'two',
      sourceFields: { customSource: { preserved: true } },
      footnotes: [{ columns: ['general'], marker: '*' }],
    });
    expect(result.rows[4]).toMatchObject({
      publishedRates: { general: '', special: null, column2: '' },
      units: null,
      footnotes: null,
    });
    expect(result.rows[4]).not.toHaveProperty('resolvedRates');
    expect(result.rows[0]).not.toHaveProperty('units');
    expect(
      requests.find((url) => url.pathname.endsWith('search'))!.searchParams.get('keyword'),
    ).toBe('battery');
  });

  it('heading pages retain full off-page parent/source follow-ups and never widen a prefix', async () => {
    const first = await drive(
      runToolContract(tools.heading, { code: '85076000', limit: 1, nodeId: '' }),
    );
    assertTwin(first);
    const all = tools.heading.output.parse(first.structuredContent);
    expect(all.page.total).toBe(4);
    expect(all.nodes[0]!.htsno).toBe('8507.60.00');
    const parent = all.nodes[0]!.parentFollowUp!;
    const parentResponse = await drive(runToolContract(tools.heading, parent.arguments));
    assertTwin(parentResponse);
    expect(tools.heading.output.parse(parentResponse.structuredContent).nodes[0]!.htsno).toBe(
      '8507.60',
    );
    const grandparent = tools.heading.output.parse(parentResponse.structuredContent).nodes[0]!
      .parentFollowUp!;
    const rootResponse = await drive(runToolContract(tools.heading, grandparent.arguments));
    assertTwin(rootResponse);
    expect(tools.heading.output.parse(rootResponse.structuredContent).nodes[0]!.htsno).toBe('8507');
    const ordinals = all.nodes.map((node) => node.sourceOrdinal);
    let cursor = all.page.nextCursor;
    while (cursor) {
      const response = await drive(
        runToolContract(tools.heading, { code: '8507.60.00', limit: 1, cursor }),
      );
      assertTwin(response);
      const result = tools.heading.output.parse(response.structuredContent);
      ordinals.push(...result.nodes.map((node) => node.sourceOrdinal));
      cursor = result.page.nextCursor;
      expect(ordinals.length).toBeLessThanOrEqual(4);
    }
    expect(ordinals).toEqual([2, 3, 4, 5]);
  });

  it('duty lookup inherits all blank statistical columns across unnamed ancestors and preserves explicit overrides', async () => {
    const response = await drive(
      runToolContract(tools.duty, { code: '8507600010', countryCode: 'au' }),
    );
    assertTwin(response);
    const result = tools.duty.output.parse(response.structuredContent);
    expect(result).toMatchObject({
      found: true,
      code: '8507.60.00.10',
      resolvedRates: {
        general: { state: 'inherited', text: '3.4%', sourceHtsno: '8507.60.00' },
        special: { state: 'inherited', text: 'Free (A*, AU) 2% (ZZ)' },
        column2: { state: 'inherited', text: '35%' },
      },
      countryAssessment: {
        countryCode: 'AU',
        eligibility: 'not_determined',
        columnSelection: 'not_determined',
        membershipCoverage: 'unknown',
        editionMatches: false,
      },
      chapter99Pointers: {
        countKnown: false,
        followUp: { arguments: { code: '8507.60.00.10', countryCode: 'AU' } },
      },
    });
    expect(result.specialPrograms).toMatchObject({ parseCoverage: 'partial' });
    expect(
      result
        .specialPrograms!.clauses.flatMap((clause) => clause.programs)
        .map((program) => program.symbol),
    ).toEqual(['A*', 'AU', 'ZZ']);
    const source = await drive(
      runToolContract(tools.heading, result.resolvedRates!.general.sourceFollowUp!.arguments),
    );
    assertTwin(source);
    expect(tools.heading.output.parse(source.structuredContent).nodes[0]).toMatchObject({
      htsno: '8507.60.00',
      publishedRates: { general: '3.4%', special: 'Free (A*, AU) 2% (ZZ)', column2: '35%' },
    });
    const parent = await drive(
      runToolContract(tools.heading, result.row!.parentFollowUp!.arguments),
    );
    assertTwin(parent);
    expect(tools.heading.output.parse(parent.structuredContent).nodes[0]).toMatchObject({
      description: 'Unnamed superior',
    });
    const override = await drive(
      runToolContract(tools.duty, { code: '8507.60.00.20', countryCode: '' }),
    );
    assertTwin(override);
    expect(tools.duty.output.parse(override.structuredContent).resolvedRates).toMatchObject({
      general: { state: 'published', text: '1.2%' },
      special: { state: 'inherited' },
      column2: { state: 'published', text: '40%' },
    });
    expect(requests.every((url) => !url.searchParams.has('countryCode'))).toBe(true);
  });

  it('does not invent Free or fall back from a nonexistent statistical suffix', async () => {
    const blank = await drive(runToolContract(tools.duty, { code: '8507800010' }));
    assertTwin(blank);
    expect(tools.duty.output.parse(blank.structuredContent).resolvedRates).toEqual({
      general: { state: 'not_published' },
      special: { state: 'not_published' },
      column2: { state: 'not_published' },
    });
    const missing = await drive(runToolContract(tools.duty, { code: '8507600099' }));
    assertTwin(missing);
    expect(missing.structuredContent).toMatchObject({
      found: false,
      notice: expect.stringContaining('usitc_get_heading'),
      guidance: expect.stringContaining('No exact'),
    });
    expect(missing.structuredContent).not.toHaveProperty('row');
    expect(missing.structuredContent).not.toHaveProperty('resolvedRates');
  });

  it('keeps a captured long Special cell and every program annotation within the complete reply budget', async () => {
    rows = [
      {
        htsno: '8539.29.10.00',
        indent: '0',
        description: 'Lamps',
        general: '3.3%',
        special: 'Free (A,AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG)2.9% (JP)',
        other: '35%',
      },
    ];
    const response = await drive(
      runToolContract(tools.duty, { code: '8539291000', countryCode: 'AU' }),
    );
    assertTwin(response);
    const result = tools.duty.output.parse(response.structuredContent);
    expect(
      result
        .specialPrograms!.clauses.flatMap((clause) => clause.programs)
        .map((program) => program.symbol),
    ).toEqual([
      'A',
      'AU',
      'BH',
      'CL',
      'CO',
      'D',
      'E',
      'IL',
      'JO',
      'KR',
      'MA',
      'OM',
      'P',
      'PA',
      'PE',
      'S',
      'SG',
      'JP',
    ]);
    expect(result.specialPrograms).toMatchObject({
      decoder: {
        sourceEdition: '2026HTSRev21',
        citation: 'General Note 3(c)(i)',
        sourceUrl:
          'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203',
        qualificationNotice:
          'Program identification does not establish origin qualification, product eligibility, quota status, program availability or the legally applicable rate.',
      },
      referenceFollowUp: { tool: 'usitc_list_reference', arguments: { topic: 'spi' } },
    });
    expect(text(response)).toContain(
      'Program identification does not establish origin qualification',
    );
    expect(
      Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result: response })),
    ).toBeLessThanOrEqual(24_000);
  });

  it('browse counts the complete hierarchy and uses the ten-digit chapter boundary', async () => {
    const response = await drive(runToolContract(tools.browse, { chapter: '85', limit: 500 }));
    assertTwin(response);
    expect(tools.browse.output.parse(response.structuredContent).headings).toEqual([
      {
        code: '8507',
        description: 'Electric accumulators',
        rateLineCount: 2,
        statisticalLineCount: 3,
      },
    ]);
    expect(
      requests.find((url) => url.pathname.endsWith('exportList'))!.searchParams.get('to'),
    ).toBe('8599.99.99.99');
  });

  it('browse Chapter 98 counts statistical children without promoting them to separate summary entries', async () => {
    rows = [
      { htsno: '9801.00.10', indent: '0', description: 'Returned products', general: 'Free' },
      { htsno: '9801.00.10.12', indent: '1', description: 'Statistical reporting category' },
    ];
    const response = await drive(runToolContract(tools.browse, { chapter: '98' }));
    assertTwin(response);
    const result = tools.browse.output.parse(response.structuredContent);
    expect(result.headings).toEqual([
      {
        code: '9801.00.10',
        description: 'Returned products',
        rateLineCount: 1,
        statisticalLineCount: 1,
      },
    ]);
    expect(result.page.total).toBe(1);
    expect(response.structuredContent).toHaveProperty('totalCount', 1);
    expect(text(response)).toContain('totalCount: 1');
  });

  it('browse Chapter 98 discloses its unavailable subchapter crosswalk without guessing a subchapter', async () => {
    rows = [
      { htsno: '9801.00.10', indent: '0', description: 'Returned products', general: 'Free' },
    ];
    const response = await drive(runToolContract(tools.browse, { chapter: '98' }));
    assertTwin(response);
    const result = tools.browse.output.parse(response.structuredContent);
    expect(result.headings[0]).not.toHaveProperty('subchapter');
    expect(result.notices).toContain(
      'The export provides no verified subchapter crosswalk; subchapter grouping is unavailable.',
    );
  });

  it.each(
    (['search', 'heading', 'browse'] as const).flatMap((kind) =>
      [501, 100_000].map((limit) => ({ kind, limit })),
    ),
  )('empty $kind results disclose the clamp at limit $limit', async ({ kind, limit }) => {
    rows = [];
    const response =
      kind === 'search'
        ? await drive(runToolContract(tools.search, { query: 'absent', limit }))
        : kind === 'heading'
          ? await drive(runToolContract(tools.heading, { code: '7701', limit }))
          : await drive(runToolContract(tools.browse, { chapter: '77', limit }));
    assertTwin(response);
    expect(response.structuredContent).toMatchObject({
      page: { total: 0, returned: 0, effectiveLimit: 100 },
      totalCount: 0,
      notice: expect.stringContaining('usitc_'),
    });
    expect(text(response)).toContain('notice:');
  });

  it.each(['identifiers', 'spi', 'chapters', 'units', 'releases'] as const)(
    'reference %s preserves typed fields and source provenance across every cursor',
    async (topic) => {
      const items: unknown[] = [];
      let cursor: string | undefined;
      do {
        const response = await drive(
          runToolContract(tools.reference, { topic, limit: 2, ...(cursor && { cursor }) }),
        );
        assertTwin(response);
        const result = tools.reference.output.parse(response.structuredContent);
        items.push(...result.items);
        cursor = result.page.nextCursor;
        expect(items.length).toBeLessThan(200);
        if (topic === 'releases') {
          expect(result.source.scheduleUrl).toBe('https://hts.usitc.gov/reststop/releaseList');
          expect(result.source.retrievedAt).toBe(releaseReadTimes[1]);
        }
      } while (cursor);
      expect(new Set(items.map((item) => JSON.stringify(item))).size).toBe(items.length);
      if (topic === 'identifiers')
        expect(items).toContainEqual(
          expect.objectContaining({
            name: 'statistical_number',
            digits: 10,
            format: 'NNNN.NN.NN.NN',
          }),
        );
      if (topic === 'spi')
        expect(items).toContainEqual(
          expect.objectContaining({
            symbol: 'AU',
            countryListCoverage: 'unknown',
            citation: expect.any(String),
            sourceEdition: '2026HTSRev21',
            sourceUrl: expect.stringContaining('release=2026HTSRev21'),
            qualificationNotice: expect.any(String),
          }),
        );
      if (topic === 'chapters')
        expect(items).toContainEqual(
          expect.objectContaining({
            chapter: '77',
            reserved: true,
            labelSource: 'published_application_navigation',
            capturedAt: expect.any(String),
            section: expect.any(String),
            sectionLabel: expect.any(String),
            scheduleUrl: expect.any(String),
          }),
        );
      if (topic === 'units')
        expect(items).toContainEqual(
          expect.objectContaining({
            kind: 'unit',
            symbol: 'kg',
            meaning: expect.any(String),
            citation: expect.any(String),
            sourceEdition: '2026HTSRev21',
          }),
        );
      if (topic === 'releases')
        expect(items).toEqual([
          {
            ...releaseRecords[0],
            kind: 'release',
            sourceUrl: 'https://hts.usitc.gov/reststop/releaseList',
          },
          {
            ...releaseRecords[1],
            kind: 'release',
            sourceUrl: 'https://hts.usitc.gov/reststop/releaseList',
          },
        ]);
    },
  );

  it.each([500, 501, 100_000])(
    'search limit %i preserves every row within 24 KB',
    async (limit) => {
      rows = Array.from({ length: 120 }, (_, index) => ({
        htsno: `8507.60.${String(index).padStart(2, '0')}`,
        indent: '0',
        description: `row-${index} ${'é🔋'.repeat(60)}`,
        general: null,
        customSource: { ordinal: index },
      }));
      const ordinals: number[] = [];
      let cursor: string | undefined;
      do {
        const response = await drive(
          runToolContract(tools.search, { query: 'many', limit, ...(cursor && { cursor }) }),
        );
        assertTwin(response);
        const result = tools.search.output.parse(response.structuredContent);
        expect(result.page.effectiveLimit).toBe(100);
        expect(
          Buffer.byteLength(
            JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result: response }),
          ),
        ).toBeLessThanOrEqual(24_000);
        expect(result.page.returned).toBeGreaterThan(0);
        if (ordinals.length === 0) expect(result.page.budgetLimited).toBe(true);
        ordinals.push(...result.rows.map((row) => row.sourceOrdinal));
        cursor = result.page.nextCursor;
        if (cursor && ordinals.length === result.page.returned) {
          const changed = await drive(
            runToolContract(tools.search, { query: 'many', limit: limit + 1, cursor }),
          );
          expect(changed.structuredContent).toMatchObject({
            error: { data: { reason: 'invalid_cursor' } },
          });
          expect(text(changed)).toContain('invalid_cursor');
        }
        expect(ordinals.length).toBeLessThanOrEqual(120);
      } while (cursor);
      expect(ordinals).toEqual(Array.from({ length: 120 }, (_, index) => index));
    },
  );

  it.each(
    (['heading', 'browse'] as const).flatMap((kind) =>
      [500, 501, 100_000].map((limit) => ({ kind, limit })),
    ),
  )('$kind limit $limit preserves the complete byte-limited forest', async ({ kind, limit }) => {
    rows = Array.from({ length: 120 }, (_, index) => ({
      htsno: `9903.${String(Math.floor(index / 100)).padStart(2, '0')}.${String(index % 100).padStart(2, '0')}`,
      indent: '0',
      description: `Published root ${index}: ${'é🔋'.repeat(80)}`,
      general: '25%',
      special: '',
      other: '35%',
    }));
    const codes: string[] = [];
    let cursor: string | undefined;
    do {
      const response =
        kind === 'heading'
          ? await drive(
              runToolContract(tools.heading, {
                code: '9903',
                limit,
                ...(cursor && { cursor }),
              }),
            )
          : await drive(
              runToolContract(tools.browse, {
                chapter: '99',
                limit,
                ...(cursor && { cursor }),
              }),
            );
      assertTwin(response);
      expect(
        Buffer.byteLength(
          JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result: response }),
        ),
      ).toBeLessThanOrEqual(24_000);
      if (kind === 'heading') {
        const result = tools.heading.output.parse(response.structuredContent);
        expect(result.nodes.every((node) => !node.parentId)).toBe(true);
        expect(result.page).toMatchObject({ total: 120, effectiveLimit: 100 });
        codes.push(...result.nodes.map((node) => node.htsno!));
        cursor = result.page.nextCursor;
      } else {
        const result = tools.browse.output.parse(response.structuredContent);
        expect(result.notices).toContain(
          'The export provides no verified subchapter crosswalk; subchapter grouping is unavailable.',
        );
        expect(
          result.headings.every(
            (heading) =>
              heading.rateLineCount === 1 &&
              heading.statisticalLineCount === 0 &&
              heading.subchapter === undefined,
          ),
        ).toBe(true);
        expect(result.page).toMatchObject({ total: 120, effectiveLimit: 100 });
        codes.push(...result.headings.map((heading) => heading.code));
        cursor = result.page.nextCursor;
      }
      expect(codes.length).toBeLessThanOrEqual(120);
    } while (cursor);
    expect(codes).toEqual(rows.map((row) => row.htsno));
  });

  it.each(
    (['identifiers', 'spi', 'chapters', 'units', 'releases'] as const).flatMap((topic) =>
      [500, 501, 100_000].map((limit) => ({ topic, limit })),
    ),
  )('reference $topic limit $limit remains complete within 24 KB', async ({ topic, limit }) => {
    let cursor: string | undefined;
    let count = 0;
    let total = 0;
    do {
      const response = await drive(
        runToolContract(tools.reference, { topic, limit, ...(cursor && { cursor }) }),
      );
      assertTwin(response);
      const result = tools.reference.output.parse(response.structuredContent);
      expect(result.page.effectiveLimit).toBe(100);
      expect(
        Buffer.byteLength(
          JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result: response }),
        ),
      ).toBeLessThanOrEqual(24_000);
      total = result.page.total;
      count += result.items.length;
      cursor = result.page.nextCursor;
      expect(count).toBeLessThanOrEqual(total);
    } while (cursor);
    expect(count).toBe(total);
  });

  it('rejects changed selectors, changed limits and cross-tool cursors with declared recovery', async () => {
    const first = tools.search.output.parse(
      (await drive(runToolContract(tools.search, { query: 'battery', limit: 1 })))
        .structuredContent,
    );
    const recovery = 'Repeat usitc_search_hts without cursor using the desired query.';
    for (const input of [
      { query: 'other', limit: 1 },
      { query: 'battery', limit: 2 },
    ])
      assertError(
        await drive(runToolContract(tools.search, { ...input, cursor: first.page.nextCursor })),
        'invalid_cursor',
        recovery,
        JsonRpcErrorCode.ValidationError,
      );
    assertError(
      await drive(
        runToolContract(tools.heading, { code: '8507', limit: 1, cursor: first.page.nextCursor }),
      ),
      'invalid_cursor',
      'Repeat usitc_get_heading without cursor or nodeId to obtain current identifiers.',
    );
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    assertError(
      await drive(
        runToolContract(tools.search, {
          query: 'battery',
          limit: 1,
          cursor: first.page.nextCursor,
        }),
      ),
      'cursor_expired',
      'Repeat usitc_search_hts without cursor to obtain current matches.',
    );
  });

  it('invalid upstream identifiers are hierarchy failures with source recovery', async () => {
    rows = [{ htsno: 'garbled', indent: '0', description: 'Malformed upstream identifier' }];
    assertError(
      await drive(runToolContract(tools.heading, { code: '8507' })),
      'invalid_hierarchy',
      'Call usitc_search_hts with this code to inspect published flat rows.',
      JsonRpcErrorCode.InternalError,
    );
  });

  it('rejects an evicted source snapshot without silently rebuilding an old cursor', async () => {
    const first = tools.search.output.parse(
      (await drive(runToolContract(tools.search, { query: 'original', limit: 1 })))
        .structuredContent,
    );
    for (let index = 0; index < 32; index++)
      await drive(runToolContract(tools.search, { query: `distinct-${index}`, limit: 1 }));
    assertError(
      await drive(
        runToolContract(tools.search, {
          query: 'original',
          limit: 1,
          cursor: first.page.nextCursor,
        }),
      ),
      'cursor_expired',
      'Repeat usitc_search_hts without cursor to obtain current matches.',
    );
    expect(requests.filter((url) => url.searchParams.get('keyword') === 'original')).toHaveLength(
      1,
    );
  });

  it('rejects stale edition cursors for source rows, static references and release snapshots', async () => {
    const search = tools.search.output.parse(
      (await drive(runToolContract(tools.search, { query: 'battery', limit: 1 })))
        .structuredContent,
    );
    const reference = tools.reference.output.parse(
      (await drive(runToolContract(tools.reference, { topic: 'identifiers', limit: 1 })))
        .structuredContent,
    );
    const releases = tools.reference.output.parse(
      (await drive(runToolContract(tools.reference, { topic: 'releases', limit: 1 })))
        .structuredContent,
    );
    edition = 'edition-B';
    await vi.advanceTimersByTimeAsync(61_000);
    assertError(
      await drive(
        runToolContract(tools.search, {
          query: 'battery',
          limit: 1,
          cursor: search.page.nextCursor,
        }),
      ),
      'cursor_expired',
      'Repeat usitc_search_hts without cursor to obtain current matches.',
    );
    for (const [topic, cursor] of [
      ['identifiers', reference.page.nextCursor],
      ['releases', releases.page.nextCursor],
    ] as const)
      assertError(
        await drive(runToolContract(tools.reference, { topic, limit: 1, cursor })),
        'cursor_expired',
        'Repeat usitc_list_reference without cursor to obtain current reference entries.',
      );
  });

  it('rejects node IDs from another scope and edition on both error surfaces', async () => {
    const response = await drive(runToolContract(tools.heading, { code: '850780' }));
    const result = tools.heading.output.parse(response.structuredContent);
    assertError(
      await drive(
        runToolContract(tools.heading, { code: '85076000', nodeId: result.nodes[0]!.nodeId }),
      ),
      'invalid_cursor',
      'Repeat usitc_get_heading without cursor or nodeId to obtain current identifiers.',
    );
    assertError(
      await drive(
        runToolContract(tools.heading, { code: '8507', nodeId: 'old-edition:fixture:0' }),
      ),
      'cursor_expired',
      'Repeat usitc_get_heading without cursor or nodeId for a current snapshot.',
    );
  });

  it('invalid caller codes and country values preserve declared reasons and recovery', async () => {
    assertError(
      await drive(runToolContract(tools.heading, { code: '850' })),
      'invalid_code',
      'Call usitc_list_reference with topic identifiers and use a supported code.',
    );
    assertError(
      await drive(runToolContract(tools.browse, { chapter: '00' })),
      'invalid_code',
      'Call usitc_list_reference with topic chapters and use one chapter number.',
    );
    assertError(
      await drive(runToolContract(tools.duty, { code: '8507' })),
      'invalid_code',
      'Call usitc_get_heading with a four-digit heading to inspect valid rate numbers.',
    );
    assertError(
      await drive(runToolContract(tools.duty, { code: '85076000', countryCode: 'ZZ' })),
      'invalid_country',
      'Use an assigned two-letter ISO country code or omit countryCode.',
    );
  });

  it('schema-invalid limits return wire InvalidParams before any network request', async () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await drive(runToolContract(tools.search, { query: 'battery', limit }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(text(result)).toContain('usitc_search_hts');
    }
    expect(requests).toEqual([]);
  });

  it.each([501, 100_000])(
    'empty release references disclose clamping for limit %i',
    async (limit) => {
      releaseRecords = [];
      const response = await drive(runToolContract(tools.reference, { topic: 'releases', limit }));
      assertTwin(response);
      expect(response.structuredContent).toMatchObject({
        page: { total: 0, returned: 0, effectiveLimit: 100 },
        items: [],
      });
    },
  );

  it.each(['search', 'heading', 'browse', 'duty', 'reference'] as const)(
    '%s reports repeated edition transitions with its own declared recovery',
    async (kind) => {
      changingEdition = 0;
      const response =
        kind === 'search'
          ? await drive(runToolContract(tools.search, { query: 'battery' }))
          : kind === 'heading'
            ? await drive(runToolContract(tools.heading, { code: '8507' }))
            : kind === 'browse'
              ? await drive(runToolContract(tools.browse, { chapter: '85' }))
              : kind === 'duty'
                ? await drive(runToolContract(tools.duty, { code: '85076000' }))
                : await drive(runToolContract(tools.reference, { topic: 'releases' }));
      const recovery =
        kind === 'duty'
          ? 'Call usitc_list_reference with topic releases, then repeat the lookup.'
          : kind === 'reference'
            ? 'Repeat usitc_list_reference with topic releases and no cursor later.'
            : 'Call usitc_list_reference with topic releases, then repeat without cursor.';
      assertError(response, 'release_changed', recovery, JsonRpcErrorCode.Conflict);
    },
  );
});
