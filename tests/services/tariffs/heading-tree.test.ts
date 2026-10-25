/** @fileoverview Legal indentation, exact prefix selection and column inheritance behavior. */
import { describe, expect, it } from 'vitest';
import {
  buildHeadingTree,
  selectHeadingNodes,
  summarizeChapter,
} from '@/services/tariffs/heading-tree.js';
import { baseRows, normalizedRows } from '../../fixtures/tariffs/base-rows.js';

describe('published heading hierarchy', () => {
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
