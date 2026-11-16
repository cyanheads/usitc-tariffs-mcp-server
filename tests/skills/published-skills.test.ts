/**
 * @fileoverview The published root `skills/` tree loads whole through the framework's skill
 * catalog: every `skills/<name>/SKILL.md` is listed as `skill://<name>/SKILL.md` and reads back
 * unchanged. The tree is served through the Worker entry point, which takes the same files as a
 * record that `createApp({ skills: 'skills' })` reads from the folder.
 * @module tests/skills/published-skills.test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { describe, expect, it } from 'vitest';

const SKILLS_DIR = new URL('../../skills/', import.meta.url).pathname;
const PROTOCOL = '2026-07-28';

const listReply = z.object({
  result: z.object({ resources: z.array(z.object({ uri: z.string() })) }),
});
const readReply = z.object({
  result: z.object({ contents: z.array(z.object({ uri: z.string(), text: z.string() })) }),
});

/** Every file under `skills/`, keyed by its path inside the tree. */
function readTree(): Record<string, string> {
  const paths = readdirSync(SKILLS_DIR, { recursive: true, encoding: 'utf8' }).filter((path) =>
    statSync(join(SKILLS_DIR, path)).isFile(),
  );
  return Object.fromEntries(
    paths.map((path) => [path, readFileSync(join(SKILLS_DIR, path), 'utf8')]),
  );
}

/** One stateless 2026-07-28 JSON-RPC request; the reply arrives as JSON or one SSE data frame. */
async function request(
  handler: ReturnType<typeof createWorkerHandler>,
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
): Promise<unknown> {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        'Mcp-Method': method,
        ...(name && { 'Mcp-Name': name }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {},
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
  const body = await response.text();
  const frame = body.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(frame ? frame.slice('data:'.length) : body);
}

describe('published skills', () => {
  it('serves every skills/<name>/SKILL.md as a skill resource, unchanged', async () => {
    const tree = readTree();
    const expected = Object.keys(tree)
      .filter((path) => /^[^/]+\/SKILL\.md$/.test(path))
      .map((path) => `skill://${path}`)
      .sort();
    expect(expected).toContain('skill://usitc-tariffs-guide/SKILL.md');

    const handler = createWorkerHandler({
      name: 'usitc-tariffs-mcp-server',
      title: 'usitc-tariffs-mcp-server',
      tools: [],
      skills: tree,
    });
    const listed = listReply
      .parse(await request(handler, 'resources/list'))
      .result.resources.map((resource) => resource.uri)
      .filter((uri) => uri.startsWith('skill://'))
      .sort();
    expect(listed).toEqual(expected);

    for (const uri of expected) {
      const read = readReply.parse(await request(handler, 'resources/read', { uri }, uri));
      expect(read.result.contents).toEqual([
        expect.objectContaining({ uri, text: tree[uri.slice('skill://'.length)] }),
      ]);
    }
  });
});
