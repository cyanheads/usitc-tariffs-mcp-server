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
} from '@/services/chapter99/chapter99-index.js';
import {
  chapterNote,
  note18,
  note20,
  note31,
} from '../../fixtures/chapter99/official-structure.js';

const source = { release: '2026HTSRev21', sourceDigest: 'literal-response-byte-digest' };

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
