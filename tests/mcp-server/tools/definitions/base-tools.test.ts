/** @fileoverview Five public tariff contracts exercised through the real service and fake HTTP. */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TariffRecord } from '@/services/usitc/types.js';
import { baseRows } from '../../../fixtures/tariffs/base-rows.js';
import { drive, noticeOf, replyBytes, text } from '../../../fixtures/tool-harness.js';

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

/** The clamp disclosure, as a regex source, for a requested limit above the 100-item cap. */
function clampPattern(limit: number): string {
  return `Requested limit ${limit} was clamped to the 100-item page cap\\.`;
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
    ['2026HTSRev23', 'listed'],
    ['2026HTSRev24', 'unknown'],
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
    const result = tools.duty.output.parse(response.structuredContent);
    expect(result).toMatchObject({
      found: true,
      code: '8505.90.75',
      row: { htsno: '8505.90.75.01', sourceOrdinal: 1, rateLineCode: '8505.90.75' },
    });
    expect(result.row!.resolvedRates).toEqual({
      general: { state: 'published', text: 'Free' },
      special: { state: 'not_published' },
      column2: { state: 'not_published' },
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
    expect(heading.structuredContent).not.toHaveProperty(['sections', 0, 'nodeId']);
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
    const rawRows = z
      .object({ rows: z.array(z.record(z.string(), z.unknown())) })
      .parse(response.structuredContent).rows;
    expect(rawRows).toHaveLength(9);
    expect(rawRows.some((row) => 'nodeId' in row)).toBe(false);
    expect(text(response)).not.toContain('"nodeId"');
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
    expect(response.structuredContent).not.toHaveProperty('resolvedRates');
    expect(text(response).match(/"resolvedRates"/g)).toHaveLength(1);
    expect(result).toMatchObject({
      found: true,
      code: '8507.60.00.10',
      row: {
        resolvedRates: {
          general: { state: 'inherited', text: '3.4%', sourceHtsno: '8507.60.00' },
          special: { state: 'inherited', text: 'Free (A*, AU) 2% (ZZ)' },
          column2: { state: 'inherited', text: '35%' },
        },
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
      runToolContract(tools.heading, result.row!.resolvedRates.general.sourceFollowUp!.arguments),
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
    const overrideRates = tools.duty.output.parse(override.structuredContent).row!.resolvedRates;
    expect(overrideRates.general).toEqual({ state: 'published', text: '1.2%' });
    expect(overrideRates.column2).toEqual({ state: 'published', text: '40%' });
    expect(overrideRates.special).toEqual({
      state: 'inherited',
      text: 'Free (A*, AU) 2% (ZZ)',
      sourceNodeId: result.row!.resolvedRates.special.sourceNodeId,
      sourceHtsno: '8507.60.00',
      sourceFollowUp: {
        tool: 'usitc_get_heading',
        arguments: { code: '8507', nodeId: result.row!.resolvedRates.special.sourceNodeId },
      },
    });
    expect(requests.every((url) => !url.searchParams.has('countryCode'))).toBe(true);
  });

  it('does not invent Free or fall back from a nonexistent statistical suffix', async () => {
    const blank = await drive(runToolContract(tools.duty, { code: '8507800010' }));
    assertTwin(blank);
    expect(tools.duty.output.parse(blank.structuredContent).row!.resolvedRates).toEqual({
      general: { state: 'not_published' },
      special: { state: 'not_published' },
      column2: { state: 'not_published' },
    });
    const missing = await drive(runToolContract(tools.duty, { code: '8507600099' }));
    assertTwin(missing);
    expect(missing.structuredContent).toMatchObject({
      found: false,
      guidance:
        'No exact rate line or statistical number matched. Call usitc_get_heading with the containing 4-digit heading to inspect its valid descendants.',
    });
    expect(missing.structuredContent).not.toHaveProperty('notice');
    expect(text(missing)).not.toContain('notice:');
    expect(text(missing).match(/No exact rate line/g)).toHaveLength(1);
    expect(missing.structuredContent).not.toHaveProperty('row');
    expect(missing.structuredContent).not.toHaveProperty('resolvedRates');
  });

  it('keeps a captured long Special cell and every program annotation in one single-line JSON fence', async () => {
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
    const fenced = text(response).match(/\n(`{3,})json\n(.*)\n\1(?:\n|$)/);
    expect(fenced).not.toBeNull();
    expect(fenced![2]).not.toContain('\n');
    const {
      totalCount: _totalCount,
      notice: _notice,
      ...structured
    } = z.record(z.string(), z.unknown()).parse(response.structuredContent);
    expect(JSON.parse(fenced![2]!)).toEqual(structured);
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
      notice: expect.stringMatching(
        kind === 'heading'
          ? new RegExp(`^${clampPattern(limit)}$`)
          : new RegExp(`^No [^\\n]*usitc_[^\\n]*\\. ${clampPattern(limit)}$`),
      ),
    });
    if (kind === 'heading')
      expect(response.structuredContent).toMatchObject({
        found: false,
        guidance: expect.stringMatching(/^No classification matched this code/),
      });
    expect(text(response)).toContain(`notice: ${JSON.stringify(noticeOf(response))}`);
  });

  it.each(['identifiers', 'spi', 'chapters', 'units', 'releases'] as const)(
    'reference %s preserves typed fields and source provenance across every cursor',
    async (topic) => {
      const items: Array<Record<string, unknown>> = [];
      const decoders: unknown[] = [];
      let cursor: string | undefined;
      do {
        const response = await drive(
          runToolContract(tools.reference, { topic, limit: 2, ...(cursor && { cursor }) }),
        );
        assertTwin(response);
        const result = tools.reference.output.parse(response.structuredContent);
        const raw = z
          .object({ items: z.array(z.record(z.string(), z.unknown())) })
          .passthrough()
          .parse(response.structuredContent);
        items.push(...raw.items);
        if (topic === 'spi' || topic === 'units') decoders.push(raw.decoder);
        else expect(raw).not.toHaveProperty('decoder');
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
      const generalNote3 =
        'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203';
      if (topic === 'spi') {
        expect(items).toContainEqual({
          kind: 'program',
          symbol: 'AU',
          name: expect.any(String),
          countryListCoverage: 'unknown',
        });
        expect(items).toHaveLength(29);
        expect(
          items.every(
            (item) => Object.keys(item).join() === 'kind,symbol,name,countryListCoverage',
          ),
        ).toBe(true);
        expect(decoders).toHaveLength(15);
        for (const decoder of decoders)
          expect(decoder).toEqual({
            sourceEdition: '2026HTSRev21',
            citation: 'General Note 3(c)(i)',
            sourceUrl: generalNote3,
            conditionality:
              'All legal requirements of the program must be met; General Note 3(a)(iii).',
            qualificationNotice:
              'Program identification does not establish origin qualification, product eligibility, quota status, program availability or the legally applicable rate.',
          });
      }
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
      if (topic === 'units') {
        expect(items).toContainEqual({ kind: 'unit', symbol: 'kg', meaning: 'kilograms' });
        expect(items).toHaveLength(54);
        expect(items.every((item) => Object.keys(item).join() === 'kind,symbol,meaning')).toBe(
          true,
        );
        expect(decoders).toHaveLength(27);
        for (const decoder of decoders)
          expect(decoder).toEqual({
            sourceEdition: '2026HTSRev21',
            citation: 'General Note 3(g)',
            sourceUrl: generalNote3,
          });
      }
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

  it.each([
    { limit: 25, sizes: [25, 25, 25, 25, 20] },
    { limit: 100, sizes: [100, 20] },
    { limit: 500, sizes: [100, 20] },
    { limit: 501, sizes: [100, 20] },
    { limit: 100_000, sizes: [100, 20] },
  ])('search limit $limit pages heavy rows by limit alone', async ({ limit, sizes }) => {
    rows = Array.from({ length: 120 }, (_, index) => ({
      htsno: `8507.60.${String(index).padStart(2, '0')}`,
      indent: '0',
      description: `row-${index} ${'é🔋"'.repeat(80)}`,
      general: null,
      customSource: { ordinal: index },
    }));
    const ordinals: number[] = [];
    const returned: number[] = [];
    let cursor: string | undefined;
    do {
      const response = await drive(
        runToolContract(tools.search, { query: 'many', limit, ...(cursor && { cursor }) }),
      );
      assertTwin(response);
      if (!cursor) expect(replyBytes(response)).toBeGreaterThan(24_000);
      const result = tools.search.output.parse(response.structuredContent);
      expect(result.page).not.toHaveProperty('budgetLimited');
      expect(result.page.effectiveLimit).toBe(Math.min(limit, 100));
      if (limit > 100) expect(noticeOf(response)).toMatch(new RegExp(`^${clampPattern(limit)}$`));
      else expect(noticeOf(response)).toBeUndefined();
      returned.push(result.page.returned);
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
    expect(returned).toEqual(sizes);
    expect(ordinals).toEqual(Array.from({ length: 120 }, (_, index) => index));
  });

  it.each(
    (['heading', 'browse'] as const).flatMap((kind) =>
      [
        { limit: 25, sizes: [25, 25, 25, 25, 20] },
        { limit: 100, sizes: [100, 20] },
        { limit: 500, sizes: [100, 20] },
        { limit: 501, sizes: [100, 20] },
        { limit: 100_000, sizes: [100, 20] },
      ].map((entry) => ({ kind, ...entry })),
    ),
  )('$kind limit $limit pages a heavy forest by limit', async ({ kind, limit, sizes }) => {
    rows = Array.from({ length: 120 }, (_, index) => ({
      htsno: `9903.${String(Math.floor(index / 100)).padStart(2, '0')}.${String(index % 100).padStart(2, '0')}`,
      indent: '0',
      description: `Published root ${index}: ${'é🔋"'.repeat(kind === 'heading' ? 80 : 300)}`,
      general: '25%',
      special: '',
      other: '35%',
    }));
    const codes: string[] = [];
    const returned: number[] = [];
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
      if (!cursor) expect(replyBytes(response)).toBeGreaterThan(24_000);
      if (limit > 100) expect(noticeOf(response)).toMatch(new RegExp(`^${clampPattern(limit)}$`));
      else expect(noticeOf(response)).toBeUndefined();
      if (kind === 'heading') {
        const result = tools.heading.output.parse(response.structuredContent);
        expect(result.nodes.every((node) => !node.parentId)).toBe(true);
        expect(result.page).toMatchObject({ total: 120, effectiveLimit: Math.min(limit, 100) });
        expect(result.page).not.toHaveProperty('budgetLimited');
        returned.push(result.page.returned);
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
        expect(result.page).toMatchObject({ total: 120, effectiveLimit: Math.min(limit, 100) });
        expect(result.page).not.toHaveProperty('budgetLimited');
        returned.push(result.page.returned);
        codes.push(...result.headings.map((heading) => heading.code));
        cursor = result.page.nextCursor;
      }
      expect(codes.length).toBeLessThanOrEqual(120);
    } while (cursor);
    expect(returned).toEqual(sizes);
    expect(codes).toEqual(rows.map((row) => row.htsno));
  });

  it.each(
    (['identifiers', 'spi', 'chapters', 'units', 'releases'] as const).flatMap((topic) =>
      [25, 100, 500, 501, 100_000].map((limit) => ({ topic, limit })),
    ),
  )('reference $topic limit $limit pages by limit alone', async ({ topic, limit }) => {
    let cursor: string | undefined;
    const items: string[] = [];
    let total = 0;
    do {
      const response = await drive(
        runToolContract(tools.reference, { topic, limit, ...(cursor && { cursor }) }),
      );
      assertTwin(response);
      if (topic === 'chapters' && limit >= 100 && !cursor)
        expect(replyBytes(response)).toBeGreaterThan(24_000);
      const result = tools.reference.output.parse(response.structuredContent);
      const effectiveLimit = Math.min(limit, 100);
      expect(result.page.effectiveLimit).toBe(effectiveLimit);
      expect(result.page).not.toHaveProperty('budgetLimited');
      expect(result.items).toHaveLength(Math.min(effectiveLimit, result.page.total - items.length));
      if (limit > 100) expect(noticeOf(response)).toMatch(new RegExp(`^${clampPattern(limit)}$`));
      else expect(noticeOf(response)).toBeUndefined();
      total = result.page.total;
      items.push(...result.items.map((item) => JSON.stringify(item)));
      cursor = result.page.nextCursor;
      expect(items.length).toBeLessThanOrEqual(total);
    } while (cursor);
    expect(items).toHaveLength(total);
    expect(new Set(items).size).toBe(total);
  });

  it('reference spi and chapters return 25 and 99 items in one page each', async () => {
    const spi = tools.reference.output.parse(
      (await drive(runToolContract(tools.reference, { topic: 'spi', limit: 25 })))
        .structuredContent,
    );
    expect(spi.page).toMatchObject({ returned: 25, effectiveLimit: 25 });
    expect(spi.page.total).toBeGreaterThan(25);
    const chapters = tools.reference.output.parse(
      (await drive(runToolContract(tools.reference, { topic: 'chapters', limit: 100 })))
        .structuredContent,
    );
    expect(chapters.page).toEqual({ total: 99, returned: 99, effectiveLimit: 100 });
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
    const nextCursor = async (reply: Promise<CallToolResult>) =>
      z
        .object({ page: z.object({ nextCursor: z.string() }) })
        .parse((await drive(reply)).structuredContent).page.nextCursor;
    const headingCursor = await nextCursor(
      runToolContract(tools.heading, { code: '8507', limit: 1 }),
    );
    // A second heading gives chapter 85 a continuation; heading 8507 was read without it.
    rows.push({ htsno: '8508', indent: '0', description: 'Vacuum cleaners' });
    const referenceRecovery = 'Repeat usitc_list_reference without cursor for the desired topic.';
    for (const [definition, args, limitRecovery] of [
      [
        tools.heading,
        { code: '8507', cursor: headingCursor },
        'Repeat usitc_get_heading without cursor or nodeId to obtain current identifiers.',
      ],
      [
        tools.browse,
        {
          chapter: '85',
          cursor: await nextCursor(runToolContract(tools.browse, { chapter: '85', limit: 1 })),
        },
        'Repeat usitc_browse_chapter without cursor for the desired chapter.',
      ],
      [
        tools.reference,
        {
          topic: 'identifiers',
          cursor: await nextCursor(
            runToolContract(tools.reference, { topic: 'identifiers', limit: 1 }),
          ),
        },
        referenceRecovery,
      ],
      [
        tools.reference,
        {
          topic: 'releases',
          cursor: await nextCursor(
            runToolContract(tools.reference, { topic: 'releases', limit: 1 }),
          ),
        },
        referenceRecovery,
      ],
    ] as const)
      assertError(
        await drive(runToolContract(definition, { ...args, limit: 2 })),
        'invalid_cursor',
        limitRecovery,
        JsonRpcErrorCode.ValidationError,
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
    const invalid =
      'Repeat usitc_get_heading without cursor or nodeId to obtain current identifiers.';
    assertError(
      await drive(
        runToolContract(tools.heading, { code: '85076000', nodeId: result.nodes[0]!.nodeId }),
      ),
      'invalid_cursor',
      invalid,
    );
    const [, digest, ordinal] = result.nodes[0]!.nodeId.split(':');
    assertError(
      await drive(
        runToolContract(tools.heading, {
          code: '8507',
          nodeId: `old-edition:${digest}:${ordinal}`,
        }),
      ),
      'cursor_expired',
      'Repeat usitc_get_heading without cursor or nodeId for a current snapshot.',
    );
    for (const nodeId of [
      `edition-A:${'0123456789abcdef'.repeat(4)}:${ordinal}`,
      `old-edition:${'0123456789abcdef'.repeat(4)}:0`,
      'old-edition:fixture:0',
      `edition-A:${digest}:x`,
      `edition-A:${digest}:999`,
      `${digest}:${ordinal}`,
    ])
      assertError(
        await drive(runToolContract(tools.heading, { code: '8507', nodeId })),
        'invalid_cursor',
        invalid,
      );
  });

  it('mints release-local 12-hex node identities that every follow-up executes, with no 64-hex string on any reply', async () => {
    const nodeIdPattern = /^edition-A:[0-9a-f]{12}:(?:0|[1-9]\d*)$/;
    const replies: CallToolResult[] = [];
    const nodes: Array<z.infer<typeof tools.heading.output>['nodes'][number]> = [];
    let cursor: string | undefined;
    do {
      const response = await drive(
        runToolContract(tools.heading, { code: '8507', limit: 4, ...(cursor && { cursor }) }),
      );
      assertTwin(response);
      replies.push(response);
      const page = tools.heading.output.parse(response.structuredContent);
      expect(page.rootId).toMatch(nodeIdPattern);
      nodes.push(...page.nodes);
      cursor = page.page.nextCursor;
      expect(nodes.length).toBeLessThanOrEqual(9);
    } while (cursor);
    expect(nodes.map((node) => node.sourceOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const duty = await drive(
      runToolContract(tools.duty, { code: '8507600010', countryCode: 'CN' }),
    );
    assertTwin(duty);
    replies.push(duty);
    const dutyRow = tools.duty.output.parse(duty.structuredContent).row!;
    const search = await drive(runToolContract(tools.search, { query: 'battery', limit: 2 }));
    assertTwin(search);
    replies.push(search);
    const followUps = new Map<string, { code: string; nodeId: string }>();
    for (const node of [...nodes, dutyRow]) {
      expect(node.nodeId).toMatch(nodeIdPattern);
      followUps.set(node.nodeId, { code: '8507', nodeId: node.nodeId });
      if (node.parentId) {
        expect(node.parentId).toMatch(nodeIdPattern);
        expect(node.parentFollowUp).toEqual({
          tool: 'usitc_get_heading',
          arguments: { code: '8507', nodeId: node.parentId },
        });
        followUps.set(node.parentId, node.parentFollowUp!.arguments);
      }
      for (const column of Object.values(node.resolvedRates)) {
        if (column.state !== 'inherited') continue;
        expect(column.sourceNodeId).toMatch(nodeIdPattern);
        expect(column.sourceFollowUp).toEqual({
          tool: 'usitc_get_heading',
          arguments: { code: '8507', nodeId: column.sourceNodeId },
        });
        followUps.set(column.sourceNodeId!, column.sourceFollowUp!.arguments);
      }
    }
    expect(followUps.size).toBe(9);
    for (const args of followUps.values()) {
      const response = await drive(runToolContract(tools.heading, args));
      assertTwin(response);
      replies.push(response);
      const selected = tools.heading.output.parse(response.structuredContent);
      expect(selected.nodes.map((node) => node.nodeId)).toEqual([args.nodeId]);
    }
    for (const reply of replies) {
      expect(JSON.stringify(reply)).not.toMatch(/[0-9a-f]{64}/);
      const next = z
        .object({ page: z.object({ nextCursor: z.string().optional() }).optional() })
        .parse(reply.structuredContent).page?.nextCursor;
      if (next) expect(Buffer.from(next, 'base64url').toString('utf8')).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it('never lets an ID from an earlier export body select a row of a later body in the same edition', async () => {
    const before = tools.heading.output.parse(
      (await drive(runToolContract(tools.heading, { code: '8507.60.00' }))).structuredContent,
    );
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    rows[2]!.description = 'Corrected within the same edition';
    const after = tools.heading.output.parse(
      (await drive(runToolContract(tools.heading, { code: '8507.60.00' }))).structuredContent,
    );
    expect(after.release.name).toBe(before.release.name);
    expect(after.nodes[0]!.description).toBe('Corrected within the same edition');
    expect(after.nodes[0]!.sourceOrdinal).toBe(before.nodes[0]!.sourceOrdinal);
    expect(after.nodes[0]!.nodeId).not.toBe(before.nodes[0]!.nodeId);
    assertError(
      await drive(
        runToolContract(tools.heading, { code: '8507.60.00', nodeId: before.nodes[0]!.nodeId }),
      ),
      'invalid_cursor',
      'Repeat usitc_get_heading without cursor or nodeId to obtain current identifiers.',
    );
  });

  it.each(['8507.60.00.10', '8507600010', '8507.60.0010'])(
    'heading accepts the ten-digit form %s and returns that node with a parent follow-up into the heading',
    async (code) => {
      const response = await drive(runToolContract(tools.heading, { code }));
      assertTwin(response);
      const result = tools.heading.output.parse(response.structuredContent);
      expect(result).toMatchObject({
        code: '8507.60.00.10',
        found: true,
        page: { total: 1, returned: 1 },
      });
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]).toMatchObject({
        htsno: '8507.60.00.10',
        rateLineCode: '8507.60.00',
        parentFollowUp: { tool: 'usitc_get_heading', arguments: { code: '8507' } },
      });
      expect(result.rootId).toBe(result.nodes[0]!.nodeId);
      const parent = await drive(
        runToolContract(tools.heading, result.nodes[0]!.parentFollowUp!.arguments),
      );
      assertTwin(parent);
      expect(tools.heading.output.parse(parent.structuredContent).nodes).toEqual([
        expect.objectContaining({
          nodeId: result.nodes[0]!.parentId,
          description: 'Unnamed superior',
          sourceOrdinal: 3,
        }),
      ]);
    },
  );

  it('heading returns a ten-digit node with its indented descendants and keeps ten-digit cursors bound', async () => {
    rows = [
      { htsno: '8507', indent: '0', description: 'Root' },
      { htsno: '8507.60.00', indent: '1', description: 'Rate line', general: '3.4%' },
      { htsno: '8507.60.00.30', indent: '2', description: 'Statistical' },
      { indent: '3', description: 'Unnamed child', superior: 'true' },
      { indent: '4', description: 'Unnamed grandchild' },
      { htsno: '8507.60.00.40', indent: '2', description: 'Sibling' },
    ];
    const first = await drive(runToolContract(tools.heading, { code: '8507600030', limit: 2 }));
    assertTwin(first);
    const page = tools.heading.output.parse(first.structuredContent);
    expect(page.page).toMatchObject({ total: 3, returned: 2 });
    const next = await drive(
      runToolContract(tools.heading, {
        code: '8507.60.00.30',
        limit: 2,
        cursor: page.page.nextCursor,
      }),
    );
    assertTwin(next);
    const rest = tools.heading.output.parse(next.structuredContent);
    expect([...page.nodes, ...rest.nodes].map((node) => node.description)).toEqual([
      'Statistical',
      'Unnamed child',
      'Unnamed grandchild',
    ]);
    expect(rest.nodes[0]!.parentId).toBe(page.nodes[1]!.nodeId);
    assertError(
      await drive(
        runToolContract(tools.heading, {
          code: '8507.60.00.40',
          limit: 2,
          cursor: page.page.nextCursor,
        }),
      ),
      'invalid_cursor',
      'Repeat usitc_get_heading without cursor or nodeId to obtain current identifiers.',
    );
  });

  it.each([10, 500])(
    'heading reports an unpublished ten-digit code as a miss with guidance only at limit %i',
    async (limit) => {
      const response = await drive(
        runToolContract(tools.heading, { code: '8507.60.00.99', limit }),
      );
      assertTwin(response);
      expect(response.structuredContent).toMatchObject({
        code: '8507.60.00.99',
        found: false,
        nodes: [],
        page: { total: 0, returned: 0 },
        guidance:
          'No classification matched this code in this edition. Call usitc_browse_chapter for its chapter, or usitc_search_hts with a broader code prefix.',
      });
      expect(response.structuredContent).not.toHaveProperty('rootId');
      expect(text(response).match(/No classification matched/g)).toHaveLength(1);
      if (limit > 100) expect(noticeOf(response)).toMatch(new RegExp(`^${clampPattern(limit)}$`));
      else {
        expect(noticeOf(response)).toBeUndefined();
        expect(text(response)).not.toContain('notice:');
      }
    },
  );

  it('invalid caller codes and country values preserve declared reasons and recovery', async () => {
    for (const chapter of ['0', '00'])
      assertError(
        await drive(runToolContract(tools.browse, { chapter })),
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

  it('accepts padded, integer and blank optional identifiers on every tool that takes them', async () => {
    const heading = await drive(runToolContract(tools.heading, { code: '\t8507.60\n' }));
    assertTwin(heading);
    expect(tools.heading.output.parse(heading.structuredContent).code).toBe('8507.60');
    // The wire can carry an integer; the framework repairs it to its decimal string first.
    const duty = await drive(
      runToolContract(tools.duty, { code: 8507600030, countryCode: '   ' } as unknown as {
        code: string;
      }),
    );
    assertTwin(duty);
    const lookup = tools.duty.output.parse(duty.structuredContent);
    expect(lookup.code).toBe('8507.60.00.30');
    expect(lookup.countryAssessment).not.toHaveProperty('countryCode');
    const country = await drive(
      runToolContract(tools.duty, { code: '85076000', countryCode: ' cn ' }),
    );
    assertTwin(country);
    expect(tools.duty.output.parse(country.structuredContent).countryAssessment.countryCode).toBe(
      'CN',
    );
    rows = [];
    for (const [chapter, normalized] of [
      [1, '01'],
      [' 85 ', '85'],
    ] as const) {
      const browse = await drive(
        runToolContract(tools.browse, { chapter } as unknown as { chapter: string }),
      );
      assertTwin(browse);
      expect(tools.browse.output.parse(browse.structuredContent).chapter).toBe(normalized);
    }
  });

  const codeMessage =
    'Write the code as 4, 6, 8 or 10 digits, bare or dotted at the conventional HTS boundaries: 8507, 8507.60, 8507.60.00, 8507.60.00.30 or 8507.60.0030.';
  it.each([
    {
      name: 'heading code "8507 60"',
      call: () => runToolContract(tools.heading, { code: '8507 60' }),
      hint: `code: ${codeMessage}`,
    },
    {
      name: 'heading code "850"',
      call: () => runToolContract(tools.heading, { code: '850' }),
      hint: `code: ${codeMessage}`,
    },
    {
      name: 'duty code "8507-60"',
      call: () => runToolContract(tools.duty, { code: '8507-60' }),
      hint: `code: ${codeMessage}`,
    },
    {
      name: 'duty countryCode "ıt"',
      call: () => runToolContract(tools.duty, { code: '85076000', countryCode: 'ıt' }),
      hint: 'countryCode: Use a two-letter ISO 3166-1 alpha-2 country code such as CN or DE, or omit countryCode.',
    },
    {
      name: 'browse chapter "100"',
      call: () => runToolContract(tools.browse, { chapter: '100' }),
      hint: 'chapter: Use a chapter number from 01 through 99, written as one or two digits (8, 08 or 85).',
    },
    {
      name: 'search query ""',
      call: () => runToolContract(tools.search, { query: '' }),
      hint: 'query: Supply nonblank commodity text or an HTS code prefix.',
    },
    {
      name: 'search query "   "',
      call: () => runToolContract(tools.search, { query: '   ' }),
      hint: 'query: Supply nonblank commodity text or an HTS code prefix.',
    },
    {
      name: 'search codePrefix "6"',
      call: () => runToolContract(tools.search, { query: 'cotton', codePrefix: '6' }),
      hint: 'codePrefix: Use a two-digit chapter or a four-, six- or eight-digit code, bare or dotted (61, 6109, 6109.10 or 6109.10.00), or omit codePrefix.',
    },
  ])(
    'rejects $name at the schema with the pattern message on both surfaces',
    async ({ call, hint }) => {
      assertError(await drive(call()), 'invalid_arguments', hint, JsonRpcErrorCode.InvalidParams);
      expect(requests).toEqual([]);
    },
  );

  it('advertises every identifier format as a pattern and query without minLength', () => {
    const property = (definition: (typeof tools)[keyof typeof tools], name: string) =>
      z.toJSONSchema(definition.input).properties?.[name];
    const code = String.raw`^\s*(?:\d{4}(?:\d{2}){0,3}|\d{4}\.\d{2}(?:\.\d{2}){0,2}|\d{4}\.\d{2}\.\d{4})\s*$`;
    expect(property(tools.heading, 'code')).toMatchObject({ type: 'string', pattern: code });
    expect(property(tools.duty, 'code')).toMatchObject({ type: 'string', pattern: code });
    expect(property(tools.duty, 'countryCode')).toMatchObject({
      type: 'string',
      pattern: String.raw`^\s*(?:[A-Za-z]{2}\s*)?$`,
    });
    expect(property(tools.browse, 'chapter')).toMatchObject({
      type: 'string',
      pattern: String.raw`^\s*\d{1,2}\s*$`,
    });
    expect(property(tools.search, 'query')).toMatchObject({
      type: 'string',
      pattern: String.raw`\S`,
    });
    expect(property(tools.search, 'query')).not.toHaveProperty('minLength');
    expect(property(tools.search, 'codePrefix')).toMatchObject({
      type: 'string',
      pattern: String.raw`^\s*(?:(?:\d{2}|\d{4}(?:\d{2}){0,2}|\d{4}\.\d{2}(?:\.\d{2})?)\s*)?$`,
    });
  });

  /** Flat keyword matches across chapters 25, 61 and 62, one of them unnumbered. */
  const prefixRows = (): TariffRecord[] => [
    { htsno: '2501.00.00.00', indent: '0', description: 'Salt', units: ['t'] },
    { htsno: '6105.10.00', indent: '1', description: 'Shirts of cotton' },
    { htsno: '6109', indent: '0', description: 'T-shirts' },
    { htsno: '6109.10.00', indent: '1', description: 'Of cotton' },
    { htsno: '6109.10.00.04', indent: '2', description: 'Men’s or boys’' },
    { indent: '1', description: 'Unnumbered cotton match' },
    { htsno: '6109.90.10', indent: '1', description: 'Of other textile materials' },
    { htsno: '6110.20.20', indent: '2', description: 'Cotton sweaters' },
    { htsno: '6205.20.20', indent: '2', description: 'Cotton shirts' },
  ];
  const htsnos = (result: CallToolResult) =>
    tools.search.output.parse(result.structuredContent).rows.map((row) => row.htsno);

  it('codePrefix filters the cached match set before counting and echoes the canonical prefix', async () => {
    rows = prefixRows();
    const all = await drive(runToolContract(tools.search, { query: 'cotton t-shirts' }));
    assertTwin(all);
    expect(all.structuredContent).toMatchObject({ page: { total: 9 }, totalCount: 9 });
    expect(all.structuredContent).not.toHaveProperty('codePrefix');
    for (const [codePrefix, canonical, expected] of [
      ['6109', '6109', ['6109', '6109.10.00', '6109.10.00.04', '6109.90.10']],
      [
        ' 61 ',
        '61',
        ['6105.10.00', '6109', '6109.10.00', '6109.10.00.04', '6109.90.10', '6110.20.20'],
      ],
      ['61091000', '6109.10.00', ['6109.10.00', '6109.10.00.04']],
    ] as const) {
      const response = await drive(
        runToolContract(tools.search, { query: 'cotton t-shirts', codePrefix }),
      );
      assertTwin(response);
      expect(response.structuredContent).toMatchObject({
        query: 'cotton t-shirts',
        codePrefix: canonical,
        page: { total: expected.length, returned: expected.length },
        totalCount: expected.length,
      });
      expect(text(response)).toContain(`totalCount: ${expected.length}`);
      expect(htsnos(response)).toEqual(expected);
    }
    const searches = requests.filter((url) => url.pathname.endsWith('search'));
    expect(searches.map((url) => url.search)).toEqual(['?keyword=cotton+t-shirts']);
  });

  it('a blank codePrefix behaves exactly like an omitted one, cursor included', async () => {
    rows = prefixRows();
    for (const codePrefix of ['', '   ']) {
      const blank = await drive(
        runToolContract(tools.search, { query: 'cotton t-shirts', codePrefix, limit: 5 }),
      );
      assertTwin(blank);
      const result = tools.search.output.parse(blank.structuredContent);
      expect(result).not.toHaveProperty('codePrefix');
      expect(result.page).toMatchObject({ total: 9, returned: 5 });
      const next = await drive(
        runToolContract(tools.search, {
          query: 'cotton t-shirts',
          limit: 5,
          cursor: result.page.nextCursor,
        }),
      );
      assertTwin(next);
      expect(htsnos(next)).toEqual([undefined, '6109.90.10', '6110.20.20', '6205.20.20']);
    }
  });

  it('a codePrefix cursor continues the filtered rows and rejects a changed or dropped prefix', async () => {
    rows = prefixRows();
    const first = tools.search.output.parse(
      (
        await drive(
          runToolContract(tools.search, { query: 'cotton t-shirts', codePrefix: '61', limit: 4 }),
        )
      ).structuredContent,
    );
    expect(first.page).toMatchObject({ total: 6, returned: 4, nextCursor: expect.any(String) });
    const next = await drive(
      runToolContract(tools.search, {
        query: 'cotton t-shirts',
        codePrefix: '61',
        limit: 4,
        cursor: first.page.nextCursor,
      }),
    );
    assertTwin(next);
    expect(htsnos(next)).toEqual(['6109.90.10', '6110.20.20']);
    expect(tools.search.output.parse(next.structuredContent).page).toEqual({
      total: 6,
      returned: 2,
      effectiveLimit: 4,
    });
    for (const changed of [{ codePrefix: '6109' }, { codePrefix: '6100' }, {}])
      assertError(
        await drive(
          runToolContract(tools.search, {
            query: 'cotton t-shirts',
            limit: 4,
            ...changed,
            cursor: first.page.nextCursor,
          }),
        ),
        'invalid_cursor',
        'Repeat usitc_search_hts without cursor using the desired query.',
        JsonRpcErrorCode.ValidationError,
      );
  });

  it('a filtered continuation leaves the cached match set whole for a later unfiltered search', async () => {
    rows = prefixRows();
    const first = tools.search.output.parse(
      (
        await drive(
          runToolContract(tools.search, { query: 'cotton t-shirts', codePrefix: '61', limit: 4 }),
        )
      ).structuredContent,
    );
    assertTwin(
      await drive(
        runToolContract(tools.search, {
          query: 'cotton t-shirts',
          codePrefix: '61',
          limit: 4,
          cursor: first.page.nextCursor,
        }),
      ),
    );
    const all = await drive(runToolContract(tools.search, { query: 'cotton t-shirts' }));
    assertTwin(all);
    expect(all.structuredContent).toMatchObject({ page: { total: 9, returned: 9 }, totalCount: 9 });
    expect(text(all)).toContain('totalCount: 9');
    expect(htsnos(all)).toEqual(prefixRows().map((row) => row.htsno));
    const searches = requests.filter((url) => url.pathname.endsWith('search'));
    expect(searches.map((url) => url.search)).toEqual(['?keyword=cotton+t-shirts']);
  });

  it('a codePrefix matching nothing is an empty success whose notice names the prefix', async () => {
    rows = prefixRows();
    const notice =
      'No published matches were found under code prefix 73. Broaden query, remove codePrefix, or call usitc_browse_chapter for chapter 73.';
    const response = await drive(
      runToolContract(tools.search, { query: 'cotton t-shirts', codePrefix: '73' }),
    );
    assertTwin(response);
    expect(response.structuredContent).toMatchObject({
      rows: [],
      codePrefix: '73',
      page: { total: 0, returned: 0 },
      totalCount: 0,
      notice,
    });
    expect(text(response)).toContain(`notice: ${JSON.stringify(notice)}`);
    const clamped = await drive(
      runToolContract(tools.search, {
        query: 'cotton t-shirts',
        codePrefix: '7304.19',
        limit: 501,
      }),
    );
    assertTwin(clamped);
    expect(noticeOf(clamped)).toBe(
      'No published matches were found under code prefix 7304.19. Broaden query, remove codePrefix, or call usitc_browse_chapter for chapter 73. Requested limit 501 was clamped to the 100-item page cap.',
    );
  });

  it('a codePrefix in chapter 00 never points at a chapter usitc_browse_chapter rejects', async () => {
    rows = prefixRows();
    for (const codePrefix of ['00', '0000.10']) {
      const response = await drive(
        runToolContract(tools.search, { query: 'cotton t-shirts', codePrefix }),
      );
      assertTwin(response);
      expect(noticeOf(response)).toBe(
        `No published matches were found under code prefix ${codePrefix}. Broaden query or remove codePrefix.`,
      );
    }
    const browse = await drive(runToolContract(tools.browse, { chapter: '00' }));
    expect(browse.isError).toBe(true);
  });

  it('schema-invalid limits return wire InvalidParams before any network request', async () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const [definition, args] of [
        [tools.search, { query: 'battery' }],
        [tools.heading, { code: '8507' }],
        [tools.browse, { chapter: '85' }],
        [tools.reference, { topic: 'spi' }],
      ] as const) {
        const result = await drive(runToolContract(definition, { ...args, limit }));
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expect(text(result)).toContain(definition.name);
      }
    }
    expect(requests).toEqual([]);
  });

  it.each([
    { kind: 'search', defaultLimit: 25 },
    { kind: 'heading', defaultLimit: 10 },
    { kind: 'browse', defaultLimit: 25 },
    { kind: 'reference', defaultLimit: 25 },
  ] as const)('$kind defaults to $defaultLimit items per page', async ({ kind, defaultLimit }) => {
    rows = Array.from({ length: 40 }, (_, index) => ({
      htsno: `9903.01.${String(index).padStart(2, '0')}`,
      indent: '0',
      description: `Published root ${index}`,
    }));
    const definition = tools[kind];
    const response =
      kind === 'search'
        ? await drive(runToolContract(tools.search, { query: '9903' }))
        : kind === 'heading'
          ? await drive(runToolContract(tools.heading, { code: '9903' }))
          : kind === 'browse'
            ? await drive(runToolContract(tools.browse, { chapter: '99' }))
            : await drive(runToolContract(tools.reference, { topic: 'chapters' }));
    assertTwin(response);
    expect(response.structuredContent).toMatchObject({
      page: {
        returned: defaultLimit,
        effectiveLimit: defaultLimit,
        nextCursor: expect.any(String),
      },
    });
    expect(noticeOf(response)).toBeUndefined();
    const limitField = z.toJSONSchema(definition.input).properties?.limit;
    expect(limitField).toMatchObject({
      default: defaultLimit,
      description: `Default ${defaultLimit}; a larger value returns at most 100 items and says so. Keep the same limit when continuing with a cursor.`,
    });
  });

  it('returns one source row larger than 24,000 bytes whole on both surfaces', async () => {
    const description = `Oversized ${'é🔋"'.repeat(9_000)}`;
    rows = [{ htsno: '9903.01.01', indent: '0', description, general: '25%' }];
    const response = await drive(runToolContract(tools.heading, { code: '9903' }));
    assertTwin(response);
    expect(replyBytes(response)).toBeGreaterThan(100_000);
    const result = tools.heading.output.parse(response.structuredContent);
    expect(result.page).toEqual({ total: 1, returned: 1, effectiveLimit: 10 });
    expect(result.nodes[0]!.description).toBe(description);
  });

  it('declares no budgetLimited field on any output schema', () => {
    for (const definition of Object.values(tools))
      expect(JSON.stringify(z.toJSONSchema(definition.output))).not.toContain('budgetLimited');
  });

  it('binds cursors with 16-hex argument and source digests; reference cursors hold no 64-hex string', async () => {
    const decode = (cursor: string | undefined) =>
      z
        .object({ v: z.number(), argumentsDigest: z.string(), digest: z.string() })
        .passthrough()
        .parse(JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8')));
    const search = tools.search.output.parse(
      (await drive(runToolContract(tools.search, { query: 'battery', limit: 1 })))
        .structuredContent,
    );
    expect(decode(search.page.nextCursor)).toMatchObject({
      v: 2,
      argumentsDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
      digest: expect.stringMatching(/^[0-9a-f]{16}$/),
      snapshotId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    const heading = tools.heading.output.parse(
      (await drive(runToolContract(tools.heading, { code: '8507', limit: 1 }))).structuredContent,
    );
    for (const cursor of [search.page.nextCursor, heading.page.nextCursor])
      expect(JSON.stringify(decode(cursor))).not.toMatch(/[0-9a-f]{64}/);
    for (const topic of ['spi', 'releases'] as const) {
      const reference = tools.reference.output.parse(
        (await drive(runToolContract(tools.reference, { topic, limit: 1 }))).structuredContent,
      );
      const decoded = decode(reference.page.nextCursor);
      expect(decoded).toMatchObject({
        argumentsDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
        digest: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(JSON.stringify(decoded)).not.toMatch(/[0-9a-f]{64}/);
    }
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
        notice: expect.stringMatching(
          new RegExp(`^No entries were found for this topic[^\\n]*\\. ${clampPattern(limit)}$`),
        ),
      });
    },
  );

  it('discloses the clamp on first and continuation pages, and never at limit 100', async () => {
    rows = Array.from({ length: 130 }, (_, index) => ({
      htsno: `9903.${String(Math.floor(index / 100)).padStart(2, '0')}.${String(index % 100).padStart(2, '0')}`,
      indent: '0',
      description: `Published root ${index}`,
    }));
    const first = await drive(runToolContract(tools.search, { query: '9903', limit: 500 }));
    assertTwin(first);
    expect(noticeOf(first)).toBe('Requested limit 500 was clamped to the 100-item page cap.');
    expect(text(first)).toContain(
      'notice: "Requested limit 500 was clamped to the 100-item page cap."',
    );
    const page = tools.search.output.parse(first.structuredContent).page;
    expect(page).toMatchObject({ returned: 100, effectiveLimit: 100 });
    const next = await drive(
      runToolContract(tools.search, { query: '9903', limit: 500, cursor: page.nextCursor }),
    );
    assertTwin(next);
    expect(noticeOf(next)).toBe('Requested limit 500 was clamped to the 100-item page cap.');
    expect(tools.search.output.parse(next.structuredContent).page).toMatchObject({
      returned: 30,
      effectiveLimit: 100,
    });
    const atCap = await drive(runToolContract(tools.search, { query: '9903', limit: 100 }));
    expect(noticeOf(atCap)).toBeUndefined();
    expect(text(atCap)).not.toContain('clamped');
  });

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
