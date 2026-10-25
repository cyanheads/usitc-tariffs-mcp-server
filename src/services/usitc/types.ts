/**
 * @fileoverview Validated USITC wire records and lossless normalized tariff data.
 * @module services/usitc/types
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Sparse metadata supplied by currentRelease and releaseList. */
export const releaseRecordSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    releaseStartDate: z.string().nullable().optional(),
    releaseEndDate: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    target: z.string().nullable().optional(),
  })
  .catchall(z.json());

/** Ordered export/search wire row; nullable fields retain their source meaning. */
export const tariffRecordSchema = z
  .object({
    htsno: z.string().optional(),
    indent: z.string().regex(/^\d+$/),
    description: z.string(),
    superior: z.string().nullable().optional(),
    general: z.string().nullable().optional(),
    special: z.string().nullable().optional(),
    other: z.string().nullable().optional(),
    units: z.array(z.string()).nullable().optional(),
    footnotes: z
      .array(
        z
          .object({
            columns: z.array(z.string()).optional(),
            value: z.string().optional(),
            marker: z.string().optional(),
            type: z.string().optional(),
          })
          .catchall(z.json()),
      )
      .nullable()
      .optional(),
    quotaQuantity: z.json().optional(),
    additionalDuties: z.json().optional(),
    addiitionalDuties: z.json().optional(),
  })
  .catchall(z.json());

/** Metadata record with source fields preserved, including omitted versus null values. */
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;
/** Validated wire row, before source order and edition identities are assigned. */
export type TariffRecord = z.infer<typeof tariffRecordSchema>;
/** Edition checked against the moving current-view source. */
export interface Release {
  checkedAt: string;
  description?: string | null;
  effectiveDate?: string | null;
  name: string;
  status?: string | null;
}
/** Retrieval provenance for a single upstream body. */
export interface Source {
  agency: 'USITC';
  retrievedAt: string;
  scheduleUrl: string;
}
/** Source-preserving tariff row; sourceFields carries non-app unmapped fields. */
export interface TariffRow {
  addiitionalDuties?: z.core.util.JSONType;
  additionalDuties?: z.core.util.JSONType;
  description: string;
  footnotes?: TariffRecord['footnotes'];
  htsno?: string;
  indent: number;
  nodeId: string;
  publishedRates: { general?: string | null; special?: string | null; column2?: string | null };
  quotaQuantity?: z.core.util.JSONType;
  sourceFields: Record<string, z.core.util.JSONType>;
  sourceOrdinal: number;
  superior?: string | null;
  units?: string[] | null;
}
/** Complete normalized rows bound to a particular edition and body digest. */
export interface RowsSnapshot {
  digest: string;
  notices: string[];
  release: Release;
  rows: TariffRow[];
  snapshotId: string;
  source: Source;
}
/** Decoded HTML is transient input to the Chapter 99 parser, never a cached body. */
export interface Chapter99Source {
  charset: string;
  digest: string;
  html: string;
  notices: string[];
  release: Release;
  source: Source;
}
/** Common edition/provenance envelope returned by an assembled operation. */
export interface EditionResult<T> {
  data: T;
  notices: string[];
  release: Release;
  source: Source;
}
