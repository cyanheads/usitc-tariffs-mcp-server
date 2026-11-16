/**
 * @fileoverview Fake-timer driver, JSON responses and reply readers shared by the tool and service suites.
 * @module tests/fixtures/tool-harness
 */
import { z } from '@cyanheads/mcp-ts-core';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { vi } from 'vitest';

type ToolReply = Awaited<ReturnType<typeof runToolContract>>;

/** Settle a promise whose source pacing waits on fake timers, advancing them until it does. */
export async function drive<T>(promise: Promise<T>): Promise<T> {
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

/** A 200 JSON response, as the USITC endpoints answer. */
export const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

/** Text blocks of a reply, joined as `content[]` renders them. */
export function text(result: ToolReply): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** Enrichment notice of one reply; undefined when the reply carries none. */
export function noticeOf(result: ToolReply): string | undefined {
  return z.object({ notice: z.string().optional() }).parse(result.structuredContent).notice;
}

/** Serialized size of a complete JSON-RPC reply, used to prove a fixture is byte-heavy. */
export function replyBytes(result: ToolReply): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}
