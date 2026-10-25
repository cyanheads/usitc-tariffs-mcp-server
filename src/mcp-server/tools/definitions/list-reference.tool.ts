/**
 * @fileoverview Edition-pinned HTS decoder tables and published release metadata.
 * @module mcp-server/tools/definitions/list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { readCursor } from '../../../services/tariffs/pagination.js';
import { TariffService } from '../../../services/tariffs/tariff-service.js';
import { getUsitcService } from '../../../services/usitc/usitc-service.js';
import { enrichmentTrailer, formatSourceData } from '../reply.js';
import { listEnrichment, metadataShape, pageSchema, paginationInputShape } from '../schemas.js';

const referenceItemSchema = z
  .union([
    z
      .object({
        kind: z.literal('identifier').describe('Identifier explanation.'),
        name: z.string().describe('Identifier kind.'),
        digits: z.number().int().describe('Digit count.'),
        format: z.string().describe('Conventional dotted format.'),
        meaning: z.string().describe('Hierarchy, inheritance or evidence semantics.'),
      })
      .describe('One accepted tariff identifier format.'),
    z
      .object({
        kind: z.literal('program').describe('Reviewed program symbol record.'),
        symbol: z.string().describe('Exact SPI, preserving suffix punctuation.'),
        name: z.string().describe('Reviewed program name.'),
        citation: z.string().describe('Official General Note citation.'),
        sourceUrl: z.string().describe('Edition-pinned official source.'),
        sourceEdition: z.string().describe('Verification edition of this decoder.'),
        conditionality: z.string().describe('Legal qualification conditions.'),
        countryListCoverage: z
          .literal('unknown')
          .describe('Country membership has not been independently verified.'),
        qualificationNotice: z.string().describe('Program qualification remains unresolved.'),
      })
      .describe('One edition-pinned program symbol and its qualification limits.'),
    z
      .object({
        kind: z.literal('chapter').describe('Published application navigation label.'),
        chapter: z.string().describe('Two-digit chapter number.'),
        label: z.string().describe('Published chapter title.'),
        section: z.string().describe('Published section identifier.'),
        sectionLabel: z.string().describe('Published section title.'),
        reserved: z.boolean().describe('Whether this chapter is reserved.'),
        sourceUrl: z.string().describe('Label source URL.'),
        capturedAt: z.string().describe('Date the navigation labels were captured.'),
        labelSource: z
          .literal('published_application_navigation')
          .describe('Label extraction provenance.'),
        scheduleUrl: z.string().describe('Official tariff schedule.'),
      })
      .describe('One published chapter and its section navigation labels.'),
    z
      .object({
        kind: z.literal('unit').describe('Published quantity-unit abbreviation.'),
        symbol: z.string().describe('Exact abbreviation, preserving exponents.'),
        meaning: z.string().describe('Published unit meaning.'),
        citation: z.string().describe('Official General Note citation.'),
        sourceUrl: z.string().describe('Edition-pinned official source.'),
        sourceEdition: z.string().describe('Verification edition.'),
      })
      .describe('One edition-pinned published quantity unit.'),
    z
      .object({
        kind: z
          .literal('release')
          .describe('Published edition record; no historical tariff lookup promise.'),
        name: z.string().describe('Published release identifier.'),
        description: z.string().nullable().optional().describe('Published description.'),
        title: z.string().nullable().optional().describe('Published title.'),
        status: z.string().nullable().optional().describe('Published status.'),
        releaseStartDate: z
          .string()
          .nullable()
          .optional()
          .describe('Published start-date source string.'),
        releaseEndDate: z
          .string()
          .nullable()
          .optional()
          .describe('Published end-date source string.'),
        date: z.string().nullable().optional().describe('Published date source string.'),
        target: z.string().nullable().optional().describe('Published target source string.'),
        sourceUrl: z.string().describe('Official edition metadata endpoint.'),
      })
      .catchall(z.json().optional())
      .describe('One published edition with every available metadata field.'),
  ])
  .describe('One record from the selected reference topic.');

/** Decode terms without presenting the bundled SPI table as current country eligibility. */
export const listReferenceTool = tool('usitc_list_reference', {
  title: 'Decode HTS references and published editions',
  description:
    'List accepted identifier formats, edition-pinned Special Program Indicators, chapter/section navigation labels, quantity units or published release metadata. Program names are decoded separately from country membership, which remains unknown without independently verified lists. Release records identify published editions but do not enable historical tariff lookup. Follow nextCursor for all entries.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .enum(['identifiers', 'spi', 'chapters', 'units', 'releases'])
      .describe('Reference table to retrieve.'),
    ...paginationInputShape,
  }),
  output: z.object({
    ...metadataShape,
    topic: z
      .enum(['identifiers', 'spi', 'chapters', 'units', 'releases'])
      .describe('Requested decoder or metadata topic.'),
    items: z
      .array(referenceItemSchema)
      .describe('Complete topic-specific records selected for this page.'),
    page: pageSchema.describe('Complete reference count and continuation.'),
  }),
  enrichment: listEnrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor tool, topic or normalized arguments differ.',
      recovery: 'Repeat usitc_list_reference without cursor for the desired topic.',
      thrownBy: 'service',
    },
    {
      reason: 'cursor_expired',
      code: JsonRpcErrorCode.Conflict,
      when: 'Reference edition, decoder digest or saved release snapshot is unavailable.',
      recovery: 'Repeat usitc_list_reference without cursor to obtain current reference entries.',
      thrownBy: 'service',
    },
    {
      reason: 'release_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Edition changed twice during source assembly.',
      recovery: 'Repeat usitc_list_reference with topic releases and no cursor later.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const cursor = readCursor(input.cursor, 'usitc_list_reference', {
      topic: input.topic,
      limit: input.limit,
    });
    const response = await new TariffService(getUsitcService()).reference(
      input.topic,
      input.limit,
      cursor,
      ctx,
    );
    ctx.enrich.total(response.result.page.total);
    if ('notice' in response && response.notice) ctx.enrich.notice(response.notice);
    return response.result;
  },
  format: formatSourceData,
});
