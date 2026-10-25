/**
 * @fileoverview HTTP-boundary coverage of USITC editions, decoding and snapshots.
 * @module tests/services/usitc/usitc-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsitcDependencies } from '@/services/usitc/usitc-service.js';

const row = { htsno: '8507.60.00', indent: '0', description: 'Lithium-ion batteries' };
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

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

async function setup(handler?: NonNullable<UsitcDependencies['fetch']>) {
  const { UsitcService } = await import('@/services/usitc/usitc-service.js');
  const requests: Array<{ url: URL; at: number }> = [];
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    requests.push({ url: new URL(url), at: Date.now() });
    if (handler) return handler(url, init);
    if (url.pathname.endsWith('currentRelease')) return json({ name: 'edition-A' });
    if (url.pathname.endsWith('releaseList')) return json([{ name: 'edition-A' }]);
    return json([row]);
  });
  return {
    service: new UsitcService({ fetch, now: Date.now }),
    requests,
    fetch,
    ctx: createMockContext(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.resetModules();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('USITC source boundary', () => {
  it('serializes concurrent operations across service instances', async () => {
    let active = 0;
    let maximum = 0;
    const { service, ctx } = await setup(async (url) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      active--;
      return url.pathname.endsWith('currentRelease') ? json({ name: 'A' }) : json([]);
    });
    const { service: other } = await setup(async (url) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      active--;
      return url.pathname.endsWith('currentRelease') ? json({ name: 'A' }) : json([]);
    });
    await drive(Promise.all([service.getCurrentRelease(ctx), other.getCurrentRelease(ctx)]));
    expect(maximum).toBe(1);
  });

  it.each(['search', 'heading', 'chapter'] as const)(
    'rejects invalid %s input with its stable reason',
    async (kind) => {
      const { service, ctx } = await setup();
      const operation =
        kind === 'search'
          ? service.search('  ', ctx)
          : kind === 'heading'
            ? service.getHeading('8507.60', ctx)
            : service.getChapter('00', ctx);
      await expect(drive(operation)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: kind === 'search' ? 'invalid_query' : 'invalid_code' },
      });
    },
  );

  it('constructs only confirmed query keys and includes the final chapter suffix', async () => {
    const { service, requests, ctx } = await setup();
    await drive(service.search(' battery & cells ', ctx));
    await drive(service.getHeading('8507', ctx));
    await drive(service.getChapter('85', ctx));
    expect(
      requests.filter(({ url }) => url.pathname.endsWith('search')).map(({ url }) => url.search),
    ).toEqual(['?keyword=battery+%26+cells']);
    expect(
      requests
        .filter(({ url }) => url.pathname.endsWith('exportList'))
        .map(({ url }) => Object.fromEntries(url.searchParams)),
    ).toEqual([
      { from: '8507', to: '8507.99.99.99', format: 'JSON', styles: 'false' },
      { from: '8500', to: '8599.99.99.99', format: 'JSON', styles: 'false' },
    ]);
    expect(requests.every(({ url }) => url.origin === 'https://hts.usitc.gov')).toBe(true);
    for (let index = 1; index < requests.length; index++)
      expect(requests[index]!.at - requests[index - 1]!.at).toBeGreaterThanOrEqual(1000);
  });

  it('preserves omitted/null fields, unnamed rows, footnotes and distinct duty spellings', async () => {
    const { service, ctx } = await setup(async (url) => {
      if (url.pathname.endsWith('currentRelease'))
        return json({ name: 'edition-A', description: null });
      if (url.pathname.endsWith('releaseList'))
        return json([{ name: 'edition-A', description: 'fallback', releaseStartDate: null }]);
      return json([
        {
          ...row,
          general: null,
          units: null,
          footnotes: [{ value: 'Published note', marker: '*', columns: ['general'] }],
          additionalDuties: 'one',
          addiitionalDuties: 'two',
          custom: { nested: null },
          hasHighlight: true,
        },
        { indent: '1', description: 'Unnamed', superior: 'true' },
      ]);
    });
    const result = await drive(service.getHeading('8507', ctx));
    expect(result.release).toMatchObject({
      name: 'edition-A',
      description: null,
      effectiveDate: null,
    });
    expect(result.release).not.toHaveProperty('status');
    expect(result.data.rows[0]).toMatchObject({
      sourceOrdinal: 0,
      publishedRates: { general: null },
      units: null,
      additionalDuties: 'one',
      addiitionalDuties: 'two',
      sourceFields: { custom: { nested: null } },
      footnotes: [{ marker: '*' }],
    });
    expect(result.data.rows[0]!.sourceFields).not.toHaveProperty('hasHighlight');
    expect(result.data.rows[1]).not.toHaveProperty('htsno');
    expect(result.data.rows[1]!.publishedRates).toEqual({});
    expect(result.notices.some((notice) => notice.includes('conflicting'))).toBe(true);
  });

  it('returns empty arrays as successful misses', async () => {
    const { service, ctx } = await setup(async (url) =>
      url.pathname.endsWith('currentRelease') ? json({ name: 'A' }) : json([]),
    );
    expect((await drive(service.search('no matches', ctx))).data.rows).toEqual([]);
    expect((await drive(service.getHeading('7701', ctx))).data.rows).toEqual([]);
  });

  it.each(['{', '{}', '[{"indent":"bad","description":"x"}]'])(
    'does not retry complete invalid JSON/schema body %s',
    async (body) => {
      const { service, fetch, ctx } = await setup(async () => new Response(body));
      await expect(drive(service.getCurrentRelease(ctx))).rejects.toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        data: { retryable: false },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects HTML rather than treating it as source data', async () => {
    const { service, ctx } = await setup(
      async () => new Response('<!doctype html><html>Unavailable</html>'),
    );
    await expect(drive(service.getCurrentRelease(ctx))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('classifies HTTP 400 as fixed-construction failure and never retries', async () => {
    const { service, fetch, ctx } = await setup(
      async () => new Response('{"status":400}', { status: 400 }),
    );
    await expect(drive(service.getCurrentRelease(ctx))).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { retryable: false, endpoint: 'currentRelease' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'retries transient HTTP %i then succeeds',
    async (status) => {
      let attempt = 0;
      const { service, requests, ctx } = await setup(async (url) => {
        if (attempt++ === 0) return new Response('', { status, headers: { 'retry-after': '2' } });
        return url.pathname.endsWith('currentRelease') ? json({ name: 'A' }) : json([]);
      });
      expect((await drive(service.getCurrentRelease(ctx))).release.name).toBe('A');
      expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(2000);
    },
  );

  it('retries a truncated response body at the fetch boundary', async () => {
    let attempt = 0;
    const { service, fetch, ctx } = await setup(async (url) => {
      if (attempt++ === 0)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('socket closed'));
            },
          }),
        );
      return url.pathname.endsWith('currentRelease') ? json({ name: 'A' }) : json([]);
    });
    expect((await drive(service.getCurrentRelease(ctx))).release.name).toBe('A');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('honors caller cancellation during a stalled body and stops requests', async () => {
    const aborter = new AbortController();
    let cancelled = false;
    const { service, fetch } = await setup(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const reason = new DOMException('Caller stopped', 'AbortError');
    const pending = service.getCurrentRelease(createMockContext({ signal: aborter.signal }));
    const check = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1);
    aborter.abort(reason);
    await check;
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled bodies by the total operation deadline', async () => {
    const { service, ctx } = await setup(async () => new Response(new ReadableStream()));
    await expect(drive(service.getCurrentRelease(ctx))).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'operation_deadline_exceeded' },
    });
  });

  it('returns RateLimited when Retry-After exceeds the remaining operation budget', async () => {
    const { service, fetch, ctx } = await setup(
      async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    );
    await expect(drive(service.getCurrentRelease(ctx))).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { retryAfter: '120', retryable: true },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued operation without starting its HTTP request', async () => {
    const { service, fetch, ctx } = await setup(async (url) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      return url.pathname.endsWith('currentRelease') ? json({ name: 'A' }) : json([]);
    });
    const first = service.getCurrentRelease(ctx);
    const controller = new AbortController();
    const reason = new DOMException('Stop queued request', 'AbortError');
    const second = service.getCurrentRelease(createMockContext({ signal: controller.signal }));
    const rejected = expect(second).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    await rejected;
    await drive(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('decodes the declared Latin-1 charset and sends only doc=99', async () => {
    const { service, requests, ctx } = await setup(async (url) => {
      if (url.pathname.endsWith('currentRelease')) return json({ name: 'A' });
      if (url.pathname.endsWith('releaseList')) return json([]);
      return new Response(new Uint8Array([60, 112, 62, 99, 97, 102, 233, 60, 47, 112, 62]), {
        headers: { 'content-type': 'text/plain;charset=ISO-8859-1' },
      });
    });
    const result = await drive(service.getChapter99Source(ctx));
    expect(result.data.html).toBe('<p>café</p>');
    expect(result.data.charset).toBe('ISO-8859-1');
    expect(requests.find(({ url }) => url.pathname.endsWith('getChapterNotes'))!.url.search).toBe(
      '?doc=99',
    );
  });

  it.each(['text/plain', 'text/plain;charset=not-a-charset'])(
    'rejects missing or unsupported notes charset %s',
    async (contentType) => {
      const { service, ctx } = await setup(async (url) =>
        url.pathname.endsWith('currentRelease')
          ? json({ name: 'A' })
          : url.pathname.endsWith('releaseList')
            ? json([])
            : new Response('<p>Notes</p>', { headers: { 'content-type': contentType } }),
      );
      await expect(drive(service.getChapter99Source(ctx))).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'notes_structure_changed', retryable: false },
      });
    },
  );
});

describe('edition and snapshot lifecycle', () => {
  it('reuses metadata within 60 seconds but always post-checks a fresh body', async () => {
    const { service, requests, ctx } = await setup();
    await drive(service.getCurrentRelease(ctx));
    await drive(service.getCurrentRelease(ctx));
    expect(requests).toHaveLength(2);
    await drive(service.search('batteries', ctx));
    expect(requests.filter(({ url }) => url.pathname.endsWith('currentRelease'))).toHaveLength(2);
    await drive(service.search('batteries', ctx));
    expect(requests).toHaveLength(5);
  });

  it('discards the first assembly on an edition transition', async () => {
    let metadata = 0;
    const { service, requests, ctx } = await setup(async (url) => {
      if (url.pathname.endsWith('currentRelease'))
        return json({ name: metadata++ === 0 ? 'A' : 'B' });
      if (url.pathname.endsWith('releaseList')) return json([]);
      return json([row]);
    });
    const result = await drive(service.search('batteries', ctx));
    expect(result.release.name).toBe('B');
    expect(result.data.rows[0]!.nodeId.startsWith('B:')).toBe(true);
    expect(requests.filter(({ url }) => url.pathname.endsWith('search'))).toHaveLength(2);
  });

  it('rejects repeated edition transitions with a stable reason', async () => {
    let metadata = 0;
    const { service, ctx } = await setup(async (url) =>
      url.pathname.endsWith('currentRelease')
        ? json({ name: `edition-${metadata++}` })
        : url.pathname.endsWith('releaseList')
          ? json([])
          : json([row]),
    );
    await expect(drive(service.search('batteries', ctx))).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'release_changed' },
    });
  });

  it('rebuilds reused components when a newly fetched component crosses editions', async () => {
    let release = 'A';
    const { service, requests, ctx } = await setup(async (url) => {
      if (url.pathname.endsWith('currentRelease')) return json({ name: release });
      if (url.pathname.endsWith('releaseList')) return json([]);
      if (url.searchParams.get('keyword') === 'new-component') release = 'B';
      return json([row]);
    });
    const original = await drive(service.search('cached-component', ctx));
    const result = await drive(
      service.assemble(ctx, async (session) => ({
        cached: await session.search('cached-component'),
        fresh: await session.search('new-component'),
      })),
    );
    expect(result.release.name).toBe('B');
    expect(result.data.cached.release.name).toBe('B');
    expect(result.data.fresh.release.name).toBe('B');
    expect(result.data.cached.rows[0]!.nodeId.startsWith('B:')).toBe(true);
    expect(
      requests.filter(({ url }) => url.searchParams.get('keyword') === 'cached-component'),
    ).toHaveLength(2);
    await expect(
      drive(service.getRowsSnapshot(original.data.snapshotId, ctx)),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'cursor_expired' },
    });
  });

  it('never silently returns stale data when metadata refresh fails', async () => {
    let failed = false;
    const { service, ctx } = await setup(async (url) => {
      if (failed) return new Response('', { status: 503 });
      return url.pathname.endsWith('currentRelease')
        ? json({ name: 'A' })
        : url.pathname.endsWith('releaseList')
          ? json([])
          : json([row]);
    });
    const snapshot = await drive(service.search('batteries', ctx));
    await vi.advanceTimersByTimeAsync(60_000);
    failed = true;
    await expect(
      drive(service.getRowsSnapshot(snapshot.data.snapshotId, ctx)),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('expires cursors after 15 minutes without rebuilding their rows', async () => {
    const { service, requests, ctx } = await setup();
    const result = await drive(service.search('batteries', ctx));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await expect(drive(service.getRowsSnapshot(result.data.snapshotId, ctx))).rejects.toMatchObject(
      { code: JsonRpcErrorCode.Conflict, data: { reason: 'cursor_expired' } },
    );
    expect(requests.filter(({ url }) => url.pathname.endsWith('search'))).toHaveLength(1);
  });

  it('evicts the least recently used snapshot at 32, including cursor touches', async () => {
    const { service, ctx } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 32; index++)
      ids.push((await drive(service.search(`query-${index}`, ctx))).data.snapshotId);
    await drive(service.getRowsSnapshot(ids[0]!, ctx));
    await drive(service.search('query-32', ctx));
    await expect(drive(service.getRowsSnapshot(ids[1]!, ctx))).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'cursor_expired' },
    });
    expect((await drive(service.getRowsSnapshot(ids[0]!, ctx))).snapshotId).toBe(ids[0]);
  });
});
