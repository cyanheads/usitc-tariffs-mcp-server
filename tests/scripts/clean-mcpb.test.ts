/** @fileoverview Bundle cleaning retains nested runtime skills modules while removing agent docs. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/** The copied CLI has framework-only branches outside this server's TypeScript project. */
function packagingErrors(entries: string[]): unknown {
  const output = execFileSync(
    'bun',
    [
      '--eval',
      'import { checkBundleEntries } from "./scripts/lint-packaging.ts"; console.log(JSON.stringify(checkBundleEntries(JSON.parse(process.env.BUNDLE_TEST_ENTRIES), "fixture.mcpb")));',
    ],
    {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, BUNDLE_TEST_ENTRIES: JSON.stringify(entries) },
      encoding: 'utf8',
    },
  );
  return JSON.parse(output);
}

describe('MCPB agent documentation boundaries', () => {
  it('removes dependency agent documentation, including nested package roots', () => {
    const docs = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/research/references/source.md',
      'node_modules/example/node_modules/@scope/child/skills/research/reference.md',
      'node_modules/example/.agents/config.json',
      'node_modules/example/docs/SKILL.md',
    ];
    expect(filterAgentDocEntries(docs)).toEqual(docs);
    expect(packagingErrors(docs)).toHaveLength(1);
  });

  it('preserves SDK and other nested skills runtime modules in cleaner and linter', () => {
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.cjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
      'node_modules/example/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/example/dist/skills/runtime.js',
    ];
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(packagingErrors(runtime)).toEqual([]);
  });
});
