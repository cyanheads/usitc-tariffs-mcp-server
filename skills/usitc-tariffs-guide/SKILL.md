---
name: usitc-tariffs-guide
description: Identifier chains and gates for the usitc_* US tariff tools. Covers choosing an HTS code from flat search hits, reading published, inherited and unpublished rate columns, Special-program symbols and Column 2 listing, and reading Chapter 99 candidates (Section 301, 232) without treating a candidate or an empty list as an applicable or cleared duty. Use when finding the base or additional duty a product pays under the HTSUS.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The usitc_* tools read the US Harmonized Tariff Schedule as USITC currently publishes it: one current edition, keyless. Reach for them to find a classification, read its indented context and published duty columns, decode program symbols and units, and gather Chapter 99 evidence for additional duties. They do not answer for a past date, confirm which countries a program covers, or find additional duties that name no product code.

## Identifiers

- **`nodeId`**: on usitc_get_heading `nodes` and the usitc_lookup_duty_rate `row`, and inside every `parentFollowUp`, every inherited rate column's `sourceFollowUp`, and footnote evidence's `followUp`. Only usitc_get_heading accepts it, paired with the containing four-digit heading as `code`. Call a follow-up object exactly as returned: a narrower `code` rejects a node outside its own subtree as `invalid_cursor`. Search rows and `sections` markers carry none. A nodeId from an earlier edition fails `cursor_expired`.
- **Cursors**: `page.nextCursor` continues only the same tool with the same normalized arguments and `limit`. usitc_check_additional_duties also returns `nextCall` (and `notesPage.nextCall` for passages) holding the complete next arguments; send them unchanged.
- **`candidateCode`**: a candidate's `code`. Its `evidenceFollowUp` already pairs it with view `evidence` and the original code and country.
- **`noteId`**: on evidence and unmapped records, except footnote evidence, whose follow-up is a heading node instead. Use it with the code that returned it, in the same edition; a query whose evidence lacks it fails `note_not_found`. Its passage pages continue through `noteCursor`.
- **`release.name`**: on every result. Every identifier above belongs to that edition.

## Gates

1. **Search words widen, never narrow.** usitc_search_hts passes the query to USITC's keyword search, which matches each word separately and splits hyphenated words: `cotton t-shirts` returns every row matching `cotton`, `t` or `shirts`, and the lone `t` matches unrelated rows across the schedule. Search one distinctive word (`singlets` rather than `cotton t-shirts`) and narrow with `codePrefix`. Hits are matching rows, not a heading's complete set of rows.
2. **Blank is not Free.** A search row's empty rate cell is unresolved. usitc_lookup_duty_rate and usitc_get_heading resolve each column as `published`, `inherited` (from the eight-digit ancestor, which it names) or `not_published`. Never report a blank cell or `not_published` as Free or zero.
3. **Read the indented path before choosing a code.** A row's description covers only its own indent level ("Of cotton", "Other"), and unnumbered superior rows carry text that governs everything indented under them. Read the heading with usitc_get_heading, or walk `parentFollowUp` up to it, before naming a classification.
4. **One edition per answer.** When an answer combines several calls, check they share `release.name`. If it changed, repeat the earlier calls.
5. **Special symbols decode names, not coverage.** `A`, `A*` and `A+` (likewise `E`/`E*`, `P`/`P+`, `S`/`S+`) decode to one program name but are distinct published symbols. What a suffix restricts is in General Note 3 at `decoder.sourceUrl`; the decoder does not transcribe it. `parseCoverage: partial` means `unparsedText` or an unrecognized symbol was left undecoded, so read `publishedText`.
6. **A Chapter 99 candidate is not an inclusion.** usitc_check_additional_duties groups every Chapter 99 heading its evidence names: through a positive list link, an exception clause, governing text or a footnote mention. Before calling a candidate relevant, page its evidence and read `relation`. Only `inclusion_candidate` is a positive product-list link. `exclusion_or_exception` is a passage naming your code beside exception wording ("except", "other than", "does not apply"). `context_only` is a mention, or governing or qualification text. Identify what a candidate is from its published `description` and governing passage, never from its number.
7. **Some additional duties are invisible here.** Provisions that apply to a country or a class of goods without listing the product's code are never found from a product code, so a candidate list, empty or not, omits them; say so whenever you report Chapter 99 results. One that does appear is there because a passage names the code, usually as an exception (gate 6).
8. **Country scope is China or Canada only.** The parser recognizes a single "product(s) of China" or "product(s) of Canada" scope, so `named` occurs only for CN or CA. For any other country every candidate is `unknown` or `different_country`, and `different_country` there marks China- or Canada-scoped evidence.
9. **Match level matters.** An eight-digit query also returns evidence for narrower ten-digit numbers (`matchLevel: statistical_subset`, `matchedCode` naming the number), which covers only goods under that number. With the exact ten-digit number, evidence is `exact`, or `rate_line` through its eight-digit line.
10. **Read unmapped evidence.** The first candidates page carries `coverage.unmappedEvidenceCount`: passages that mention the code but could not be tied to a heading. Read them (view `unmapped`, then each `noteId`) even when candidates exist; the result notice points to them only when candidates are empty.
11. **Quote whole passages.** Concatenate every fragment page of a noteId before quoting, and read any `governing` and `qualification` evidence records the same candidate carries: a list passage alone omits its exceptions and conditions.

## Workflows

**Classify and price a product.** Search as gate 1 describes; usitc_list_reference topic `chapters` gives chapter titles for choosing a `codePrefix`. Read the heading (gate 3), then carry the most specific number the goods support, the ten-digit statistical number when known, into usitc_lookup_duty_rate with `countryCode`, and on into usitc_check_additional_duties through its `chapter99Pointers.followUp`. Report the published columns and the Chapter 99 evidence separately, with the edition, and never add them together.

**Every line of a heading with its rates.** usitc_get_heading on the four-digit heading with `limit` 100 returns each node with `resolvedRates`, one page per 100 nodes; no per-line lookup is needed. Rate lines are the eight-digit nodes plus any ten-digit node whose `rateLineCode` has no eight-digit row of its own (a combined row). usitc_browse_chapter's `rateLineCount` gives the count to expect. Call usitc_lookup_duty_rate on a line only for its decoded Special column or country assessment.

**Preference programs for a heading.** Programs attach to rate lines, not headings. Read each line's Special text from usitc_get_heading, then decode one line's symbols with usitc_lookup_duty_rate, or the whole symbol table with usitc_list_reference topic `spi`. No tool says which countries a program covers.

**Is a country a Column 2 country.** No tool lists Column 2 countries. Call usitc_lookup_duty_rate with any eight-digit code and that `countryCode`: `countryAssessment.column2Listing.status` does not depend on the code, and a miss still returns it. `unknown` means the current edition's General Note 3 has not been verified against the reviewed one; read General Note 3(b) at `column2Listing.sourceUrl`.

**Chapter 99 research for one product** (Section 301 on a battery from China, say). Call usitc_check_additional_duties with the exact number and `countryCode`. On the first page read `collectionTotals`, `countryFilter` and `coverage.unmappedEvidenceCount`. Follow each candidate's `evidenceFollowUp` (gate 6), each record's `followUp` for its passage (gate 11), then the unmapped view (gate 10). Report candidates with their relations and passages, and what gate 7 leaves out.
