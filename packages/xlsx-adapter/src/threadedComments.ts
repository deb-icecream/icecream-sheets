/**
 * Native XLSX threaded comments + person records (audit §3.2;
 * [MS-XLSX] §§2.3.7, 2.6.202–2.6.206).
 *
 * Modern Excel comments are NOT the legacy §18.7 comments part. They are:
 * - `xl/persons/person.xml` — `<personList><person …/>`: one record per
 *   author / mentioned person, `CT_Person` (§2.6.203) with attributes
 *   `id` (GUID), `displayName`, `initials`, `userId`, `providerId`.
 * - `xl/threadedComments/threadedCommentN.xml` — one part PER SHEET,
 *   `<ThreadedComments><threadedComment …>`: `CT_ThreadedComment`
 *   (§2.6.205) with attributes `ref`, `dT`, `personId`, `id` (GUID),
 *   `parentId` (replies only), `done` (resolved), a `<text>` child and
 *   an optional `<mentions>` child (`CT_Mention` §2.6.202:
 *   `mentionId`, `mentionpersonId`, `startIndex`, `length`).
 * A comment whose `parentId` names another comment's `id` is a reply;
 * replies are flat in the part (their parentId names the TOP-LEVEL
 * comment in Excel's files) and are grouped under their thread here.
 *
 * Sheet ↔ part mapping follows the worksheet's relationships
 * (Type `…/2017/relationships/threadedComment`), the same pattern
 * pivotTables.ts uses for pivot parts; persons are resolved through
 * `xl/workbook.xml.rels` (Type `…/2017/relationships/person`) with the
 * conventional `xl/persons/person.xml` path as the primary lookup.
 * The worksheet ALSO links its part via an `extLst` extension
 * (`x18at:threadedComments` carrying the relationship id) — the write
 * path emits/updates that extension (see injectThreadedComments).
 *
 * MODEL (following the nativeSheetFeatures precedent): threads attach
 * to the sheet objects as an OPTIONAL field (`threadedComments`, set
 * only when the file carries them) via the intersection type
 * `SheetDataWithThreadedComments`; the workbook-level person records —
 * which are global, not per-sheet — travel with the threads in the
 * workbook model stashed in `WorkbookData.metadata` under
 * THREADED_COMMENTS_METADATA_KEY by XlsxAdapter.extractZipMetadata
 * (the same funnel pivots/SmartArt use for workbook-level families).
 *
 * READ is best-effort: malformed/partial parts yield fewer threads,
 * never an error. WRITE (classic path) regenerates the persons +
 * threadedComment parts from the model, wires worksheet/workbook rels,
 * [Content_Types].xml overrides, and the worksheet extLst reference.
 * A workbook whose model carries no threaded comments is untouched —
 * no parts are invented. The streaming/direct save path is NOT covered
 * (it copies source parts verbatim, like the other wave-1 families).
 */
import { unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';
import { sheetPartPaths, type ZipLike } from './formulaRecovery.js';
import type { SheetData, WorkbookData } from '@icecream-sheets/engine';
import {
  boolAttrValue,
  escapeXmlAttr,
  escapeXmlText,
  findBlock,
  findBlocks,
  normalizeRef,
  parseAttrRecord,
  splitTopElements,
  unescapeXmlText,
} from './nativeXmlUtil.js';

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/** One `CT_Person` record ([MS-XLSX] §2.6.203). */
export interface PersonRecord {
  /** GUID (kept verbatim, braces included as stored). */
  id: string;
  displayName: string;
  initials?: string;
  userId?: string;
  providerId?: string;
}

/** One `CT_Mention` ([MS-XLSX] §2.6.202) inside a comment's `<mentions>`. */
export interface ThreadedCommentMention {
  mentionId?: string;
  /** Person `id` of the mentioned person. */
  mentionPersonId: string;
  startIndex?: number;
  length?: number;
}

/** A reply: a threadedComment whose parentId names its thread's id. */
export interface ThreadedCommentReply {
  id: string;
  /** The immediate parent as stored (the top-level comment's id). */
  parentId: string;
  personId: string;
  /** Raw `dT` attribute, ISO-8601 as stored (kept verbatim). */
  dateTime?: string;
  done: boolean;
  text: string;
  mentions?: ThreadedCommentMention[];
}

/** A top-level threaded comment (a thread) at one cell. */
export interface ThreadedCommentThread {
  id: string;
  /** Canonical A1 ref of the anchored cell. */
  ref: string;
  personId: string;
  dateTime?: string;
  /** Resolved state (`done="1"`). */
  done: boolean;
  text: string;
  mentions?: ThreadedCommentMention[];
  replies: ThreadedCommentReply[];
}

export interface ThreadedCommentsForSheet {
  sheetName: string;
  threads: ThreadedCommentThread[];
}

/** Workbook-level threaded-comments model (persons are global). */
export interface WorkbookThreadedComments {
  persons: PersonRecord[];
  sheets: ThreadedCommentsForSheet[];
}

/** SheetData plus the adapter's threaded-comments extension field. */
export type SheetDataWithThreadedComments = SheetData & {
  threadedComments?: ThreadedCommentThread[];
};

/** Workbook-metadata key (contract shared with the write path). */
export const THREADED_COMMENTS_METADATA_KEY = 'icecream.threadedComments';

export const PERSONS_PART_PATH = 'xl/persons/person.xml';
export const THREADED_COMMENTS_NS =
  'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
export const THREADED_COMMENT_REL_TYPE =
  'http://schemas.microsoft.com/office/2017/relationships/threadedComment';
export const PERSON_REL_TYPE = 'http://schemas.microsoft.com/office/2017/relationships/person';
export const THREADED_COMMENT_CONTENT_TYPE = 'application/vnd.ms-excel.threadedcomments+xml';
export const PERSON_CONTENT_TYPE = 'application/vnd.ms-excel.person+xml';
/**
 * Worksheet extLst extension URI for the x18at:threadedComments link.
 * NOTE: this URI could not be re-verified against the [MS-XLSX] text
 * available while building this module; the relationship (rels) link —
 * the one the Open XML SDK's WorksheetThreadedCommentsPart is built on —
 * is authored alongside it, and unknown ext URIs are ignored by readers
 * by design (ISO/IEC 29500-3 extension lists).
 */
export const THREADED_COMMENTS_EXT_URI = '{E9A180F0-9CD2-4F85-A628-08839FB49195}';

/* ------------------------------------------------------------------ */
/* Small XML / package helpers (cloned from pivotTables.ts patterns)   */
/* ------------------------------------------------------------------ */

const DEC = new TextDecoder();
const ENC = new TextEncoder();

/** Strip namespace prefixes from element names (attribute names untouched). */
function denamespaceXml(xml: string): string {
  return xml.replace(/<(\/?)([A-Za-z_][\w.-]*):/g, '<$1');
}

function resolveTarget(ownerPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const dir = ownerPart.includes('/') ? ownerPart.slice(0, ownerPart.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  for (const seg of (dir + target).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function relativeTarget(fromPart: string, toPart: string): string {
  const fromDir = fromPart.split('/').slice(0, -1);
  const toSegs = toPart.split('/');
  let i = 0;
  while (i < fromDir.length && i < toSegs.length - 1 && fromDir[i] === toSegs[i]) i += 1;
  return [...Array<string>(fromDir.length - i).fill('..'), ...toSegs.slice(i)].join('/');
}

function relsPathFor(partPath: string): string {
  return partPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
}

interface RelEntry {
  id: string;
  type: string;
  target: string;
}

function parseRels(xml: string): RelEntry[] {
  const out: RelEntry[] = [];
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const a = parseAttrRecord(tag);
    if (a.Id && a.Type && a.Target) out.push({ id: a.Id, type: a.Type, target: a.Target });
  }
  return out;
}

function readRels(files: ZipLike, partPath: string): RelEntry[] {
  const raw = files[relsPathFor(partPath)];
  return raw ? parseRels(DEC.decode(raw)) : [];
}

/** The rel (id + resolved part path) whose Type ends with `suffix`. */
function relByTypeSuffix(
  files: ZipLike,
  ownerPart: string,
  suffix: string,
): { id: string; path: string } | null {
  for (const rel of readRels(files, ownerPart)) {
    if (rel.type.endsWith(suffix)) return { id: rel.id, path: resolveTarget(ownerPart, rel.target) };
  }
  return null;
}

function freshRid(relsXml: string): string {
  const used = new Set<string>();
  for (const m of relsXml.match(/Id="([^"]*)"/g) ?? []) {
    const id = /^Id="([^"]*)"$/.exec(m)?.[1];
    if (id) used.add(id);
  }
  let n = 1;
  while (used.has(`rId${n}`)) n += 1;
  return `rId${n}`;
}

function emptyRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  );
}

/** Ensure a relationship exists in a part's .rels; returns its id. Mutates `files`. */
function ensureRel(
  files: Record<string, Uint8Array>,
  ownerPart: string,
  type: string,
  targetPart: string,
): string {
  const relsPath = relsPathFor(ownerPart);
  let xml = files[relsPath] ? DEC.decode(files[relsPath]) : emptyRelsXml();
  const target = relativeTarget(ownerPart, targetPart);
  for (const rel of parseRels(xml)) {
    if (rel.type === type && resolveTarget(ownerPart, rel.target) === targetPart) return rel.id;
  }
  const rid = freshRid(xml);
  const rel =
    `<Relationship Id="${rid}" Type="${escapeXmlAttr(type)}" Target="${escapeXmlAttr(target)}"/>`;
  xml = xml.includes('</Relationships>')
    ? xml.replace('</Relationships>', `${rel}</Relationships>`)
    : `${xml}${rel}`;
  files[relsPath] = ENC.encode(xml);
  return rid;
}

function ensureContentType(
  files: Record<string, Uint8Array>,
  path: string,
  contentType: string,
): void {
  const raw = files['[Content_Types].xml'];
  if (!raw) return;
  let xml = DEC.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return;
  if (!xml.includes('</Types>')) return;
  xml = xml.replace(
    '</Types>',
    `<Override PartName="/${path}" ContentType="${contentType}"/></Types>`,
  );
  files['[Content_Types].xml'] = ENC.encode(xml);
}

function freeThreadedCommentPartPath(files: Record<string, Uint8Array>): string {
  let n = 1;
  while (files[`xl/threadedComments/threadedComment${n}.xml`]) n += 1;
  return `xl/threadedComments/threadedComment${n}.xml`;
}

/* ------------------------------------------------------------------ */
/* Persons: parse / serialize                                          */
/* ------------------------------------------------------------------ */

/** Parse a `person.xml` part ([MS-XLSX] §2.6.204 CT_PersonList). */
export function parsePersonsXml(xml: string): PersonRecord[] {
  const clean = denamespaceXml(xml);
  const out: PersonRecord[] = [];
  for (const block of findBlocks(clean, 'person')) {
    const a = block.attrs;
    if (!a.id || a.displayName === undefined) continue;
    const person: PersonRecord = { id: a.id, displayName: a.displayName };
    if (a.initials !== undefined) person.initials = a.initials;
    if (a.userId !== undefined) person.userId = a.userId;
    if (a.providerId !== undefined) person.providerId = a.providerId;
    out.push(person);
  }
  return out;
}

/** Serialize persons to a `person.xml` part. */
export function personsToXml(persons: readonly PersonRecord[]): string {
  const items = persons
    .map((p) => {
      const attrs = [
        `displayName="${escapeXmlAttr(p.displayName)}"`,
        `id="${escapeXmlAttr(p.id)}"`,
        ...(p.userId !== undefined ? [`userId="${escapeXmlAttr(p.userId)}"`] : []),
        ...(p.providerId !== undefined ? [`providerId="${escapeXmlAttr(p.providerId)}"`] : []),
        ...(p.initials !== undefined ? [`initials="${escapeXmlAttr(p.initials)}"`] : []),
      ];
      return `<person ${attrs.join(' ')}/>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<personList xmlns="${THREADED_COMMENTS_NS}">${items}</personList>`
  );
}

/** Locate the persons part: conventional path first, workbook rels fallback. */
export function personsPartPath(files: ZipLike): string | null {
  if (files[PERSONS_PART_PATH]) return PERSONS_PART_PATH;
  const rel = relByTypeSuffix(files, 'xl/workbook.xml', '/person');
  if (rel && files[rel.path]) return rel.path;
  // A persons part at a non-standard path with no rel: last-resort scan.
  for (const path of Object.keys(files)) {
    if (/\/persons\/person\d*\.xml$/i.test(path)) return path;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Threaded comments: parse / serialize                                */
/* ------------------------------------------------------------------ */

interface FlatComment {
  id: string;
  ref?: string;
  parentId?: string;
  personId: string;
  dateTime?: string;
  done: boolean;
  text: string;
  mentions?: ThreadedCommentMention[];
}

function parseMentions(blockXml: string): ThreadedCommentMention[] | undefined {
  const mentionsBlock = findBlock(blockXml, 'mentions');
  if (!mentionsBlock) return undefined;
  const out: ThreadedCommentMention[] = [];
  for (const el of splitTopElements(mentionsBlock.inner, 'mention')) {
    const a = parseAttrRecord(el);
    if (!a.mentionpersonId) continue;
    const mention: ThreadedCommentMention = { mentionPersonId: a.mentionpersonId };
    if (a.mentionId !== undefined) mention.mentionId = a.mentionId;
    if (a.startIndex !== undefined && Number.isFinite(Number(a.startIndex))) {
      mention.startIndex = Number(a.startIndex);
    }
    if (a.length !== undefined && Number.isFinite(Number(a.length))) {
      mention.length = Number(a.length);
    }
    out.push(mention);
  }
  return out.length > 0 ? out : undefined;
}

function commentText(blockXml: string): string {
  const textBlock = findBlock(blockXml, 'text');
  if (!textBlock) return '';
  // <text> is a plain string per §2.6.205; strip any stray markup
  // defensively, then decode entities.
  return unescapeXmlText(textBlock.inner.replace(/<[^>]+>/g, ''));
}

/** Parse the flat `<threadedComment>` elements of one part. */
export function parseThreadedCommentsFlat(xml: string): FlatComment[] {
  const clean = denamespaceXml(xml);
  const out: FlatComment[] = [];
  for (const block of findBlocks(clean, 'threadedComment')) {
    const a = block.attrs;
    if (!a.id || !a.personId) continue;
    const flat: FlatComment = {
      id: a.id,
      personId: a.personId,
      done: boolAttrValue(a.done, false),
      text: commentText(block.whole),
    };
    if (a.ref) flat.ref = normalizeRef(a.ref);
    if (a.parentId) flat.parentId = a.parentId;
    if (a.dT !== undefined) flat.dateTime = a.dT;
    const mentions = parseMentions(block.whole);
    if (mentions) flat.mentions = mentions;
    out.push(flat);
  }
  return out;
}

/**
 * Group a part's flat comments into threads: comments without a
 * parentId are top-level; a comment whose parentId names a top-level
 * comment (or, defensively, any earlier comment in the same part)
 * becomes a reply of that thread. Orphan replies (parent missing from
 * the part) are promoted to threads so nothing is silently dropped.
 */
export function groupThreadedComments(flat: readonly FlatComment[]): ThreadedCommentThread[] {
  const threads: ThreadedCommentThread[] = [];
  const threadByAnyId = new Map<string, ThreadedCommentThread>();
  const toThread = (c: FlatComment): ThreadedCommentThread => ({
    id: c.id,
    ref: c.ref ?? '',
    personId: c.personId,
    ...(c.dateTime !== undefined ? { dateTime: c.dateTime } : {}),
    done: c.done,
    text: c.text,
    ...(c.mentions ? { mentions: c.mentions } : {}),
    replies: [],
  });
  for (const c of flat) {
    if (!c.parentId) {
      const t = toThread(c);
      threads.push(t);
      threadByAnyId.set(c.id, t);
    }
  }
  for (const c of flat) {
    if (!c.parentId) continue;
    const parent = threadByAnyId.get(c.parentId);
    if (!parent) {
      const t = toThread(c);
      threads.push(t);
      threadByAnyId.set(c.id, t);
      continue;
    }
    parent.replies.push({
      id: c.id,
      parentId: c.parentId,
      personId: c.personId,
      ...(c.dateTime !== undefined ? { dateTime: c.dateTime } : {}),
      done: c.done,
      text: c.text,
      ...(c.mentions ? { mentions: c.mentions } : {}),
    });
    threadByAnyId.set(c.id, parent);
  }
  return threads;
}

/** Parse one threadedComments part into threads. */
export function parseThreadedCommentsXml(xml: string): ThreadedCommentThread[] {
  return groupThreadedComments(parseThreadedCommentsFlat(xml));
}

function mentionsToXml(mentions: readonly ThreadedCommentMention[] | undefined): string {
  if (!mentions || mentions.length === 0) return '';
  const items = mentions
    .map((m) => {
      const attrs = [
        ...(m.startIndex !== undefined ? [`startIndex="${m.startIndex}"`] : []),
        ...(m.length !== undefined ? [`length="${m.length}"`] : []),
        ...(m.mentionId !== undefined ? [`mentionId="${escapeXmlAttr(m.mentionId)}"`] : []),
        `mentionpersonId="${escapeXmlAttr(m.mentionPersonId)}"`,
      ];
      return `<mention ${attrs.join(' ')}/>`;
    })
    .join('');
  return `<mentions>${items}</mentions>`;
}

function oneCommentToXml(c: {
  id: string;
  ref?: string;
  parentId?: string;
  personId: string;
  dateTime?: string;
  done: boolean;
  text: string;
  mentions?: ThreadedCommentMention[];
  threadRef: string;
}): string {
  const attrs = [
    `ref="${escapeXmlAttr(normalizeRef(c.ref ?? c.threadRef))}"`,
    ...(c.dateTime !== undefined ? [`dT="${escapeXmlAttr(c.dateTime)}"`] : []),
    `personId="${escapeXmlAttr(c.personId)}"`,
    `id="${escapeXmlAttr(c.id)}"`,
    ...(c.parentId !== undefined ? [`parentId="${escapeXmlAttr(c.parentId)}"`] : []),
    ...(c.done ? ['done="1"'] : []),
  ];
  return (
    `<threadedComment ${attrs.join(' ')}>` +
    `<text>${escapeXmlText(c.text)}</text>${mentionsToXml(c.mentions)}</threadedComment>`
  );
}

/** Serialize threads to a threadedComments part (thread, then its replies). */
export function threadedCommentsToXml(threads: readonly ThreadedCommentThread[]): string {
  let body = '';
  for (const t of threads) {
    body += oneCommentToXml({ ...t, threadRef: t.ref });
    for (const r of t.replies) body += oneCommentToXml({ ...r, threadRef: t.ref });
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<ThreadedComments xmlns="${THREADED_COMMENTS_NS}">${body}</ThreadedComments>`
  );
}

/* ------------------------------------------------------------------ */
/* Package read                                                        */
/* ------------------------------------------------------------------ */

/** Sheet name → threadedComments part path, via the sheet's rels. */
export function threadedCommentPartPaths(files: ZipLike): Map<string, string> {
  const out = new Map<string, string>();
  for (const [sheetName, sheetPath] of sheetPartPaths(files)) {
    const rel = relByTypeSuffix(files, sheetPath, '/threadedComment');
    if (rel && files[rel.path]) {
      out.set(sheetName, rel.path);
      continue;
    }
    // Fallback: the worksheet extLst x18at:threadedComments r:id resolves
    // through the same sheet rels (some producers register the rel only
    // for the extension).
    const raw = files[sheetPath];
    if (!raw) continue;
    const xml = DEC.decode(raw);
    const m = /threadedComments[^>]*\br:id="([^"]*)"/.exec(xml);
    if (!m) continue;
    for (const relEntry of readRels(files, sheetPath)) {
      if (relEntry.id === m[1]) {
        const path = resolveTarget(sheetPath, relEntry.target);
        if (files[path]) out.set(sheetName, path);
      }
    }
  }
  return out;
}

/**
 * Read the whole workbook model from an unzipped package. Never throws:
 * missing/corrupt parts yield an empty (or smaller) model.
 */
export function readThreadedComments(files: ZipLike): WorkbookThreadedComments {
  const model: WorkbookThreadedComments = { persons: [], sheets: [] };
  try {
    const pPath = personsPartPath(files);
    if (pPath) {
      try {
        model.persons = parsePersonsXml(DEC.decode(files[pPath] as Uint8Array));
      } catch {
        model.persons = [];
      }
    }
    const partBySheet = threadedCommentPartPaths(files);
    // Preserve workbook sheet order.
    for (const sheetName of sheetPartPaths(files).keys()) {
      const path = partBySheet.get(sheetName);
      if (!path) continue;
      try {
        const threads = parseThreadedCommentsXml(DEC.decode(files[path] as Uint8Array));
        if (threads.length > 0) model.sheets.push({ sheetName, threads });
      } catch {
        // One corrupt part must not lose the other sheets' threads.
      }
    }
  } catch {
    // Best-effort: threaded comments must never break the open.
  }
  return model;
}

/**
 * Attach threads onto sheet objects (mutates them), following the
 * nativeSheetFeatures precedent: the field is set only for sheets the
 * file actually carries threads for. Returns the workbook model (with
 * persons) when the file carries any persons or threads, else undefined.
 * Never throws.
 */
export function attachThreadedComments(
  sheets: SheetData[],
  files: ZipLike | undefined,
): WorkbookThreadedComments | undefined {
  try {
    if (!files) return undefined;
    const model = readThreadedComments(files);
    if (model.persons.length === 0 && model.sheets.length === 0) return undefined;
    const byName = new Map(model.sheets.map((s) => [s.sheetName, s.threads]));
    for (const sheet of sheets) {
      const threads = byName.get(sheet.name);
      if (threads && threads.length > 0) {
        (sheet as SheetDataWithThreadedComments).threadedComments = threads;
      }
    }
    return model;
  } catch {
    return undefined;
  }
}

/** Resolve a personId against the workbook's person records. */
export function resolvePerson(
  persons: readonly PersonRecord[],
  personId: string,
): PersonRecord | undefined {
  return persons.find((p) => p.id === personId);
}

/* ------------------------------------------------------------------ */
/* Metadata (de)serialization + write-model collection                 */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function cleanMentions(v: unknown): ThreadedCommentMention[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ThreadedCommentMention[] = [];
  for (const m of v) {
    if (!isRecord(m) || typeof m.mentionPersonId !== 'string') continue;
    const mention: ThreadedCommentMention = { mentionPersonId: m.mentionPersonId };
    if (typeof m.mentionId === 'string') mention.mentionId = m.mentionId;
    if (typeof m.startIndex === 'number' && Number.isFinite(m.startIndex)) mention.startIndex = m.startIndex;
    if (typeof m.length === 'number' && Number.isFinite(m.length)) mention.length = m.length;
    out.push(mention);
  }
  return out.length > 0 ? out : undefined;
}

function cleanReply(v: unknown): ThreadedCommentReply | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.personId !== 'string') return null;
  const reply: ThreadedCommentReply = {
    id: v.id,
    parentId: typeof v.parentId === 'string' ? v.parentId : '',
    personId: v.personId,
    done: v.done === true,
    text: typeof v.text === 'string' ? v.text : '',
  };
  if (typeof v.dateTime === 'string') reply.dateTime = v.dateTime;
  const mentions = cleanMentions(v.mentions);
  if (mentions) reply.mentions = mentions;
  return reply;
}

function cleanThread(v: unknown): ThreadedCommentThread | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.personId !== 'string') return null;
  const thread: ThreadedCommentThread = {
    id: v.id,
    ref: typeof v.ref === 'string' ? normalizeRef(v.ref) : '',
    personId: v.personId,
    done: v.done === true,
    text: typeof v.text === 'string' ? v.text : '',
    replies: [],
  };
  if (typeof v.dateTime === 'string') thread.dateTime = v.dateTime;
  const mentions = cleanMentions(v.mentions);
  if (mentions) thread.mentions = mentions;
  if (Array.isArray(v.replies)) {
    for (const r of v.replies) {
      const reply = cleanReply(r);
      if (reply) {
        if (!reply.parentId) reply.parentId = thread.id;
        thread.replies.push(reply);
      }
    }
  }
  return thread;
}

/**
 * Validate/sanitize an unknown value (a metadata entry: object or JSON
 * string) into a WorkbookThreadedComments, or undefined when it carries
 * neither persons nor threads.
 */
export function threadedCommentsFromUnknown(value: unknown): WorkbookThreadedComments | undefined {
  try {
    let v: unknown = value;
    if (typeof v === 'string') {
      if (v.trim() === '') return undefined;
      v = JSON.parse(v) as unknown;
    }
    if (!isRecord(v)) return undefined;
    const persons: PersonRecord[] = [];
    if (Array.isArray(v.persons)) {
      for (const p of v.persons) {
        if (!isRecord(p) || typeof p.id !== 'string' || typeof p.displayName !== 'string') continue;
        const person: PersonRecord = { id: p.id, displayName: p.displayName };
        if (typeof p.initials === 'string') person.initials = p.initials;
        if (typeof p.userId === 'string') person.userId = p.userId;
        if (typeof p.providerId === 'string') person.providerId = p.providerId;
        persons.push(person);
      }
    }
    const sheets: ThreadedCommentsForSheet[] = [];
    if (Array.isArray(v.sheets)) {
      for (const s of v.sheets) {
        if (!isRecord(s) || typeof s.sheetName !== 'string' || !Array.isArray(s.threads)) continue;
        const threads: ThreadedCommentThread[] = [];
        for (const t of s.threads) {
          const thread = cleanThread(t);
          if (thread) threads.push(thread);
        }
        sheets.push({ sheetName: s.sheetName, threads });
      }
    }
    if (persons.length === 0 && sheets.every((s) => s.threads.length === 0)) {
      // Persons-only is a real model; sheets present-but-empty means the
      // caller explicitly cleared threads — keep that only when some
      // sheet entry exists AND persons exist, else treat as no model.
      if (persons.length === 0) return undefined;
    }
    return { persons, sheets };
  } catch {
    return undefined;
  }
}

/**
 * The write model for a WorkbookData: per-sheet `threadedComments`
 * fields, when ANY sheet carries the field (present-but-empty included),
 * are authoritative for the threads (nativeSheetFeatures precedence);
 * otherwise the metadata model's sheets are used. Persons always come
 * from the metadata model (they are workbook-global). Undefined when
 * the workbook carries no threaded-comments model at all.
 */
export function threadedCommentsForWrite(data: WorkbookData): WorkbookThreadedComments | undefined {
  const fromMeta = threadedCommentsFromUnknown(data.metadata?.[THREADED_COMMENTS_METADATA_KEY]);
  const sheets = data.sheets as SheetDataWithThreadedComments[];
  const anyField = sheets.some((s) => s.threadedComments !== undefined);
  if (!anyField && !fromMeta) return undefined;
  const persons = fromMeta?.persons ?? [];
  if (anyField) {
    const out: ThreadedCommentsForSheet[] = [];
    for (const s of sheets) {
      if (s.threadedComments !== undefined) {
        // Re-clean through the sanitizer so hand-built models serialize
        // in canonical form.
        const cleaned = threadedCommentsFromUnknown({
          persons: [],
          sheets: [{ sheetName: s.name, threads: s.threadedComments }],
        });
        out.push(cleaned?.sheets[0] ?? { sheetName: s.name, threads: [] });
      }
    }
    if (persons.length === 0 && out.every((s) => s.threads.length === 0)) return undefined;
    return { persons, sheets: out };
  }
  return fromMeta;
}

/* ------------------------------------------------------------------ */
/* Package write                                                       */
/* ------------------------------------------------------------------ */

/** Ensure/update the worksheet's extLst x18at:threadedComments reference. */
export function ensureThreadedCommentsExtLst(sheetXml: string, rid: string): string {
  const ext =
    `<ext uri="${THREADED_COMMENTS_EXT_URI}" xmlns:x18at="${THREADED_COMMENTS_NS}" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<x18at:threadedComments r:id="${escapeXmlAttr(rid)}"/></ext>`;
  const extLst = findBlock(sheetXml, 'extLst');
  if (!extLst) {
    const block = `<extLst>${ext}</extLst>`;
    if (sheetXml.includes('</worksheet>')) return sheetXml.replace('</worksheet>', `${block}</worksheet>`);
    return sheetXml + block;
  }
  // Drop any existing threadedComments extension, then append ours.
  let inner = extLst.inner.replace(
    /<ext\b[^>]*>(?:(?!<\/ext>)[\s\S])*?threadedComments[\s\S]*?<\/ext>/g,
    '',
  );
  inner += ext;
  return sheetXml.slice(0, extLst.start) + `<extLst>${inner}</extLst>` + sheetXml.slice(extLst.end);
}

/**
 * Author persons + threadedComment parts for `model` into an unzipped
 * package map (mutates `files`). Sheets named in the model that are not
 * in the package are skipped; sheets with empty thread lists get no
 * part (the classic writer rebuilds sheets from scratch, so there is
 * no stale part to clean). Returns the number of sheets written.
 */
export function authorThreadedCommentParts(
  files: Record<string, Uint8Array>,
  model: WorkbookThreadedComments,
): number {
  const sheetPaths = sheetPartPaths(files as ZipLike);
  let written = 0;

  // Persons part (workbook-global): written when there are persons, or
  // when threads exist (Excel expects the part alongside the comments).
  const anyThreads = model.sheets.some((s) => s.threads.length > 0);
  if (model.persons.length > 0 || anyThreads) {
    const existing = personsPartPath(files as ZipLike);
    const path = existing ?? PERSONS_PART_PATH;
    files[path] = ENC.encode(personsToXml(model.persons));
    ensureContentType(files, path, PERSON_CONTENT_TYPE);
    if (files['xl/workbook.xml']) {
      ensureRel(files, 'xl/workbook.xml', PERSON_REL_TYPE, path);
    }
  }

  const claimed = new Set<string>();
  for (const sheetModel of model.sheets) {
    if (sheetModel.threads.length === 0) continue;
    const sheetPath = sheetPaths.get(sheetModel.sheetName);
    if (!sheetPath) continue;
    const existingRel = relByTypeSuffix(files as ZipLike, sheetPath, '/threadedComment');
    const partPath =
      existingRel && !claimed.has(existingRel.path)
        ? existingRel.path
        : freeThreadedCommentPartPath(files);
    claimed.add(partPath);
    files[partPath] = ENC.encode(threadedCommentsToXml(sheetModel.threads));
    ensureContentType(files, partPath, THREADED_COMMENT_CONTENT_TYPE);
    const rid = ensureRel(files, sheetPath, THREADED_COMMENT_REL_TYPE, partPath);
    const sheetRaw = files[sheetPath];
    if (sheetRaw) {
      const xml = DEC.decode(sheetRaw);
      const out = ensureThreadedCommentsExtLst(xml, rid);
      if (out !== xml) files[sheetPath] = ENC.encode(out);
    }
    written += 1;
  }
  return written;
}

/**
 * Bytes wrapper (unzip → author → deterministic re-zip), the
 * injectPivotParts shape. Never throws: a workbook with no threaded
 * comments (or any failure) returns the input bytes unchanged.
 */
export function injectThreadedComments(
  packageBytes: Uint8Array,
  model: WorkbookThreadedComments | unknown,
): Uint8Array {
  try {
    const clean = threadedCommentsFromUnknown(model);
    if (!clean) return packageBytes;
    if (clean.persons.length === 0 && clean.sheets.every((s) => s.threads.length === 0)) {
      return packageBytes;
    }
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    const written = authorThreadedCommentParts(files, clean);
    if (written === 0 && clean.persons.length === 0) return packageBytes;
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}
