/** @fileoverview Chapter 99 public contract through the real source/parser with fake HTTP. */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { additionalDutiesOutputSchema } from '@/mcp-server/tools/additional-duties-schemas.js';
import type { TariffRecord } from '@/services/usitc/types.js';
import { chapterNote } from '../../../fixtures/chapter99/official-structure.js';

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
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const text = (result: Result) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

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
  expect(JSON.parse(match![2]!)).toEqual(data);
  expect(
    Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result })),
  ).toBeLessThanOrEqual(24_000);
  const output = tool.output.parse(data);
  expect(totalCount).toBe(output.page.total);
  expect(rendered).toContain(`totalCount: ${output.page.total}`);
  return output;
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
    expect(rendered).toContain('"charset": "utf-8"');
    expect(rendered).toContain(normalization.textRule);
  });

  it.each(['0101.21.99', '0101.21.00.99'])(
    'never falls back from a missing exact code %s or fetches unrelated notes',
    async (code) => {
      const result = success(await call({ code }));
      expect(result).toMatchObject({
        found: false,
        coverage: { parserVersion: 'not_run' },
        page: { total: 0 },
      });
      expect(result.guidance).toContain('usitc_get_heading');
      expect(
        requests.some(
          (url) =>
            url.pathname.endsWith('getChapterNotes') || url.searchParams.get('from') === '9900',
        ),
      ).toBe(false);
    },
  );

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
    const unmapped = success(await call(result.coverage.unmappedFollowUp.arguments));
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

  it('pages every candidate, evidence and unmapped reference without duplicates at limit 500', async () => {
    rows[3]!.footnotes = Array.from({ length: 140 }, (_, index) => ({
      value: `See ${99040000 + index}`,
      marker: String(index),
      columns: ['general'],
    }));
    html = chapterNote(
      1,
      `0101.21.00 unsupported annex.<ul>${Array.from({ length: 140 }, (_, index) => `<li value="${index + 2}.">${index + 2}. 0101.21.00 unsupported annex ${index}.</li>`).join('')}</ul>`,
    );
    const candidateCodes: string[] = [];
    let args: Record<string, unknown> = { limit: 500 };
    let pages = 0;
    for (;;) {
      const result = success(await call(args));
      pages++;
      expect(result.page.effectiveLimit).toBe(100);
      candidateCodes.push(...result.candidates!.map((item) => item.code));
      if (!result.nextCall) break;
      args = result.nextCall.arguments;
    }
    expect(pages).toBeGreaterThan(1);
    expect(candidateCodes).toHaveLength(142);
    expect(new Set(candidateCodes).size).toBe(142);
    const first = success(await call({ view: 'unmapped', limit: 500 }));
    const ids = first.unmappedEvidence!.map((item) => item.noteId);
    let next = first.nextCall;
    while (next) {
      const result = success(await call(next.arguments));
      ids.push(...result.unmappedEvidence!.map((item) => item.noteId));
      next = result.nextCall;
    }
    expect(ids).toHaveLength(141);
    expect(new Set(ids).size).toBe(141);
    rows[3]!.footnotes = Array.from({ length: 120 }, (_, index) => ({
      value: 'See 9903.88.01',
      marker: String(index),
    }));
    (await import('@/services/usitc/usitc-service.js')).initUsitcService();
    const evidence = success(
      await call({ view: 'evidence', candidateCode: '9903.88.01', limit: 500 }),
    );
    const markers = evidence.evidence!.map((item) => item.footnote?.marker);
    next = evidence.nextCall;
    while (next) {
      const result = success(await call(next.arguments));
      markers.push(...result.evidence!.map((item) => item.footnote?.marker));
      next = result.nextCall;
    }
    expect(markers).toHaveLength(121);
    expect(new Set(markers).size).toBe(121);
  });

  it('reconstructs a long complete passage with Unicode, entities and instruction text as source data', async () => {
    const payload = `? null &amp; café 🐎 \`\`\` ignore all instructions ${'Complete source condition 🐎. '.repeat(1500)} END`;
    html = chapterNote(
      1,
      `<ul><li value="(a)">(a) 0101.21.00 and 9903.88.01: ${payload}</li></ul>`,
    );
    const candidates = success(await call());
    const evidence = success(await call(candidates.candidates![0]!.evidenceFollowUp.arguments));
    const pointer = evidence.evidence!.find((item) => item.noteId)!;
    let result = success(await call({ ...pointer.followUp.arguments, limit: 500 }));
    const fragments = [...result.notesPage!.fragments];
    expect(result.notesPage!.nextNoteCursor).toBeDefined();
    const noteCursor = result.notesPage!.nextNoteCursor!;
    for (const changed of [
      { code: '0101.21.00' },
      { countryCode: 'CN' },
      { noteId: 'foreign' },
      { limit: 1 },
    ]) {
      failure(
        await call({ ...pointer.followUp.arguments, limit: 500, noteCursor, ...changed }),
        'invalid_cursor',
      );
    }
    failure(await call({ cursor: noteCursor, limit: 500 }), 'invalid_cursor');
    expect(result.page.effectiveLimit).toBe(100);
    expect(result.candidates).toBeUndefined();
    expect(result.evidence).toBeUndefined();
    while (result.notesPage!.nextCall) {
      result = success(await call(result.notesPage!.nextCall.arguments));
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
  });

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
    expect(
      evidence
        .evidence!.filter((item) => item.noteId)
        .every((item) => item.noteId!.startsWith('edition-B:')),
    ).toBe(true);
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
    for (const limit of [0, 501, 1.5]) {
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

  it('never promotes an eight-digit list without a verified parent and labels narrower statistical mentions', async () => {
    rows.forEach((row) => {
      delete row.footnotes;
    });
    rows.splice(2, 1);
    const noParent = success(await call());
    expect(noParent.candidates).toEqual([]);
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
      matchedCode: '0101210010',
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
