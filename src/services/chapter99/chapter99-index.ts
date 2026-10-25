/**
 * @fileoverview Lossless Chapter 99 passage extraction and bounded legal-reference evidence indexing.
 * @module services/chapter99/chapter99-index
 */
import { createHash } from 'node:crypto';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** Edition and original response-byte digest supplied by the source boundary. */
export interface Chapter99Source {
  release: string;
  sourceDigest: string;
}

/** A complete document-order passage; text is never trimmed. */
export interface NotePassage {
  codeMentions: string[];
  compilerNotice: boolean;
  listCodes: string[];
  locatorStatus: 'recognized' | 'ambiguous';
  noteId: string;
  noteLocator: string;
  noteNumber?: string;
  ordinal: number;
  passageId: string;
  statusMention: boolean;
  subchapter?: string;
  subdivision?: string;
  text: string;
}

/** A supported positive link; the source and target passages remain separately retrievable. */
export interface ExplicitListLink {
  countryCode?: 'CN';
  governingNoteId: string;
  grammar: 'same_note_enumeration' | 'same_subdivision_table';
  heading: string;
  listNoteId: string;
}

/** Partial coverage facts, rather than an applicability or parser confidence claim. */
export interface Chapter99Coverage {
  ambiguousBlocks: number;
  limitations: string[];
  parsedListBlocks: number;
  parserVersion: string;
  sourceDigest: string;
  status: 'partial';
  supportedGrammar: string[];
  totalNoteBlocks: number;
  unresolvedReferenceBlocks: number;
}

/** In-memory normalized source index, with no fetch or persistence side effects. */
export interface Chapter99Index extends Chapter99Source {
  coverage: Chapter99Coverage;
  links: ExplicitListLink[];
  mentions: Map<string, NotePassage[]>;
  passages: NotePassage[];
}

/** Exact matches and their governing/qualification passages; no applicability is computed. */
export interface Chapter99Evidence {
  countryRelation: 'named' | 'unknown' | 'different_country' | 'not_requested';
  kind: 'explicit_list_link' | 'same_passage_mention' | 'compiler_notice';
  matchedCode: string;
  matchLevel: 'exact' | 'rate_line' | 'statistical_subset';
  noteId: string;
  noteLocator: string;
  passageId: string;
  relation: 'inclusion_candidate' | 'exclusion_or_exception' | 'context_only';
  role: 'product_list' | 'governing' | 'qualification' | 'mention';
  sourceCode?: string;
  statusMention: boolean;
}

/** A scalar-safe fragment; concatenation in fragmentIndex order reconstructs the passage. */
export interface NoteFragment {
  fragmentCount: number;
  fragmentIndex: number;
  passageId: string;
  text: string;
}

const CODE = /(?<![\w.])(?:\d{4}\.\d{2}\.\d{2}(?:\.?\d{2})?|\d{10}|\d{8})(?![\d.]|\w)/g;
const EXCEPTION =
  /\b(?:except|other than|excluding|exclusions?|notwithstanding|do not apply|does not apply|shall not apply|not subject to)\b/i;
const BLOCKS = new Set([
  'div',
  'p',
  'li',
  'ul',
  'ol',
  'table',
  'tr',
  'br',
  'nl',
  'hr',
  'h1',
  'h2',
  'h3',
]);
const GRAMMARS = [
  'exact_code_tokens',
  'same_note_enumeration',
  'same_subdivision_table',
  'qualified_co_mentions',
];

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function element(node: Node): node is Element {
  return 'tagName' in node;
}

function ownText(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if (!('childNodes' in node)) return '';
  return node.childNodes
    .filter(
      (child) => !element(child) || !['ul', 'ol', 'table', 'li', 'div'].includes(child.tagName),
    )
    .map(ownText)
    .join('');
}

function codes(text: string): string[] {
  return [...new Set([...text.matchAll(CODE)].map((match) => match[0].replaceAll('.', '')))];
}

/** Compiler annotations remain source text but cannot supply a positive legal clause or list entry. */
function withoutCompilerNotices(text: string): string {
  const marker = /compiler[’']?s?\s+note\b\s*:?/gi;
  let cursor = 0;
  let result = '';
  for (const match of text.matchAll(marker)) {
    if (match.index < cursor) continue;
    const opening = text.lastIndexOf('[', match.index);
    if (opening < cursor || text.slice(opening + 1, match.index).trim()) {
      return result + text.slice(cursor, match.index);
    }
    result += text.slice(cursor, opening);
    let depth = 1;
    let end = opening + 1;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === '[') depth++;
      if (text[end] === ']') depth--;
    }
    if (depth > 0) return result;
    result += ' ';
    cursor = end;
  }
  return result + text.slice(cursor);
}

function key(passage: Pick<NotePassage, 'subchapter' | 'noteNumber' | 'subdivision'>): string {
  return `${passage.subchapter ?? 'chapter'}:${passage.noteNumber ?? '?'}:${passage.subdivision ?? ''}`;
}

/** Parse decoded source HTML. Missing chapter/note structure is an explicit failure. */
export function buildChapter99Index(html: string, source: Chapter99Source): Chapter99Index {
  const document = parseFragment(html);
  const passages: NotePassage[] = [];
  let subchapter: string | undefined;
  let noteNumber: string | undefined;
  let subdivision: string | undefined;
  let recognized = false;
  let section = 'unknown';
  let previousNote = 0;
  let previousAlpha = '';
  let text = '';
  let listCodes: string[] = [];
  let sawChapter = false;
  let sawNotes = false;

  function flush(): void {
    if (!text) return;
    const ordinal = passages.length;
    const location = {
      ...(subchapter && { subchapter }),
      ...(noteNumber && { noteNumber }),
      ...(subdivision && { subdivision }),
    };
    const noteId = `${source.release}:${digest(source.sourceDigest).slice(0, 12)}:${recognized ? key(location) : `${subchapter ?? 'chapter'}:ambiguous`}:${ordinal}:${digest(text).slice(0, 16)}`;
    passages.push({
      ...location,
      noteId,
      passageId: noteId,
      ordinal,
      text,
      locatorStatus: recognized ? 'recognized' : 'ambiguous',
      noteLocator: `${subchapter ? `Subchapter ${subchapter}` : 'Chapter 99'} ${section} ${noteNumber ?? 'unlocated'}${subdivision ? `(${subdivision})` : ''}; block ${ordinal}`,
      codeMentions: codes(text),
      listCodes: [...new Set(listCodes)].filter((code) => !code.startsWith('99')),
      compilerNotice: /compiler[’']?s?\s+note/i.test(text),
      statusMention: /\b(?:expired|terminated|suspended)\b/i.test(text),
    });
    text = '';
    listCodes = [];
  }

  function visit(node: Node): void {
    if (node.nodeName === '#text' && 'value' in node) {
      text += node.value;
      return;
    }
    if (!('childNodes' in node)) return;
    if (element(node)) {
      const className = node.attrs.find((attr) => attr.name === 'class')?.value ?? '';
      const direct = ownText(node).trim();
      if (/misc_title\b/.test(className)) {
        if (/^CHAPTER\s+99$/i.test(direct)) sawChapter = true;
        const title = /^SUBCHAPTER\s+([IVXLCDM]+)\b/i.exec(direct);
        if (title) {
          flush();
          subchapter = title[1];
          noteNumber = undefined;
          subdivision = undefined;
          previousNote = 0;
          previousAlpha = '';
          recognized = false;
        }
      }
      if (/misc_note_title\b/.test(className)) {
        flush();
        section = direct;
        sawNotes ||= /U\.S\.\s*Notes/i.test(direct);
        noteNumber = undefined;
        subdivision = undefined;
        previousNote = 0;
        previousAlpha = '';
        recognized = false;
      }
      if (node.tagName === 'li') {
        flush();
        const attribute = node.attrs.find((attr) => attr.name === 'value')?.value.trim();
        const numbered = /^(\d+)\./.exec(direct);
        const alpha = /^(?:\(([a-z]+)\)|([a-z]+)\.)/.exec(direct);
        const label = numbered?.[0] ?? alpha?.[0];
        const agrees = attribute === label;
        const enumeration = direct.replace(/^(?:\([\da-z]+\)|[\da-z]+\.)\s*/, '').trim();
        const enumeratedCodes = codes(enumeration);
        if (enumeratedCodes.length === 1 && enumeration.replaceAll('.', '') === enumeratedCodes[0])
          listCodes.push(enumeratedCodes[0]);
        if (numbered) {
          const number = Number(numbered[1]);
          recognized = agrees && number === previousNote + 1 && /U\.S\.\s*Notes/i.test(section);
          if (agrees && number > previousNote) {
            noteNumber = numbered[1];
            previousNote = number;
            previousAlpha = '';
          }
          subdivision = undefined;
        } else if (alpha) {
          const value = alpha[1] ?? alpha[2] ?? '';
          const expected =
            previousAlpha === ''
              ? 'a'
              : previousAlpha.at(-1) === 'z'
                ? 'a'.repeat(previousAlpha.length + 1)
                : String.fromCharCode((previousAlpha.charCodeAt(0) || 96) + 1).repeat(
                    previousAlpha.length,
                  );
          recognized = agrees && Boolean(noteNumber) && value === expected;
          subdivision = recognized || value === previousAlpha ? value : undefined;
          if (recognized) previousAlpha = value;
        } else {
          recognized = false;
          subdivision = undefined;
        }
      }
      if (BLOCKS.has(node.tagName)) text += '\n';
      if (node.tagName === 'td' || node.tagName === 'th') {
        const cell = ownText(node).trim();
        const exact = codes(cell);
        if (exact.length === 1 && cell.replaceAll('.', '') === exact[0]) listCodes.push(exact[0]);
      }
    }
    for (const child of node.childNodes) visit(child);
    if (element(node)) {
      if (node.tagName === 'td' || node.tagName === 'th') text += '\t';
      if (BLOCKS.has(node.tagName)) text += '\n';
    }
  }
  visit(document);
  flush();
  if (!sawChapter || !sawNotes || !passages.some((passage) => passage.noteNumber))
    throw serviceUnavailable('USITC Chapter 99 title and numbered U.S. notes are missing.', {
      reason: 'notes_structure_changed',
      retryable: false,
    });

  const unique = new Map<string, NotePassage[]>();
  for (const passage of passages) {
    if (!passage.noteNumber || (!passage.subdivision && passage.locatorStatus !== 'recognized'))
      continue;
    const entries = unique.get(key(passage)) ?? [];
    entries.push(passage);
    unique.set(key(passage), entries);
  }
  for (const entries of unique.values())
    if (entries.length > 1) for (const passage of entries) passage.locatorStatus = 'ambiguous';
  const links: ExplicitListLink[] = [];
  for (const passage of passages) {
    if (passage.locatorStatus !== 'recognized') continue;
    const positive = withoutCompilerNotices(passage.text).split(EXCEPTION, 1)[0] ?? '';
    const references = [
      ...positive.matchAll(
        /(?:subheadings?\s+enumerated|products?\s+(?:enumerated|described|provided for))\s+in\s+(?:U\.S\.\s*)?note\s+(\d+)\s*\(([a-z]+)\)(?:\s+to\s+subchapter\s+([IVXLCDM]+))?/gi,
      ),
    ];
    for (const reference of references) {
      if (
        reference[1] !== passage.noteNumber ||
        (reference[3] && reference[3] !== passage.subchapter)
      )
        continue;
      const targets = unique.get(key({ ...passage, subdivision: reference[2] ?? '' }));
      const target = targets?.length === 1 ? targets[0] : undefined;
      if (target?.locatorStatus !== 'recognized' || target.listCodes.length === 0) continue;
      // Only a sentence naming one heading can establish a positive link. Decimal dots are not sentence boundaries.
      const sentenceStart = positive.lastIndexOf('. ', reference.index);
      const sentence = positive.slice(
        sentenceStart < 0 ? 0 : sentenceStart + 2,
        (reference.index ?? 0) + reference[0].length,
      );
      const headings = codes(sentence).filter((code) => code.startsWith('99') && code.length === 8);
      if (
        headings.length !== 1 ||
        !/\b(?:subject to|appl(?:y|ies)|imposed by|under heading)\b/i.test(sentence)
      )
        continue;
      links.push({
        heading: headings[0] ?? '',
        governingNoteId: passage.noteId,
        listNoteId: target.noteId,
        grammar: 'same_note_enumeration',
        ...(/products of China (?:that are|as provided)/i.test(sentence) && {
          countryCode: 'CN' as const,
        }),
      });
    }
    const opening = positive.split('\t', 1)[0] ?? '';
    const headings = codes(opening).filter((code) => code.startsWith('99') && code.length === 8);
    if (
      passage.listCodes.length &&
      headings.length === 1 &&
      /heading\s+99\d{2}\.\d{2}\.\d{2}\s+applies to products\b/i.test(opening) &&
      /enumerated in this subdivision/i.test(opening)
    )
      links.push({
        heading: headings[0] ?? '',
        governingNoteId: passage.noteId,
        listNoteId: passage.noteId,
        grammar: 'same_subdivision_table',
        ...(/applies to products of China that are/i.test(opening) && {
          countryCode: 'CN' as const,
        }),
      });
  }
  const deduplicatedLinks = [
    ...new Map(
      links.map((link) => [`${link.heading}:${link.governingNoteId}:${link.listNoteId}`, link]),
    ).values(),
  ];
  const mentions = new Map<string, NotePassage[]>();
  // Failed progression retains its text, never the preceding block's inferred legal locator.
  for (const passage of passages) {
    if (passage.locatorStatus !== 'ambiguous') continue;
    delete passage.noteNumber;
    delete passage.subdivision;
    passage.noteLocator = `${passage.subchapter ? `Subchapter ${passage.subchapter}` : 'Chapter 99'}; ambiguous document-order block ${passage.ordinal}`;
  }
  for (const passage of passages)
    for (const code of passage.codeMentions) {
      const entries = mentions.get(code) ?? [];
      entries.push(passage);
      mentions.set(code, entries);
    }
  const linked = new Set(deduplicatedLinks.map((link) => link.listNoteId));
  return {
    ...source,
    passages,
    links: deduplicatedLinks,
    mentions,
    coverage: {
      status: 'partial',
      parserVersion: 'chapter99-1',
      sourceDigest: source.sourceDigest,
      supportedGrammar: GRAMMARS,
      totalNoteBlocks: passages.length,
      parsedListBlocks: linked.size,
      unresolvedReferenceBlocks: passages.filter(
        (passage) =>
          passage.codeMentions.some((code) => !code.startsWith('99')) &&
          !linked.has(passage.noteId),
      ).length,
      ambiguousBlocks: passages.filter((passage) => passage.locatorStatus === 'ambiguous').length,
      limitations: [
        'Only exact 8/10-digit mentions and bounded positive same-note list links are indexed.',
        'DOM nesting does not establish legal hierarchy; conflicting labels remain ambiguous.',
        'Product-independent provisions, ranges, external annexes, derivative/content tests and legal applicability are not determined.',
        'Country scope is unknown except for reviewed explicit products-of-China enumeration clauses.',
        'Published status words do not establish current enforceability.',
      ],
    },
  };
}

/** Retrieve all evidence for a verified base rate line or statistical number. */
export function findChapter99Evidence(
  index: Chapter99Index,
  input: { code: string; verifiedBase8?: string; countryCode?: string },
): {
  evidence: Chapter99Evidence[];
  unmappedEvidence: Chapter99Evidence[];
  coverage: Chapter99Coverage & { unmappedEvidenceCount: number };
} {
  if (!/^(?:\d{8}|\d{10})$/.test(input.code) || input.code.startsWith('99'))
    throw new Error('A base commodity code of 8 or 10 digits is required.');
  if (
    input.verifiedBase8 &&
    (!/^\d{8}$/.test(input.verifiedBase8) || !input.code.startsWith(input.verifiedBase8))
  )
    throw new Error('Verified rate-line parent must be the matching 8-digit code.');
  const matched = new Map<string, 'exact' | 'rate_line' | 'statistical_subset'>([
    [input.code, 'exact'],
  ]);
  if (input.code.length === 10 && input.verifiedBase8)
    matched.set(input.verifiedBase8, 'rate_line');
  if (input.code.length === 8)
    for (const code of index.mentions.keys())
      if (code.length === 10 && code.startsWith(input.code))
        matched.set(code, 'statistical_subset');
  const evidence: Chapter99Evidence[] = [];
  const unmappedEvidence: Chapter99Evidence[] = [];
  const byId = new Map(index.passages.map((passage) => [passage.noteId, passage]));
  for (const [matchedCode, matchLevel] of matched)
    for (const passage of index.mentions.get(matchedCode) ?? []) {
      const links = index.links.filter(
        (link) => link.listNoteId === passage.noteId && passage.listCodes.includes(matchedCode),
      );
      function record(
        target: NotePassage,
        sourceCode: string | undefined,
        relation: Chapter99Evidence['relation'],
        role: Chapter99Evidence['role'],
        link?: ExplicitListLink,
      ): Chapter99Evidence {
        return {
          kind:
            target.compilerNotice && relation !== 'inclusion_candidate'
              ? 'compiler_notice'
              : link
                ? 'explicit_list_link'
                : 'same_passage_mention',
          relation:
            target.compilerNotice && relation !== 'inclusion_candidate' ? 'context_only' : relation,
          role,
          noteId: target.noteId,
          passageId: target.passageId,
          noteLocator: target.noteLocator,
          ...(sourceCode && { sourceCode }),
          matchedCode,
          matchLevel,
          countryRelation: !input.countryCode
            ? 'not_requested'
            : !link?.countryCode
              ? 'unknown'
              : input.countryCode === link.countryCode
                ? 'named'
                : 'different_country',
          statusMention: target.statusMention,
        };
      }
      for (const link of links) {
        const relation = codes(withoutCompilerNotices(passage.text)).includes(matchedCode)
          ? 'inclusion_candidate'
          : 'context_only';
        evidence.push(record(passage, link.heading, relation, 'product_list', link));
        if (passage.compilerNotice)
          evidence.push({
            ...record(passage, link.heading, 'context_only', 'qualification', link),
            kind: 'compiler_notice',
          });
        const governing = byId.get(link.governingNoteId);
        if (governing && governing !== passage)
          evidence.push(record(governing, link.heading, 'context_only', 'governing', link));
        // Every uniquely located sibling is reachable as qualification context; no scope is inferred from it.
        for (const sibling of index.passages)
          if (
            sibling !== governing &&
            sibling !== passage &&
            sibling.locatorStatus === 'recognized' &&
            sibling.subchapter === passage.subchapter &&
            sibling.noteNumber === passage.noteNumber &&
            sibling.codeMentions.includes(link.heading)
          )
            evidence.push(record(sibling, link.heading, 'context_only', 'qualification', link));
      }
      const headings = passage.codeMentions.filter(
        (code) => code.startsWith('99') && code.length === 8,
      );
      if (links.length === 0) {
        const relation = EXCEPTION.test(passage.text) ? 'exclusion_or_exception' : 'context_only';
        if (headings.length && passage.locatorStatus === 'recognized')
          for (const heading of headings)
            evidence.push(record(passage, heading, relation, 'mention'));
        else unmappedEvidence.push(record(passage, undefined, relation, 'mention'));
      }
    }
  function deduplicate(items: Chapter99Evidence[]): Chapter99Evidence[] {
    return [
      ...new Map(
        items.map((item) => [
          `${item.noteId}:${item.sourceCode}:${item.matchedCode}:${item.kind}:${item.role}:${item.relation}`,
          item,
        ]),
      ).values(),
    ];
  }
  const unmatched = deduplicate(unmappedEvidence);
  return {
    evidence: deduplicate(evidence),
    unmappedEvidence: unmatched,
    coverage: { ...index.coverage, unmappedEvidenceCount: unmatched.length },
  };
}

/** Retrieve one complete passage as ordered fragments of at most 2,000 UTF-8 bytes. */
export function getChapter99Fragments(index: Chapter99Index, noteId: string): NoteFragment[] {
  const passage = index.passages.find((item) => item.noteId === noteId);
  if (!passage)
    throw validationError('Passage does not belong to this edition and source digest.', {
      reason: 'note_not_found',
    });
  const texts: string[] = [];
  let fragment = '';
  let bytes = 0;
  for (const scalar of passage.text) {
    const size = Buffer.byteLength(scalar, 'utf8');
    if (bytes + size > 2000) {
      texts.push(fragment);
      fragment = '';
      bytes = 0;
    }
    fragment += scalar;
    bytes += size;
  }
  if (fragment) texts.push(fragment);
  return texts.map((text, fragmentIndex) => ({
    passageId: passage.passageId,
    fragmentIndex,
    fragmentCount: texts.length,
    text,
  }));
}
