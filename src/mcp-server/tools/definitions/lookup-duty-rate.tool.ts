/**
 * @fileoverview Exact published base-duty lookup with uncertainty-preserving SPI decoding.
 * @module mcp-server/tools/definitions/lookup-duty-rate.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  normalizeCode,
  normalizeCountryCode,
} from '../../../services/reference/reference-service.js';
import { TariffService } from '../../../services/tariffs/tariff-service.js';
import { getUsitcService } from '../../../services/usitc/usitc-service.js';
import { enrichmentTrailer, formatSourceData } from '../reply.js';
import {
  countryAssessmentSchema,
  headingNodeSchema,
  listEnrichment,
  metadataShape,
  parsedSpecialSchema,
  resolvedRatesSchema,
} from '../schemas.js';

/** All published columns remain visible; no rate selection or combined-duty arithmetic. */
export const lookupDutyRateTool = tool('usitc_lookup_duty_rate', {
  title: 'Look up published base duty columns',
  description:
    'Retrieve an exact eight-digit rate line or ten-digit statistical number with all published General, Special and Column 2 cells. Blank statistical cells inherit only from the matching eight-digit legal ancestor. Country comparisons retain all symbols and unknown membership; they do not establish qualification or select a column. Follow usitc_check_additional_duties for partial Chapter 99 research.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    code: z
      .string()
      .describe('Exact eight- or ten-digit HTS identifier, bare or conventionally dotted.'),
    countryCode: z
      .string()
      .optional()
      .describe('Assigned ISO 3166-1 alpha-2 country; comparison only, never sent upstream.'),
  }),
  output: z.object({
    ...metadataShape,
    code: z.string().describe('Canonical requested exact identifier.'),
    found: z.boolean().describe('Whether this exact published number exists.'),
    row: headingNodeSchema
      .optional()
      .describe('Exact source row with executable parent and rate-source follow-ups.'),
    resolvedRates: resolvedRatesSchema
      .optional()
      .describe('All resolved duty columns when the exact number exists.'),
    specialPrograms: parsedSpecialSchema
      .optional()
      .describe('Decoded nonblank Special cell, preserving unmatched text.'),
    countryAssessment: countryAssessmentSchema.describe(
      'Explicitly unresolved membership, qualification and column choice.',
    ),
    chapter99Pointers: z
      .object({
        countKnown: z
          .literal(false)
          .describe('Additional-duty candidate counts have not been computed by base lookup.'),
        followUp: z
          .object({
            tool: z
              .literal('usitc_check_additional_duties')
              .describe('Additional-duty evidence research tool.'),
            arguments: z
              .object({
                code: z.string().describe('Exact base identifier.'),
                countryCode: z.string().optional().describe('Normalized optional country.'),
              })
              .describe('Executable additional-duty research arguments.'),
          })
          .describe('Partial Chapter 99 investigation follow-up.'),
      })
      .describe('Research pointer with no fabricated candidate count.'),
    guidance: z.string().optional().describe('Exact research follow-up for a successful miss.'),
  }),
  enrichment: listEnrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Identifier is not exactly eight or ten digits in a supported form.',
      recovery: 'Call usitc_get_heading with a four-digit heading to inspect valid rate numbers.',
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
      reason: 'release_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Edition changed twice during source assembly.',
      recovery: 'Call usitc_list_reference with topic releases, then repeat the lookup.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_hierarchy',
      code: JsonRpcErrorCode.InternalError,
      when: 'Complete heading rows cannot establish safe ancestry.',
      recovery: 'Call usitc_search_hts with the code to inspect published flat cells.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const code = normalizeCode(input.code, [8, 10]).code;
    const countryCode = normalizeCountryCode(input.countryCode);
    const result = await new TariffService(getUsitcService()).duty(code, countryCode, ctx);
    if (result.guidance) ctx.enrich.notice(result.guidance);
    return result;
  },
  format: formatSourceData,
});
