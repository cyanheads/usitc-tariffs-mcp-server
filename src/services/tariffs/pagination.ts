/**
 * @fileoverview Versioned argument-bound cursors and whole-item pages sized by the requested limit.
 * @module services/tariffs/pagination
 */
import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { conflict, validationError } from '@cyanheads/mcp-ts-core/errors';

const CURSOR_TTL_MS = 15 * 60_000;
/** Most whole items one page returns, whatever limit was requested. */
export const PAGE_CAP = 100;
/** Cursors and snapshot ids carry the first 64 bits of a digest; full digests would dominate the token. */
const SHORT_DIGEST_HEX = 16;

/** Whole-collection counts and an executable continuation token. */
export interface Page {
  effectiveLimit: number;
  nextCursor?: string;
  returned: number;
  total: number;
}
const digestPrefix = z.string().regex(/^[0-9a-f]{16}$/);
const cursorSchema = z
  .object({
    v: z.literal(2),
    tool: z.string(),
    argumentsDigest: digestPrefix,
    edition: z.string(),
    digest: digestPrefix,
    snapshotId: z.string(),
    offset: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
/** Validated continuation identity for the original source snapshot. */
export type PageCursor = z.infer<typeof cursorSchema>;
/** Deterministic identity for normalized selectors and immutable reference tables. */
export function digestValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** First 64 bits of a hex digest, as bound into cursors and snapshot ids. */
export const shortDigest = (digest: string) => digest.slice(0, SHORT_DIGEST_HEX);

/** Decode and bind a cursor before any source retrieval; never restart invalid pages. */
export function readCursor(
  cursor: string | undefined,
  tool: string,
  args: unknown,
  now = Date.now(),
): PageCursor | undefined {
  if (!cursor?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw validationError(
      'Cursor is not a valid continuation token. Repeat the original call without a cursor.',
      { reason: 'invalid_cursor' },
    );
  }
  const parsed = cursorSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.tool !== tool ||
    parsed.data.argumentsDigest !== shortDigest(digestValue(args))
  )
    throw validationError('Cursor does not match this tool and its normalized arguments.', {
      reason: 'invalid_cursor',
    });
  if (parsed.data.expiresAt <= now || parsed.data.expiresAt > now + CURSOR_TTL_MS)
    throw conflict('Cursor expired. Repeat the original call without a cursor.', {
      reason: 'cursor_expired',
    });
  return parsed.data;
}

/** Confirm current edition and source identity before serving the saved collection. */
export function validateCursor(
  cursor: PageCursor | undefined,
  identity: { edition: string; digest: string; snapshotId: string },
): void {
  if (!cursor) return;
  if (cursor.edition !== identity.edition)
    throw conflict('The published edition changed. Repeat the original call without a cursor.', {
      reason: 'cursor_expired',
    });
  if (cursor.digest !== shortDigest(identity.digest) || cursor.snapshotId !== identity.snapshotId)
    throw conflict('The original source snapshot is no longer available.', {
      reason: 'cursor_expired',
    });
}

/**
 * Select `min(effectiveLimit, remaining)` whole items from the cursor offset; `effectiveLimit` is
 * the requested limit clamped to {@link PAGE_CAP}. `snapshotId` is embedded verbatim: it is the
 * handle the caller's snapshot store resolves on continuation.
 */
export function packPage<T, R>(options: {
  tool: string;
  args: unknown;
  edition: string;
  digest: string;
  snapshotId: string;
  items: readonly T[];
  limit: number;
  cursor?: PageCursor | undefined;
  expiresAt?: number;
  build: (items: T[], page: Page) => R;
}): R {
  validateCursor(options.cursor, options);
  const offset = options.cursor?.offset ?? 0;
  if (offset > options.items.length || (offset === options.items.length && offset !== 0))
    throw validationError('Cursor offset is outside this collection.', {
      reason: 'invalid_cursor',
    });
  const effectiveLimit = Math.min(options.limit, PAGE_CAP);
  const next = Math.min(offset + effectiveLimit, options.items.length);
  const nextCursor =
    next < options.items.length
      ? Buffer.from(
          JSON.stringify({
            v: 2,
            tool: options.tool,
            argumentsDigest: shortDigest(digestValue(options.args)),
            edition: options.edition,
            digest: shortDigest(options.digest),
            snapshotId: options.snapshotId,
            offset: next,
            expiresAt: options.cursor?.expiresAt ?? options.expiresAt ?? Date.now() + CURSOR_TTL_MS,
          } satisfies PageCursor),
        ).toString('base64url')
      : undefined;
  return options.build(options.items.slice(offset, next), {
    total: options.items.length,
    returned: next - offset,
    effectiveLimit,
    ...(nextCursor && { nextCursor }),
  });
}

/**
 * One enrichment notice per page: the result's own notice, then the clamp disclosure on every
 * page of a call whose requested limit exceeds {@link PAGE_CAP}.
 */
export function pageNotice(notice: string | undefined, limit: number): string | undefined {
  const clamp =
    limit > PAGE_CAP
      ? `Requested limit ${limit} was clamped to the ${PAGE_CAP}-item page cap.`
      : undefined;
  return notice && clamp ? `${notice} ${clamp}` : (notice ?? clamp);
}
