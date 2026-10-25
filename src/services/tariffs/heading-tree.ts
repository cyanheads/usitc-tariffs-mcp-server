/**
 * @fileoverview Complete-heading ancestry and column-level statistical-rate inheritance.
 * @module services/tariffs/heading-tree
 */
import { internalError, McpError } from '@cyanheads/mcp-ts-core/errors';
import { normalizeCode } from '../reference/reference-service.js';
import type { TariffRow } from '../usitc/types.js';

/** Executable lookup for a source node, including unnamed ancestors. */
export interface NodeFollowUp {
  arguments: { code: string; nodeId: string };
  tool: 'usitc_get_heading';
}
/** Published or inherited column value; absence is never interpreted as Free. */
export interface ResolvedColumn {
  sourceFollowUp?: NodeFollowUp;
  sourceHtsno?: string;
  sourceNodeId?: string;
  state: 'published' | 'inherited' | 'not_published';
  text?: string;
}
/** All three independent published duty columns. */
export interface ResolvedRates {
  column2: ResolvedColumn;
  general: ResolvedColumn;
  special: ResolvedColumn;
}
/** A flat source node with its legal parent and rate provenance. */
export interface HeadingNode extends TariffRow {
  parentFollowUp?: NodeFollowUp;
  parentId?: string;
  resolvedRates: ResolvedRates;
}

function invalid(message: string): never {
  throw internalError(message, { reason: 'invalid_hierarchy', retryable: false });
}

function readSourceCode(value: string) {
  try {
    return normalizeCode(value);
  } catch (cause) {
    if (!(cause instanceof McpError) || cause.data?.reason !== 'invalid_code') throw cause;
    throw internalError(
      'USITC supplied an invalid numbered classification in its heading export.',
      {
        reason: 'invalid_hierarchy',
        retryable: false,
      },
      { cause },
    );
  }
}

/** Build ancestry over the entire containing heading before selecting a subtree. */
export function buildHeadingTree(rows: readonly TariffRow[], heading: string): HeadingNode[] {
  if (rows.length === 0) return [];
  const forest = heading.startsWith('98') || heading.startsWith('99');
  const stack: HeadingNode[] = [];
  const nodes: HeadingNode[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.indent) || row.indent < 0)
      invalid('USITC supplied malformed heading indentation.');
    const code = row.htsno ? readSourceCode(row.htsno) : undefined;
    if (code && !code.digits.startsWith(heading))
      invalid('USITC heading export contains a different heading.');
    if (code && seen.has(code.digits))
      invalid('USITC heading export contains duplicate numbered nodes.');
    if (code) seen.add(code.digits);
    for (let top = stack.at(-1); top && top.indent >= row.indent; top = stack.at(-1)) stack.pop();
    const parent = stack[stack.length - 1];
    if (!forest && nodes.length === 0 && !code?.digits.startsWith(heading))
      invalid('USITC heading export has no numbered root within the heading.');
    if (!forest && nodes.length > 0 && !parent)
      invalid('USITC heading export contains a disconnected root.');
    const numberedParent = stack.findLast((node) => node.htsno);
    if (
      !forest &&
      code &&
      numberedParent?.htsno &&
      !code.digits.startsWith(normalizeCode(numberedParent.htsno).digits)
    )
      invalid('USITC numbered ancestry contradicts code containment.');
    const rateAncestor =
      code?.length === 10
        ? stack.findLast(
            (node) => node.htsno && normalizeCode(node.htsno).digits === code.digits.slice(0, 8),
          )
        : undefined;
    const followUp = (nodeId: string): NodeFollowUp => ({
      tool: 'usitc_get_heading',
      arguments: { code: heading, nodeId },
    });
    const resolve = (column: keyof TariffRow['publishedRates']): ResolvedColumn => {
      const own = row.publishedRates[column];
      if (typeof own === 'string' && own.trim())
        return {
          state: 'published',
          text: own,
          sourceNodeId: row.nodeId,
          ...(row.htsno && { sourceHtsno: row.htsno }),
          sourceFollowUp: followUp(row.nodeId),
        };
      const inherited = rateAncestor?.publishedRates[column];
      if (rateAncestor?.htsno && typeof inherited === 'string' && inherited.trim())
        return {
          state: 'inherited',
          text: inherited,
          sourceNodeId: rateAncestor.nodeId,
          sourceHtsno: rateAncestor.htsno,
          sourceFollowUp: followUp(rateAncestor.nodeId),
        };
      return { state: 'not_published' };
    };
    const node: HeadingNode = {
      ...row,
      ...(parent && { parentId: parent.nodeId, parentFollowUp: followUp(parent.nodeId) }),
      resolvedRates: {
        general: resolve('general'),
        special: resolve('special'),
        column2: resolve('column2'),
      },
    };
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

/** Select a numbered prefix and its actual indented descendants, retaining unnamed rows. */
export function selectHeadingNodes(nodes: readonly HeadingNode[], digits: string): HeadingNode[] {
  if (digits.length === 4)
    return nodes.filter((node) => !node.htsno || normalizeCode(node.htsno).heading === digits);
  const rootIndex = nodes.findIndex(
    (node) => node.htsno && normalizeCode(node.htsno).digits === digits,
  );
  const root = nodes[rootIndex];
  if (!root) {
    let selectedIndent: number | undefined;
    return nodes.filter((node) => {
      if (selectedIndent !== undefined && node.indent > selectedIndent) return true;
      selectedIndent = undefined;
      if (!node.htsno || !normalizeCode(node.htsno).digits.startsWith(digits)) return false;
      selectedIndent = node.indent;
      return true;
    });
  }
  const selected = [root];
  for (const node of nodes.slice(rootIndex + 1)) {
    if (node.indent <= root.indent) break;
    selected.push(node);
  }
  return selected;
}

/** Reduce a complete chapter to numbered heading counts without statistical-row duplication. */
export function summarizeChapter(rows: readonly TariffRow[], chapter: string) {
  const groups = new Map<string, TariffRow[]>();
  for (const row of rows) {
    if (row.htsno) {
      const code = readSourceCode(row.htsno);
      if (code.chapter !== chapter) invalid('USITC chapter export contains another chapter.');
      const group = groups.get(code.heading);
      if (group) group.push(row);
      else groups.set(code.heading, [row]);
    } else {
      const last = [...groups.values()].at(-1);
      if (!last) invalid('USITC chapter export has unnamed rows before a heading.');
      last.push(row);
    }
  }
  return [...groups].flatMap(([code, group]) => {
    const nodes = buildHeadingTree(group, code);
    if (chapter === '98' || chapter === '99')
      return nodes.flatMap((node) => {
        if (!node.htsno) return [];
        const normalized = normalizeCode(node.htsno);
        if (normalized.length === 10) {
          let parent = nodes.find((entry) => entry.nodeId === node.parentId);
          while (parent) {
            if (
              parent.htsno &&
              normalizeCode(parent.htsno).digits === normalized.digits.slice(0, 8)
            )
              return [];
            parent = nodes.find((entry) => entry.nodeId === parent?.parentId);
          }
        }
        const descendants = selectHeadingNodes(nodes, normalizeCode(node.htsno).digits);
        return [
          {
            code: node.htsno,
            description: node.description,
            rateLineCount: descendants.filter(
              (child) => child.htsno && normalizeCode(child.htsno).length === 8,
            ).length,
            statisticalLineCount: descendants.filter(
              (child) => child.htsno && normalizeCode(child.htsno).length === 10,
            ).length,
          },
        ];
      });
    const lengths = nodes.flatMap((node) => (node.htsno ? [normalizeCode(node.htsno).length] : []));
    const root = nodes[0];
    if (!root) invalid('USITC chapter group has no published root.');
    return [
      {
        code,
        description: root.description,
        rateLineCount: lengths.filter((length) => length === 8).length,
        statisticalLineCount: lengths.filter((length) => length === 10).length,
      },
    ];
  });
}
