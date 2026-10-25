/**
 * @fileoverview Fixed-origin, paced USITC requests and edition-checked snapshots.
 * @module services/usitc/usitc-service
 */
import { createHash } from 'node:crypto';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  conflict,
  internalError,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import {
  type Chapter99Source,
  type EditionResult,
  type Release,
  type ReleaseRecord,
  type RowsSnapshot,
  releaseRecordSchema,
  type Source,
  type TariffRecord,
  type TariffRow,
  tariffRecordSchema,
} from './types.js';

const ORIGIN = 'https://hts.usitc.gov';
const OPERATION_MS = 45_000;
const ATTEMPT_MS = 15_000;
const METADATA_MS = 60_000;
const SNAPSHOT_MS = 15 * 60_000;
const CONSISTENCY_NOTICE =
  'USITC current-view metadata checks cannot detect a silent correction within the same release; source digests and a 15-minute snapshot lifetime bound reuse.';
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const pacer = createPacer({
  name: 'usitc',
  minStartGapMs: 1000,
  maxConcurrent: 1,
  cooldown: { baseMs: 1000, maxMs: 45_000 },
});

type Request =
  | { endpoint: 'currentRelease' | 'releaseList' }
  | { endpoint: 'search'; keyword: string }
  | { endpoint: 'exportList'; from: string; to: string }
  | { endpoint: 'getChapterNotes' };
type Operation = {
  signal: AbortSignal;
  callerSignal: AbortSignal | undefined;
  deadline: number;
  ctx: Context;
};
type Body = { bytes: Uint8Array; contentType: string | null; source: Source; digest: string };
type Metadata = { release: Release; source: Source; fetchedAt: number; sequence: number };
type CacheEntry = { snapshot: RowsSnapshot; expiresAt: number; requestKey: string };

/** Injectable I/O and wall clock; tests can combine this with fake timers. */
export interface UsitcDependencies {
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** Edition-scoped component access for a tool assembling more than one source. */
export interface UsitcEditionSession {
  getChapter(chapter: string): Promise<RowsSnapshot>;
  getChapter99Source(): Promise<Chapter99Source>;
  getHeading(heading: string): Promise<RowsSnapshot>;
  getReleases(): Promise<ReleaseRecord[]>;
  getRowsSnapshot(snapshotId: string): Promise<RowsSnapshot>;
  release: Release;
  search(query: string): Promise<RowsSnapshot>;
}

function requestUrl(request: Request): URL {
  const url = new URL(`/reststop/${request.endpoint}`, ORIGIN);
  switch (request.endpoint) {
    case 'search':
      url.searchParams.set('keyword', request.keyword);
      break;
    case 'exportList':
      url.searchParams.set('from', request.from);
      url.searchParams.set('to', request.to);
      url.searchParams.set('format', 'JSON');
      url.searchParams.set('styles', 'false');
      break;
    case 'getChapterNotes':
      url.searchParams.set('doc', '99');
      break;
    case 'currentRelease':
    case 'releaseList':
      break;
  }
  return url;
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => {
    cancellation = reader.cancel(signal.reason);
  };
  let cancellation: Promise<void> | undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) break;
      chunks.push(result.value);
      size += result.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    if (cancellation) await cancellation;
    reader.releaseLock();
  }
}

function normalizeRelease(
  current: ReleaseRecord,
  matching: ReleaseRecord | undefined,
  checkedAt: string,
): Release {
  const description =
    current.description !== undefined ? current.description : matching?.description;
  const effectiveDate =
    current.releaseStartDate !== undefined ? current.releaseStartDate : matching?.releaseStartDate;
  const status = current.status !== undefined ? current.status : matching?.status;
  return {
    name: current.name,
    checkedAt,
    ...(description !== undefined && { description }),
    ...(effectiveDate !== undefined && { effectiveDate }),
    ...(status !== undefined && { status }),
  };
}

const mappedRowKeys = new Set([
  'htsno',
  'indent',
  'description',
  'superior',
  'general',
  'special',
  'other',
  'units',
  'footnotes',
  'quotaQuantity',
  'additionalDuties',
  'addiitionalDuties',
]);
const appRowKeys = new Set(['hasHighlight', 'highlightHtsNo', 'highlightStatSuffix', 'selector']);

function normalizeRow(
  row: TariffRecord,
  ordinal: number,
  release: string,
  digest: string,
): TariffRow {
  const sourceFields: TariffRow['sourceFields'] = Object.create(null);
  for (const [key, value] of Object.entries(row)) {
    if (!mappedRowKeys.has(key) && !appRowKeys.has(key) && value !== undefined)
      sourceFields[key] = value;
  }
  return {
    nodeId: `${release}:${digest}:${ordinal}`,
    sourceOrdinal: ordinal,
    ...(row.htsno && { htsno: row.htsno }),
    indent: Number(row.indent),
    description: row.description,
    ...(row.superior !== undefined && { superior: row.superior }),
    publishedRates: {
      ...(row.general !== undefined && { general: row.general }),
      ...(row.special !== undefined && { special: row.special }),
      ...(row.other !== undefined && { column2: row.other }),
    },
    ...(row.units !== undefined && { units: row.units }),
    ...(row.footnotes !== undefined && { footnotes: row.footnotes }),
    ...(row.quotaQuantity !== undefined && { quotaQuantity: row.quotaQuantity }),
    ...(row.additionalDuties !== undefined && { additionalDuties: row.additionalDuties }),
    ...(row.addiitionalDuties !== undefined && { addiitionalDuties: row.addiitionalDuties }),
    sourceFields,
  };
}

/** One process service; all instances still share the same upstream request pacer. */
export class UsitcService {
  private readonly fetch: NonNullable<UsitcDependencies['fetch']>;
  private readonly now: () => number;
  private metadata: Metadata | undefined;
  private metadataSequence = 0;
  private readonly snapshots = new Map<string, CacheEntry>();

  constructor(dependencies: UsitcDependencies = {}) {
    this.fetch = dependencies.fetch ?? ((input, init) => fetch(input, init));
    this.now = dependencies.now ?? Date.now;
  }

  /** Check current metadata, reusing a completed successful check for at most 60 seconds. */
  getCurrentRelease(ctx: Context): Promise<EditionResult<Release>> {
    return this.operation(ctx, async (op) => {
      const metadata = await this.currentRelease(op, false);
      return {
        data: metadata.release,
        release: metadata.release,
        source: metadata.source,
        notices: [CONSISTENCY_NOTICE],
      };
    });
  }

  /** Fetch complete release metadata and verify that its assembly did not cross editions. */
  getReleases(ctx: Context): Promise<EditionResult<ReleaseRecord[]>> {
    return this.assemble(ctx, (session) => session.getReleases());
  }

  /** Fetch flat USITC keyword results without sending unsupported country filters. */
  search(query: string, ctx: Context): Promise<EditionResult<RowsSnapshot>> {
    return this.assemble(ctx, (session) => session.search(query));
  }

  /** Fetch the complete heading export, including unnamed structural rows. */
  getHeading(heading: string, ctx: Context): Promise<EditionResult<RowsSnapshot>> {
    return this.assemble(ctx, (session) => session.getHeading(heading));
  }

  /** Fetch a complete chapter through its final ten-digit statistical suffix. */
  getChapter(chapter: string, ctx: Context): Promise<EditionResult<RowsSnapshot>> {
    return this.assemble(ctx, (session) => session.getChapter(chapter));
  }

  /** Decode the declared Chapter 99 charset; callers must derive and discard the HTML. */
  getChapter99Source(ctx: Context): Promise<EditionResult<Chapter99Source>> {
    return this.assemble(ctx, (session) => session.getChapter99Source());
  }

  /**
   * Assemble related components under one 45-second deadline. A transition discards
   * the assembly and invokes build once more; build must have no external effects.
   */
  assemble<T>(
    ctx: Context,
    build: (session: UsitcEditionSession) => Promise<T>,
  ): Promise<EditionResult<T>> {
    return this.operation(ctx, async (op) => {
      let metadata = await this.currentRelease(op, false);
      for (let transition = 0; transition < 2; transition++) {
        const staged: CacheEntry[] = [];
        const components: Array<Pick<RowsSnapshot, 'release' | 'source' | 'notices'>> = [];
        let fetched = false;
        const session: UsitcEditionSession = {
          release: metadata.release,
          getRowsSnapshot: (snapshotId) => {
            const entry = this.snapshots.get(snapshotId);
            if (
              !entry ||
              entry.expiresAt <= this.now() ||
              entry.snapshot.release.name !== metadata.release.name
            ) {
              this.snapshots.delete(snapshotId);
              throw conflict(
                'USITC snapshot expired, was evicted, or belongs to a previous release.',
                { reason: 'cursor_expired' },
              );
            }
            this.snapshots.delete(snapshotId);
            this.snapshots.set(snapshotId, entry);
            const snapshot = structuredClone(entry.snapshot);
            components.push(snapshot);
            return Promise.resolve(snapshot);
          },
          search: (query) => {
            if (!query.trim())
              throw validationError('Search requires nonblank text.', { reason: 'invalid_query' });
            return rows({ endpoint: 'search', keyword: query.trim() });
          },
          getHeading: (heading) => {
            if (!/^\d{4}$/.test(heading))
              throw validationError('Heading must contain four digits.', {
                reason: 'invalid_code',
              });
            return rows({ endpoint: 'exportList', from: heading, to: `${heading}.99.99.99` });
          },
          getChapter: (chapter) => {
            if (!/^(?:0[1-9]|[1-9]\d)$/.test(chapter))
              throw validationError('Chapter must be two digits from 01 through 99.', {
                reason: 'invalid_code',
              });
            return rows({
              endpoint: 'exportList',
              from: `${chapter}00`,
              to: `${chapter}99.99.99.99`,
            });
          },
          getChapter99Source: async () => {
            fetched = true;
            const body = await this.request({ endpoint: 'getChapterNotes' }, op);
            const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(body.contentType ?? '')?.[1];
            if (!charset)
              throw serviceUnavailable('USITC Chapter 99 source did not declare a charset.', {
                reason: 'notes_structure_changed',
                retryable: false,
              });
            let html: string;
            try {
              html = new TextDecoder(charset, { fatal: true }).decode(body.bytes);
            } catch (cause) {
              throw serviceUnavailable(
                'USITC Chapter 99 charset could not be decoded.',
                { reason: 'notes_structure_changed', retryable: false },
                { cause },
              );
            }
            const component = {
              html,
              charset,
              digest: body.digest,
              release: metadata.release,
              source: body.source,
              notices: [CONSISTENCY_NOTICE],
            };
            components.push(component);
            return component;
          },
          getReleases: async () => {
            fetched = true;
            const body = await this.request({ endpoint: 'releaseList' }, op);
            const records = this.json(body, z.array(releaseRecordSchema));
            components.push({ release: metadata.release, source: body.source, notices: [] });
            return records;
          },
        };
        const service = this;
        async function rows(request: Request): Promise<RowsSnapshot> {
          const key = requestUrl(request).href;
          const cached = service.cachedRows(key, metadata.release.name);
          if (cached) {
            components.push(cached);
            return cached;
          }
          fetched = true;
          const body = await service.request(request, op);
          const raw = service.json(body, z.array(tariffRecordSchema));
          const notices = [CONSISTENCY_NOTICE];
          if (raw.some((row) => row.addiitionalDuties != null))
            notices.push(
              'USITC supplied the distinct misspelled addiitionalDuties field; it is preserved separately from additionalDuties.',
            );
          if (
            raw.some(
              (row) =>
                row.addiitionalDuties != null &&
                row.additionalDuties != null &&
                JSON.stringify(row.addiitionalDuties) !== JSON.stringify(row.additionalDuties),
            )
          )
            notices.push(
              'USITC supplied conflicting additionalDuties and addiitionalDuties values; neither value was overwritten.',
            );
          const snapshot: RowsSnapshot = {
            snapshotId: hash(`${metadata.release.name}:${key}:${body.digest}`),
            digest: body.digest,
            release: metadata.release,
            source: body.source,
            notices,
            rows: raw.map((row, index) =>
              normalizeRow(row, index, metadata.release.name, body.digest),
            ),
          };
          staged.push({ snapshot, requestKey: key, expiresAt: service.now() + SNAPSHOT_MS });
          components.push(snapshot);
          return snapshot;
        }
        const data = await build(session);
        const checked = fetched ? await this.currentRelease(op, true) : metadata;
        if (
          checked.release.name !== metadata.release.name ||
          components.some((component) => component.release.name !== checked.release.name)
        ) {
          metadata = checked;
          continue;
        }
        if (this.metadata?.release.name !== checked.release.name) {
          metadata = await this.currentRelease(op, true);
          continue;
        }
        for (const entry of staged) this.storeRows(entry);
        for (const component of components) component.release = checked.release;
        return {
          data,
          release: checked.release,
          source: components[0]?.source ?? checked.source,
          notices: [
            ...new Set([
              CONSISTENCY_NOTICE,
              ...components.flatMap((component) => component.notices),
            ]),
          ],
        };
      }
      throw conflict('USITC release changed twice while assembling the result.', {
        reason: 'release_changed',
      });
    });
  }

  /** Retrieve a cursor's original snapshot; never rebuild evicted or expired data. */
  getRowsSnapshot(snapshotId: string, ctx: Context): Promise<RowsSnapshot> {
    return this.operation(ctx, async (op) => {
      const metadata = await this.currentRelease(op, false);
      const entry = this.snapshots.get(snapshotId);
      if (
        !entry ||
        entry.expiresAt <= this.now() ||
        entry.snapshot.release.name !== metadata.release.name
      ) {
        this.snapshots.delete(snapshotId);
        throw conflict('USITC snapshot expired, was evicted, or belongs to a previous release.', {
          reason: 'cursor_expired',
        });
      }
      this.snapshots.delete(snapshotId);
      this.snapshots.set(snapshotId, entry);
      return { ...entry.snapshot, release: metadata.release };
    });
  }

  private cachedRows(requestKey: string, release: string): RowsSnapshot | undefined {
    for (const [id, entry] of this.snapshots) {
      if (entry.expiresAt <= this.now()) {
        this.snapshots.delete(id);
        continue;
      }
      if (entry.requestKey === requestKey && entry.snapshot.release.name === release) {
        this.snapshots.delete(id);
        this.snapshots.set(id, entry);
        return structuredClone(entry.snapshot);
      }
    }
    return undefined;
  }

  private storeRows(entry: CacheEntry): void {
    for (const [id, previous] of this.snapshots)
      if (previous.requestKey === entry.requestKey || previous.expiresAt <= this.now())
        this.snapshots.delete(id);
    this.snapshots.set(entry.snapshot.snapshotId, structuredClone(entry));
    while (this.snapshots.size > 32) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
  }

  private async currentRelease(op: Operation, fresh: boolean): Promise<Metadata> {
    if (!fresh && this.metadata && this.now() - this.metadata.fetchedAt < METADATA_MS)
      return this.metadata;
    const sequence = ++this.metadataSequence;
    const body = await this.request({ endpoint: 'currentRelease' }, op);
    const current = this.json(body, releaseRecordSchema);
    const records = this.json(
      await this.request({ endpoint: 'releaseList' }, op),
      z.array(releaseRecordSchema),
    );
    const metadata = {
      release: normalizeRelease(
        current,
        records.find((record) => record.name === current.name),
        body.source.retrievedAt,
      ),
      source: body.source,
      fetchedAt: Date.parse(body.source.retrievedAt),
      sequence,
    };
    if (!this.metadata || sequence >= this.metadata.sequence) {
      if (this.metadata && this.metadata.release.name !== current.name) this.snapshots.clear();
      this.metadata = metadata;
    }
    return metadata;
  }

  private json<T>(body: Body, schema: z.ZodType<T>): T {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
    } catch (cause) {
      throw internalError(
        'USITC JSON response is not valid UTF-8.',
        { retryable: false },
        { cause },
      );
    }
    if (/^\s*<(?:!doctype\s+html|html|head|body)[\s>]/i.test(text))
      throw serviceUnavailable('USITC returned HTML instead of JSON.');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw internalError(
        'USITC returned a complete invalid JSON response.',
        { retryable: false },
        { cause },
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw internalError(
        'USITC response did not match its source contract.',
        { retryable: false },
        { cause: parsed.error },
      );
    return parsed.data;
  }

  private async operation<T>(ctx: Context, task: (op: Operation) => Promise<T>): Promise<T> {
    ctx.signal?.throwIfAborted();
    const controller = new AbortController();
    const deadlineError = timeout('USITC operation exceeded its 45-second budget.', {
      reason: 'operation_deadline_exceeded',
    });
    const timer = setTimeout(() => controller.abort(deadlineError), OPERATION_MS);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    try {
      return await task({
        signal,
        callerSignal: ctx.signal,
        deadline: this.now() + OPERATION_MS,
        ctx,
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (controller.signal.aborted) throw deadlineError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private request(request: Request, op: Operation): Promise<Body> {
    const remaining = () => Math.max(0, op.deadline - this.now());
    return withRetry(
      () =>
        pacer.run(
          async (queueSignal) => {
            queueSignal.throwIfAborted();
            const controller = new AbortController();
            const attemptError = timeout('USITC request exceeded its attempt budget.');
            const timer = setTimeout(
              () => controller.abort(attemptError),
              Math.min(ATTEMPT_MS, remaining()),
            );
            const signal = AbortSignal.any([queueSignal, controller.signal]);
            try {
              const url = requestUrl(request);
              const response = await this.fetch(url, {
                signal,
                redirect: 'manual',
                headers: {
                  Accept:
                    request.endpoint === 'getChapterNotes'
                      ? 'text/plain, text/html'
                      : 'application/json',
                },
              });
              if (!response.ok) {
                const error = await httpErrorFromResponse(response, {
                  service: 'USITC',
                  captureBody: false,
                  codeOverride: (status) =>
                    status === 400 ? JsonRpcErrorCode.InternalError : undefined,
                  data: {
                    retryable: RETRY_STATUSES.has(response.status),
                    endpoint: request.endpoint,
                  },
                });
                await response.body?.cancel();
                throw error;
              }
              const bytes = await readBody(response, signal);
              signal.throwIfAborted();
              if (
                request.endpoint !== 'getChapterNotes' &&
                /^\s*<(?:!doctype\s+html|html|head|body)[\s>]/i.test(
                  new TextDecoder().decode(bytes),
                )
              )
                throw serviceUnavailable('USITC returned HTML instead of JSON.');
              return {
                bytes,
                contentType: response.headers.get('content-type'),
                digest: hash(bytes),
                source: {
                  agency: 'USITC' as const,
                  scheduleUrl: url.href,
                  retrievedAt: new Date(this.now()).toISOString(),
                },
              };
            } catch (error) {
              if (op.callerSignal?.aborted) throw op.callerSignal.reason;
              if (queueSignal.aborted) throw queueSignal.reason;
              if (controller.signal.aborted) throw attemptError;
              if (error instanceof McpError) throw error;
              throw serviceUnavailable(
                'USITC request or response body could not be read.',
                { endpoint: request.endpoint },
                { cause: error },
              );
            } finally {
              clearTimeout(timer);
            }
          },
          { signal: op.signal, maxWaitMs: remaining() },
        ),
      {
        signal: op.signal,
        deadlineMs: remaining(),
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: OPERATION_MS,
        jitter: 0,
        operation: `USITC.${request.endpoint}`,
        context: op.ctx,
        isTransient: defaultIsTransient,
      },
    );
  }
}

let service: UsitcService | undefined;
/** Initialize the USITC boundary once during application setup. */
export function initUsitcService(): void {
  service = new UsitcService();
}
/** Access the initialized USITC service from request handlers. */
export function getUsitcService(): UsitcService {
  if (!service)
    throw new Error('USITC service is not initialized; call initUsitcService in setup.');
  return service;
}
/** Reject queued work and release the shared pacer's timer on server shutdown. */
export function disposeUsitcService(): void {
  pacer.dispose();
}
