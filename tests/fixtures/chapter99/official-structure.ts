/**
 * @fileoverview Small USITC-shaped Chapter 99 HTML fixtures; legal clauses are literal test inputs.
 * @module tests/fixtures/chapter99/official-structure
 */

/** Surround a numbered note with the explicit source titles and prior note labels. */
export function chapterNote(number: number, body: string): string {
  const earlier = Array.from(
    { length: number - 1 },
    (_, index) => `<li value="${index + 1}.">${index + 1}. Reserved.</li>`,
  ).join('');
  return `<div class="misc_title">CHAPTER 99</div><div class="misc_title">SUBCHAPTER III</div><div class="misc_note_title">U.S. Notes</div><ul>${earlier}<li index="null" value="  ${number}.  ">${number}. ${body}</li></ul>`;
}

/** Official note 20 clause shape: one positive list reference followed by exclusions. */
export const note20 = chapterNote(
  20,
  '<ul><li value="(a)">(a) Heading 9903.88.01 applies to products of China that are classified in the subheadings enumerated in U.S. note 20(b) to subchapter III, except products provided for in note 20(c) under heading 9903.88.02.</li><li value="(b)">(b) <table><tr><td>0101.21.00</td><td>0101.29.00.10</td></tr></table></li><li value="(c)">(c) Heading 9903.88.01 does not apply to 0101.21.00; the exclusion is subject to its own conditions.</li></ul>',
);

/** Official note 31 table shape, with the governing clause in the table subdivision. */
export const note31 = chapterNote(
  31,
  '<ul><li value="(a)">(a) Definitions.</li><li value="(b)">(b) Heading 9903.91.01 applies to products enumerated in this subdivision: <table><tr><td>7208.10.15</td><td>7208.25.30</td></tr></table></li></ul>',
);

/** Note 18 conditional narrative establishes context rather than product-list inclusion. */
export const note18 = chapterNote(
  18,
  '<ul><li value="(a)">(a) Definitions.</li><li value="(b)">(b) Reserved.</li><li value="(c)">(c) Reserved.</li><li value="(d)">(d) Reserved.</li><li value="(e)">(e) Reserved.</li><li value="(f)">(f) Reserved.</li><li value="(g)">(g) If the conditions are met, heading 9903.45.21 concerns solar cells classified in 8541.43.00 during the stated period.</li><li value="(h)">(h) Notwithstanding heading 9903.45.22, 8541.43.00 remains subject to the product definition and content tests.</li></ul>',
);
