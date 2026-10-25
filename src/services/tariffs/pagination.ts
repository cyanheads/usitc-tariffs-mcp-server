/**
 * @fileoverview Versioned argument-bound cursors and whole-item MCP page packing.
 * @module services/tariffs/pagination
 */
import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { conflict, internalError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { replySizeInBytes } from '../../mcp-server/tools/reply.js';

/** Whole-collection counts and an executable continuation token. */
export interface Page {
  budgetLimited?: boolean;
  effectiveLimit: number;
  nextCursor?: string;
  returned: number;
  total: number;
}
const cursorSchema = z
  .object({
    v: z.literal(1),
    tool: z.string(),
    argumentsDigest: z.string(),
    edition: z.string(),
    digest: z.string(),
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
    parsed.data.argumentsDigest !== digestValue(args)
  )
    throw validationError('Cursor does not match this tool and its normalized arguments.', {
      reason: 'invalid_cursor',
    });
  if (parsed.data.expiresAt <= now || parsed.data.expiresAt > now + 15 * 60_000)
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
  if (cursor.digest !== identity.digest || cursor.snapshotId !== identity.snapshotId)
    throw conflict('The original source snapshot is no longer available.', {
      reason: 'cursor_expired',
    });
}

/** Pack complete items against both MCP surfaces, counting the final cursor and enrichment. */
export function packPage<T, R>(options: {
  tool: string;
  args: unknown;
  edition: string;
  digest: string;
  snapshotId: string;
  items: readonly T[];
  limit: number;
  cursor?: PageCursor;
  expiresAt?: number;
  build: (items: T[], page: Page) => R;
  notice?: string;
}): R {
  validateCursor(options.cursor, options);
  const offset = options.cursor?.offset ?? 0;
  if (offset > options.items.length || (offset === options.items.length && offset !== 0))
    throw validationError('Cursor offset is outside this collection.', {
      reason: 'invalid_cursor',
    });
  const effectiveLimit = Math.min(options.limit, 100);
  const expiresAt = options.cursor?.expiresAt ?? options.expiresAt ?? Date.now() + 15 * 60_000;
  const enrichment = {
    totalCount: options.items.length,
    ...(options.notice && { notice: options.notice }),
  };
  const build = (count: number, budgetLimited: boolean): R => {
    const next = offset + count;
    const nextCursor =
      next < options.items.length
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              tool: options.tool,
              argumentsDigest: digestValue(options.args),
              edition: options.edition,
              digest: options.digest,
              snapshotId: options.snapshotId,
              offset: next,
              expiresAt,
            }),
          ).toString('base64url')
        : undefined;
    return options.build(options.items.slice(offset, next), {
      total: options.items.length,
      returned: count,
      effectiveLimit,
      ...(nextCursor && { nextCursor }),
      ...(budgetLimited && { budgetLimited: true }),
    });
  };
  let count = Math.min(effectiveLimit, options.items.length - offset);
  let result = build(count, false);
  while (replySizeInBytes(result, enrichment) > 24_000 && count > 0) {
    count--;
    result = build(count, true);
  }
  if (
    (count === 0 && offset < options.items.length) ||
    replySizeInBytes(result, enrichment) > 24_000
  )
    throw internalError(
      'One complete source item exceeds the MCP reply budget; a narrower detail selector is required.',
      { reason: 'reply_item_too_large', retryable: false },
    );
  return result;
}
