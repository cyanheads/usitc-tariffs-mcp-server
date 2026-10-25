/**
 * @fileoverview Complete-heading legal ancestry and exact source-node retrieval.
 * @module mcp-server/tools/definitions/get-heading.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { normalizeCode } from '../../../services/reference/reference-service.js';
import { readCursor } from '../../../services/tariffs/pagination.js';
import { TariffService } from '../../../services/tariffs/tariff-service.js';
import { getUsitcService } from '../../../services/usitc/usitc-service.js';
import { enrichmentTrailer, formatSourceData } from '../reply.js';
import {
  headingNodeSchema,
  listEnrichment,
  metadataShape,
  pageSchema,
  paginationInputShape,
} from '../schemas.js';

/** Reconstruct before filtering and expose executable parent/source lookups. */
export const getHeadingTool = tool('usitc_get_heading', {
  title: 'Inspect an HTS heading and ancestry',
  description:
    'Inspect a four-, six- or eight-digit HTS classification and its complete indented descendants, including unnamed superior rows. Ancestry is built from the whole containing heading before filtering. Each parent and inherited-rate source has an exact nodeId follow-up. Chapters 98 and 99 preserve published forest roots without inventing four-digit records.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    code: z
      .string()
      .describe('Four-, six- or eight-digit HTS code, bare or conventionally dotted.'),
    nodeId: z
      .string()
      .optional()
      .describe(
        'Exact returned node identifier within this classification subtree; omit to browse.',
      ),
    ...paginationInputShape,
  }),
  output: z.object({
    ...metadataShape,
    code: z.string().describe('Canonical requested code.'),
    found: z.boolean().describe('Whether the requested classification has published nodes.'),
    rootId: z
      .string()
      .optional()
      .describe('First selected source node; special chapters can have multiple published roots.'),
    nodes: z
      .array(headingNodeSchema)
      .describe('Flat source-order nodes with legal parents and rate provenance.'),
    page: pageSchema.describe('Complete selected subtree and continuation.'),
    guidance: z
      .string()
      .optional()
      .describe('Executable research guidance for a successful classification miss.'),
  }),
  enrichment: listEnrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Code is not a supported four-, six- or eight-digit identifier.',
      recovery: 'Call usitc_list_reference with topic identifiers and use a supported code.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor arguments or node selection do not match this heading.',
      recovery: 'Repeat usitc_get_heading without cursor or nodeId to obtain current identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'cursor_expired',
      code: JsonRpcErrorCode.Conflict,
      when: 'Saved source snapshot or selected edition expired.',
      recovery: 'Repeat usitc_get_heading without cursor or nodeId for a current snapshot.',
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
      recovery: 'Call usitc_search_hts with this code to inspect published flat rows.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const code = normalizeCode(input.code, [4, 6, 8]).code;
    const nodeId = input.nodeId?.trim() || undefined;
    const cursor = readCursor(input.cursor, 'usitc_get_heading', {
      code,
      ...(nodeId && { nodeId }),
      limit: input.limit,
    });
    const { result, notice } = await new TariffService(getUsitcService()).heading(
      code,
      nodeId,
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
