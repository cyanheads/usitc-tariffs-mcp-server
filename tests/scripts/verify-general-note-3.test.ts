/**
 * @fileoverview Offline coverage of the General Note 3 maintainer check: running-header filter,
 * text comparison, download guards and the check's request flow.
 * @module tests/scripts/verify-general-note-3.test
 */
import { describe, expect, it, vi } from 'vitest';
import { decoderSourceEdition, generalNote3Url } from '@/services/reference/program-data.js';
import {
  diffLines,
  extractWithPdftotext,
  generalNote3PdfUrl,
  main,
  readPdf,
  stripRunningHeaders,
  VerificationError,
  type VerifyDependencies,
  verifyGeneralNote3,
} from '../../scripts/verify-general-note-3.js';

const pages = [
  ['Annotated for Statistical Reporting Purposes', 'GENERAL NOTE 3', '(b) Rate of duty column 2.'],
  ['Republic of Belarus', 'Cuba', 'North Korea', 'Russian Federation'],
  ['(c) Products Eligible for Special Tariff Treatment.', '(g) Abbreviations.'],
];
const strippedPages = pages.flatMap((lines) => [...lines, '']);

/** pdftotext layout: every page opens with the running header and closes with a form feed. */
function extraction(header: string, body: string[][] = pages): string {
  return body.map((lines) => `${[header, ...lines].join('\n')}\n\n\f`).join('');
}
const header = (revision: number) =>
  `Harmonized Tariff Schedule of the United States Revision ${revision} (2026)`;

const pdfResponse = (label: string) =>
  new Response(`%PDF-1.7 ${label}`, { headers: { 'content-type': 'application/octet-stream' } });
const htmlResponse = (status: number) =>
  new Response('<!doctype html><html><body>Unavailable</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });

/**
 * Fake USITC and pdftotext; every fetch and pacing wait lands in one ordered event log, and every
 * fetch's `init` in `inits`.
 */
function harness(responses: Record<string, () => Response>, extractions: Record<string, string>) {
  const events: string[] = [];
  const inits: RequestInit[] = [];
  const extract = vi.fn(async (pdf: Uint8Array) => {
    const text = extractions[new TextDecoder().decode(pdf)];
    if (text === undefined) throw new Error('Unexpected PDF passed to the extractor.');
    return text;
  });
  return {
    events,
    extract,
    inits,
    dependencies: {
      fetch: async (url: string, init: RequestInit) => {
        events.push(`fetch ${url}`);
        inits.push(init);
        const respond = responses[url];
        if (!respond) throw new Error(`Unexpected request ${url}`);
        return respond();
      },
      extract,
      wait: async (ms: number) => {
        events.push(`wait ${ms}`);
      },
    },
  };
}
const reviewedUrl = generalNote3PdfUrl('2026HTSRev21');
const currentReleaseUrl = 'https://hts.usitc.gov/reststop/currentRelease';

describe('running-header filter', () => {
  it('removes exactly one running header from every page, including pages after a form feed', () => {
    expect(stripRunningHeaders(extraction(header(21)), '2026HTSRev21')).toEqual(strippedPages);
    expect(stripRunningHeaders(extraction(header(23)), '2026HTSRev23')).toEqual(strippedPages);
    expect(
      stripRunningHeaders(
        extraction('Harmonized Tariff Schedule of the United States (2026)'),
        '2026HTSBasic',
      ),
    ).toEqual(strippedPages);
  });

  it('keeps a header-like line that is not the exact running header', () => {
    const body = [['Harmonized Tariff Schedule of the United States Revision 21 (2026) note']];
    expect(stripRunningHeaders(extraction(header(21), body), '2026HTSRev21')).toEqual([
      ...body[0]!,
      '',
    ]);
  });

  it.each([
    [
      'a later page has no running header',
      `${extraction(header(21))}Body without header\n\f`,
      4,
      0,
    ],
    [
      'a later page has two running headers',
      extraction(header(21), [pages[0]!, [header(21), 'Duplicated'], pages[2]!]),
      2,
      2,
    ],
  ])('fails when %s', (_case, text, page, count) => {
    expect(() => stripRunningHeaders(text, '2026HTSRev21')).toThrowError(
      new VerificationError(
        `Page ${page} of the 2026HTSRev21 extraction has ${count} running headers; expected exactly one.`,
      ),
    );
  });

  it.each([
    ['', 'The 2026HTSRev21 extraction contains no pages.'],
    ['\f', 'Page 1 of the 2026HTSRev21 extraction has 0 running headers; expected exactly one.'],
  ])('fails an empty extraction %j instead of comparing it', (text, message) => {
    expect(() => stripRunningHeaders(text, '2026HTSRev21')).toThrowError(
      new VerificationError(message),
    );
  });
});

describe('body comparison', () => {
  it('reports no difference for identical bodies', () => {
    expect(diffLines(strippedPages, [...strippedPages])).toEqual([]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('prints one changed line with its body line number', () => {
    const edited = strippedPages.map((line) =>
      line === 'Russian Federation' ? 'Russian Federatiom' : line,
    );
    expect(diffLines(strippedPages, edited)).toEqual([
      '@@ -8,1 +8,1 @@',
      '-Russian Federation',
      '+Russian Federatiom',
    ]);
  });

  it.each([
    ['abc', 'ac', ['@@ -2,1 +2,0 @@', '-b']],
    ['ac', 'abc', ['@@ -2,0 +2,1 @@', '+b']],
    ['ab', 'xb', ['@@ -1,1 +1,1 @@', '-a', '+x']],
    ['ab', 'ax', ['@@ -2,1 +2,1 @@', '-b', '+x']],
    ['xx', 'xxx', ['@@ -3,0 +3,1 @@', '+x']],
    ['aba', 'aa', ['@@ -2,1 +2,0 @@', '-b']],
    ['abcd', 'xbcy', ['@@ -1,4 +1,4 @@', '-a', '-b', '-c', '-d', '+x', '+b', '+c', '+y']],
  ])('spans every difference between one-letter lines %j and %j', (reviewed, target, expected) => {
    expect(diffLines([...reviewed], [...target])).toEqual(expected);
  });
});

describe('download guards', () => {
  it('derives the reviewed edition URL exactly as pinned in program data', () => {
    expect(generalNote3PdfUrl(decoderSourceEdition)).toBe(generalNote3Url);
    expect(generalNote3PdfUrl('2026HTSRev23')).toBe(
      'https://hts.usitc.gov/reststop/file?release=2026HTSRev23&filename=General%20Note%203',
    );
  });

  it('accepts a 200 body carrying the PDF signature', async () => {
    const bytes = await readPdf(pdfResponse('body'), '2026HTSRev23');
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7 body');
  });

  it.each([
    [htmlResponse(503), 'USITC returned HTTP 503 for General Note 3 in 2026HTSRev23.'],
    [
      new Response('%PDF-1.7 moved', { status: 302, headers: { location: '/elsewhere' } }),
      'USITC returned HTTP 302 for General Note 3 in 2026HTSRev23.',
    ],
    [
      htmlResponse(200),
      'USITC returned text/html instead of a PDF for General Note 3 in 2026HTSRev23.',
    ],
    [
      new Response(new Uint8Array()),
      'USITC returned an untyped body instead of a PDF for General Note 3 in 2026HTSRev23.',
    ],
  ])('rejects a non-200 or non-PDF response %#', async (response, message) => {
    await expect(readPdf(response, '2026HTSRev23')).rejects.toThrowError(
      new VerificationError(message),
    );
  });

  it('names the poppler install when pdftotext is missing', async () => {
    vi.stubEnv('PATH', '/nonexistent');
    try {
      await expect(extractWithPdftotext(new TextEncoder().encode('%PDF-1.7'))).rejects.toThrowError(
        new VerificationError(
          'pdftotext was not found on PATH; install poppler (brew install poppler, or apt install poppler-utils).',
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('verifyGeneralNote3', () => {
  it('compares the live current edition, paced, and prints the entry to add on a match', async () => {
    const run = harness(
      {
        [currentReleaseUrl]: () => Response.json({ name: '2026HTSRev24' }),
        [reviewedUrl]: () => pdfResponse('reviewed'),
        [generalNote3PdfUrl('2026HTSRev24')]: () => pdfResponse('target'),
      },
      { '%PDF-1.7 reviewed': extraction(header(21)), '%PDF-1.7 target': extraction(header(24)) },
    );
    await expect(verifyGeneralNote3(undefined, run.dependencies)).resolves.toEqual({
      exitCode: 0,
      lines: [
        `General Note 3 in 2026HTSRev24 matches the reviewed 2026HTSRev21 text (${strippedPages.length} body lines compared).`,
        "Add to verifiedEditions in src/services/reference/program-data.ts: '2026HTSRev24'",
      ],
    });
    expect(run.events).toEqual([
      `fetch ${currentReleaseUrl}`,
      'wait 1000',
      `fetch ${reviewedUrl}`,
      'wait 1000',
      `fetch ${generalNote3PdfUrl('2026HTSRev24')}`,
    ]);
    expect(run.inits).toHaveLength(3);
    for (const init of run.inits)
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });

  it('says so when a matching edition is already listed', async () => {
    const run = harness(
      {
        [reviewedUrl]: () => pdfResponse('reviewed'),
        [generalNote3PdfUrl('2026HTSRev23')]: () => pdfResponse('target'),
      },
      { '%PDF-1.7 reviewed': extraction(header(21)), '%PDF-1.7 target': extraction(header(23)) },
    );
    const result = await verifyGeneralNote3('2026HTSRev23', run.dependencies);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.lines[1]).toBe(
      "'2026HTSRev23' is already covered by decoderSourceEdition or verifiedEditions in src/services/reference/program-data.ts.",
    );
    expect(run.events).toEqual([
      `fetch ${reviewedUrl}`,
      'wait 1000',
      `fetch ${generalNote3PdfUrl('2026HTSRev23')}`,
    ]);
  });

  it('exits 1 with the diff when one body line changed', async () => {
    const edited = pages.map((lines) =>
      lines.map((line) => (line === 'Russian Federation' ? 'Russian Federatiom' : line)),
    );
    const run = harness(
      {
        [reviewedUrl]: () => pdfResponse('reviewed'),
        [generalNote3PdfUrl('2026HTSRev23')]: () => pdfResponse('target'),
      },
      {
        '%PDF-1.7 reviewed': extraction(header(21)),
        '%PDF-1.7 target': extraction(header(23), edited),
      },
    );
    await expect(verifyGeneralNote3('2026HTSRev23', run.dependencies)).resolves.toEqual({
      exitCode: 1,
      lines: [
        'General Note 3 in 2026HTSRev23 differs from the reviewed 2026HTSRev21 text; review it before adding the edition to verifiedEditions.',
        '--- 2026HTSRev21',
        '+++ 2026HTSRev23',
        '@@ -8,1 +8,1 @@',
        '-Russian Federation',
        '+Russian Federatiom',
      ],
    });
  });

  it.each([
    ['the reviewed edition is not a PDF', () => htmlResponse(200), () => pdfResponse('target'), 1],
    ['the target edition is not served', () => pdfResponse('reviewed'), () => htmlResponse(503), 2],
  ])('fails before any extraction when %s', async (_case, reviewed, target, fetches) => {
    const run = harness(
      { [reviewedUrl]: reviewed, [generalNote3PdfUrl('2022HTSABasic')]: target },
      { '%PDF-1.7 reviewed': extraction(header(21)), '%PDF-1.7 target': extraction(header(21)) },
    );
    await expect(verifyGeneralNote3('2022HTSABasic', run.dependencies)).rejects.toBeInstanceOf(
      VerificationError,
    );
    expect(run.events.filter((event) => event.startsWith('fetch'))).toHaveLength(fetches);
    expect(run.extract).not.toHaveBeenCalled();
  });

  it('fails when the target extraction loses a running header on a later page', async () => {
    const run = harness(
      {
        [reviewedUrl]: () => pdfResponse('reviewed'),
        [generalNote3PdfUrl('2026HTSRev23')]: () => pdfResponse('target'),
      },
      {
        '%PDF-1.7 reviewed': extraction(header(21)),
        '%PDF-1.7 target': extraction(header(23)).replace(
          `\f${header(23)}\nRepublic`,
          '\fRepublic',
        ),
      },
    );
    await expect(verifyGeneralNote3('2026HTSRev23', run.dependencies)).rejects.toThrowError(
      new VerificationError(
        'Page 2 of the 2026HTSRev23 extraction has 0 running headers; expected exactly one.',
      ),
    );
  });

  it('fails when the live current edition cannot be read', async () => {
    const run = harness({ [currentReleaseUrl]: () => htmlResponse(503) }, {});
    await expect(verifyGeneralNote3(undefined, run.dependencies)).rejects.toThrowError(
      new VerificationError('USITC currentRelease returned HTTP 503.'),
    );
    expect(run.extract).not.toHaveBeenCalled();
  });
});

describe('CLI entry', () => {
  /** Run `main` with console output captured, restoring `process.exitCode` afterwards. */
  async function runMain(target: string | undefined, dependencies: VerifyDependencies) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
      await main(target, dependencies);
      return { exitCode: process.exitCode, log: log.mock.calls.flat(), error: error.mock.calls };
    } finally {
      process.exitCode = saved;
      log.mockRestore();
      error.mockRestore();
    }
  }
  const edited = pages.map((lines) =>
    lines.map((line) => (line === 'Russian Federation' ? 'Russian Federatiom' : line)),
  );
  const rev23 = (target: string[][]) =>
    harness(
      {
        [reviewedUrl]: () => pdfResponse('reviewed'),
        [generalNote3PdfUrl('2026HTSRev23')]: () => pdfResponse('target'),
      },
      {
        '%PDF-1.7 reviewed': extraction(header(21)),
        '%PDF-1.7 target': extraction(header(23), target),
      },
    );

  it.each([
    [
      'exit 0 with the coverage line on a match',
      pages,
      0,
      [
        `General Note 3 in 2026HTSRev23 matches the reviewed 2026HTSRev21 text (${strippedPages.length} body lines compared).`,
        "'2026HTSRev23' is already covered by decoderSourceEdition or verifiedEditions in src/services/reference/program-data.ts.",
      ],
    ],
    [
      'exit 1 with the diff on a changed body line',
      edited,
      1,
      [
        'General Note 3 in 2026HTSRev23 differs from the reviewed 2026HTSRev21 text; review it before adding the edition to verifiedEditions.',
        '--- 2026HTSRev21',
        '+++ 2026HTSRev23',
        '@@ -8,1 +8,1 @@',
        '-Russian Federation',
        '+Russian Federatiom',
      ],
    ],
  ])('prints every result line and sets %s', async (_case, target, exitCode, lines) => {
    await expect(runMain('2026HTSRev23', rev23(target).dependencies)).resolves.toEqual({
      exitCode,
      log: lines,
      error: [],
    });
  });

  it('sets exit 2 and prints only the message when the check fails with a VerificationError', async () => {
    const run = harness({ [currentReleaseUrl]: () => htmlResponse(503) }, {});
    await expect(runMain(undefined, run.dependencies)).resolves.toEqual({
      exitCode: 2,
      log: [],
      error: [['USITC currentRelease returned HTTP 503.']],
    });
  });

  it('sets exit 2 and prints the error itself when the check cannot run for another reason', async () => {
    const failure = new TypeError('fetch failed');
    const run = harness(
      {
        [currentReleaseUrl]: () => {
          throw failure;
        },
      },
      {},
    );
    await expect(runMain(undefined, run.dependencies)).resolves.toEqual({
      exitCode: 2,
      log: [],
      error: [[failure]],
    });
  });
});
