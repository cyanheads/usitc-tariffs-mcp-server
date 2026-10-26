/** @fileoverview Legal indentation, exact prefix selection and column inheritance behavior. */
import { describe, expect, it } from 'vitest';
import {
  buildHeadingTree,
  headingSections,
  isSectionMarker,
  resolveDutyNode,
  selectHeadingNodes,
  summarizeChapter,
} from '@/services/tariffs/heading-tree.js';
import { baseRows, normalizedRows } from '../../fixtures/tariffs/base-rows.js';

describe('published heading hierarchy', () => {
  it('bounds source title scanning across malformed delimiters, overlapping prefixes and line breaks', () => {
    const next = normalizedRows([{ htsno: '3901', indent: '0', description: 'Root' }])[0]!;
    const marker = normalizedRows([{ superior: 'true', indent: '2', description: '' }])[0]!;
    for (const form of [
      (size: number) => 'I'.repeat(size),
      (size: number) => 'I.'.repeat(size / 2),
      (size: number) => 'I. '.repeat(Math.ceil(size / 3)),
      (size: number) => `I.${' '.repeat(size)}\n `,
      (size: number) => `I.${' \n'.repeat(size / 2)}`,
      (size: number) => `I. ${'A'.repeat(size)}\n `,
    ]) {
      const measurements: number[] = [];
      for (const size of [5_000, 20_000, 80_000, 320_000]) {
        const row = { ...marker, description: form(size) };
        const expected = row.description.startsWith('I. I.') || row.description.startsWith('I. A');
        for (let index = 0; index < 20; index++) expect(isSectionMarker(row, next)).toBe(expected);
        const start = process.threadCpuUsage();
        for (let index = 0; index < 200; index++) isSectionMarker(row, next);
        const elapsed = process.threadCpuUsage(start);
        const cpuUs = elapsed.user + elapsed.system;
        expect(cpuUs).toBeLessThan(2_000_000);
        measurements.push(cpuUs);
      }
      expect(measurements[3]! / Math.max(measurements[0]!, 1)).toBeLessThan(256);
    }
  });
  it.each([
    ['28', 'I. CHEMICAL ELEMENTS', '2801', '1'],
    ['29', 'XIII. OTHER ORGANIC COMPOUNDS', '2940.00', '1'],
    ['39', 'I. PRIMARY FORMS', '3901', '2'],
    ['63', 'II. NEEDLECRAFT SETS', '6308.00.00', '1'],
    [
      '69',
      'I. GOODS OF SILICEOUS FOSSIL MEALS OR OF SIMILAR SILICEOUS EARTHS, AND REFRACTORY GOODS',
      '6901.00.00.00',
      '3',
    ],
    ['71', 'II. PRECIOUS METALS AND METALS CLAD WITH PRECIOUS METAL', '7106', '1'],
    ['72', 'III. STAINLESS STEEL', '7218', '1'],
  ])(
    'recognizes the captured chapter %s title/root shape',
    (chapter, description, htsno, indent) => {
      const rows = normalizedRows([
        { indent, description, superior: 'true' },
        { htsno, indent: '0', description: 'Published root' },
      ]);
      expect(headingSections(rows)).toEqual([rows[0]]);
      const nodes = buildHeadingTree(rows, htsno!.slice(0, 4));
      expect(nodes.map((node) => node.sourceOrdinal)).toEqual([1]);
      expect(summarizeChapter(rows, chapter!)[0]).toMatchObject({
        subchapter: description,
        statisticalLineCount: htsno!.replaceAll('.', '').length === 10 ? 1 : 0,
      });
    },
  );
  it('retains Roman-prefix inner superiors and requires the published title position and flag', () => {
    const rows = normalizedRows([
      { htsno: '8507', indent: '0', description: 'Root' },
      { superior: 'true', indent: '1', description: 'I. Other products' },
      { htsno: '8507.60.00', indent: '2', description: 'Rate', general: 'Free' },
    ]);
    const nodes = buildHeadingTree(rows, '8507');
    expect(nodes[2]?.parentId).toBe(rows[1]!.nodeId);
    expect(headingSections(rows)).toEqual([]);
    expect(isSectionMarker({ ...rows[1]!, description: 'I. OTHER PRODUCTS' }, rows[2])).toBe(false);
    expect(
      isSectionMarker({ ...rows[1]!, superior: null, description: 'I. OTHER PRODUCTS' }, rows[0]),
    ).toBe(false);
  });

  it('keeps sourced section changes between Chapter 99 roots out of their legal ancestry', () => {
    const rows = normalizedRows([
      { indent: '1', superior: 'true', description: 'I. FIRST SECTION' },
      { htsno: '9903.01.01', indent: '0', description: 'First root' },
      { indent: '2', superior: 'true', description: 'II. NEXT SECTION' },
      { htsno: '9903.02.01', indent: '0', description: 'Next root' },
    ]);
    expect(buildHeadingTree(rows, '9903').map((node) => node.parentId)).toEqual([
      undefined,
      undefined,
    ]);
    expect(summarizeChapter(rows, '99').map((entry) => entry.subchapter)).toEqual([
      'I. FIRST SECTION',
      'II. NEXT SECTION',
    ]);
  });
  it.each([
    ['8505.90.75', '8505.90.75.01'],
    ['8505.90.75.01', '8505.90.75.01'],
    ['8505.90.75.99', undefined],
    ['8505.90.80', undefined],
    ['8505.90.80.10', '8505.90.80.10'],
    ['8505.90.90', '8505.90.90'],
  ])('resolves %s to the verified source row %s', (request, expected) => {
    const nodes = buildHeadingTree(
      normalizedRows([
        { htsno: '8505', indent: '0', description: 'Root' },
        { htsno: '8505.90.75.01', indent: '1', description: 'Combined', general: 'Free' },
        { htsno: '8505.90.80.10', indent: '1', description: 'Alternative one' },
        { htsno: '8505.90.80.20', indent: '1', description: 'Alternative two' },
        { htsno: '8505.90.90', indent: '1', description: 'Explicit rate', general: '2%' },
        { htsno: '8505.90.90.01', indent: '2', description: 'Explicit suffix', general: '3%' },
      ]),
      '8505',
    );
    const row = resolveDutyNode(nodes, request.replaceAll('.', ''));
    expect(row?.htsno).toBe(expected);
    if (request === '8505.90.75') {
      expect(row).toMatchObject({
        nodeId: 'edition-A:fixture:1',
        sourceOrdinal: 1,
        rateLineCode: '8505.90.75',
        resolvedRates: {
          general: { state: 'published', text: 'Free', sourceHtsno: '8505.90.75.01' },
        },
      });
      expect(row).not.toHaveProperty('parentId', 'invented');
    }
  });
  it('separates published section titles from legal ancestry and preceding subtrees', () => {
    const rows = normalizedRows([
      { indent: '2', superior: 'true', description: 'I. PRIMARY FORMS' },
      { htsno: '3901', indent: '0', description: 'First heading' },
      { htsno: '3901.10.00.00', indent: '1', description: 'Combined line', general: 'Free' },
      { indent: '1', superior: 'true', description: 'II. WASTE AND SCRAP' },
      { htsno: '3902', indent: '0', description: 'Second heading' },
    ]);
    expect(summarizeChapter(rows, '39')).toEqual([
      {
        code: '3901',
        description: 'First heading',
        rateLineCount: 1,
        statisticalLineCount: 1,
        subchapter: 'I. PRIMARY FORMS',
      },
      {
        code: '3902',
        description: 'Second heading',
        rateLineCount: 0,
        statisticalLineCount: 0,
        subchapter: 'II. WASTE AND SCRAP',
      },
    ]);
    const nodes = buildHeadingTree(rows.slice(0, 3), '3901');
    expect(nodes.map((node) => node.sourceOrdinal)).toEqual([1, 2]);
    expect(nodes[0]).not.toHaveProperty('parentId');
  });

  it('counts unique combined rate lines without merging ambiguous statistical alternatives', () => {
    const rows = normalizedRows([
      { htsno: '8505', indent: '0', description: 'Root' },
      { htsno: '8505.90.75.01', indent: '1', description: 'Combined', general: 'Free' },
      { htsno: '8505.90.80.10', indent: '1', description: 'Alternative one' },
      { htsno: '8505.90.80.20', indent: '1', description: 'Alternative two' },
    ]);
    expect(summarizeChapter(rows, '85')).toEqual([
      { code: '8505', description: 'Root', rateLineCount: 1, statisticalLineCount: 3 },
    ]);
  });
  it('keeps unnamed ancestors and inherits every blank column only from the matching eight-digit ancestor', () => {
    const nodes = buildHeadingTree(normalizedRows(baseRows), '8507');
    expect(nodes[4]).toMatchObject({
      parentId: 'edition-A:fixture:3',
      parentFollowUp: {
        tool: 'usitc_get_heading',
        arguments: { code: '8507', nodeId: 'edition-A:fixture:3' },
      },
      resolvedRates: {
        general: {
          state: 'inherited',
          text: '3.4%',
          sourceNodeId: 'edition-A:fixture:2',
          sourceHtsno: '8507.60.00',
        },
        special: { state: 'inherited', text: 'Free (A*, AU) 2% (ZZ)' },
        column2: { state: 'inherited', text: '35%' },
      },
    });
    expect(nodes[5]!.resolvedRates).toMatchObject({
      general: { state: 'published', text: '1.2%', sourceNodeId: 'edition-A:fixture:5' },
      special: { state: 'inherited' },
      column2: { state: 'published', text: '40%' },
    });
    expect(nodes[8]!.resolvedRates).toEqual({
      general: { state: 'not_published' },
      special: { state: 'not_published' },
      column2: { state: 'not_published' },
    });
    expect(nodes[4]!.resolvedRates.general.sourceFollowUp).toEqual({
      tool: 'usitc_get_heading',
      arguments: { code: '8507', nodeId: 'edition-A:fixture:2' },
    });
  });

  it('selects only the requested branch and keeps unnamed rows without merging duplicate descriptions', () => {
    const nodes = buildHeadingTree(normalizedRows(baseRows), '8507');
    expect(selectHeadingNodes(nodes, '850760').map((node) => node.sourceOrdinal)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(selectHeadingNodes(nodes, '85076000').map((node) => node.sourceOrdinal)).toEqual([
      2, 3, 4, 5,
    ]);
    expect(selectHeadingNodes(nodes, '850799')).toEqual([]);
    expect(summarizeChapter(normalizedRows(baseRows), '85')).toEqual([
      {
        code: '8507',
        description: 'Electric accumulators',
        rateLineCount: 2,
        statisticalLineCount: 3,
      },
    ]);
  });

  it.each(['98', '99'])(
    'preserves independent %s roots and exact six/eight-digit selections',
    (chapter) => {
      const rows = normalizedRows([
        { htsno: `${chapter}03.01.01`, indent: '0', description: 'First root', general: 'Free' },
        { indent: '1', description: 'Unnamed child' },
        { htsno: `${chapter}03.01.01.10`, indent: '2', description: 'Statistical child' },
        { htsno: `${chapter}03.02.01`, indent: '0', description: 'Second root' },
        { htsno: `${chapter}03.03`, indent: '0', description: 'Six-digit root' },
      ]);
      const nodes = buildHeadingTree(rows, `${chapter}03`);
      expect(nodes.filter((node) => !node.parentId).map((node) => node.htsno)).toEqual([
        `${chapter}03.01.01`,
        `${chapter}03.02.01`,
        `${chapter}03.03`,
      ]);
      expect(selectHeadingNodes(nodes, `${chapter}0301`).map((node) => node.sourceOrdinal)).toEqual(
        [0, 1, 2],
      );
      expect(
        selectHeadingNodes(nodes, `${chapter}030201`).map((node) => node.sourceOrdinal),
      ).toEqual([3]);
      expect(selectHeadingNodes(nodes, `${chapter}03`)).toHaveLength(5);
    },
  );

  it.each(['8503.00', '8534.00.00', '8548.00.00.00'])(
    'accepts the actual published root %s without fabricating a four-digit node',
    (htsno) => {
      const heading = htsno.slice(0, 4);
      const nodes = buildHeadingTree(
        normalizedRows([{ htsno, indent: '0', description: 'Published root' }]),
        heading,
      );
      expect(selectHeadingNodes(nodes, heading).map((node) => node.htsno)).toEqual([htsno]);
      expect(nodes[0]).not.toHaveProperty('parentId');
    },
  );

  it('retains nested Chapter 98 rate lines with different prefixes without borrowing another eight-digit rate', () => {
    const nodes = buildHeadingTree(
      normalizedRows([
        { htsno: '9823.03.01', indent: '1', description: 'Parent', general: 'Free' },
        { htsno: '9823.03.02', indent: '2', description: 'Nested rate line' },
        { htsno: '9823.03.02.10', indent: '3', description: 'Statistical child' },
      ]),
      '9823',
    );
    expect(nodes[1]!.parentId).toBe('edition-A:fixture:0');
    expect(nodes[2]!.resolvedRates.general).toEqual({ state: 'not_published' });
  });

  it.each([
    [
      { htsno: '8507', indent: '0', description: 'Root' },
      { htsno: '8507.60', indent: '-1', description: 'Invalid indent' },
    ],
    [
      { htsno: '8507', indent: '0', description: 'Root' },
      { htsno: '8508.10', indent: '1', description: 'Another heading' },
    ],
    [
      { htsno: '8507', indent: '0', description: 'Root' },
      { htsno: '8507', indent: '1', description: 'Duplicate code' },
    ],
  ])('rejects malformed hierarchy with a stable reason', (...rows) => {
    expect(() => buildHeadingTree(normalizedRows(rows), '8507')).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'invalid_hierarchy' }) }),
    );
  });
});
