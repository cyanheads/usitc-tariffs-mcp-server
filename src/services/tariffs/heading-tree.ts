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
  rateLineCode?: string;
  resolvedRates: ResolvedRates;
}

/** Published uppercase Roman titles precede numbered roots, independently of title indentation. */
export function isSectionMarker(row: TariffRow, next: TariffRow | undefined): boolean {
  return (
    !row.htsno &&
    row.superior === 'true' &&
    !!next?.htsno &&
    next.indent === 0 &&
    row.description === row.description.toUpperCase() &&
    /^[IVXLCDM]+\.\s+\S/.test(row.description)
  );
}

/** Preserve complete source identities and fields for published section metadata. */
export function headingSections(rows: readonly TariffRow[]): TariffRow[] {
  return rows.filter((row, index) => isSectionMarker(row, rows[index + 1]));
}

/** Prefer exact rows; an absent eight-digit row resolves only through one published suffix. */
export function resolveDutyNode(
  nodes: readonly HeadingNode[],
  digits: string,
): HeadingNode | undefined {
  const exact = nodes.find((node) => node.htsno && normalizeCode(node.htsno).digits === digits);
  if (exact || digits.length !== 8) return exact;
  const rateLineCode = normalizeCode(digits).code;
  return nodes.find((node) => node.rateLineCode === rateLineCode);
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
  for (const [index, row] of rows.entries()) {
    if (!Number.isSafeInteger(row.indent) || row.indent < 0)
      invalid('USITC supplied malformed heading indentation.');
    if (isSectionMarker(row, rows[index + 1])) continue;
    const code = row.htsno ? readSourceCode(row.htsno) : undefined;
    if (code && !code.digits.startsWith(heading))
      invalid('USITC heading export contains a different heading.');
    if (code && seen.has(code.digits))
      invalid('USITC heading export contains duplicate numbered nodes.');
    if (code) seen.add(code.digits);
    for (let top = stack.at(-1); top && top.indent >= row.indent; top = stack.at(-1)) stack.pop();
    const parent = stack.at(-1);
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
      ...(code &&
        (code.length === 8 || rateAncestor) && {
          rateLineCode: normalizeCode(code.digits.slice(0, 8)).code,
        }),
    };
    nodes.push(node);
    stack.push(node);
  }
  const suffixes = new Map<string, HeadingNode | null>();
  for (const node of nodes) {
    if (!node.htsno) continue;
    const code = normalizeCode(node.htsno);
    if (code.length !== 10 || seen.has(code.digits.slice(0, 8))) continue;
    const prefix = code.digits.slice(0, 8);
    suffixes.set(prefix, suffixes.has(prefix) ? null : node);
  }
  for (const [prefix, node] of suffixes) if (node) node.rateLineCode = normalizeCode(prefix).code;
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
  const sections = new Map<string, string>();
  let section: string | undefined;
  let last: TariffRow[] | undefined;
  for (const [index, row] of rows.entries()) {
    if (isSectionMarker(row, rows[index + 1])) {
      section = row.description;
      continue;
    }
    if (row.htsno) {
      const code = readSourceCode(row.htsno);
      if (code.chapter !== chapter) invalid('USITC chapter export contains another chapter.');
      const group = groups.get(code.heading);
      if (group) group.push(row);
      else groups.set(code.heading, [row]);
      if (section) sections.set(row.nodeId, section);
      last = groups.get(code.heading);
    } else {
      if (!last) invalid('USITC chapter export has unnamed rows before a heading.');
      last.push(row);
    }
  }
  return [...groups].flatMap(([code, group]) => {
    const nodes = buildHeadingTree(group, code);
    const normalized = nodes.map((node) => ({
      node,
      code: node.htsno ? normalizeCode(node.htsno) : undefined,
    }));
    const explicit = new Set(
      normalized.flatMap(({ node, code }) =>
        code?.length === 8 && node.rateLineCode ? [node.rateLineCode] : [],
      ),
    );
    const summaries = normalized.map(({ node, code }) => ({
      node,
      code,
      counts: {
        rateLineCount:
          code?.length === 8 || (node.rateLineCode && !explicit.has(node.rateLineCode)) ? 1 : 0,
        statisticalLineCount: code?.length === 10 ? 1 : 0,
      },
    }));
    const byId = new Map(summaries.map((entry) => [entry.node.nodeId, entry]));
    for (const { node, counts: own } of summaries.toReversed()) {
      const parent = node.parentId ? byId.get(node.parentId)?.counts : undefined;
      if (parent) {
        parent.rateLineCount += own.rateLineCount;
        parent.statisticalLineCount += own.statisticalLineCount;
      }
    }
    if (chapter === '98' || chapter === '99')
      return summaries.flatMap(({ node, code: normalizedCode, counts }) => {
        if (!node.htsno) return [];
        if (normalizedCode?.length === 10 && node.rateLineCode && explicit.has(node.rateLineCode))
          return [];
        const subchapter = sections.get(node.nodeId);
        return [
          {
            code: node.htsno,
            description: node.description,
            ...counts,
            ...(subchapter && { subchapter }),
          },
        ];
      });
    const root = summaries[0];
    if (!root) invalid('USITC chapter group has no published root.');
    const subchapter = sections.get(root.node.nodeId);
    return [
      {
        code,
        description: root.node.description,
        ...root.counts,
        ...(subchapter && { subchapter }),
      },
    ];
  });
}
