/**
 * @fileoverview Serializable shared USITC metadata, source rows and rate schemas.
 * @module mcp-server/tools/schemas
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Source metadata shared by all tariff research tools. */
export const metadataShape = {
  release: z
    .object({
      name: z.string().describe('Published release identifier.'),
      description: z.string().nullable().optional().describe('Published release description.'),
      effectiveDate: z
        .string()
        .nullable()
        .optional()
        .describe('Published effective-date source string.'),
      status: z.string().nullable().optional().describe('Published release status.'),
      checkedAt: z.string().describe('UTC time of the edition check.'),
    })
    .describe('Edition checked for this result.'),
  source: z
    .object({
      agency: z.literal('USITC').describe('Publishing agency.'),
      scheduleUrl: z.string().describe('Exact USITC source URL.'),
      retrievedAt: z.string().describe('UTC source retrieval time.'),
    })
    .describe('Source provenance.'),
  notices: z.array(z.string()).describe('Persistent source and coverage limitations.'),
};
/** Positive workload limits accept 500 but process at most 100 complete items per page. */
export const paginationInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(25)
    .describe(
      'Requested items, 1–500; effective pages contain at most 100 and may be byte limited.',
    ),
  cursor: z
    .string()
    .optional()
    .describe('Opaque nextCursor from the same tool with identical arguments.'),
};
/** Explicit complete-collection pagination, including byte-limited pages. */
export const pageSchema = z.object({
  total: z.number().int().describe('Complete locally filtered item count.'),
  returned: z.number().int().describe('Items returned on this page.'),
  effectiveLimit: z.number().int().describe('Applied item ceiling after clamping to 100.'),
  nextCursor: z.string().optional().describe('Continuation for every remaining whole item.'),
  budgetLimited: z
    .boolean()
    .optional()
    .describe('True when the complete reply byte budget reduced this page.'),
});
/** Optional result-specific recovery and complete list count, mirrored by the framework. */
export const listEnrichment = {
  notice: z.string().optional().describe('Actionable next call for this particular empty result.'),
  totalCount: z.number().int().optional().describe('Complete locally filtered item count.'),
};
/** Exact executable lookup for an ancestor or rate source. */
export const nodeFollowUpSchema = z.object({
  tool: z.literal('usitc_get_heading').describe('Tool resolving the exact node.'),
  arguments: z
    .object({
      code: z.string().describe('Containing four-digit heading.'),
      nodeId: z.string().describe('Exact source node identifier.'),
    })
    .describe('Executable node lookup arguments.'),
});
/** Sparse published cells retain null, empty string and omission separately. */
export const publishedRatesSchema = z.object({
  general: z
    .string()
    .nullable()
    .optional()
    .describe('Published General cell, without interpretation.'),
  special: z
    .string()
    .nullable()
    .optional()
    .describe('Published Special cell, without interpretation.'),
  column2: z.string().nullable().optional().describe('Published Column 2 cell mapped from other.'),
});
/** Complete normalized source row; non-app unknown fields remain source data. */
export const tariffRowShape = {
  nodeId: z.string().describe('Release and source-digest-local node identifier.'),
  sourceOrdinal: z.number().int().describe('Zero-based position in the complete source export.'),
  htsno: z
    .string()
    .optional()
    .describe('Published numbered classification; absent on unnamed rows.'),
  indent: z.number().int().describe('Published legal indentation level.'),
  description: z.string().describe('Untrusted published description, preserved as source data.'),
  superior: z.string().nullable().optional().describe('Published superior flag source text.'),
  publishedRates: publishedRatesSchema.describe('Untouched published duty cells.'),
  units: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Published quantity units; never inherited.'),
  footnotes: z
    .array(
      z
        .object({
          columns: z.array(z.string()).optional().describe('Published column scope.'),
          value: z.string().optional().describe('Complete published footnote text.'),
          marker: z.string().optional().describe('Published footnote marker.'),
          type: z.string().optional().describe('Published footnote type.'),
        })
        .catchall(z.json())
        .describe('One complete published footnote.'),
    )
    .nullable()
    .optional()
    .describe('Footnotes attached directly to this source row.'),
  quotaQuantity: z.json().optional().describe('Published quota quantity value.'),
  additionalDuties: z.json().optional().describe('Published additionalDuties source value.'),
  addiitionalDuties: z
    .json()
    .optional()
    .describe('Distinct misspelled source field, retained without overwriting.'),
  sourceFields: z
    .record(z.string(), z.json())
    .describe('Other non-app source fields, without inferred values.'),
};
/** Each rate column resolves independently and retains its exact source lookup. */
export const resolvedColumnSchema = z.object({
  state: z
    .enum(['published', 'inherited', 'not_published'])
    .describe(
      'Whether a nonblank value is published here, inherited from the exact eight-digit ancestor, or absent.',
    ),
  text: z.string().optional().describe('Unevaluated published rate text.'),
  sourceNodeId: z.string().optional().describe('Node on which this rate was published.'),
  sourceHtsno: z.string().optional().describe('Number on which this rate was published.'),
  sourceFollowUp: nodeFollowUpSchema
    .optional()
    .describe('Retrieve the complete rate source and its own parent.'),
});
/** General, Special and Column 2 remain independent; country never selects one. */
export const resolvedRatesSchema = z.object({
  general: resolvedColumnSchema.describe('Resolved General cell.'),
  special: resolvedColumnSchema.describe('Resolved Special cell.'),
  column2: resolvedColumnSchema.describe('Resolved Column 2 cell.'),
});
/** Flat node rather than a recursively repeated ancestry tree. */
export const headingNodeSchema = z
  .object({
    ...tariffRowShape,
    parentId: z.string().optional().describe('Immediate legal parent, including unnamed rows.'),
    parentFollowUp: nodeFollowUpSchema
      .optional()
      .describe('Exact parent retrieval, including off-page ancestors.'),
    resolvedRates: resolvedRatesSchema.describe('Independent rate provenance for this node.'),
  })
  .describe('One published source node with legal ancestry and rate provenance.');

const programSchema = z
  .object({
    symbol: z.string().describe('Exact SPI, retaining suffix punctuation.'),
    recognized: z
      .boolean()
      .describe('Whether the shared edition-pinned decoder recognizes this symbol.'),
    name: z.string().optional().describe('Reviewed program name when recognized.'),
    countryRelation: z
      .enum(['unknown', 'not_requested'])
      .describe('Country membership is unverified, never presumed eligible.'),
    countryListCoverage: z
      .literal('unknown')
      .describe('Country relationships have not been independently verified.'),
  })
  .describe('One symbol interpreted with the shared decoder citation and qualification notice.');
/** Balanced SPI clauses with all unmatched source text still available. */
export const parsedSpecialSchema = z.object({
  publishedText: z.string().describe('Complete Special source cell.'),
  clauses: z
    .array(
      z
        .object({
          text: z.string().describe('Exact clause source slice.'),
          rateText: z.string().describe('Unevaluated clause rate text.'),
          start: z.number().int().describe('UTF-16 source offset inclusive.'),
          end: z.number().int().describe('UTF-16 source offset exclusive.'),
          programs: z
            .array(programSchema)
            .describe('Every published symbol, including unknown symbols.'),
        })
        .describe('One balanced rate clause and all its symbols.'),
    )
    .describe('Supported balanced clauses.'),
  decoder: z
    .object({
      sourceEdition: z.string().describe('Shared verification edition for recognized symbols.'),
      citation: z.string().describe('Official General Note citation for the symbol decoder.'),
      sourceUrl: z.string().describe('Edition-pinned official decoder source.'),
      qualificationNotice: z
        .string()
        .describe('Qualification remains unresolved for every symbol.'),
    })
    .describe('Common provenance and qualification text applying to all symbol annotations.'),
  referenceFollowUp: z
    .object({
      tool: z.literal('usitc_list_reference').describe('Program reference tool.'),
      arguments: z
        .object({ topic: z.literal('spi').describe('Symbol reference topic.') })
        .describe('Executable decoder lookup.'),
    })
    .describe('Full decoder follow-up for every recognized or unknown symbol.'),
  unparsedText: z.string().describe('Complete text outside parsed clauses.'),
  parseCoverage: z
    .enum(['complete', 'partial'])
    .describe('Coverage of this cell by the supported grammar.'),
});
/** Country comparison retains uncertainty and does not select a rate column. */
export const countryAssessmentSchema = z.object({
  countryCode: z.string().optional().describe('Normalized requested ISO alpha-2 country.'),
  eligibility: z.literal('not_determined').describe('No program eligibility determination.'),
  columnSelection: z
    .literal('not_determined')
    .describe('No General versus Column 2 determination.'),
  membershipCoverage: z.literal('unknown').describe('Country membership is unverified.'),
  decoderSourceEdition: z.string().describe('Reviewed decoder edition.'),
  editionMatches: z
    .boolean()
    .describe('Whether the decoder edition equals the checked schedule edition.'),
  recognizedSymbolCount: z.number().int().describe('Recognized SPI occurrences in parsed clauses.'),
  notice: z.string().describe('Limits of this country comparison.'),
  qualificationNotice: z.string().describe('Program legal requirements remain unresolved.'),
});
