/**
 * @fileoverview Flat published HTS keyword and code-prefix search.
 * @module mcp-server/tools/definitions/search-hts.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { normalizeSearchQuery } from '../../../services/reference/reference-service.js';
import { readCursor } from '../../../services/tariffs/pagination.js';
import { TariffService } from '../../../services/tariffs/tariff-service.js';
import { getUsitcService } from '../../../services/usitc/usitc-service.js';
import { enrichmentTrailer, formatSourceData } from '../reply.js';
import {
  listEnrichment,
  metadataShape,
  pageSchema,
  paginationInputShape,
  tariffRowShape,
} from '../schemas.js';

/** Search never invents hierarchy or resolves statistical blank cells. */
export const searchHtsTool = tool('usitc_search_hts', {
  title: 'Search published HTS classifications',
  description:
    'Search published USITC descriptions or complete HTS code prefixes in source order. Matches are flat published rows with unresolved rates; call usitc_get_heading for legal ancestry and usitc_lookup_duty_rate for exact base rate columns. Follow nextCursor with identical arguments for all remaining matches.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Nonblank commodity text or an HTS code prefix; preserve leading zeros.'),
    ...paginationInputShape,
  }),
  output: z.object({
    ...metadataShape,
    query: z.string().describe('Normalized query actually sent to USITC.'),
    context: z
      .literal('flat_search_matches')
      .describe('Flat matches without reconstructed ancestry.'),
    rows: z
      .array(
        z
          .object({
            ...tariffRowShape,
            ratesResolved: z
              .literal(false)
              .describe('Published cells have not been resolved through ancestry.'),
          })
          .describe('One flat source match with unresolved rate cells.'),
      )
      .describe('Complete source rows selected for this page.'),
    page: pageSchema.describe('Complete matching collection and continuation.'),
  }),
  enrichment: listEnrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor shape, tool or normalized arguments differ.',
      recovery: 'Repeat usitc_search_hts without cursor using the desired query.',
      thrownBy: 'service',
    },
    {
      reason: 'cursor_expired',
      code: JsonRpcErrorCode.Conflict,
      when: 'Original source snapshot or edition is unavailable.',
      recovery: 'Repeat usitc_search_hts without cursor to obtain current matches.',
      thrownBy: 'service',
    },
    {
      reason: 'release_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Edition changed twice during source assembly.',
      recovery: 'Call usitc_list_reference with topic releases, then repeat without cursor.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const query = normalizeSearchQuery(input.query);
    const cursor = readCursor(input.cursor, 'usitc_search_hts', { query, limit: input.limit });
    const { result, notice } = await new TariffService(getUsitcService()).search(
      query,
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
