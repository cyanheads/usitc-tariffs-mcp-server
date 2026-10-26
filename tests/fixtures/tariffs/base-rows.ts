/** @fileoverview Small source-shaped tariff fixtures for hierarchy and tool contracts. */
import type { TariffRecord, TariffRow } from '@/services/usitc/types.js';

/** Published columns, unnamed legal ancestors and two independent statistical branches. */
export const baseRows: TariffRecord[] = [
  { htsno: '8507', indent: '0', description: 'Electric accumulators' },
  { htsno: '8507.60', indent: '1', description: 'Lithium-ion' },
  {
    htsno: '8507.60.00',
    indent: '2',
    description: 'Duplicate description',
    general: '3.4%',
    special: 'Free (A*, AU) 2% (ZZ)',
    other: '35%',
    units: ['No.'],
    footnotes: [{ value: 'See 9903.88.01', columns: ['general'], marker: '*' }],
    quotaQuantity: null,
    additionalDuties: 'one',
    addiitionalDuties: 'two',
    customSource: { preserved: true },
  },
  { indent: '3', description: 'Unnamed superior', superior: 'true' },
  {
    htsno: '8507.60.00.10',
    indent: '4',
    description: 'Duplicate description',
    general: '',
    special: null,
    other: '',
    units: null,
    footnotes: null,
  },
  {
    htsno: '8507.60.00.20',
    indent: '4',
    description: 'Explicit override',
    general: '1.2%',
    special: '',
    other: '40%',
  },
  { htsno: '8507.80', indent: '1', description: 'Other accumulators' },
  {
    htsno: '8507.80.00',
    indent: '2',
    description: 'Blank rate line',
    general: '',
    special: null,
    other: '',
  },
  { htsno: '8507.80.00.10', indent: '3', description: 'Unpublished statistical rates' },
];

/** Pure-algorithm rows have explicit stable source identities independent of HTTP decoding. */
export function normalizedRows(rows: readonly TariffRecord[]): TariffRow[] {
  return rows.map((row, index) => ({
    nodeId: `edition-A:fixture:${index}`,
    sourceOrdinal: index,
    ...(row.htsno && { htsno: row.htsno }),
    indent: Number(row.indent),
    description: row.description,
    ...(row.superior !== undefined && { superior: row.superior }),
    publishedRates: {
      ...(row.general !== undefined && { general: row.general }),
      ...(row.special !== undefined && { special: row.special }),
      ...(row.other !== undefined && { column2: row.other }),
    },
    sourceFields: {},
  }));
}
