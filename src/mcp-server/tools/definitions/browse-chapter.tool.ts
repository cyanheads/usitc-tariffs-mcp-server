/**
 * @fileoverview Complete-chapter heading discovery with source-derived descendant counts.
 * @module mcp-server/tools/definitions/browse-chapter.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { normalizeChapter } from '../../../services/reference/reference-service.js';
import { readCursor } from '../../../services/tariffs/pagination.js';
import { TariffService } from '../../../services/tariffs/tariff-service.js';
import { getUsitcService } from '../../../services/usitc/usitc-service.js';
import { enrichmentTrailer, formatSourceData } from '../reply.js';
import { listEnrichment, metadataShape, pageSchema, paginationInputShape } from '../schemas.js';

/** Counts are computed from the complete chapter, including its final statistical suffix. */
export const browseChapterTool = tool('usitc_browse_chapter', {
  title: 'Browse published HTS chapter headings',
  description:
    'Browse numbered headings and complete eight-digit rate-line and ten-digit statistical counts for a chapter. Chapters 98 and 99 expose their actual published numbered entries rather than synthetic four-digit headings; subchapter grouping stays unavailable without a verified crosswalk. Reserved chapters can return a successful empty collection.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    chapter: z.string().describe('Chapter 01–99, accepting one or two digits.'),
    ...paginationInputShape,
  }),
  output: z.object({
    ...metadataShape,
    chapter: z.string().describe('Normalized two-digit chapter.'),
    headings: z
      .array(
        z
          .object({
            code: z.string().describe('Published heading or special-chapter numbered entry.'),
            description: z.string().describe('Complete published description.'),
            rateLineCount: z
              .number()
              .int()
              .describe('Distinct eight-digit rows in this published subtree.'),
            statisticalLineCount: z
              .number()
              .int()
              .describe('Distinct ten-digit rows in this published subtree.'),
            subchapter: z
              .string()
              .optional()
              .describe('Published subchapter locator only when independently established.'),
          })
          .describe('One numbered entry with complete descendant counts.'),
      )
      .describe('Source-order numbered entries.'),
    page: pageSchema.describe('Complete heading collection and continuation.'),
  }),
  enrichment: listEnrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Chapter is outside 01–99 or has invalid syntax.',
      recovery: 'Call usitc_list_reference with topic chapters and use one chapter number.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor tool or chapter arguments differ.',
      recovery: 'Repeat usitc_browse_chapter without cursor for the desired chapter.',
      thrownBy: 'service',
    },
    {
      reason: 'cursor_expired',
      code: JsonRpcErrorCode.Conflict,
      when: 'Original chapter snapshot or edition is unavailable.',
      recovery: 'Repeat usitc_browse_chapter without cursor to obtain current headings.',
      thrownBy: 'service',
    },
    {
      reason: 'release_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Edition changed twice during source assembly.',
      recovery: 'Call usitc_list_reference with topic releases, then repeat without cursor.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_hierarchy',
      code: JsonRpcErrorCode.InternalError,
      when: 'Complete source rows cannot establish safe ancestry.',
      recovery: 'Call usitc_search_hts with a code prefix to inspect flat source rows.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const chapter = normalizeChapter(input.chapter);
    const cursor = readCursor(input.cursor, 'usitc_browse_chapter', {
      chapter,
      limit: input.limit,
    });
    const { result, notice } = await new TariffService(getUsitcService()).browse(
      chapter,
      input.limit,
      cursor,
      ctx,
    );
    ctx.enrich.total(result.page.total);
    if (notice) ctx.enrich.notice(notice);
    return result;
  },
  format: formatSourceData,
});
