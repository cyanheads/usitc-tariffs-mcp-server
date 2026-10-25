/**
 * @fileoverview Selected Chapter 99 research views and executable evidence retrieval schemas.
 * @module mcp-server/tools/additional-duties-schemas
 */
import { z } from '@cyanheads/mcp-ts-core';
import { metadataShape, nodeFollowUpSchema, pageSchema, publishedRatesSchema } from './schemas.js';

const followUpSchema = z
  .object({
    tool: z.literal('usitc_check_additional_duties').describe('Chapter 99 research tool.'),
    arguments: z
      .object({
        code: z.string().describe('Exact base commodity code.'),
        countryCode: z.string().optional().describe('Normalized optional country comparison.'),
        view: z
          .enum(['evidence', 'unmapped'])
          .optional()
          .describe('Selected evidence collection; omitted for candidates or passage retrieval.'),
        candidateCode: z.string().optional().describe('Exact candidate for evidence selection.'),
        noteId: z.string().optional().describe('Query-bound supporting passage identifier.'),
        noteCursor: z.string().optional().describe('Continuation for the same complete passage.'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('Original requested page size, when needed for continuation.'),
        cursor: z
          .string()
          .optional()
          .describe('Collection continuation with identical normalized selectors.'),
      })
      .describe('Exact executable follow-up arguments.'),
  })
  .describe('Exact executable Chapter 99 evidence or passage lookup.');
const countryRelationSchema = z.enum(['named', 'unknown', 'different_country', 'not_requested']);
const evidenceSchema = z
  .object({
    kind: z
      .enum(['footnote', 'explicit_list_link', 'same_passage_mention', 'compiler_notice'])
      .describe('Published pointer or parser evidence kind.'),
    relation: z
      .enum(['inclusion_candidate', 'exclusion_or_exception', 'context_only'])
      .describe('Supported relation; never legal applicability.'),
    role: z
      .enum(['product_list', 'governing', 'qualification', 'mention'])
      .describe('Source role within the evidence chain.'),
    countryRelation: countryRelationSchema.describe(
      'Recognized country relation without dropping unknown or different-country evidence.',
    ),
    matchedCode: z
      .string()
      .optional()
      .describe('Exact commodity code mentioned; absent for unresolved compiler scope.'),
    matchLevel: z
      .enum(['exact', 'rate_line', 'statistical_subset'])
      .optional()
      .describe('Exact, verified parent or narrower statistical reference.'),
    noteId: z.string().optional().describe('Complete supporting passage identifier.'),
    noteLocator: z
      .string()
      .optional()
      .describe('Legal label or explicitly ambiguous document-order locator.'),
    passageId: z.string().optional().describe('Complete normalized passage identifier.'),
    sourceCode: z
      .string()
      .optional()
      .describe('Referenced Chapter 99 code; absent when unresolved.'),
    statusMention: z
      .boolean()
      .describe('Source contains status words; current legal status remains undetermined.'),
    scope: z
      .literal('unresolved')
      .optional()
      .describe('Compiler notice has no safely established commodity or heading scope.'),
    sourceNodeId: z.string().optional().describe('Footnote source row identifier.'),
    sourceScope: z
      .enum(['selected_row', 'ancestor', 'inherited_rate_source'])
      .optional()
      .describe('Distinguishes directly attached and ancestor footnotes.'),
    inheritedColumns: z
      .array(z.string())
      .optional()
      .describe('Columns whose inherited rates were published on this footnote source row.'),
    footnote: z
      .object({
        columns: z.array(z.string()).optional().describe('Exact published footnote column scope.'),
        value: z.string().optional().describe('Complete published footnote text.'),
        marker: z.string().optional().describe('Published marker.'),
        type: z.string().optional().describe('Published type.'),
      })
      .catchall(z.json())
      .optional()
      .describe('Complete source footnote, including sparse fields.'),
    followUp: z
      .union([followUpSchema, nodeFollowUpSchema.describe('Exact source-row lookup.')])
      .describe('Retrieve the full passage or source row without guessed selectors.'),
  })
  .describe('Complete source evidence reference, without an inline note passage.');
const candidateSchema = z
  .object({
    code: z.string().describe('Merged Chapter 99 candidate number.'),
    headingResolved: z
      .boolean()
      .describe('Whether the exact candidate exists in the complete Chapter 99 export.'),
    description: z.string().optional().describe('Published description, absent when unresolved.'),
    publishedRates: publishedRatesSchema
      .optional()
      .describe('Every published rate column, without combined-duty arithmetic.'),
    sourceUrl: z.string().describe('Exact Chapter 99 export source URL supplying the rate row.'),
    evidenceCount: z.number().int().describe('Complete count of candidate evidence records.'),
    compilerNoticeCount: z
      .number()
      .int()
      .describe('Compiler-notice references within this candidate evidence.'),
    evidenceFollowUp: followUpSchema.describe('Page all evidence for this candidate.'),
    countryRelation: countryRelationSchema.describe(
      'Country prioritization while retaining every candidate.',
    ),
    countryNotice: z
      .string()
      .optional()
      .describe('Recognized different-country scope explanation.'),
    legalStatus: z.literal('not_determined').describe('No in-force status determination.'),
  })
  .describe('Merged Chapter 99 candidate retaining all published rate columns.');

/** Flat serializable output retains exactly one collection per selected view. */
export const additionalDutiesOutputSchema = z.object({
  ...metadataShape,
  normalization: z
    .object({
      charset: z.string().describe('Charset declared by the notes source response.'),
      textRule: z
        .string()
        .describe('Exact text normalization rule used for every retrievable passage.'),
    })
    .optional()
    .describe('Notes decoding and normalization provenance; absent when notes were not searched.'),
  code: z.string().describe('Canonical exact commodity number.'),
  found: z
    .boolean()
    .describe('Whether that exact base number exists; a statistical miss never falls back.'),
  view: z
    .enum(['candidates', 'evidence', 'unmapped', 'notes'])
    .describe('Only the selected collection is included.'),
  page: pageSchema.describe('Complete selected-collection pagination.'),
  baseLine: z
    .object({
      code: z.string().describe('Exact published base number.'),
      nodeId: z.string().describe('Source-local exact base row.'),
      dutyFollowUp: z
        .object({
          tool: z.literal('usitc_lookup_duty_rate').describe('Base duty research tool.'),
          arguments: z
            .object({
              code: z.string().describe('Exact commodity number.'),
              countryCode: z.string().optional().describe('Normalized optional country.'),
            })
            .describe('Exact base duty lookup.'),
        })
        .describe('Retrieve all base duty columns separately.'),
    })
    .optional()
    .describe('Base-line identification without duplicating the full source row.'),
  coverage: z
    .object({
      status: z.literal('partial').describe('Permanent first-version grammar limitation.'),
      parserVersion: z
        .string()
        .describe('Parser grammar version, or not_run for an exact base miss.'),
      sourceDigest: z
        .string()
        .describe('Chapter 99 notes byte digest; empty when notes were not searched.'),
      supportedGrammar: z.array(z.string()).describe('Actually implemented grammar labels.'),
      totalNoteBlocks: z.number().int().describe('Complete normalized note block count.'),
      parsedListBlocks: z.number().int().describe('Blocks linked by supported inclusion grammar.'),
      unresolvedReferenceBlocks: z
        .number()
        .int()
        .describe('Commodity-mention blocks lacking supported positive links.'),
      ambiguousBlocks: z.number().int().describe('Blocks with ambiguous legal labels.'),
      unmappedEvidenceCount: z
        .number()
        .int()
        .describe('Complete unmatched evidence count, including unresolved compiler context.'),
      unmappedFollowUp: followUpSchema.describe('Retrieve all unresolved evidence.'),
      limitations: z.array(z.string()).describe('Measured and permanent parser limitations.'),
    })
    .describe('Partial coverage facts, never a completeness or clearance claim.'),
  notComputed: z
    .array(z.string())
    .describe('Legal, qualification and arithmetic questions not determined.'),
  guidance: z.string().optional().describe('Actionable follow-up for an exact base miss.'),
  countryFilter: z
    .object({
      mode: z
        .literal('retain_unknown')
        .describe('Retain every unknown and different-country candidate.'),
      countryCode: z.string().optional().describe('Requested ISO alpha-2 country.'),
      namedCount: z.number().int().describe('Candidates with supported matching country scope.'),
      unknownCount: z.number().int().describe('Candidates whose country scope is unknown.'),
      differentCountryCount: z
        .number()
        .int()
        .describe('Candidates with recognized different-country scope, retained.'),
    })
    .optional()
    .describe('Factual prioritization counts over the full candidate collection.'),
  collectionTotals: z
    .object({
      candidates: z.number().int().describe('Merged candidate count.'),
      evidence: z.number().int().describe('All candidate evidence records.'),
      unmappedEvidence: z.number().int().describe('All unresolved evidence records.'),
    })
    .optional()
    .describe('Complete collection totals before page selection.'),
  candidateCode: z.string().optional().describe('Selected candidate in evidence view.'),
  candidates: z
    .array(candidateSchema)
    .optional()
    .describe('Selected whole candidates, without nested evidence passages.'),
  evidence: z
    .array(evidenceSchema)
    .optional()
    .describe('Selected complete evidence references for one candidate.'),
  unmappedEvidence: z
    .array(evidenceSchema)
    .optional()
    .describe('Selected unmatched references, including unresolved compiler notices.'),
  notesPage: z
    .object({
      noteId: z.string().describe('Query-bound source passage.'),
      fragments: z
        .array(
          z
            .object({
              passageId: z.string().describe('Complete normalized passage identifier.'),
              fragmentIndex: z.number().int().describe('Zero-based scalar-safe fragment order.'),
              fragmentCount: z
                .number()
                .int()
                .describe('Total fragments reconstructing this complete passage.'),
              text: z.string().describe('Exact normalized text slice of at most 2000 UTF-8 bytes.'),
            })
            .describe('One ordered scalar-safe source passage fragment.'),
        )
        .describe('Ordered lossless fragments; concatenate all pages.'),
      totalFragments: z.number().int().describe('Complete passage fragment count.'),
      returnedFragments: z.number().int().describe('Fragments returned on this page.'),
      context: z.string().describe('Full-fragment and governing-context retrieval requirements.'),
      nextNoteCursor: z
        .string()
        .optional()
        .describe('Next fragment page; every omitted fragment remains reachable.'),
      nextCall: followUpSchema.optional().describe('Exact passage continuation arguments.'),
    })
    .optional()
    .describe('Complete passage retrieval, without candidate arrays.'),
  nextCall: followUpSchema.optional().describe('Exact selected-collection continuation arguments.'),
});
