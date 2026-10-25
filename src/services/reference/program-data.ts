/**
 * @fileoverview Reviewed General Note 3(c)(i) symbol table and 3(g) abbreviations.
 * @module services/reference/program-data
 */

/** Edition of the reviewed General Note 3 PDF; never relabel this with the live edition. */
export const decoderSourceEdition = '2026HTSRev21';
/** Pinned official source; GN pages 4–5 contain symbols, pages 7–8 contain abbreviations. */
export const generalNote3Url =
  'https://hts.usitc.gov/reststop/file?release=2026HTSRev21&filename=General%20Note%203';
/** Legal requirements remain unresolved even for a recognized program symbol. */
export const qualificationNotice =
  'Program identification does not establish origin qualification, product eligibility, quota status, program availability or the legally applicable rate.';

/** Complete symbol/name transcription; suffixes identify distinct published symbols. */
export const programNames = [
  ['A', 'Generalized System of Preferences'],
  ['A*', 'Generalized System of Preferences'],
  ['A+', 'Generalized System of Preferences'],
  ['AU', 'United States-Australia Free Trade Agreement'],
  ['B', 'Automotive Products Trade Act'],
  ['BH', 'United States-Bahrain Free Trade Agreement Implementation Act'],
  ['C', 'Agreement on Trade in Civil Aircraft'],
  ['CL', 'United States-Chile Free Trade Agreement'],
  ['D', 'African Growth and Opportunity Act'],
  ['E', 'Caribbean Basin Economic Recovery Act'],
  ['E*', 'Caribbean Basin Economic Recovery Act'],
  ['IL', 'United States-Israel Free Trade Area'],
  ['JO', 'United States-Jordan Free Trade Area Implementation Act'],
  ['JP', 'Trade Agreement Between the United States and Japan'],
  ['K', 'Agreement on Trade in Pharmaceutical Products'],
  ['P', 'Dominican Republic-Central America-United States Free Trade Agreement Implementation Act'],
  [
    'P+',
    'Dominican Republic-Central America-United States Free Trade Agreement Implementation Act',
  ],
  ['L', 'Uruguay Round Concessions on Intermediate Chemicals for Dyes'],
  ['R', 'United States-Caribbean Basin Trade Partnership Act'],
  ['MA', 'United States-Morocco Free Trade Agreement Implementation Act'],
  ['SG', 'United States-Singapore Free Trade Agreement'],
  ['OM', 'United States-Oman Free Trade Agreement Implementation Act'],
  ['PE', 'United States-Peru Trade Promotion Agreement Implementation Act'],
  ['KR', 'United States-Korea Free Trade Agreement Implementation Act'],
  ['CO', 'United States-Colombia Trade Promotion Agreement Implementation Act'],
  ['PA', 'United States-Panama Trade Promotion Agreement Implementation Act'],
  ['NP', 'Nepal Preference Program'],
  ['S', 'United States-Mexico-Canada Agreement'],
  ['S+', 'United States-Mexico-Canada Agreement'],
] as const;

/** GN3(g) abbreviations; published spelling and capitalization are preserved. */
export const quantityUnitNames = [
  ['$', 'dollars'],
  ['¢', 'cents'],
  ['%', 'percent ad valorem'],
  ['+', 'plus'],
  ['/', 'per'],
  ['°', 'degrees'],
  ['AC', 'alternating current'],
  ['ASTM', 'American Society for Testing Materials'],
  ['bbl', 'barrels'],
  ['C', 'Celcius'],
  ['cc', 'cubic centimeters'],
  ['cu.', 'cubic'],
  ['cg', 'centigrams'],
  ['cm', 'centimeters'],
  ['cm²', 'square centimeters'],
  ['cm³', 'cubic centimeters'],
  ['cy', 'clean yield'],
  ['d', 'Denier'],
  ['DC', 'direct current'],
  ['doz.', 'Dozens'],
  ['g', 'grams'],
  ['G.V.W.', 'gross vehicle weight'],
  ['I.R.C.', 'Internal Revenue Code'],
  ['kcal', 'kilocalories'],
  ['kg', 'kilograms'],
  ['kHz', 'kilohertz'],
  ['kN', 'kilonewtons'],
  ['kVA', 'kilovolt-amperes'],
  ['kvar', 'kilovolt-amperes reactive'],
  ['kW', 'kilowatts'],
  ['kWH', 'kilowatt-hours'],
  ['lin', 'linear'],
  ['m', 'meter'],
  ['Mbq', 'megabecquerel'],
  ['mc', 'millicuries'],
  ['mg', 'milligrams'],
  ['MHz', 'megahertz'],
  ['ml', 'milliliters'],
  ['mm', 'millimeters'],
  ['MPa', 'megapascals'],
  ['m²', 'square meters'],
  ['m³', 'cubic meters'],
  ['No.', 'number'],
  ['ode', 'ozone depletion equivalent'],
  ['pcs', 'pieces'],
  ['pf.', 'proof'],
  ['prs.', 'pairs'],
  ['r.p.m.', 'revolutions per minute'],
  ['sbe', 'standard brick equivalent'],
  ['SME', 'square meters equivalent'],
  ['t', 'metric tons'],
  ['V', 'volts'],
  ['W', 'watts'],
  ['wt.', 'weight'],
] as const;
