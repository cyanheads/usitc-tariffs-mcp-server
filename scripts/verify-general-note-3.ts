#!/usr/bin/env bun
/**
 * @fileoverview Maintainer check that an edition's General Note 3 text matches the reviewed
 * edition (`decoderSourceEdition`). Run `bun run scripts/verify-general-note-3.ts [edition]`; the
 * edition defaults to the live current release. Both PDFs are downloaded at least one second
 * apart and extracted with poppler's `pdftotext`; exactly one running header is removed from each
 * page and the remaining lines are compared.
 *
 * Exit 0: the text matches; prints the `verifiedEditions` entry. Exit 1: the text differs; prints
 * the diff, and the edition needs a new review. Exit 2: the check could not run.
 * The server never imports this file.
 * @module scripts/verify-general-note-3
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decoderSourceEdition, verifiedEditions } from '../src/services/reference/program-data.js';
import { releaseRecordSchema } from '../src/services/usitc/types.js';

const ORIGIN = 'https://hts.usitc.gov';
const REQUEST_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const PROGRAM_DATA = 'src/services/reference/program-data.ts';
/** pdftotext opens every page with this line; editions differ only in the revision number. */
const RUNNING_HEADER =
  /^Harmonized Tariff Schedule of the United States(?: Revision \d+)? \(\d{4}\)$/;
const runFile = promisify(execFile);

/** An expected failure the CLI reports as a message rather than a stack trace. */
export class VerificationError extends Error {
  override name = 'VerificationError';
}

/** I/O the check performs; tests substitute all three to run without network or poppler. */
export interface VerifyDependencies {
  extract: (pdf: Uint8Array) => Promise<string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  wait: (ms: number) => Promise<void>;
}

/** Lines for the maintainer; exit code 0 when the text matches, 1 when it differs. */
export interface VerifyResult {
  exitCode: 0 | 1;
  lines: string[];
}

/** Official General Note 3 PDF for an edition; the reviewed edition's URL is `generalNote3Url`. */
export function generalNote3PdfUrl(edition: string): string {
  return `${ORIGIN}/reststop/file?release=${encodeURIComponent(edition)}&filename=General%20Note%203`;
}

/**
 * Body lines of a pdftotext extraction, whose pages each end with a form feed, after removing
 * each page's running header. A page without exactly one header, or an extraction without pages,
 * fails: two failed extractions must never compare equal.
 */
export function stripRunningHeaders(text: string, edition: string): string[] {
  const pages = text.split('\f');
  if (pages.at(-1) === '') pages.pop();
  if (pages.length === 0)
    throw new VerificationError(`The ${edition} extraction contains no pages.`);
  return pages.flatMap((page, index) => {
    const lines = page.split('\n');
    // A newline terminates its line, so a page ending in one has no further line.
    if (lines.at(-1) === '') lines.pop();
    const body = lines.filter((line) => !RUNNING_HEADER.test(line));
    const headers = lines.length - body.length;
    if (headers !== 1)
      throw new VerificationError(
        `Page ${index + 1} of the ${edition} extraction has ${headers} running headers; expected exactly one.`,
      );
    return body;
  });
}

/**
 * One unified-diff hunk spanning the first through the last differing line, numbered from 1
 * after header removal; empty when the bodies are identical.
 */
export function diffLines(reviewed: readonly string[], target: readonly string[]): string[] {
  let start = 0;
  while (start < reviewed.length && start < target.length && reviewed[start] === target[start])
    start++;
  if (start === reviewed.length && start === target.length) return [];
  let end = 0;
  while (
    end < reviewed.length - start &&
    end < target.length - start &&
    reviewed[reviewed.length - 1 - end] === target[target.length - 1 - end]
  )
    end++;
  const removed = reviewed.slice(start, reviewed.length - end);
  const added = target.slice(start, target.length - end);
  return [
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
}

/** PDF bytes of a 200 response; another status or a body without the `%PDF-` signature fails. */
export async function readPdf(response: Response, edition: string): Promise<Uint8Array> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new VerificationError(
      `USITC returned HTTP ${response.status} for General Note 3 in ${edition}.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new VerificationError(
      `USITC returned ${response.headers.get('content-type') ?? 'an untyped body'} instead of a PDF for General Note 3 in ${edition}.`,
    );
  return bytes;
}

/** Text of a PDF from poppler's pdftotext, so both editions go through the same extractor. */
export async function extractWithPdftotext(pdf: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'general-note-3-'));
  try {
    const file = join(directory, 'general-note-3.pdf');
    await writeFile(file, pdf);
    const { stdout } = await runFile('pdftotext', ['-enc', 'UTF-8', file, '-'], {
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new VerificationError(
        'pdftotext was not found on PATH; install poppler (brew install poppler, or apt install poppler-utils).',
        { cause: error },
      );
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Compare General Note 3 in `target` (default: the live current edition) with the reviewed
 * edition. Both downloads are validated before either extraction runs.
 */
export async function verifyGeneralNote3(
  target: string | undefined,
  dependencies: VerifyDependencies,
): Promise<VerifyResult> {
  const get = (url: string) =>
    dependencies.fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  let edition = target;
  if (edition === undefined) {
    const response = await get(`${ORIGIN}/reststop/currentRelease`);
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new VerificationError(`USITC currentRelease returned HTTP ${response.status}.`);
    }
    edition = releaseRecordSchema.parse(await response.json()).name;
    await dependencies.wait(REQUEST_GAP_MS);
  }
  const reviewedPdf = await readPdf(
    await get(generalNote3PdfUrl(decoderSourceEdition)),
    decoderSourceEdition,
  );
  await dependencies.wait(REQUEST_GAP_MS);
  const targetPdf = await readPdf(await get(generalNote3PdfUrl(edition)), edition);
  const reviewed = stripRunningHeaders(
    await dependencies.extract(reviewedPdf),
    decoderSourceEdition,
  );
  const current = stripRunningHeaders(await dependencies.extract(targetPdf), edition);
  const diff = diffLines(reviewed, current);
  if (diff.length > 0)
    return {
      exitCode: 1,
      lines: [
        `General Note 3 in ${edition} differs from the reviewed ${decoderSourceEdition} text; review it before adding the edition to verifiedEditions.`,
        `--- ${decoderSourceEdition}`,
        `+++ ${edition}`,
        ...diff,
      ],
    };
  return {
    exitCode: 0,
    lines: [
      `General Note 3 in ${edition} matches the reviewed ${decoderSourceEdition} text (${current.length} body lines compared).`,
      edition === decoderSourceEdition || verifiedEditions.includes(edition)
        ? `'${edition}' is already covered by decoderSourceEdition or verifiedEditions in ${PROGRAM_DATA}.`
        : `Add to verifiedEditions in ${PROGRAM_DATA}: '${edition}'`,
    ],
  };
}

/**
 * CLI entry: run the check, print its lines, and set `process.exitCode` (0 match, 1 diff, 2 the
 * check could not run). A {@link VerificationError} prints its message alone; any other failure
 * prints the error itself.
 */
export async function main(
  target: string | undefined,
  dependencies: VerifyDependencies,
): Promise<void> {
  try {
    const result = await verifyGeneralNote3(target, dependencies);
    for (const line of result.lines) console.log(line);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof VerificationError ? error.message : error);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[2], { fetch, extract: extractWithPdftotext, wait: (ms) => delay(ms) });
