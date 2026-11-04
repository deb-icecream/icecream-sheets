/**
 * Wave-2 slice A (audit §3.2): threaded comments + persons in the XLSX
 * adapter — [MS-XLSX] CT_Person §2.6.203, CT_Mention §2.6.202,
 * CT_ThreadedComment §2.6.205, CT_ThreadedComments §2.6.206.
 *
 * Fixtures are hand-built packages the way Excel writes them: a
 * workbook-global xl/persons/person.xml, one
 * xl/threadedComments/threadedCommentN.xml per sheet linked from the
 * worksheet rels (+ the extLst x18at:threadedComments reference), and
 * [Content_Types].xml overrides for both part families.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { WorkbookData } from '@icecream-sheets/engine';
import {
  THREADED_COMMENTS_METADATA_KEY,
  XlsxAdapter,
  injectThreadedComments,
  parsePersonsXml,
  parseThreadedCommentsXml,
  personsToXml,
  readThreadedComments,
  resolvePerson,
  threadedCommentsToXml,
  type PersonRecord,
  type SheetDataWithThreadedComments,
  type ThreadedCommentThread,
  type WorkbookThreadedComments,
} from '../src/index.js';

const dec = new TextDecoder();
const adapter = new XlsxAdapter();

const ALICE = '{11111111-1111-1111-1111-111111111111}';
const BOB = '{22222222-2222-2222-2222-222222222222}';
const CAROL = '{33333333-3333-3333-3333-333333333333}';
const THREAD_A = '{AAAAAAAA-0000-0000-0000-000000000001}';
const REPLY_A1 = '{AAAAAAAA-0000-0000-0000-000000000002}';
const REPLY_A2 = '{AAAAAAAA-0000-0000-0000-000000000003}';
const THREAD_B = '{BBBBBBBB-0000-0000-0000-000000000001}';
const THREAD_C = '{CCCCCCCC-0000-0000-0000-000000000001}';
const MENTION_1 = '{DDDDDDDD-0000-0000-0000-000000000001}';

const PERSONS: PersonRecord[] = [
  { id: ALICE, displayName: 'Alice Adams', initials: 'AA', userId: 'alice@example.com', providerId: 'Office365' },
  { id: BOB, displayName: 'Bob Smith', initials: 'BS', userId: 'bob@example.com', providerId: 'Office365' },
  // Mention-only person: providerId is "PeoplePicker" per [MS-XLSX] §2.3.7.1.
  { id: CAROL, displayName: 'Carol Jones', userId: 'carol@example.com', providerId: 'PeoplePicker' },
];

const THREADS_DATA: ThreadedCommentThread[] = [
  {
    id: THREAD_A,
    ref: 'B2',
    personId: ALICE,
    dateTime: '2024-03-01T10:15:00Z',
    done: false,
    text: 'Hi @Bob Smith, check totals & <units>',
    mentions: [{ mentionId: MENTION_1, mentionPersonId: BOB, startIndex: 3, length: 10 }],
    replies: [
      { id: REPLY_A1, parentId: THREAD_A, personId: BOB, dateTime: '2024-03-01T11:00:00Z', done: false, text: 'On it' },
      { id: REPLY_A2, parentId: THREAD_A, personId: ALICE, dateTime: '2024-03-01T11:30:00Z', done: false, text: 'Thanks!' },
    ],
  },
  {
    id: THREAD_B,
    ref: 'C4',
    personId: BOB,
    dateTime: '2024-03-02T09:00:00Z',
    done: true,
    text: 'Resolved thread',
    replies: [],
  },
];

const THREADS_NOTES: ThreadedCommentThread[] = [
  {
    id: THREAD_C,
    ref: 'A1',
    personId: CAROL,
    dateTime: '2024-03-03T08:00:00Z',
    done: false,
    text: 'Note-sheet thread',
    replies: [],
  },
];

const EXPECTED_MODEL: WorkbookThreadedComments = {
  persons: PERSONS,
  sheets: [
    { sheetName: 'Data', threads: THREADS_DATA },
    { sheetName: 'Notes', threads: THREADS_NOTES },
  ],
};

/* ------------------------------------------------------------------ */
/* Hand-built native source package (as Excel writes it)               */
/* ------------------------------------------------------------------ */

const PERSONS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">' +
  `<person displayName="Alice Adams" id="${ALICE}" userId="alice@example.com" providerId="Office365" initials="AA"/>` +
  `<person displayName="Bob Smith" id="${BOB}" userId="bob@example.com" providerId="Office365" initials="BS"/>` +
  `<person displayName="Carol Jones" id="${CAROL}" userId="carol@example.com" providerId="PeoplePicker"/>` +
  '</personList>';

// Document order deliberately interleaves thread B between thread A's
// replies: grouping must follow parentId, not position.
const COMMENTS_1_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">' +
  `<threadedComment ref="B2" dT="2024-03-01T10:15:00Z" personId="${ALICE}" id="${THREAD_A}">` +
  '<text>Hi @Bob Smith, check totals &amp; &lt;units&gt;</text>' +
  `<mentions><mention startIndex="3" length="10" mentionId="${MENTION_1}" mentionpersonId="${BOB}"/></mentions>` +
  '</threadedComment>' +
  `<threadedComment ref="B2" dT="2024-03-01T11:00:00Z" personId="${BOB}" id="${REPLY_A1}" parentId="${THREAD_A}">` +
  '<text>On it</text></threadedComment>' +
  `<threadedComment ref="C4" dT="2024-03-02T09:00:00Z" personId="${BOB}" id="${THREAD_B}" done="1">` +
  '<text>Resolved thread</text></threadedComment>' +
  `<threadedComment ref="B2" dT="2024-03-01T11:30:00Z" personId="${ALICE}" id="${REPLY_A2}" parentId="${THREAD_A}">` +
  '<text>Thanks!</text></threadedComment>' +
  '</ThreadedComments>';

const COMMENTS_2_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">' +
  `<threadedComment ref="A1" dT="2024-03-03T08:00:00Z" personId="${CAROL}" id="${THREAD_C}">` +
  '<text>Note-sheet thread</text></threadedComment>' +
  '</ThreadedComments>';

function sheetXml(cellText: string, withExtLstRid: string | null): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>' + cellText + '</t></is></c></row></sheetData>' +
    (withExtLstRid
      ? '<extLst><ext uri="{E9A180F0-9CD2-4F85-A628-08839FB49195}" xmlns:x18at="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">' +
        `<x18at:threadedComments r:id="${withExtLstRid}"/></ext></extLst>`
      : '') +
    '</worksheet>'
  );
}

function relsXml(entries: Array<[string, string, string]>): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') +
    '</Relationships>'
  );
}

const TC_REL = 'http://schemas.microsoft.com/office/2017/relationships/threadedComment';
const PERSON_REL = 'http://schemas.microsoft.com/office/2017/relationships/person';
const WS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

function sourcePackage(overrides: Record<string, string | null> = {}): Uint8Array {
  const files: Record<string, ReturnType<typeof strToU8>> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>' +
      '<Override PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>' +
      '<Override PartName="/xl/threadedComments/threadedComment2.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>' +
      '</Types>',
    ),
    '_rels/.rels': strToU8(relsXml([['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'xl/workbook.xml']])),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(relsXml([
      ['rId1', WS_REL, 'worksheets/sheet1.xml'],
      ['rId2', WS_REL, 'worksheets/sheet2.xml'],
      ['rId3', PERSON_REL, 'persons/person.xml'],
    ])),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml('Data sheet', 'rIdTc1')),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(relsXml([['rIdTc1', TC_REL, '../threadedComments/threadedComment1.xml']])),
    'xl/worksheets/sheet2.xml': strToU8(sheetXml('Notes sheet', 'rIdTc2')),
    'xl/worksheets/_rels/sheet2.xml.rels': strToU8(relsXml([['rIdTc2', TC_REL, '../threadedComments/threadedComment2.xml']])),
    'xl/persons/person.xml': strToU8(PERSONS_XML),
    'xl/threadedComments/threadedComment1.xml': strToU8(COMMENTS_1_XML),
    'xl/threadedComments/threadedComment2.xml': strToU8(COMMENTS_2_XML),
  };
  for (const [path, value] of Object.entries(overrides)) {
    if (value === null) delete files[path];
    else files[path] = strToU8(value);
  }
  return zipSync(files);
}

function partText(bytes: Uint8Array, path: string): string {
  const raw = unzipSync(bytes.slice())[path];
  return raw ? dec.decode(raw) : '';
}

function partPaths(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes.slice()));
}

function modelOf(data: WorkbookData): WorkbookThreadedComments {
  return JSON.parse(data.metadata[THREADED_COMMENTS_METADATA_KEY] as string) as WorkbookThreadedComments;
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

describe('threaded comments: parse', () => {
  it('parses persons + threads exactly (persons resolved, reply chains, done, timestamps, mentions)', () => {
    const data = adapter.read(sourcePackage());
    expect(modelOf(data)).toEqual(EXPECTED_MODEL);
    const dataSheet = data.sheets[0] as SheetDataWithThreadedComments;
    const notesSheet = data.sheets[1] as SheetDataWithThreadedComments;
    expect(dataSheet.threadedComments).toEqual(THREADS_DATA);
    expect(notesSheet.threadedComments).toEqual(THREADS_NOTES);
    // Persons resolve by id.
    const persons = modelOf(data).persons;
    expect(resolvePerson(persons, THREADS_DATA[0]!.personId)?.displayName).toBe('Alice Adams');
    expect(resolvePerson(persons, THREADS_DATA[0]!.mentions![0]!.mentionPersonId)?.displayName).toBe('Bob Smith');
    expect(THREADS_DATA[0]!.replies.map((r) => r.id)).toEqual([REPLY_A1, REPLY_A2]);
    expect(dataSheet.threadedComments![1]!.done).toBe(true);
    expect(dataSheet.threadedComments![0]!.dateTime).toBe('2024-03-01T10:15:00Z');
  });

  it('readThreadedComments works directly on an unzipped package', () => {
    const files = unzipSync(sourcePackage().slice());
    expect(readThreadedComments(files)).toEqual(EXPECTED_MODEL);
  });

  it('parses prefixed (xltc:) parts and a lowercase root', () => {
    const xml =
      '<xltc:threadedComments xmlns:xltc="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">' +
      `<xltc:threadedComment ref="$b$2" dT="2024-01-01T00:00:00Z" personId="${ALICE}" id="${THREAD_A}" done="true">` +
      '<xltc:text>Prefixed</xltc:text></xltc:threadedComment></xltc:threadedComments>';
    expect(parseThreadedCommentsXml(xml)).toEqual([{
      id: THREAD_A, ref: 'B2', personId: ALICE, dateTime: '2024-01-01T00:00:00Z',
      done: true, text: 'Prefixed', replies: [],
    }]);
  });

  it('persons XML round-trips at the unit level', () => {
    expect(parsePersonsXml(PERSONS_XML)).toEqual(PERSONS);
    expect(parsePersonsXml(personsToXml(PERSONS))).toEqual(PERSONS);
  });

  it('threadedComments XML round-trips at the unit level', () => {
    expect(parseThreadedCommentsXml(threadedCommentsToXml(THREADS_DATA))).toEqual(THREADS_DATA);
  });
});

/* ------------------------------------------------------------------ */
/* Round-trip through the adapter                                      */
/* ------------------------------------------------------------------ */

describe('threaded comments: adapter round-trip', () => {
  it('model -> write -> re-parse is value-identical, with native parts wired', () => {
    const once = adapter.read(sourcePackage());
    const bytes = adapter.write(once);
    const paths = partPaths(bytes);
    expect(paths).toContain('xl/persons/person.xml');
    const tcParts = paths.filter((p) => p.startsWith('xl/threadedComments/')).sort();
    expect(tcParts).toHaveLength(2);
    // Persons part parses back to the same records.
    expect(parsePersonsXml(partText(bytes, 'xl/persons/person.xml'))).toEqual(PERSONS);
    // Content types carry both overrides.
    const ct = partText(bytes, '[Content_Types].xml');
    expect(ct).toContain('application/vnd.ms-excel.person+xml');
    expect(ct).toContain('application/vnd.ms-excel.threadedcomments+xml');
    // Workbook rels link the persons part.
    expect(partText(bytes, 'xl/_rels/workbook.xml.rels')).toContain(PERSON_REL);
    // Each sheet: rels link + extLst reference whose r:id matches the rel.
    for (const sheetFile of ['sheet1', 'sheet2']) {
      const rels = partText(bytes, `xl/worksheets/_rels/${sheetFile}.xml.rels`);
      expect(rels).toContain(TC_REL);
      const rid = /<Relationship Id="([^"]*)"[^>]*threadedComment/.exec(rels)?.[1];
      expect(rid).toBeTruthy();
      const sheet = partText(bytes, `xl/worksheets/${sheetFile}.xml`);
      expect(sheet).toContain('<extLst>');
      expect(sheet).toContain(`<x18at:threadedComments r:id="${rid}"/>`);
    }
    // Full re-read is value-identical.
    const twice = adapter.read(bytes);
    expect(modelOf(twice)).toEqual(EXPECTED_MODEL);
    expect((twice.sheets[0] as SheetDataWithThreadedComments).threadedComments).toEqual(THREADS_DATA);
    expect((twice.sheets[1] as SheetDataWithThreadedComments).threadedComments).toEqual(THREADS_NOTES);
  });

  it('writes an app-authored model (sheet fields + metadata persons) natively', () => {
    const data: WorkbookData = {
      sheets: [{
        name: 'S',
        rows: [['x', 1]],
        threadedComments: THREADS_DATA,
      } as SheetDataWithThreadedComments],
      metadata: {
        [THREADED_COMMENTS_METADATA_KEY]: JSON.stringify({ persons: PERSONS, sheets: [] }),
      },
    };
    const bytes = adapter.write(data);
    expect(partPaths(bytes)).toContain('xl/persons/person.xml');
    const back = adapter.read(bytes);
    expect(modelOf(back).persons).toEqual(PERSONS);
    expect((back.sheets[0] as SheetDataWithThreadedComments).threadedComments).toEqual(THREADS_DATA);
  });

  it('injectThreadedComments on a plain SheetJS package creates the wired parts', () => {
    const plain: WorkbookData = { sheets: [{ name: 'S', rows: [[1]] }], metadata: {} };
    const plainBytes = adapter.write(plain);
    const out = injectThreadedComments(plainBytes, EXPECTED_MODEL.sheets[0]
      ? { persons: PERSONS, sheets: [{ sheetName: 'S', threads: THREADS_DATA }] }
      : EXPECTED_MODEL);
    expect(out).not.toBe(plainBytes);
    const files = unzipSync(out.slice());
    expect(readThreadedComments(files)).toEqual({
      persons: PERSONS,
      sheets: [{ sheetName: 'S', threads: THREADS_DATA }],
    });
  });

  it('inject on an Excel-shaped package updates parts in place (one extLst ref, rel id reused)', () => {
    const changed: WorkbookThreadedComments = {
      persons: PERSONS,
      sheets: [{ sheetName: 'Data', threads: [{ ...THREADS_DATA[0]!, text: 'Edited text', replies: [] }] }],
    };
    const out = injectThreadedComments(sourcePackage(), changed);
    const sheet = partText(out, 'xl/worksheets/sheet1.xml');
    // Exactly one threadedComments extension, pointing at the sheet's rel.
    expect(sheet.match(/x18at:threadedComments/g)).toHaveLength(1);
    expect(sheet).toContain('<x18at:threadedComments r:id="rIdTc1"/>');
    const files = unzipSync(out.slice());
    const model = readThreadedComments(files);
    expect(model.sheets.find((s) => s.sheetName === 'Data')!.threads[0]!.text).toBe('Edited text');
    // The other sheet's part is preserved untouched by this pass.
    expect(model.sheets.find((s) => s.sheetName === 'Notes')!.threads).toEqual(THREADS_NOTES);
  });
});

/* ------------------------------------------------------------------ */
/* Untouched + clearing                                                */
/* ------------------------------------------------------------------ */

describe('threaded comments: untouched / cleared', () => {
  it('a package without threaded comments is untouched (no parts invented)', () => {
    const data: WorkbookData = { sheets: [{ name: 'S', rows: [[1, 2]] }], metadata: {} };
    const bytes = adapter.write(data);
    const paths = partPaths(bytes);
    expect(paths.some((p) => p.includes('threadedComments'))).toBe(false);
    expect(paths.some((p) => p.includes('persons'))).toBe(false);
    const back = adapter.read(bytes);
    expect(back.metadata[THREADED_COMMENTS_METADATA_KEY]).toBeUndefined();
    expect((back.sheets[0] as SheetDataWithThreadedComments).threadedComments).toBeUndefined();
    // The bytes wrapper is a no-op for an absent/garbage model.
    expect(injectThreadedComments(bytes, undefined)).toBe(bytes);
    expect(injectThreadedComments(bytes, { persons: [], sheets: [] })).toBe(bytes);
    expect(injectThreadedComments(bytes, 'not json')).toBe(bytes);
  });

  it('present-but-empty sheet fields strip the threads on write (persons kept when modelled)', () => {
    const data = adapter.read(sourcePackage());
    (data.sheets[0] as SheetDataWithThreadedComments).threadedComments = [];
    (data.sheets[1] as SheetDataWithThreadedComments).threadedComments = [];
    const bytes = adapter.write(data);
    const paths = partPaths(bytes);
    expect(paths.some((p) => p.startsWith('xl/threadedComments/'))).toBe(false);
    expect(paths).toContain('xl/persons/person.xml'); // persons model survives
    const back = adapter.read(bytes);
    expect(modelOf(back).persons).toEqual(PERSONS);
    expect(modelOf(back).sheets).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Malformed / partial parts never break an open                       */
/* ------------------------------------------------------------------ */

describe('threaded comments: malformed tolerance', () => {
  it('corrupt persons XML + a comment missing personId: valid threads still parse', () => {
    const broken = sourcePackage({
      'xl/persons/person.xml': '<personList><person displayName="NoId"/></personList>',
      'xl/threadedComments/threadedComment1.xml':
        '<ThreadedComments>' +
        `<threadedComment ref="B2" id="${THREAD_A}"><text>no author</text></threadedComment>` +
        `<threadedComment ref="C4" dT="2024-03-02T09:00:00Z" personId="${BOB}" id="${THREAD_B}" done="1"><text>Still here</text></threadedComment>` +
        '</ThreadedComments>',
    });
    const data = adapter.read(broken);
    const model = modelOf(data);
    expect(model.persons).toEqual([]);
    expect(model.sheets[0]!.threads).toEqual([{
      id: THREAD_B, ref: 'C4', personId: BOB, dateTime: '2024-03-02T09:00:00Z',
      done: true, text: 'Still here', replies: [],
    }]);
  });

  it('an orphan reply is promoted to a thread instead of being dropped', () => {
    const orphan =
      '<ThreadedComments>' +
      `<threadedComment ref="B2" personId="${ALICE}" id="${REPLY_A1}" parentId="${THREAD_A}"><text>orphan</text></threadedComment>` +
      '</ThreadedComments>';
    const threads = parseThreadedCommentsXml(orphan);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.text).toBe('orphan');
    expect(threads[0]!.replies).toEqual([]);
  });

  it('garbage threadedComment bytes and a missing persons part do not break the open', () => {
    // Persons part absent entirely (part + workbook rel + content-type
    // override removed together — a dangling rel is rejected by SheetJS
    // itself, before any adapter-level best-effort code can run).
    const broken = sourcePackage({
      'xl/persons/person.xml': null,
      '[Content_Types].xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>' +
        '<Override PartName="/xl/threadedComments/threadedComment2.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>' +
        '</Types>',
      'xl/_rels/workbook.xml.rels': relsXml([
        ['rId1', WS_REL, 'worksheets/sheet1.xml'],
        ['rId2', WS_REL, 'worksheets/sheet2.xml'],
      ]),
      'xl/threadedComments/threadedComment1.xml': 'this is not xml at all <<<',
    });
    const data = adapter.read(broken);
    expect(data.sheets).toHaveLength(2);
    // Sheet 1's garbage part yields no threads; sheet 2's valid part parses.
    expect((data.sheets[0] as SheetDataWithThreadedComments).threadedComments).toBeUndefined();
    expect((data.sheets[1] as SheetDataWithThreadedComments).threadedComments).toEqual(THREADS_NOTES);
    expect(modelOf(data).persons).toEqual([]);
  });

  it('readThreadedComments on an empty package returns an empty model', () => {
    expect(readThreadedComments({})).toEqual({ persons: [], sheets: [] });
  });
});
