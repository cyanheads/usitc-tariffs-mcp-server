/** @fileoverview Node compatibility for lossless rendering of repeated source delimiters. */
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('renders many separate backtick runs losslessly under Node', () => {
  const sourceModule = new URL('../../../src/mcp-server/tools/reply.ts', import.meta.url);
  // The module URL is embedded, not passed as an argument: Bun's `node` shim (the Bun test lane) drops positionals after `--eval`.
  const script = `const { formatSourceData } = await import(${JSON.stringify(sourceModule.href)}); const source = { description: String.fromCharCode(96).concat('x').repeat(200_000) }; const rendered = formatSourceData(source)[0]; process.stdout.write(String(rendered.text.includes(String.fromCharCode(10).concat(JSON.stringify(source), String.fromCharCode(10)))));`;
  const result = execFileSync('node', ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
  });
  expect(result).toBe('true');
});
