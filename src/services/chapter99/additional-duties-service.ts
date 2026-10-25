/**
 * @fileoverview Edition-safe Chapter 99 candidate, evidence and complete-passage research.
 * @module services/chapter99/additional-duties-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { conflict, validationError } from '@cyanheads/mcp-ts-core/errors';
import { normalizeCode, normalizeCountryCode } from '../reference/reference-service.js';
import { buildHeadingTree, type HeadingNode } from '../tariffs/heading-tree.js';
import { digestValue, packPage, readCursor } from '../tariffs/pagination.js';
import type { Source, TariffRow } from '../usitc/types.js';
import type { UsitcService } from '../usitc/usitc-service.js';
import {
  buildChapter99Index,
  type Chapter99Evidence,
  type Chapter99Index,
  findChapter99Evidence,
  getChapter99Fragments,
} from './chapter99-index.js';

const TOOL = 'usitc_check_additional_duties';
const TTL_MS = 15 * 60_000;
const NOT_COMPUTED = [
  'in-force status',
  'stacking and precedence',
  'exclusions and exemptions',
  'origin qualification',
  'effective-date and in-transit conditions',
  'derivative-product inclusion',
  'content/value tests',
  'quota status',
  'CBP determinations',
  'combined duties',
];
const ZERO_NOTICE =
  'No Chapter 99 candidates were identified by the supported parser. Coverage is partial and this does not establish absence of additional duties. Call usitc_get_heading for the base classification and usitc_list_reference with topic identifiers for coverage guidance.';
const UNMAPPED_NOTICE =
  'Matching Chapter 99 passages could not be linked safely to a heading. Call usitc_check_additional_duties with a returned noteId to inspect the full supporting passages.';

/** One selected collection, or one source passage, with no duplicated evidence arrays. */
export interface AdditionalDutyInput {
  candidateCode?: string | undefined;
  code: string;
  countryCode?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  noteCursor?: string | undefined;
  noteId?: string | undefined;
  view?: 'candidates' | 'evidence' | 'unmapped' | undefined;
}
type Arguments = {
  code: string;
  countryCode?: string;
  view: 'candidates' | 'evidence' | 'unmapped';
  candidateCode?: string;
  noteId?: string;
  limit: number;
};
type FollowUp = {
  tool: typeof TOOL;
  arguments: {
    code: string;
    countryCode?: string;
    view?: 'evidence' | 'unmapped';
    candidateCode?: string;
    noteId?: string;
    noteCursor?: string;
    limit?: number;
    cursor?: string;
  };
};
type Evidence = Omit<
  Chapter99Evidence,
  'kind' | 'matchedCode' | 'matchLevel' | 'noteId' | 'noteLocator' | 'passageId'
> & {
  kind: Chapter99Evidence['kind'] | 'footnote';
  matchedCode?: string;
  matchLevel?: Chapter99Evidence['matchLevel'];
  noteId?: string;
  noteLocator?: string;
  passageId?: string;
  scope?: 'unresolved';
  footnote?: NonNullable<TariffRow['footnotes']>[number];
  sourceNodeId?: string;
  sourceScope?: 'selected_row' | 'ancestor' | 'inherited_rate_source';
  inheritedColumns?: string[];
  followUp: FollowUp | { tool: 'usitc_get_heading'; arguments: { code: string; nodeId: string } };
};
type CompletedIndex = {
  charset: string;
  index: Chapter99Index;
  rates: Map<string, TariffRow>;
  digest: string;
  snapshotId: string;
  expiresAt: number;
  source: Source;
  ratesSourceUrl: string;
  notices: string[];
};

function normalize(input: AdditionalDutyInput): Arguments {
  const code = normalizeCode(input.code, [8, 10]);
  if (code.chapter === '99')
    throw validationError('Use an eight- or ten-digit base commodity number outside Chapter 99.', {
      reason: 'invalid_code',
    });
  const countryCode = normalizeCountryCode(input.countryCode);
  const view = input.view ?? 'candidates';
  const candidateCode = input.candidateCode?.trim()
    ? normalizeCode(input.candidateCode, [8]).code
    : undefined;
  const noteId = input.noteId?.trim() || undefined;
  if (candidateCode && (!candidateCode.startsWith('99') || view !== 'evidence'))
    throw validationError('candidateCode must be a Chapter 99 number and requires view evidence.', {
      reason: 'invalid_selector',
    });
  if (view === 'evidence' && !candidateCode)
    throw validationError('view evidence requires a returned candidateCode.', {
      reason: 'invalid_selector',
    });
  if (noteId && (candidateCode || input.cursor?.trim() || view !== 'candidates'))
    throw validationError(
      'Use noteId with code and optional countryCode, limit and noteCursor only.',
      { reason: 'invalid_selector' },
    );
  if (input.noteCursor?.trim() && !noteId)
    throw validationError('noteCursor requires its returned noteId.', {
      reason: 'invalid_selector',
    });
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw validationError('limit must be an integer from 1 through 500.', {
      reason: 'invalid_selector',
    });
  return {
    code: code.code,
    ...(countryCode && { countryCode }),
    view,
    ...(candidateCode && { candidateCode }),
    ...(noteId && { noteId }),
    limit,
  };
}

/** One bounded completed index per source service; raw HTML and per-product results are never stored. */
export class AdditionalDutiesService {
  private completed: CompletedIndex | undefined;
  private readonly source: UsitcService;
  constructor(source: UsitcService) {
    this.source = source;
  }

  /** Verify the exact commodity row and expose every supported reference through a bounded selected view. */
  async check(input: AdditionalDutyInput, ctx: Context) {
    const args = normalize(input);
    const code = normalizeCode(args.code, [8, 10]);
    const cursor = readCursor(args.noteId ? input.noteCursor : input.cursor, TOOL, args);
    const assembled = await this.source.assemble(ctx, async (session) => {
      ctx.signal?.throwIfAborted();
      if (
        this.completed &&
        (this.completed.expiresAt <= Date.now() ||
          this.completed.index.release !== session.release.name)
      )
        this.completed = undefined;
      const cached = this.completed;
      if (cursor && (!cached || !cursor.snapshotId.startsWith(`${cached.snapshotId}~`)))
        throw conflict(
          'The completed Chapter 99 index expired, was evicted, or changed edition. Repeat without a cursor.',
          { reason: 'cursor_expired' },
        );
      const base = cursor
        ? await session.getRowsSnapshot(cursor.snapshotId.slice(cursor.snapshotId.indexOf('~') + 1))
        : await session.getHeading(code.heading);
      const nodes = buildHeadingTree(base.rows, code.heading);
      const row = nodes.find(
        (node) => node.htsno && normalizeCode(node.htsno).digits === code.digits,
      );
      if (!row) return { base, nodes, row, completed: undefined };
      if (cached) return { base, nodes, row, completed: cached };
      const rates = await session.getChapter('99');
      const notes = await session.getChapter99Source();
      const index = buildChapter99Index(notes.html, {
        release: session.release.name,
        sourceDigest: notes.digest,
      });
      const digest = digestValue([index.sourceDigest, rates.digest, index.coverage.parserVersion]);
      const completed: CompletedIndex = {
        charset: notes.charset,
        index,
        rates: new Map(
          rates.rows.flatMap((rate) =>
            rate.htsno ? [[normalizeCode(rate.htsno).digits, rate] as const] : [],
          ),
        ),
        digest,
        snapshotId: `chapter99:${digest}`,
        expiresAt: Date.now() + TTL_MS,
        source: notes.source,
        ratesSourceUrl: rates.source.scheduleUrl,
        notices: [...new Set([...rates.notices, ...notes.notices])],
      };
      return { base, nodes, row, completed };
    });
    const { base, nodes, row, completed } = assembled.data;
    const follow = (selector: Omit<FollowUp['arguments'], 'code' | 'countryCode'>): FollowUp => ({
      tool: TOOL,
      arguments: {
        code: args.code,
        ...(args.countryCode && { countryCode: args.countryCode }),
        ...selector,
      },
    });
    const unmappedFollowUp = follow({ view: 'unmapped' });
    if (!row || !completed) {
      const guidance =
        'No exact rate line or statistical number matched. Call usitc_get_heading with the containing 4-digit heading to inspect its valid descendants.';
      const result = {
        release: assembled.release,
        source: base.source,
        notices: assembled.notices,
        code: args.code,
        found: false,
        view: args.noteId ? ('notes' as const) : args.view,
        page: { total: 0, returned: 0, effectiveLimit: Math.min(args.limit, 100) },
        coverage: {
          status: 'partial' as const,
          parserVersion: 'not_run',
          sourceDigest: '',
          supportedGrammar: [] as string[],
          totalNoteBlocks: 0,
          parsedListBlocks: 0,
          unresolvedReferenceBlocks: 0,
          ambiguousBlocks: 0,
          unmappedEvidenceCount: 0,
          unmappedFollowUp,
          limitations: [
            'No notes search was performed because this exact base number does not exist.',
          ],
        },
        notComputed: NOT_COMPUTED,
        guidance,
      };
      return { result, notice: guidance };
    }
    // Publish only an index whose complete source assembly passed the edition post-check.
    this.completed = completed;
    const base8 = this.verifiedParent(row, nodes, code.digits);
    const found = findChapter99Evidence(completed.index, {
      code: code.digits,
      ...(base8 && { verifiedBase8: base8 }),
      ...(args.countryCode && { countryCode: args.countryCode }),
    });
    const evidence: Evidence[] = found.evidence.map((item) => ({
      ...item,
      followUp: follow({ noteId: item.noteId }),
    }));
    const unmapped: Evidence[] = found.unmappedEvidence.map((item) => ({
      ...item,
      followUp: follow({ noteId: item.noteId }),
    }));
    const referenced = new Set([...evidence, ...unmapped].map((item) => item.noteId));
    for (const passage of completed.index.passages) {
      ctx.signal?.throwIfAborted();
      if (
        !passage.compilerNotice ||
        referenced.has(passage.noteId) ||
        passage.codeMentions.some((mention) => !mention.startsWith('99'))
      )
        continue;
      unmapped.push({
        kind: 'compiler_notice',
        relation: 'context_only',
        role: 'qualification',
        scope: 'unresolved',
        noteId: passage.noteId,
        noteLocator: passage.noteLocator,
        passageId: passage.passageId,
        statusMention: passage.statusMention,
        countryRelation: args.countryCode ? 'unknown' : 'not_requested',
        followUp: follow({ noteId: passage.noteId }),
      });
    }
    evidence.push(...this.footnotes(row, nodes, code.digits, code.heading, args.countryCode));
    const grouped = new Map<string, Evidence[]>();
    for (const item of evidence) {
      if (!item.sourceCode) {
        unmapped.push(item);
        continue;
      }
      const key = normalizeCode(item.sourceCode, [8]).digits;
      const entries = grouped.get(key) ?? [];
      entries.push(item);
      grouped.set(key, entries);
    }
    const candidates = [...grouped].map(([digits, items]) => {
      const rate = completed.rates.get(digits);
      const conflictingCountryScope =
        items.some((item) => item.countryRelation === 'named') &&
        items.some((item) => item.countryRelation === 'different_country');
      const countryRelation = !args.countryCode
        ? ('not_requested' as const)
        : conflictingCountryScope
          ? ('unknown' as const)
          : items.some((item) => item.countryRelation === 'named')
            ? ('named' as const)
            : items.every((item) => item.countryRelation === 'different_country')
              ? ('different_country' as const)
              : ('unknown' as const);
      return {
        code: normalizeCode(digits).code,
        headingResolved: rate !== undefined,
        ...(rate && { description: rate.description, publishedRates: rate.publishedRates }),
        sourceUrl: completed.ratesSourceUrl,
        evidenceCount: items.length,
        compilerNoticeCount: items.filter((item) => item.kind === 'compiler_notice').length,
        evidenceFollowUp: follow({ view: 'evidence', candidateCode: normalizeCode(digits).code }),
        countryRelation,
        ...(countryRelation === 'different_country' && {
          countryNotice:
            'Outside the recognized exclusive country scope; evidence is retained for research.',
        }),
        legalStatus: 'not_determined' as const,
      };
    });
    if (args.countryCode) {
      const order = { named: 0, unknown: 1, different_country: 2, not_requested: 3 };
      candidates.sort((left, right) => order[left.countryRelation] - order[right.countryRelation]);
    }
    const coverage = {
      ...found.coverage,
      unmappedEvidenceCount: unmapped.length,
      unmappedFollowUp,
    };
    const common = {
      release: assembled.release,
      source: completed.source,
      normalization: {
        charset: completed.charset,
        textRule:
          'Decode the declared charset using the Web Encoding Standard; decode HTML entities; emit each text node once in document order, with line breaks at block and table-row boundaries and tabs between cells.',
      },
      notices: [...new Set([...assembled.notices, ...completed.notices, ...coverage.limitations])],
      code: args.code,
      found: true,
      baseLine: {
        code: args.code,
        nodeId: row.nodeId,
        dutyFollowUp: {
          tool: 'usitc_lookup_duty_rate' as const,
          arguments: {
            code: args.code,
            ...(args.countryCode && { countryCode: args.countryCode }),
          },
        },
      },
      coverage,
      notComputed: NOT_COMPUTED,
      countryFilter: {
        mode: 'retain_unknown' as const,
        ...(args.countryCode && { countryCode: args.countryCode }),
        namedCount: candidates.filter((item) => item.countryRelation === 'named').length,
        unknownCount: candidates.filter((item) => item.countryRelation === 'unknown').length,
        differentCountryCount: candidates.filter(
          (item) => item.countryRelation === 'different_country',
        ).length,
      },
      collectionTotals: {
        candidates: candidates.length,
        evidence: evidence.length,
        unmappedEvidence: unmapped.length,
      },
    };
    const identity = {
      tool: TOOL,
      args,
      edition: assembled.release.name,
      digest: digestValue([completed.digest, base.digest]),
      snapshotId: `${completed.snapshotId}~${base.snapshotId}`,
      expiresAt: completed.expiresAt,
      limit: args.limit,
      ...(cursor && { cursor }),
    };
    const notice =
      candidates.length === 0 ? (unmapped.length ? UNMAPPED_NOTICE : ZERO_NOTICE) : undefined;
    if (args.noteId) {
      const noteId = args.noteId;
      if (![...evidence, ...unmapped].some((item) => item.noteId === args.noteId))
        throw validationError(
          'noteId is not supporting evidence for this commodity and country query. Repeat without noteId to obtain valid passage references.',
          { reason: 'note_not_found' },
        );
      const fragments = getChapter99Fragments(completed.index, args.noteId);
      const result = packPage({
        ...identity,
        items: fragments,
        build: (selected, page) => ({
          ...common,
          view: 'notes' as const,
          page,
          notesPage: {
            noteId,
            fragments: selected,
            totalFragments: page.total,
            returnedFragments: page.returned,
            context:
              'Retrieve all fragments and linked governing/qualification passages before interpreting this source.',
            ...(page.nextCursor && {
              nextNoteCursor: page.nextCursor,
              nextCall: follow({
                noteId,
                noteCursor: page.nextCursor,
                limit: args.limit,
              }),
            }),
          },
        }),
      });
      return { result, notice: undefined };
    }
    if (args.view === 'evidence' && args.candidateCode) {
      const candidateCode = args.candidateCode;
      const items = grouped.get(normalizeCode(candidateCode, [8]).digits);
      if (!items)
        throw validationError(
          'candidateCode must be returned by this commodity query. Repeat view candidates to obtain current candidate numbers.',
          { reason: 'invalid_selector' },
        );
      const result = packPage({
        ...identity,
        items,
        build: (selected, page) => ({
          ...common,
          view: 'evidence' as const,
          candidateCode,
          evidence: selected,
          page,
          ...(page.nextCursor && {
            nextCall: follow({
              view: 'evidence',
              candidateCode,
              limit: args.limit,
              cursor: page.nextCursor,
            }),
          }),
        }),
      });
      return { result, notice: undefined };
    }
    if (args.view === 'unmapped') {
      const result = packPage({
        ...identity,
        items: unmapped,
        build: (selected, page) => ({
          ...common,
          view: 'unmapped' as const,
          unmappedEvidence: selected,
          page,
          ...(page.nextCursor && {
            nextCall: follow({ view: 'unmapped', limit: args.limit, cursor: page.nextCursor }),
          }),
        }),
      });
      return { result, notice: undefined };
    }
    const result = packPage({
      ...identity,
      items: candidates,
      ...(notice && { notice }),
      build: (selected, page) => ({
        ...common,
        view: 'candidates' as const,
        candidates: selected,
        page,
        ...(page.nextCursor && {
          nextCall: follow({ limit: args.limit, cursor: page.nextCursor }),
        }),
      }),
    });
    return { result, notice };
  }

  private verifiedParent(
    row: HeadingNode,
    nodes: HeadingNode[],
    digits: string,
  ): string | undefined {
    if (digits.length !== 10) return undefined;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    let parent = row.parentId ? byId.get(row.parentId) : undefined;
    while (parent) {
      if (parent.htsno && normalizeCode(parent.htsno).digits === digits.slice(0, 8))
        return digits.slice(0, 8);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return undefined;
  }

  private footnotes(
    row: HeadingNode,
    nodes: HeadingNode[],
    digits: string,
    heading: string,
    countryCode: string | undefined,
  ): Evidence[] {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const selected = new Map<
      string,
      { node: HeadingNode; scope: NonNullable<Evidence['sourceScope']>; columns: string[] }
    >();
    selected.set(row.nodeId, { node: row, scope: 'selected_row', columns: [] });
    let parent = row.parentId ? byId.get(row.parentId) : undefined;
    while (parent) {
      selected.set(parent.nodeId, { node: parent, scope: 'ancestor', columns: [] });
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    for (const entry of selected.values())
      for (const [column, resolved] of Object.entries(row.resolvedRates)) {
        if (resolved.state !== 'inherited' || resolved.sourceNodeId !== entry.node.nodeId) continue;
        entry.scope = 'inherited_rate_source';
        entry.columns.push(column);
      }
    const result: Evidence[] = [];
    for (const entry of selected.values())
      for (const footnote of entry.node.footnotes ?? []) {
        const pointers = [
          ...new Set(
            [
              ...(footnote.value ?? '').matchAll(
                /(?<![\w.])(?:99\d{2}\.\d{2}\.\d{2}|99\d{6})(?![\w.])/g,
              ),
            ].map((match) => normalizeCode(match[0], [8]).code),
          ),
        ];
        for (const pointer of pointers)
          result.push({
            kind: 'footnote',
            relation: 'context_only',
            role: 'mention',
            sourceCode: pointer,
            matchedCode: digits,
            matchLevel: entry.scope === 'inherited_rate_source' ? 'rate_line' : 'exact',
            countryRelation: countryCode ? 'unknown' : 'not_requested',
            statusMention: /\b(?:expired|terminated|suspended)\b/i.test(footnote.value ?? ''),
            sourceNodeId: entry.node.nodeId,
            sourceScope: entry.scope,
            ...(entry.columns.length && { inheritedColumns: entry.columns }),
            footnote,
            followUp: {
              tool: 'usitc_get_heading',
              arguments: { code: heading, nodeId: entry.node.nodeId },
            },
          });
      }
    return result;
  }
}

const services = new WeakMap<UsitcService, AdditionalDutiesService>();
/** Reuse exactly one derived Chapter 99 index for each initialized source service. */
export function getAdditionalDutiesService(source: UsitcService): AdditionalDutiesService {
  let service = services.get(source);
  if (!service) {
    service = new AdditionalDutiesService(source);
    services.set(source, service);
  }
  return service;
}
