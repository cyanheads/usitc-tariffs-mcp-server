/**
 * @fileoverview Schema patterns for caller identifiers: accepted and rejected forms, agreement with
 * the handler normalizers, JSON Schema emission and CPU growth.
 * @module tests/services/reference/input-patterns.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_CODE_INPUT,
  CHAPTER_INPUT,
  CODE_INPUT,
  CODE_PREFIX_INPUT,
  COUNTRY_INPUT,
  type InputPattern,
  normalizeChapter,
  normalizeCode,
  normalizeCodePrefix,
  normalizeCountryCode,
  QUERY_INPUT,
} from '@/services/reference/reference-service.js';

const fields = {
  code: {
    input: CODE_INPUT,
    message:
      'Write the code as 4, 6, 8 or 10 digits, bare or dotted at the conventional HTS boundaries: 8507, 8507.60, 8507.60.00, 8507.60.00.30 or 8507.60.0030.',
    accepted: [
      '8507',
      ' 8507 ',
      '850760',
      '8507.60',
      '85076000',
      '8507.60.00',
      '8507600030',
      '8507.60.00.30',
      '8507.60.0030',
      '\t8507.60\n',
    ],
    rejected: ['8507 60', '8507-60', '85.07', '', '850', '8507.6', '８５０７', '8507.60.00.30.10'],
  },
  candidateCode: {
    input: CANDIDATE_CODE_INPUT,
    message:
      'Use a returned Chapter 99 candidate number, bare or dotted (99038803 or 9903.88.03), or omit candidateCode.',
    accepted: ['', '   ', ' 99038803 ', '9903.88.03', '9903.88.0300'],
    rejected: ['9903-88-03', '9903 88 03', '99'],
  },
  countryCode: {
    input: COUNTRY_INPUT,
    message:
      'Use a two-letter ISO 3166-1 alpha-2 country code such as CN or DE, or omit countryCode.',
    accepted: ['cn', ' CN ', '', '   ', 'zz'],
    rejected: ['China', 'C', 'ıt', 'CHN', '1A', 'c n'],
  },
  chapter: {
    input: CHAPTER_INPUT,
    message: 'Use a chapter number from 01 through 99, written as one or two digits (8, 08 or 85).',
    accepted: ['1', '01', ' 85 ', '99', '0', '00'],
    rejected: ['', '8 5', '100', '   ', '1.0', '-1'],
  },
  query: {
    input: QUERY_INPUT,
    message: 'Supply nonblank commodity text or an HTS code prefix.',
    accepted: ['battery', ' 8507 ', '\tx', 'lithium-ion 8507 batteries'],
    rejected: ['', '   ', '\n\t\r'],
  },
  codePrefix: {
    input: CODE_PREFIX_INPUT,
    message:
      'Use a two-digit chapter or a four-, six- or eight-digit code, bare or dotted (61, 6109, 6109.10 or 6109.10.00), or omit codePrefix.',
    accepted: [
      '61',
      ' 61 ',
      '6109',
      '610910',
      '6109.10',
      '61091000',
      '6109.10.00',
      '',
      '   ',
      '\t6109\n',
    ],
    rejected: [
      '6',
      '6109.10.00.04',
      '6109100004',
      '61-09',
      '6109 10',
      '61.09',
      '6109.1',
      '610',
      '6109.10.0030',
    ],
  },
} satisfies Record<
  string,
  { input: InputPattern; message: string; accepted: string[]; rejected: string[] }
>;

const parse = ({ pattern, message }: InputPattern, value: string) =>
  z.string().regex(pattern, message).safeParse(value);

function accepts(normalize: () => unknown): boolean {
  try {
    normalize();
    return true;
  } catch {
    return false;
  }
}

/** Outer padding drawn from both ends of the whitespace set, plus line terminators. */
const paddings = ['', ' ', '\t', '\n', '\r\n', ' ', ' ', '　', '﻿', ' \t\n '];
function padded(cores: readonly string[]): string[] {
  return cores.flatMap((core) =>
    paddings.flatMap((left) => paddings.map((right) => `${left}${core}${right}`)),
  );
}

describe('identifier input patterns', () => {
  for (const [field, { input, message, accepted, rejected }] of Object.entries(fields)) {
    it.each(accepted)(`${field} accepts %j`, (value) => {
      expect(parse(input, value).success).toBe(true);
    });
    it.each(rejected)(`${field} rejects %j with a message naming the accepted forms`, (value) => {
      const result = parse(input, value);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([message]);
    });
    it(`${field} reaches JSON Schema as a flagless pattern`, () => {
      expect(input.pattern.flags).toBe('');
      expect(input.message).toBe(message);
      expect(z.toJSONSchema(z.string().regex(input.pattern, input.message))).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'string',
        pattern: input.pattern.source,
      });
    });
  }

  it('treats exactly the characters String.prototype.trim removes as pattern whitespace', () => {
    const disagreements: string[] = [];
    for (let point = 0; point <= 0xffff; point++) {
      const character = String.fromCharCode(point);
      if (/^\s$/.test(character) !== (character.trim() === ''))
        disagreements.push(point.toString(16));
    }
    expect(disagreements).toEqual([]);
  });

  it('code and candidateCode accept exactly the syntax normalizeCode accepts', () => {
    const corpus = padded([
      ...fields.code.accepted,
      ...fields.code.rejected,
      '8507..60',
      '8507.60.000',
      '+8507',
      '8507x',
      '850760003010',
      '8507 60',
      '99038803',
    ]);
    for (const value of corpus) {
      const syntax = accepts(() => normalizeCode(value));
      expect(CODE_INPUT.pattern.test(value), JSON.stringify(value)).toBe(syntax);
      expect(CANDIDATE_CODE_INPUT.pattern.test(value), JSON.stringify(value)).toBe(
        syntax || value.trim() === '',
      );
    }
  });

  it('codePrefix accepts exactly the forms normalizeCodePrefix accepts', () => {
    for (const value of padded([
      ...fields.codePrefix.accepted,
      ...fields.codePrefix.rejected,
      '00',
      '６１',
      '6109..10',
      '61091',
    ]))
      expect(CODE_PREFIX_INPUT.pattern.test(value), JSON.stringify(value)).toBe(
        accepts(() => normalizeCodePrefix(value)),
      );
  });

  it('chapter rejects nothing normalizeChapter accepts and leaves only 0 and 00 to it', () => {
    for (const value of padded([...fields.chapter.accepted, ...fields.chapter.rejected, '０１'])) {
      const pattern = CHAPTER_INPUT.pattern.test(value);
      const handler = accepts(() => normalizeChapter(value));
      if (handler) expect(pattern, JSON.stringify(value)).toBe(true);
      if (pattern && !handler) expect(['0', '00']).toContain(value.trim());
    }
  });

  it('countryCode rejects only non-ASCII forms that uppercase onto an assigned code', () => {
    const narrowed = new Set<string>();
    for (const value of padded([
      ...fields.countryCode.accepted,
      ...fields.countryCode.rejected,
      'ß',
      'ﬁ',
      'ſe',
      'é',
      'c n',
    ])) {
      const pattern = COUNTRY_INPUT.pattern.test(value);
      let reason: string | undefined;
      try {
        normalizeCountryCode(value);
      } catch (error) {
        reason = (error as { data?: { reason?: string } }).data?.reason ?? 'unclassified';
      }
      if (pattern) expect([undefined, 'invalid_country']).toContain(reason);
      else if (reason === undefined) narrowed.add(value.trim());
    }
    expect([...narrowed].sort()).toEqual(['ıt', 'ſe', 'ß', 'ﬁ'].sort());
  });
});

/** Thread CPU microseconds; a descheduled thread accrues none. */
function cpuMicros(): number {
  const { user, system } = process.threadCpuUsage();
  return user + system;
}

/** Least per-call CPU over three batches, each doubled until it spans 2 ms. */
function perCallMicros(pattern: RegExp, text: string): number {
  let least = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (let calls = 1; ; calls *= 2) {
      const started = cpuMicros();
      for (let index = 0; index < calls; index++) pattern.test(text);
      const used = cpuMicros() - started;
      if (used >= 2_000 || calls >= 1 << 22) {
        least = Math.min(least, used / calls);
        break;
      }
    }
  }
  return least;
}

const timed: Record<string, RegExp> = {
  code: CODE_INPUT.pattern,
  candidateCode: CANDIDATE_CODE_INPUT.pattern,
  countryCode: COUNTRY_INPUT.pattern,
  chapter: CHAPTER_INPUT.pattern,
  query: QUERY_INPUT.pattern,
  codePrefix: CODE_PREFIX_INPUT.pattern,
};
const shapes: Record<string, (size: number) => string> = {
  whitespace_then_refused: (size) => `${' '.repeat(size - 1)}x`,
  code_whitespace_then_refused: (size) => `8507${' '.repeat(size - 5)}x`,
  long_line_then_break: (size) => `${'§1 x'.repeat(size / 4)}\ny`,
  breaks_throughout: (size) => `${'  \r\n'.repeat(size / 4)}x`,
  digit_run: (size) => '1'.repeat(size),
};
const BASE_SIZE = 5_000;
/** Generous linear budget: a quarter microsecond of thread CPU per input character. */
const MICROS_PER_CHARACTER = 0.25;

describe('identifier input pattern CPU growth', () => {
  it.each(
    Object.keys(timed).flatMap((field) => Object.keys(shapes).map((shape) => [field, shape])),
  )(
    '%s stays linear on %s across a 64-fold span',
    (field, shape) => {
      const pattern = timed[field]!;
      const build = shapes[shape]!;
      const growth: number[] = [];
      for (let size = BASE_SIZE * 2; size <= BASE_SIZE * 64; size *= 2) {
        let least = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 2; pair++) {
          // The baseline is re-timed beside each larger size so both run on the same core class.
          const baseline = perCallMicros(pattern, build(BASE_SIZE));
          const larger = perCallMicros(pattern, build(size));
          expect(larger).toBeLessThan(size * MICROS_PER_CHARACTER);
          least = Math.min(least, larger / Math.max(baseline, 0.01));
        }
        growth.push(least);
        // Checked before the next doubling, so super-linear growth fails at a small size.
        expect(least).toBeLessThan(256);
      }
      console.info(
        JSON.stringify({
          runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
          field,
          shape,
          growth: growth.map((ratio) => Number(ratio.toFixed(1))),
        }),
      );
    },
    0,
  );

  it.each(Object.keys(timed))(
    '%s answers 40,000 spaces followed by x within a few milliseconds',
    (field) => {
      expect(perCallMicros(timed[field]!, `${' '.repeat(40_000)}x`)).toBeLessThan(5_000);
    },
    0,
  );
});
