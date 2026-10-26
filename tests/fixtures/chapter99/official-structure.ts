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

/** Literal note 31 following-list openings and representative source children, including nested (f)(i). */
export const note31Following = chapterNote(
  31,
  '<ul><li value="(a)">(a) Definitions.</li><li value="(b)">(b) Reserved.</li><li value="(c)">(c) Heading 9903.91.02 applies to products of China that are classified in the following 8-digit subheadings, effective with respect to goods entered for consumption, or withdrawn from warehouse for consumption, on or after 12:01 a.m. eastern daylight time on September 27, 2024:<ul><li value="(1)">(1) 8541.42.00</li><li value="(2)">(2) 8541.43.00</li></ul></li><li value="(d)">(d) Heading 9903.91.03 applies to products of China that are classified in the following 8-digit subheadings, effective with respect to goods entered for consumption, or withdrawn from warehouse for consumption, on or after 12:01 a.m. eastern daylight time on September 27, 2024:<ul><li value="(1)">(1) 8702.40.31</li></ul></li><li value="(e)">(e) Reserved.</li><li value="(f)">(f) null<ul><li value="(i)">(i) Heading 9903.91.05 applies to products of China that are classified in the following 8-digit subheadings, effective with respect to goods entered for consumption, or withdrawn from warehouse for consumption, on or after 12:01 a.m. eastern standard time on January 1, 2025:<ul><li value="(1)">(1) 2804.61.00</li><li value="(2)">(2) 3818.00.00</li><li value="(3)">(3) [Compiler?s note: Deleted. See 89 Fed. Reg. 101682]</li></ul></li></ul></li><li value="(g)">(g) Heading 9903.91.06 applies to products of China that are classified in the following 8-digit subheadings, effective with respect to goods entered for consumption, or withdrawn from warehouse for consumption, on or after 12:01 a.m. eastern standard time on January 1, 2026:<ul><li value="(1)">(1) 2504.10.10</li><li value="(2)">(2) 2504.10.50</li><li value="(3)">(3) 2504.90.00</li><li value="(4)">(4) 8505.11.00</li><li value="(5)">(5) 8507.60.00</li></ul></li><li value="(h)">(h) Heading 9903.91.07 applies to products of China that are described in the following 10-digit statistical reporting numbers, effective with respect to goods entered for consumption, or withdrawn from warehouse for consumption, on or after 12:01 a.m. eastern standard time on January 1, 2026:<ul><li value="(1)">(1) N95 respirators of textiles, described in statistical reporting numbers 6307.90.9842 or 6307.90.9844</li><li value="(2)">(2) Respirators of textiles, other than N95 respirators, described in statistical reporting number 6307.90.9850</li></ul></li><li value="(i)">(i) Reserved.</li><li value="(j)">(j) Heading 9903.91.11 applies to products of China that are classified in the following 8-digit subheadings, effective with respect to goods entered for consumption, or withdrawn from warehouse for consumption, on or after 12:01 a.m. eastern daylight time on January 1, 2025:<ul><li value="(1)">(1) 8101.94.00</li></ul></li></ul>',
);

/** Note 18 conditional narrative establishes context rather than product-list inclusion. */
export const note18 = chapterNote(
  18,
  '<ul><li value="(a)">(a) Definitions.</li><li value="(b)">(b) Reserved.</li><li value="(c)">(c) Reserved.</li><li value="(d)">(d) Reserved.</li><li value="(e)">(e) Reserved.</li><li value="(f)">(f) Reserved.</li><li value="(g)">(g) If the conditions are met, heading 9903.45.21 concerns solar cells classified in 8541.43.00 during the stated period.</li><li value="(h)">(h) Notwithstanding heading 9903.45.22, 8541.43.00 remains subject to the product definition and content tests.</li></ul>',
);
