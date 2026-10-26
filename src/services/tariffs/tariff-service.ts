/**
 * @fileoverview Edition-safe discovery, hierarchy, base-duty and reference research operations.
 * @module services/tariffs/tariff-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { conflict, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  assessCountry,
  listChapterReferences,
  listIdentifierReferences,
  listProgramReferences,
  listQuantityUnits,
  normalizeCode,
  parseSpecialCell,
} from '../reference/reference-service.js';
import type { EditionResult, ReleaseRecord, RowsSnapshot } from '../usitc/types.js';
import type { UsitcService } from '../usitc/usitc-service.js';
import {
  buildHeadingTree,
  headingSections,
  resolveDutyNode,
  selectHeadingNodes,
  summarizeChapter,
} from './heading-tree.js';
import { digestValue, type PageCursor, packPage, validateCursor } from './pagination.js';

/** Published decoder topics, without unsupported historical schedule selection. */
export type ReferenceTopic = 'identifiers' | 'spi' | 'chapters' | 'units' | 'releases';
type StaticReference =
  | ReturnType<typeof listIdentifierReferences>[number]
  | ReturnType<typeof listProgramReferences>[number]
  | ReturnType<typeof listChapterReferences>[number]
  | ReturnType<typeof listQuantityUnits>[number];
type ReleaseSnapshot = EditionResult<ReleaseRecord[]> & {
  digest: string;
  snapshotId: string;
  expiresAt: number;
};
let releases: ReleaseSnapshot | undefined;

/** Research operations reuse the source boundary's bounded schedule snapshot store. */
export class TariffService {
  private readonly source: UsitcService;
  constructor(source: UsitcService) {
    this.source = source;
  }

  private async rows(
    kind: 'search' | 'heading' | 'chapter',
    selector: string,
    cursor: PageCursor | undefined,
    ctx: Context,
  ): Promise<RowsSnapshot> {
    if (cursor) {
      const snapshot = await this.source.getRowsSnapshot(cursor.snapshotId, ctx);
      validateCursor(cursor, {
        edition: snapshot.release.name,
        digest: snapshot.digest,
        snapshotId: snapshot.snapshotId,
      });
      return snapshot;
    }
    const result =
      kind === 'search'
        ? await this.source.search(selector, ctx)
        : kind === 'heading'
          ? await this.source.getHeading(selector, ctx)
          : await this.source.getChapter(selector, ctx);
    return { ...result.data, release: result.release, notices: result.notices };
  }

  /** Flat matches preserve upstream order and never claim resolved blank rates. */
  async search(query: string, limit: number, cursor: PageCursor | undefined, ctx: Context) {
    const snapshot = await this.rows('search', query, cursor, ctx);
    const rows = snapshot.rows.map((row) => ({ ...row, ratesResolved: false as const }));
    const notice =
      rows.length === 0
        ? 'No published matches were found. Broaden query or call usitc_browse_chapter for the relevant chapter; call usitc_list_reference with topic identifiers for code formats.'
        : undefined;
    return {
      notice,
      result: packPage({
        tool: 'usitc_search_hts',
        args: { query, limit },
        edition: snapshot.release.name,
        digest: snapshot.digest,
        snapshotId: snapshot.snapshotId,
        items: rows,
        limit,
        cursor,
        notice,
        build: (selected, page) => ({
          release: snapshot.release,
          source: snapshot.source,
          notices: snapshot.notices,
          query,
          context: 'flat_search_matches' as const,
          rows: selected,
          page,
        }),
      }),
    };
  }

  /** Reconstruct the complete heading, then select the requested numbered subtree or node. */
  async heading(
    code: string,
    nodeId: string | undefined,
    limit: number,
    cursor: PageCursor | undefined,
    ctx: Context,
  ) {
    const normalized = normalizeCode(code, [4, 6, 8]);
    const snapshot = await this.rows('heading', normalized.heading, cursor, ctx);
    const all = buildHeadingTree(snapshot.rows, normalized.heading);
    const scope = selectHeadingNodes(all, normalized.digits);
    let nodes = scope;
    if (nodeId) {
      const node = scope.find((item) => item.nodeId === nodeId);
      if (!node) {
        if (!nodeId.startsWith(`${snapshot.release.name}:`))
          throw conflict('The node belongs to an expired edition.', { reason: 'cursor_expired' });
        throw validationError(
          'nodeId is not in the requested heading or classification subtree. Repeat without nodeId to obtain current identifiers.',
          { reason: 'invalid_cursor' },
        );
      }
      nodes = [node];
    }
    const guidance =
      nodes.length === 0
        ? 'No classification matched this code in this edition. Call usitc_browse_chapter for its chapter, or usitc_search_hts with a broader code prefix.'
        : undefined;
    return {
      notice: guidance,
      result: packPage({
        tool: 'usitc_get_heading',
        args: { code: normalized.code, ...(nodeId && { nodeId }), limit },
        edition: snapshot.release.name,
        digest: snapshot.digest,
        snapshotId: snapshot.snapshotId,
        items: nodes,
        limit,
        cursor,
        notice: guidance,
        build: (selected, page) => ({
          release: snapshot.release,
          source: snapshot.source,
          notices: snapshot.notices,
          code: normalized.code,
          found: nodes.length > 0,
          ...(scope[0] && { rootId: scope[0].nodeId }),
          nodes: selected,
          sections: headingSections(snapshot.rows),
          page,
          ...(guidance && { guidance }),
        }),
      }),
    };
  }

  /** Count all distinct rate/statistical descendants before paging complete heading summaries. */
  async browse(chapter: string, limit: number, cursor: PageCursor | undefined, ctx: Context) {
    const snapshot = await this.rows('chapter', chapter, cursor, ctx);
    const headings = summarizeChapter(snapshot.rows, chapter);
    const notice =
      headings.length === 0
        ? 'No numbered headings were published in this chapter. Call usitc_list_reference with topic chapters to inspect reserved and available chapters.'
        : undefined;
    const notices =
      (chapter === '98' || chapter === '99') && headings.some((entry) => !entry.subchapter)
        ? [
            ...snapshot.notices,
            'The export provides no verified subchapter crosswalk; subchapter grouping is unavailable.',
          ]
        : snapshot.notices;
    return {
      notice,
      result: packPage({
        tool: 'usitc_browse_chapter',
        args: { chapter, limit },
        edition: snapshot.release.name,
        digest: snapshot.digest,
        snapshotId: snapshot.snapshotId,
        items: headings,
        limit,
        cursor,
        notice,
        build: (selected, page) => ({
          release: snapshot.release,
          source: snapshot.source,
          notices,
          chapter,
          headings: selected,
          page,
        }),
      }),
    };
  }

  /** Exact statistical misses remain misses; country never selects a published column. */
  async duty(code: string, countryCode: string | undefined, ctx: Context) {
    const normalized = normalizeCode(code, [8, 10]);
    const snapshot = await this.rows('heading', normalized.heading, undefined, ctx);
    const nodes = buildHeadingTree(snapshot.rows, normalized.heading);
    const row = resolveDutyNode(nodes, normalized.digits);
    const specialPrograms =
      row?.resolvedRates.special.text === undefined
        ? undefined
        : parseSpecialCell(row.resolvedRates.special.text, countryCode);
    const guidance = row
      ? undefined
      : 'No exact rate line or statistical number matched. Call usitc_get_heading with the containing 4-digit heading to inspect its valid descendants.';
    return {
      release: snapshot.release,
      source: snapshot.source,
      notices: snapshot.notices,
      code: normalized.code,
      found: row !== undefined,
      ...(row && { row, resolvedRates: row.resolvedRates }),
      ...(specialPrograms && { specialPrograms }),
      countryAssessment: assessCountry(
        specialPrograms ?? { clauses: [] },
        countryCode,
        snapshot.release.name,
      ),
      chapter99Pointers: {
        countKnown: false as const,
        followUp: {
          tool: 'usitc_check_additional_duties' as const,
          arguments: { code: normalized.code, ...(countryCode && { countryCode }) },
        },
      },
      ...(guidance && { guidance }),
    };
  }

  /** Static tables bind digest and edition without duplicating immutable reference records. */
  async reference(
    topic: ReferenceTopic,
    limit: number,
    cursor: PageCursor | undefined,
    ctx: Context,
  ) {
    if (topic === 'releases') return this.releaseReference(limit, cursor, ctx);
    const metadata = await this.source.getCurrentRelease(ctx);
    const items: readonly StaticReference[] =
      topic === 'identifiers'
        ? listIdentifierReferences()
        : topic === 'spi'
          ? listProgramReferences()
          : topic === 'chapters'
            ? listChapterReferences()
            : listQuantityUnits();
    const digest = digestValue(items);
    const result = packPage({
      tool: 'usitc_list_reference',
      args: { topic, limit },
      edition: metadata.release.name,
      digest,
      snapshotId: `reference:${topic}:${digest}`,
      items,
      limit,
      cursor,
      build: (selected, page) => ({
        release: metadata.release,
        source: metadata.source,
        notices: metadata.notices,
        topic,
        items: selected,
        page,
      }),
    });
    return { result, notice: undefined };
  }

  private async releaseReference(limit: number, cursor: PageCursor | undefined, ctx: Context) {
    const topic = 'releases' as const;
    let snapshot: ReleaseSnapshot;
    if (cursor) {
      const current = await this.source.getCurrentRelease(ctx);
      if (
        !releases ||
        releases.expiresAt <= Date.now() ||
        releases.release.name !== current.release.name
      ) {
        releases = undefined;
        throw conflict(
          'The saved release list expired or the edition changed. Repeat without a cursor.',
          { reason: 'cursor_expired' },
        );
      }
      snapshot = releases;
    } else {
      const metadata = await this.source.getReleases(ctx);
      const digest = digestValue(metadata.data);
      snapshot = {
        ...metadata,
        digest,
        snapshotId: `releases:${digest}`,
        expiresAt: Date.now() + 15 * 60_000,
      };
      releases = snapshot;
    }
    const items = snapshot.data.map((record) => ({
      ...record,
      kind: 'release' as const,
      sourceUrl: 'https://hts.usitc.gov/reststop/releaseList',
    }));
    const notice =
      items.length === 0
        ? 'No entries were found for this topic in the published edition. Call usitc_list_reference with topic identifiers for available reference topics.'
        : undefined;
    return {
      notice,
      result: packPage({
        tool: 'usitc_list_reference',
        args: { topic, limit },
        edition: snapshot.release.name,
        digest: snapshot.digest,
        snapshotId: snapshot.snapshotId,
        items,
        limit,
        cursor,
        expiresAt: snapshot.expiresAt,
        notice,
        build: (selected, page) => ({
          release: snapshot.release,
          source: snapshot.source,
          notices: snapshot.notices,
          topic,
          items: selected,
          page,
        }),
      }),
    };
  }
}
