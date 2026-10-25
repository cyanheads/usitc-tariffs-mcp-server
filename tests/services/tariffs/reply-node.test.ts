/** @fileoverview Node compatibility for lossless rendering of repeated source delimiters. */
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('renders many separate backtick runs losslessly under Node', () => {
  const sourceModule = new URL('../../../src/mcp-server/tools/reply.ts', import.meta.url);
  const script =
    "const { formatSourceData } = await import(process.argv[1]); const source = { description: String.fromCharCode(96).concat('x').repeat(200_000) }; const rendered = formatSourceData(source)[0]; process.stdout.write(String(rendered.text.includes(JSON.stringify(source, null, 2))));";
  const result = execFileSync(
    'node',
    ['--input-type=module', '--eval', script, sourceModule.href],
    { encoding: 'utf8' },
  );
  expect(result).toBe('true');
});
