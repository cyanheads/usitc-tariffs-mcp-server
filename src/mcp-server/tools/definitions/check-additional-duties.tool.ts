/**
 * @fileoverview Partial Chapter 99 research with complete pageable evidence and source passages.
 * @module mcp-server/tools/definitions/check-additional-duties.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAdditionalDutiesService } from '../../../services/chapter99/additional-duties-service.js';
import { getUsitcService } from '../../../services/usitc/usitc-service.js';
import { additionalDutiesOutputSchema } from '../additional-duties-schemas.js';
import { enrichmentTrailer, formatSourceData } from '../reply.js';
import { listEnrichment, paginationInputShape } from '../schemas.js';

/** Empty candidates never establish absence of additional duties or current legal enforceability. */
export const checkAdditionalDutiesTool = tool('usitc_check_additional_duties', {
  title: 'Research Chapter 99 additional-duty evidence',
  description:
    'Find Chapter 99 candidate headings and source references for an exact eight- or ten-digit commodity number. Coverage is partial and empty candidates never establish clearance. Use candidates, evidence with a returned candidateCode, or unmapped views; follow returned noteId and noteCursor for complete source passages. Country comparisons retain unknown and different-country evidence. No applicability, current legal status, exclusions, stacking or combined duties are determined.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    code: z
      .string()
      .describe(
        'Exact eight- or ten-digit base commodity number, bare or conventionally dotted; Chapter 99 input is invalid.',
      ),
    countryCode: z
      .string()
      .optional()
      .describe('Assigned ISO alpha-2 country; comparison only, never sent upstream.'),
    view: z
      .enum(['candidates', 'evidence', 'unmapped'])
      .default('candidates')
      .describe('One result collection; evidence requires candidateCode.'),
    candidateCode: z
      .string()
      .optional()
      .describe('Returned Chapter 99 candidate number, only with view evidence.'),
    ...paginationInputShape,
    noteId: z
      .string()
      .optional()
      .describe(
        'Returned supporting passage identifier; cannot combine with candidateCode, cursor or a nondefault view.',
      ),
    noteCursor: z
      .string()
      .optional()
      .describe('Returned nextNoteCursor; requires the same noteId and original selectors.'),
  }),
  output: additionalDutiesOutputSchema,
  enrichment: listEnrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Identifier is not an exact eight- or ten-digit base commodity number.',
      recovery:
        'Call usitc_list_reference with topic identifiers, then retry with a supported tariff code.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_country',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Country is not an assigned ISO alpha-2 value.',
      recovery: 'Use an assigned two-letter ISO country code or omit countryCode.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Evidence, passage and collection selectors cannot be combined as requested.',
      recovery:
        'Keep code and countryCode unchanged; use view evidence with candidateCode, or omit view, candidateCode and cursor when supplying noteId and optional noteCursor.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor is malformed or bound to different arguments.',
      recovery:
        'Repeat usitc_check_additional_duties without cursor or noteCursor, retaining the original code, countryCode and collection selectors.',
      thrownBy: 'service',
    },
    {
      reason: 'cursor_expired',
      code: JsonRpcErrorCode.Conflict,
      when: 'Index or base snapshot expired, was evicted, or changed edition.',
      recovery:
        'Repeat usitc_check_additional_duties with code and optional countryCode only to obtain current candidates and passage identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'release_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Edition changes twice during complete source assembly.',
      recovery:
        'Call usitc_list_reference with topic releases, then repeat the original tool without a cursor.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_hierarchy',
      code: JsonRpcErrorCode.InternalError,
      when: 'Complete base heading cannot establish safe ancestry.',
      recovery:
        'Call usitc_search_hts with the code to inspect published flat rows while hierarchy resolution is unavailable.',
      thrownBy: 'service',
    },
    {
      reason: 'notes_structure_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Required Chapter 99 structure is missing or cannot be decoded.',
      recovery:
        'Call usitc_lookup_duty_rate for published base rates and retry usitc_check_additional_duties later.',
      thrownBy: 'service',
    },
    {
      reason: 'note_not_found',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Passage does not belong to this commodity query, source digest or edition.',
      recovery:
        'Call usitc_check_additional_duties with the same code and countryCode, omitting noteId, noteCursor, cursor, candidateCode and view, to obtain current passage identifiers.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const { result, notice } = await getAdditionalDutiesService(getUsitcService()).check(
      input,
      ctx,
    );
    ctx.enrich.total(result.page.total);
    if (notice) ctx.enrich.notice(notice);
    return result;
  },
  format: formatSourceData,
});
