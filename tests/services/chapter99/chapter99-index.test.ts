/**
 * @fileoverview Behavioral coverage of Chapter 99 segmentation, legal-link polarity and lossless fragments.
 * @module tests/services/chapter99/chapter99-index.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  buildChapter99Index,
  findChapter99Evidence,
  getChapter99Fragments,
  productCountry,
} from '@/services/chapter99/chapter99-index.js';
import {
  chapterNote,
  note18,
  note20,
  note31,
  note31Following,
} from '../../fixtures/chapter99/official-structure.js';

const source = { release: '2026HTSRev21', sourceDigest: 'literal-response-byte-digest' };

describe('Chapter 99 scanner CPU growth', () => {
  it.each(['unclosed', 'prefixes', 'openers', 'line_break', 'whitespace_breaks'])(
    'bounds %s scans over a 64-fold input span',
    (shape) => {
      const measurements: { size: number; cpuUs: number }[] = [];
      for (const size of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000]) {
        const unit =
          shape === 'unclosed'
            ? '[Compiler’s note: ['
            : shape === 'prefixes'
              ? '9903.90.08..10 products of Canad '
              : shape === 'openers'
                ? '[[((Heading products of '
                : shape === 'line_break'
                  ? 'x'
                  : ' \n\t';
        const payload =
          unit.repeat(Math.ceil(size / unit.length)).slice(0, size) +
          (shape === 'line_break' ? '\n   ' : '');
        const html = chapterNote(
          1,
          `<ul><li value="(a)">(a) Heading 9903.91.06 applies to products of China that are classified in the following 8-digit subheadings: ${payload}<ul><li value="(1)">(1) 8507.60.00</li></ul></li></ul>`,
        );
        // Warm the same shape before measuring this thread; scheduler delays are excluded.
        buildChapter99Index(html, source);
        const started = process.threadCpuUsage();
        for (let iteration = 0; iteration < 3; iteration++) {
          const index = buildChapter99Index(html, source);
          expect(index.mentions.has('85076000')).toBe(true);
          expect(index.links.length).toBe(shape === 'unclosed' ? 0 : 1);
          expect(productCountry(payload)).toBeUndefined();
        }
        const used = process.threadCpuUsage(started);
        const cpuUs = used.user + used.system;
        measurements.push({ size, cpuUs });
        // Check the absolute bound before trying the next doubled input.
        expect(cpuUs).toBeLessThan(500_000);
      }
      expect(measurements.at(-1)!.cpuUs / Math.max(1, measurements[0]!.cpuUs)).toBeLessThan(256);
      console.info(
        JSON.stringify({
          runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
          shape,
          measurements,
        }),
      );
    },
  );
});

describe('Chapter 99 failure contracts', () => {
  it.each([
    '',
    '<div class="misc_title">CHAPTER 99</div>',
    '<div class="misc_note_title">U.S. Notes</div><li value="1.">1. Text.</li>',
  ])('rejects missing required structure with a stable service reason', (html) => {
    expect(() => buildChapter99Index(html, source)).toThrowError(
      expect.objectContaining({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: expect.objectContaining({ reason: 'notes_structure_changed' }),
      }),
    );
  });
  it('rejects an unknown note selector with its stable reason', () => {
    const index = buildChapter99Index(chapterNote(1, 'Text.'), source);
    expect(() => getChapter99Fragments(index, 'not-a-note')).toThrowError(
      expect.objectContaining({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'note_not_found' },
      }),
    );
  });
});

describe('bounded legal-link grammars', () => {
  it.each([
    [
      '(b)',
      '(a)',
      '(1)',
      'Heading 9903.91.06 applies to products of China that are classified in the following 8-digit subheadings:',
    ],
    [
      '(a)',
      '(a)',
      '(2)',
      'Heading 9903.91.06 applies to products of China that are classified in the following 8-digit subheadings:',
    ],
    [
      '(a)',
      '(a)',
      '(1)',
      'Heading 9903.91.06 and heading 9903.91.05 apply to products of China that are classified in the following 8-digit subheadings:',
    ],
    [
      '(a)',
      '(a)',
      '(1)',
      'Heading 9903.91.06 applies to products of China other than products classified in the following 8-digit subheadings:',
    ],
    [
      '(a)',
      '(a)',
      '(1)',
      'Compiler’s note: Heading 9903.91.06 applies to products of China that are classified in the following 8-digit subheadings:',
    ],
  ])(
    'rejects conflicting labels or unreviewed governor %s/%s/%s/%s',
    (attribute, label, itemAttribute, opening) => {
      const index = buildChapter99Index(
        chapterNote(
          1,
          `<ul><li value="${attribute}">${label} ${opening}<ul><li value="${itemAttribute}">(1) 8507.60.00</li></ul></li></ul>`,
        ),
        source,
      );
      expect(index.links).toEqual([]);
      expect(
        findChapter99Evidence(index, { code: '85076000' }).evidence.some(
          (item) => item.relation === 'inclusion_candidate',
        ),
      ).toBe(false);
    },
  );
  it('does not reach into an unsupported nested numbered item through the outer governor', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Heading 9903.91.06 applies to products of China that are classified in the following 8-digit subheadings:<ul><li value="(1)">(1) Outer text<ul><li value="(1)">(1) 8507.60.00</li></ul></li></ul></li></ul>',
      ),
      source,
    );
    expect(index.links).toEqual([]);
  });
  it.each([
    ['85414200', '99039102'],
    ['87024031', '99039103'],
    ['38180000', '99039105'],
    ['85076000', '99039106'],
    ['81019400', '99039111'],
  ])('links captured following-list product %s only to its governor %s', (code, heading) => {
    const index = buildChapter99Index(note31Following, source);
    const result = findChapter99Evidence(index, { code, countryCode: 'CA' });
    expect(result.evidence.filter((item) => item.relation === 'inclusion_candidate')).toEqual([
      expect.objectContaining({ sourceCode: heading, countryRelation: 'different_country' }),
    ]);
    const governor = result.evidence.find((item) => item.role === 'governing')!;
    expect(
      getChapter99Fragments(index, governor.noteId)
        .map((item) => item.text)
        .join(''),
    ).toContain('effective with respect to goods');
    if (heading === '99039105')
      expect(index.passages.find((item) => item.noteId === governor.noteId)!.locatorStatus).toBe(
        'ambiguous',
      );
    expect(index.coverage.status).toBe('partial');
  });
  it.each(['6307909842', '6307909850'])(
    'retains the descriptive .07 item %s and governor as qualified context',
    (code) => {
      const result = findChapter99Evidence(buildChapter99Index(note31Following, source), {
        code,
        countryCode: 'CN',
      });
      expect(result.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceCode: '99039107',
            role: 'governing',
            relation: 'context_only',
          }),
          expect.objectContaining({ sourceCode: '99039107', role: 'product_list' }),
        ]),
      );
      expect(result.evidence.some((item) => item.relation === 'inclusion_candidate')).toBe(false);
    },
  );
  it.each([
    ['Articles the product of Canada as provided in this heading.', 'CA'],
    ['Products of China that are classified in the following subheadings.', 'CN'],
    [
      'Effective with respect to entries on or after January 1, 2026, articles the product of China, as provided for in subdivision (g) of U.S. note 31 to this subchapter',
      'CN',
    ],
    ['Parts of passenger vehicles and light trucks of the United Kingdom.', undefined],
    ['Except for products described elsewhere, articles the product of Vietnam.', undefined],
    ['Products of Canada and China.', undefined],
    ['Products of Canada or Mexico.', undefined],
    ['Products of Canada; products of Vietnam.', undefined],
    ['If eligible, products of Canada.', undefined],
    ['Products of Canada other than eligible articles.', undefined],
    ['Products of China and products of Canada.', undefined],
  ])('recognizes only reviewed single positive country scope: %s', (text, country) =>
    expect(productCountry(text!)).toBe(country),
  );
  it('links note 20(b) only to the positive heading and keeps governing and exclusion context reachable', () => {
    const index = buildChapter99Index(note20, source);
    const result = findChapter99Evidence(index, { code: '01012100', countryCode: 'CN' });
    expect(index.links.map(({ heading, grammar }) => ({ heading, grammar }))).toEqual([
      { heading: '99038801', grammar: 'same_note_enumeration' },
    ]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceCode: '99038801',
          relation: 'inclusion_candidate',
          role: 'product_list',
          countryRelation: 'named',
        }),
        expect.objectContaining({
          sourceCode: '99038801',
          relation: 'context_only',
          role: 'governing',
        }),
        expect.objectContaining({
          sourceCode: '99038801',
          relation: 'context_only',
          role: 'qualification',
        }),
        expect.objectContaining({
          sourceCode: '99038801',
          relation: 'exclusion_or_exception',
          role: 'mention',
        }),
      ]),
    );
    expect(
      result.evidence.some(
        (item) => item.sourceCode === '99038802' && item.relation === 'inclusion_candidate',
      ),
    ).toBe(false);
    for (const item of result.evidence)
      expect(getChapter99Fragments(index, item.noteId).length).toBeGreaterThan(0);
  });
  it('links note 31(b) code-only table cells to the heading named by its opening clause', () => {
    const result = findChapter99Evidence(buildChapter99Index(note31, source), { code: '72081015' });
    expect(result.evidence).toEqual([
      expect.objectContaining({
        sourceCode: '99039101',
        kind: 'explicit_list_link',
        relation: 'inclusion_candidate',
        matchLevel: 'exact',
      }),
    ]);
  });
  it('recognizes a code-only explicitly labeled enumeration without requiring a table', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Heading 9903.88.01 applies to products described in note 1(b).</li><li value="(b)">(b) 8501.10.00</li></ul>',
      ),
      source,
    );
    expect(findChapter99Evidence(index, { code: '85011000' }).evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'inclusion_candidate',
          matchedCode: '85011000',
          sourceCode: '99038801',
        }),
      ]),
    );
  });
  it.each([
    'Heading 9903.91.01 does not apply to products enumerated in this subdivision:',
    'Heading 9903.91.01 applies to products enumerated in Annex A:',
    'Heading 9903.91.01 applies conditionally to products mentioned here:',
  ])('never infers a positive same-subdivision table from unsupported opening %s', (opening) => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        `<ul><li value="(a)">(a) ${opening}<table><tr><td>7208.10.15</td></tr></table></li></ul>`,
      ),
      source,
    );
    expect(index.links).toEqual([]);
    expect(
      findChapter99Evidence(index, { code: '72081015' }).evidence.every(
        (item) => item.relation !== 'inclusion_candidate',
      ),
    ).toBe(true);
  });
  it('does not promote narrative or range table cells to enumerated product inclusion', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Heading 9903.91.01 applies to products enumerated in this subdivision:<table><tr><td>7208.10.15 through 7208.25.30</td><td>Goods described in 8501.10.00</td><td>9903.91.02</td></tr></table></li></ul>',
      ),
      source,
    );
    expect(index.links).toEqual([]);
    expect(index.passages.flatMap((passage) => passage.listCodes)).toEqual([]);
    expect(findChapter99Evidence(index, { code: '72081015' }).evidence[0]).toMatchObject({
      relation: 'context_only',
      sourceCode: '99039101',
    });
  });
  it('keeps note 18(g)/(h) conditional co-mentions qualified without inclusion', () => {
    const result = findChapter99Evidence(buildChapter99Index(note18, source), {
      code: '85414300',
      countryCode: 'CN',
    });
    expect(
      result.evidence.map(({ sourceCode, relation, countryRelation }) => ({
        sourceCode,
        relation,
        countryRelation,
      })),
    ).toEqual([
      { sourceCode: '99034521', relation: 'context_only', countryRelation: 'unknown' },
      { sourceCode: '99034522', relation: 'exclusion_or_exception', countryRelation: 'unknown' },
    ]);
  });
  it.each([
    'except',
    'other than',
    'excluding',
    'does not apply to',
    'shall not apply to',
    'not subject to',
  ])('does not turn a %s list reference into inclusion', (negative) => {
    const html = chapterNote(
      1,
      `<ul><li value="(a)">(a) Heading 9903.88.01 ${negative} products described in note 1(b).</li><li value="(b)">(b) <table><tr><td>0101.21.00</td></tr></table></li></ul>`,
    );
    const result = findChapter99Evidence(buildChapter99Index(html, source), { code: '01012100' });
    expect(result.evidence.filter((item) => item.relation === 'inclusion_candidate')).toEqual([]);
    expect(result.unmappedEvidence).toHaveLength(1);
  });
  it.each([
    'Heading 9903.88.01 applies to products described in note 2(b).',
    'Heading 9903.88.01 applies to products described in note 1(b) to subchapter IV.',
    'Heading 9903.88.01 and heading 9903.88.02 apply to products described in note 1(b).',
    'See Annex A for heading 9903.88.01.',
  ])('leaves unsupported or nonlocal table linkage unmapped: %s', (clause) => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        `<ul><li value="(a)">(a) ${clause}</li><li value="(b)">(b) <table><tr><td>7208.10.15</td></tr></table></li></ul>`,
      ),
      source,
    );
    const result = findChapter99Evidence(index, { code: '72081015' });
    expect(index.links).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.unmappedEvidence).toHaveLength(1);
  });
  it('does not link an ungoverned table merely because a sibling names a heading', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Heading 9903.88.01 applies subject to conditions.</li><li value="(b)">(b) <table><tr><td>7208.10.15</td></tr></table></li></ul>',
      ),
      source,
    );
    expect(findChapter99Evidence(index, { code: '72081015' }).unmappedEvidence).toHaveLength(1);
    expect(index.links).toEqual([]);
  });
  it('retains known different-country and unknown-country evidence', () => {
    const named = findChapter99Evidence(buildChapter99Index(note20, source), {
      code: '01012100',
      countryCode: 'CA',
    });
    expect(
      named.evidence.some(
        (item) =>
          item.relation === 'inclusion_candidate' && item.countryRelation === 'different_country',
      ),
    ).toBe(true);
    const unknown = findChapter99Evidence(buildChapter99Index(note31, source), {
      code: '72081015',
      countryCode: 'CA',
    });
    expect(unknown.evidence[0]?.countryRelation).toBe('unknown');
  });
});

describe('exact code matching and precision', () => {
  it('accepts complete sentence-final tokens while rejecting malformed continuations', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '9903.90.08. 7208.10.15. 7208.10.15.00. x9903.90.09. 9903.90.10.1 9903.90.11..10 9903.90.121',
      ),
      source,
    );
    expect([...index.mentions.keys()]).toEqual(['99039008', '72081015', '7208101500']);
  });
  it('recognizes dotted and undotted tokens but never substrings or expanded ranges', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '9903.88.01 concerns 0101.21.00, 0101290010; range 7208.10.15 through 7208.25.30; embedded x85414300, 18541430000 and 854143001234.',
      ),
      source,
    );
    expect([...index.mentions.keys()].sort()).toEqual([
      '01012100',
      '0101290010',
      '72081015',
      '72082530',
      '99038801',
    ]);
    expect(findChapter99Evidence(index, { code: '72081016' }).evidence).toEqual([]);
    expect(findChapter99Evidence(index, { code: '85414300' }).unmappedEvidence).toEqual([]);
  });
  it('requires a verified eight-digit parent to extend a list to a ten-digit request', () => {
    const index = buildChapter99Index(note20, source);
    expect(findChapter99Evidence(index, { code: '0101210010' }).evidence).toEqual([]);
    const result = findChapter99Evidence(index, { code: '0101210010', verifiedBase8: '01012100' });
    expect(result.evidence.filter((item) => item.role === 'product_list')).toEqual([
      expect.objectContaining({ matchedCode: '01012100', matchLevel: 'rate_line' }),
    ]);
    expect(() =>
      findChapter99Evidence(index, { code: '0101210010', verifiedBase8: '01012900' }),
    ).toThrow();
  });
  it('marks narrower statistical lists without extending them to sibling statistical numbers', () => {
    const index = buildChapter99Index(note20, source);
    expect(findChapter99Evidence(index, { code: '01012900' }).evidence[0]).toMatchObject({
      matchedCode: '0101290010',
      matchLevel: 'statistical_subset',
    });
    expect(
      findChapter99Evidence(index, { code: '0101290020', verifiedBase8: '01012900' }).evidence,
    ).toEqual([]);
  });
  it.each(['99038801', '0101', '0101210', '010121000', '01012100100', '0101.21.00'])(
    'rejects invalid normalized base input %s',
    (code) => {
      expect(() => findChapter99Evidence(buildChapter99Index(note20, source), { code })).toThrow();
    },
  );
});

describe('passages and fragments', () => {
  it('links only directly owned numbered code-only following-list entries and retains the complete governor', () => {
    const html = chapterNote(
      1,
      '<ul><li value="(a)">(a) Heading 9903.91.06 applies to products of China that are classified in the following 8-digit subheadings:<ul><li value="(1)">(1) 8507.60.00</li><li value="(2)">(2) Other than 8505.11.00</li><li value="(3)">(3) 2504.10.10 and 2504.10.50</li></ul></li><li value="(b)">(b) Other scope<ul><li value="(1)">(1) 8501.10.00</li></ul></li></ul>',
    );
    const index = buildChapter99Index(html, source);
    const result = findChapter99Evidence(index, { code: '85076000', countryCode: 'CN' });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceCode: '99039106',
          relation: 'inclusion_candidate',
          countryRelation: 'named',
        }),
        expect.objectContaining({ role: 'governing', relation: 'context_only' }),
      ]),
    );
    const governor = result.evidence.find((item) => item.role === 'governing')!;
    expect(
      getChapter99Fragments(index, governor.noteId)
        .map((item) => item.text)
        .join(''),
    ).toContain('following 8-digit subheadings:');
    for (const code of ['85051100', '25041010', '85011000'])
      expect(
        findChapter99Evidence(index, { code }).evidence.some(
          (item) => item.relation === 'inclusion_candidate',
        ),
      ).toBe(false);
  });
  it('preserves every nested text node once, source uncertainty, entities, row tabs and block breaks', () => {
    const html = chapterNote(
      1,
      'Before <span>nested <b>maté &amp; ? null</b></span><div>block</div><table><tr><td>first</td><td>second</td></tr><tr><td>third</td><td>fourth</td></tr></table> after.',
    );
    const index = buildChapter99Index(html, source);
    const text = index.passages.map((passage) => passage.text).join('');
    expect(text.match(/nested/g)).toHaveLength(1);
    expect(text).toContain('Before nested maté & ? null\nblock\n');
    expect(text).toContain('first\tsecond\t\n\nthird\tfourth\t');
    expect(text).toContain(' after.');
  });
  it('keeps repeated subdivision labels ambiguous and cannot attach their table as inclusion', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Heading 9903.88.01 applies to products described in note 1(b).</li><li value="(b)">(b) <table><tr><td>0101.21.00</td></tr></table></li><li value="(b)">(b) <table><tr><td>0101.29.00</td></tr></table></li></ul>',
      ),
      source,
    );
    const repeated = index.passages.filter((passage) =>
      passage.codeMentions.some((code) => ['01012100', '01012900'].includes(code)),
    );
    expect(repeated).toHaveLength(2);
    expect(
      repeated.every(
        (passage) =>
          passage.locatorStatus === 'ambiguous' && !passage.noteNumber && !passage.subdivision,
      ),
    ).toBe(true);
    expect(index.links).toEqual([]);
    expect(findChapter99Evidence(index, { code: '01012100' }).unmappedEvidence).toHaveLength(1);
  });
  it('preserves malformed nesting and mismatched labels as unmapped source context', () => {
    const html = chapterNote(
      1,
      '<ul><li value="(a)">(a) intro<ul><li value="(b)">(x) 9903.88.01 concerns <span>8541.43.00</span></ul>trailing',
    );
    const index = buildChapter99Index(html, source);
    const result = findChapter99Evidence(index, { code: '85414300' });
    expect(result.evidence).toEqual([]);
    expect(result.unmappedEvidence).toHaveLength(1);
    expect(index.passages.map((passage) => passage.text).join('')).toContain('trailing');
  });
  it('keeps a scoped compiler notice context-only and marks status words without legal status', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Heading 9903.88.01 applies to products described in note 1(b).</li><li value="(b)">(b) Compiler’s note: This provision is suspended. <table><tr><td>0101.21.00</td></tr></table></li></ul>',
      ),
      source,
    );
    const result = findChapter99Evidence(index, { code: '01012100' });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'compiler_notice',
          relation: 'context_only',
          statusMention: true,
        }),
      ]),
    );
    expect(result.evidence.every((item) => !Object.hasOwn(item, 'legalStatus'))).toBe(true);
  });
  it('retains unresolved compiler notices in unmapped evidence without assigning their scope to other candidates', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Compiler’s note: 0101.21.00 is suspended under an unresolved amendment.</li><li value="(b)">(b) Heading 9903.88.01 applies to products enumerated in this subdivision: <table><tr><td>0101.21.00</td></tr></table></li></ul>',
      ),
      source,
    );
    const result = findChapter99Evidence(index, { code: '01012100' });
    expect(result.unmappedEvidence).toEqual([
      expect.objectContaining({
        kind: 'compiler_notice',
        relation: 'context_only',
        statusMention: true,
      }),
    ]);
    expect(
      result.evidence
        .filter((item) => item.role === 'product_list')
        .every((item) => !item.statusMention),
    ).toBe(true);
  });
  it('keeps an exclusion quoted in a compiler notice context-only', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        'Compiler’s note: Heading 9903.88.01 does not apply to 0101.21.00 according to the quoted amendment.',
      ),
      source,
    );
    expect(findChapter99Evidence(index, { code: '01012100' }).evidence).toEqual([
      expect.objectContaining({ kind: 'compiler_notice', relation: 'context_only' }),
    ]);
  });
  it('never promotes a compiler notice that quotes a list-link clause into inclusion', () => {
    const index = buildChapter99Index(
      chapterNote(
        1,
        '<ul><li value="(a)">(a) Compiler’s note: Heading 9903.88.01 applies to products described in note 1(b) in the superseded text.</li><li value="(b)">(b) <table><tr><td>0101.21.00</td></tr></table></li></ul>',
      ),
      source,
    );
    const result = findChapter99Evidence(index, { code: '01012100' });
    expect(result.evidence.some((item) => item.relation === 'inclusion_candidate')).toBe(false);
  });
  it('reconstructs a long Unicode table exactly across scalar-safe 2000-byte fragments', () => {
    const cells = 'é😀 &amp; ? null '.repeat(700);
    const index = buildChapter99Index(
      chapterNote(1, `<table><tr><td>${cells}</td><td>last</td></tr></table>`),
      source,
    );
    const passage = index.passages.find((item) => item.noteNumber === '1');
    expect(passage).toBeDefined();
    const fragments = getChapter99Fragments(index, passage!.noteId);
    expect(fragments.length).toBeGreaterThan(5);
    expect(fragments.map((fragment) => fragment.text).join('')).toBe(
      `\n1. \n\n${'é😀 & ? null '.repeat(700)}\tlast\t\n\n\n\n`,
    );
    expect(fragments.map((fragment) => fragment.text).join('')).toBe(passage!.text);
    for (const [ordinal, fragment] of fragments.entries()) {
      expect(fragment.fragmentIndex).toBe(ordinal);
      expect(fragment.fragmentCount).toBe(fragments.length);
      expect(Buffer.byteLength(fragment.text)).toBeLessThanOrEqual(2000);
      expect(fragment.text.isWellFormed()).toBe(true);
    }
  });
  it.each([
    [1994, [2000]],
    [1995, [2000, 1]],
  ])(
    'splits an ASCII passage at the exact UTF-8 byte boundary for %i payload bytes',
    (length, sizes) => {
      const index = buildChapter99Index(chapterNote(1, 'x'.repeat(length)), source);
      const passage = index.passages.find((item) => item.noteNumber === '1');
      const fragments = getChapter99Fragments(index, passage!.noteId);
      expect(fragments.map((fragment) => Buffer.byteLength(fragment.text))).toEqual(sizes);
      expect(fragments.map((fragment) => fragment.text).join('')).toBe(
        `\n1. ${'x'.repeat(length)}\n\n`,
      );
    },
  );
  it('moves a complete multibyte scalar to the next fragment when it cannot fit', () => {
    const index = buildChapter99Index(chapterNote(1, `${'x'.repeat(1993)}😀`), source);
    const passage = index.passages.find((item) => item.noteNumber === '1');
    const fragments = getChapter99Fragments(index, passage!.noteId);
    expect(fragments.map((fragment) => Buffer.byteLength(fragment.text))).toEqual([1997, 6]);
    expect(fragments[1]?.text).toBe('😀\n\n');
  });
  it('binds stable passage IDs to edition, source digest, ordinal and content', () => {
    const html = chapterNote(1, 'source');
    const first = buildChapter99Index(html, source);
    expect(buildChapter99Index(html, source).passages.map((item) => item.noteId)).toEqual(
      first.passages.map((item) => item.noteId),
    );
    for (const changed of [
      { ...source, release: 'other' },
      { ...source, sourceDigest: 'other' },
    ]) {
      const second = buildChapter99Index(html, changed);
      expect(second.passages[0]?.noteId).not.toBe(first.passages[0]?.noteId);
      expect(() => getChapter99Fragments(second, first.passages[0]!.noteId)).toThrow();
    }
    const originalNote = first.passages.find((item) => item.noteNumber === '1');
    const changedNote = buildChapter99Index(chapterNote(1, 'changed source'), source).passages.find(
      (item) => item.noteNumber === '1',
    );
    expect(changedNote?.noteId).not.toBe(originalNote?.noteId);
  });
  it('reports measured partial coverage and an empty result without claiming completeness', () => {
    const index = buildChapter99Index(note31, source);
    const result = findChapter99Evidence(index, { code: '01012100' });
    expect(result.evidence).toEqual([]);
    expect(result.unmappedEvidence).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: 'partial',
      sourceDigest: source.sourceDigest,
      totalNoteBlocks: index.passages.length,
      parsedListBlocks: 1,
      unmappedEvidenceCount: 0,
    });
    expect(result.coverage.limitations.length).toBeGreaterThan(0);
  });
});
