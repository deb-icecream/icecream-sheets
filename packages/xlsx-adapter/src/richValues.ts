/**
 * Native XLSX rich values / linked data types (OOXML audit §9.2, [MS-XLSX]
 * §2.6.170s, rich-data namespaces 2017/richdata + 2017/richdata2).
 *
 * A rich-value cell in a real Excel file arrives as its cached fallback
 * only unless this chain is followed:
 *
 * - Worksheet cell: `<c r="A1" vm="N" ...><v>cached fallback</v></c>`.
 *   `vm` is a 1-based index into `xl/metadata.xml` `<valueMetadata>` blocks.
 * - `xl/metadata.xml`: `<metadataTypes>` names the metadata kinds
 *   (rich values are the `XLRICHVALUE` type); each `<valueMetadata><bk>`
 *   holds `<rc t="T" v="V"/>` records, where `t` is a 1-based index into
 *   `<metadataTypes>` and `v` is a 0-based index into the matching
 *   `<futureMetadata name="..."><bk>` list.
 * - Each future-metadata `<bk>` carries an `<extLst><ext>` whose
 *   `xlrd:rvb` element has `i` = a 0-based index into the rich-value data
 *   part's `<rv>` list.
 * - Rich-data parts under `xl/richData/` (part filenames vary between
 *   producers — `richValue*.xml` vs `rdrichvalue*.xml` — so discovery is
 *   by directory + root element, never by one exact filename):
 *   - `rvData` (`xlrd`): one `<rv s="S">` per rich value, `s` a 0-based
 *     index into the structures part; its value children sit positionally
 *     against the structure's keys, and an optional `<fb>` child is the
 *     record's own fallback text.
 *   - `rvStructures`: one `<s>` per structure, each a list of
 *     `<k name="..." t="..."/>` keys (`t` = value kind: `s` string, `d`
 *     double, `i` integer, `b` boolean, `e` error, verbatim otherwise).
 *   - `rvTypes` (`xlrd2`): the registered rich-value type names
 *     (e.g. `_Stock`, `_Geography`); their inner schema is preserved
 *     structurally (attributes + inner XML) rather than modeled, because
 *     the type registry carries no per-cell data.
 *
 * Model fidelity rule (same as slicersTimelines.ts): an attribute is
 * present in the model iff it was present in the XML, and the serializer
 * writes exactly the attributes the model carries — so parse → model →
 * write → re-parse is an identity on the model. Counts (`count`
 * attributes) are derived from list lengths on write and are NOT modeled,
 * so a source count that disagrees with its list length does not survive
 * (the list is the truth).
 *
 * Never throws: any missing/corrupt part yields fewer entries, never an
 * error (read), and an unchanged package (write of an empty model).
 *
 * Deliberately NOT here (follow-up, not this module):
 * - Stamping `vm` attributes + cached `<v>` fallbacks into worksheet XML
 *   on write: that lives in the sheet-generation path (adapter.ts /
 *   streamingSave.ts), which this piece must not edit. `injectRichValueParts`
 *   writes the metadata + rich-data parts only.
 * - Engine FIELDVALUE / dot-notation binding and grid wiring: see the
 *   follow-up spec in hidden_files/ooxml-69/piece-b-rich-values/REPORT.md.
 * - Workbook↔rich-data relationship types: the reader discovers rich-data
 *   parts by path scan, so it needs no rel types; the writer therefore
 *   writes content-type overrides + the workbook metadata relationship
 *   only, and does NOT invent rich-data rel types. Verify them against a
 *   real Excel-produced file before wiring write into the adapter.
 */

import { unzipSync } from 'fflate';
import { base64ToU8, u8ToBase64 } from './macroProject.js';

// ---------------------------------------------------------------------------
// Namespaces, relationship types, content types, metadata keys.
// ---------------------------------------------------------------------------

export const RICH_DATA_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata';
export const RICH_DATA2_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2';
export const MAIN_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const MC_NAMESPACE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** Workbook relationship type for xl/metadata.xml. */
export const METADATA_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata';
/** Metadata type name Excel uses for rich values. */
export const RICH_VALUE_METADATA_TYPE = 'XLRICHVALUE';

/** WorkbookData metadata key carrying the parsed model (JSON). */
export const RICH_VALUES_METADATA_KEY = 'icecream.richValues';
/**
 * Raw-parts metadata key. Deliberately NOT `icecream.`-prefixed so the
 * adapter's custom-property persistence does not duplicate the base64
 * bulk into the file (same rule as PIVOT_PARTS_METADATA_KEY /
 * SLICER_PARTS_METADATA_KEY).
 */
export const RICH_VALUE_PARTS_METADATA_KEY = 'xlsx.richValueParts';

// ---------------------------------------------------------------------------
// Typed model.
// ---------------------------------------------------------------------------

/** One `<k>` key of a rich-value structure. `type` is the `t` attr, verbatim. */
export interface RichValueKey {
  name: string;
  /** `t` — present iff the attribute was in the XML. */
  type?: string;
  /** Any other attributes on the `<k>` element (name/t excluded), when present. */
  attrs?: Record<string, string>;
}

/** One `<s>` structure: the key list an `<rv>`'s values sit against, positionally. */
export interface RichValueStructure {
  keys: RichValueKey[];
}

/** One value child of an `<rv>` element, before type conversion. */
export interface RichValueRawValue {
  /** Child element name as written (producers vary); usually `v`. */
  tag: string;
  /** `t` — present iff the attribute was in the XML. */
  t?: string;
  text: string;
  /** Any other attributes on the value element (t excluded), when present. */
  attrs?: Record<string, string>;
}

/** The `<fb>` fallback child of an `<rv>` element, when present. */
export interface RichValueFallback {
  /** `t` — present iff the attribute was in the XML. */
  t?: string;
  text: string;
}

/** One `<rv>` rich-value record. */
export interface RichValueRecord {
  /** `s` — 0-based structure index; present iff the attribute was in the XML. */
  structureIndex?: number;
  /** Value children in document order (positional against the structure keys). */
  values: RichValueRawValue[];
  /** `<fb>` child, when present. */
  fallback?: RichValueFallback;
}

/** One `<type>` element of the rich-value types part, preserved structurally. */
export interface RichValueTypeDef {
  /** All attributes of the `<type>` element (including `name` when present). */
  attrs: Record<string, string>;
  /** Inner XML of the `<type>` element, verbatim ('' when empty/self-closing). */
  innerXml: string;
}

/** One `<metadataType>` element: name + all other attributes, verbatim. */
export interface MetadataType {
  name: string;
  /** Attributes other than `name`, when present. */
  attrs?: Record<string, string>;
}

/** One `<bk>` of a `<futureMetadata>` list: the block's rich-value binding. */
export interface FutureMetadataBlock {
  /** `i` of the block's `xlrd:rvb` element; present iff the block carried one. */
  rvbIndex?: number;
  /** `uri` of the block's `<ext>` element; present iff the attribute was in the XML. */
  extUri?: string;
}

/** One `<futureMetadata name="...">` list. */
export interface FutureMetadata {
  name: string;
  blocks: FutureMetadataBlock[];
}

/** One `<rc t="T" v="V"/>` record inside a metadata block. */
export interface MetadataRecord {
  /** `t` — 1-based index into `<metadataTypes>`. */
  t: number;
  /** `v` — 0-based index into the matching future-metadata block list. */
  v: number;
}

/** One `<bk>` of `<valueMetadata>` / `<cellMetadata>`: its `<rc>` records. */
export interface MetadataBlock {
  records: MetadataRecord[];
}

/** The whole `xl/metadata.xml` part, in model form. */
export interface MetadataModel {
  types: MetadataType[];
  futureMetadata: FutureMetadata[];
  valueMetadata: MetadataBlock[];
  /** `<cellMetadata>` blocks, when the part carried any. */
  cellMetadata: MetadataBlock[];
  /** `<metadataStrings>` strings, in order, when the part carried any. */
  strings: string[];
}

/** One worksheet cell carrying a `vm` attribute. */
export interface CellRichValueRef {
  sheetName: string;
  sheetIndex: number;
  /** Cell reference as written, e.g. "A1". */
  ref: string;
  /** `vm` as written (1-based into valueMetadata blocks). */
  vm: number;
  /** The cell's own `<v>` text, when present (its cached fallback). */
  cachedValue?: string;
  /** The cell's `t` attribute, when present (e.g. "s" for shared strings). */
  cellType?: string;
}

/** One resolved field: a structure key + its typed value. */
export interface ResolvedRichValueField {
  key: string;
  /** Structure key `t`, verbatim, when the key carried one. */
  type?: string;
  /** Typed value: number for `d`/`i` when numeric, boolean for `b`, else the raw text. */
  value: string | number | boolean;
  /** The raw text as written, before type conversion. */
  rawText: string;
}

/** A cell ref fully resolved through metadata → rich-value record → structure. */
export interface ResolvedRichValue {
  cell: CellRichValueRef;
  /** 0-based index into the rich-value data list. */
  richValueIndex: number;
  /** 0-based structure index of the record, when the record carried one. */
  structureIndex?: number;
  /** Metadata type name that resolved (normally `XLRICHVALUE`). */
  typeName: string;
  /** Fields in structure order (only keys with a positional value). */
  fields: ResolvedRichValueField[];
  /** Record `<fb>` text, falling back to the cell's cached `<v>` text. */
  fallback?: string;
}

export interface RichValuePartPaths {
  metadata?: string;
  data?: string;
  structures?: string;
  types?: string;
}

export interface RichValuesModel {
  metadata: MetadataModel;
  structures: RichValueStructure[];
  values: RichValueRecord[];
  types: RichValueTypeDef[];
  cellRefs: CellRichValueRef[];
  partPaths: RichValuePartPaths;
}

/** Raw part bytes for the no-model fallback write path. */
export interface RichValueRawParts {
  /** Part path → base64 bytes for every rich-value part read. */
  parts: Record<string, string>;
}

export interface ReadRichValuesResult extends RichValuesModel {
  rawParts: RichValueRawParts;
}

// ---------------------------------------------------------------------------
// Small XML helpers (same regex-based approach as slicersTimelines.ts).
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Strip namespace prefixes from element names (attribute names untouched). */
function denamespaceXml(xml: string): string {
  return xml.replace(/<(\/?)([A-Za-z_][\w.-]*):/g, '<$1');
}

/**
 * One attribute of a tag string, or null. Anchored on whitespace/start so
 * `name` never matches the tail of `sourceName`.
 */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[:]/g, '\\:')}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]!) : null;
}

/** All attributes of a tag string except `exclude` (names kept verbatim). */
function allAttrs(tag: string, exclude: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\/?[^\s>]+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    const name = m[1]!;
    if (!exclude.includes(name)) out[name] = unescapeXml(m[2]!);
  }
  return out;
}

function hasAttrs(o: Record<string, string> | undefined): boolean {
  return !!o && Object.keys(o).length > 0;
}

function intAttr(tag: string, name: string): number | null {
  const v = attr(tag, name);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/** Open tag of the first `<name ...>` element (self-closing or not). */
function openTag(xml: string, name: string): string {
  const m = new RegExp(`<${name}(\\s[^>]*)?/?>`).exec(xml);
  return m ? m[0] : '';
}

/** Every `<name ...>...</name>` or `<name .../>` block, in document order. */
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(\\s[^>]*?)?(?:/>|>[\\s\\S]*?</${name}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

/** First `<name ...>...</name>` block (non-greedy); '' when absent. */
function element(xml: string, name: string): string {
  const m = new RegExp(`<${name}(\\s[^>]*)?>[\\s\\S]*?</${name}>`).exec(xml);
  return m ? m[0] : '';
}

/** Inner XML of a block ('' for a self-closing element). */
function innerOf(block: string, name: string): string {
  const m = new RegExp(`^<${name}(\\s[^>]*)?>([\\s\\S]*)</${name}>$`).exec(block.trim());
  return m ? m[2]! : '';
}

/** Direct child elements of an inner-XML string: [{tag, attrsTag, inner}]. */
function childElements(inner: string): { tag: string; tagText: string; inner: string }[] {
  const out: { tag: string; tagText: string; inner: string }[] = [];
  const re = /<([A-Za-z_][\w.-]*)(\s[^>]*)?\/>|<([A-Za-z_][\w.-]*)(\s[^>]*)?>([\s\S]*?)<\/\3>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    if (m[1]) out.push({ tag: m[1], tagText: m[0], inner: '' });
    else out.push({ tag: m[3]!, tagText: `<${m[3]}${m[4] ?? ''}>`, inner: m[5] ?? '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse: xl/metadata.xml.
// ---------------------------------------------------------------------------

function parseMetadataBlocks(scope: string): MetadataBlock[] {
  const out: MetadataBlock[] = [];
  for (const bk of blocks(scope, 'bk')) {
    const records: MetadataRecord[] = [];
    for (const tag of bk.match(/<rc\b[^>]*>/g) ?? []) {
      const t = intAttr(tag, 't');
      const v = intAttr(tag, 'v');
      if (t !== null && v !== null) records.push({ t, v });
    }
    out.push({ records });
  }
  return out;
}

/** Parse xl/metadata.xml into the typed model (null when no metadata root). */
export function parseMetadataXml(xml: string): MetadataModel | null {
  try {
    const den = denamespaceXml(xml);
    if (!openTag(den, 'metadata')) return null;
    const types: MetadataType[] = [];
    const typesEl = element(den, 'metadataTypes');
    if (typesEl) {
      for (const tag of typesEl.match(/<metadataType\b[^>]*>/g) ?? []) {
        const name = attr(tag, 'name');
        if (name === null) continue;
        const rest = allAttrs(tag, ['name']);
        const mt: MetadataType = { name };
        if (hasAttrs(rest)) mt.attrs = rest;
        types.push(mt);
      }
    }
    const futureMetadata: FutureMetadata[] = [];
    for (const fm of blocks(den, 'futureMetadata')) {
      const name = attr(openTag(fm, 'futureMetadata'), 'name');
      if (name === null) continue;
      const fmBlocks: FutureMetadataBlock[] = [];
      for (const bk of blocks(fm, 'bk')) {
        const block: FutureMetadataBlock = {};
        const extTag = openTag(bk, 'ext');
        if (extTag) {
          const uri = attr(extTag, 'uri');
          if (uri !== null) block.extUri = uri;
        }
        const rvbTag = openTag(bk, 'rvb');
        if (rvbTag) {
          const i = intAttr(rvbTag, 'i');
          if (i !== null) block.rvbIndex = i;
        }
        fmBlocks.push(block);
      }
      futureMetadata.push({ name, blocks: fmBlocks });
    }
    const valueEl = element(den, 'valueMetadata');
    const cellEl = element(den, 'cellMetadata');
    const strings: string[] = [];
    const stringsEl = element(den, 'metadataStrings');
    if (stringsEl) {
      for (const sBlock of blocks(stringsEl, 's')) {
        const v = /<v>([\s\S]*?)<\/v>/.exec(sBlock);
        if (v) strings.push(unescapeXml(v[1]!));
      }
    }
    return {
      types,
      futureMetadata,
      valueMetadata: valueEl ? parseMetadataBlocks(valueEl) : [],
      cellMetadata: cellEl ? parseMetadataBlocks(cellEl) : [],
      strings,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse: rich-data parts.
// ---------------------------------------------------------------------------

/** Parse an rvData part (root `<rvData>`) into its record list. */
export function parseRichValueDataXml(xml: string): RichValueRecord[] {
  const out: RichValueRecord[] = [];
  try {
    const den = denamespaceXml(xml);
    const root = element(den, 'rvData');
    if (!root) return out;
    for (const rv of blocks(root, 'rv')) {
      const record: RichValueRecord = { values: [] };
      const s = intAttr(openTag(rv, 'rv'), 's');
      if (s !== null) record.structureIndex = s;
      for (const child of childElements(innerOf(rv, 'rv'))) {
        if (child.tag === 'extLst') continue;
        if (child.tag === 'fb') {
          const fb: RichValueFallback = { text: unescapeXml(child.inner) };
          const t = attr(child.tagText, 't');
          if (t !== null) fb.t = t;
          record.fallback = fb;
          continue;
        }
        const value: RichValueRawValue = { tag: child.tag, text: unescapeXml(child.inner) };
        const t = attr(child.tagText, 't');
        if (t !== null) value.t = t;
        const rest = allAttrs(child.tagText, ['t']);
        if (hasAttrs(rest)) value.attrs = rest;
        record.values.push(value);
      }
      out.push(record);
    }
  } catch {
    // best-effort: a corrupt record list yields fewer records, never a throw
  }
  return out;
}

/** Parse an rvStructures part (root `<rvStructures>`) into its structure list. */
export function parseRichValueStructuresXml(xml: string): RichValueStructure[] {
  const out: RichValueStructure[] = [];
  try {
    const den = denamespaceXml(xml);
    const root = element(den, 'rvStructures');
    if (!root) return out;
    for (const sBlock of blocks(root, 's')) {
      const keys: RichValueKey[] = [];
      for (const tag of sBlock.match(/<k\b[^>]*>/g) ?? []) {
        const name = attr(tag, 'name');
        if (name === null) continue;
        const key: RichValueKey = { name };
        const t = attr(tag, 't');
        if (t !== null) key.type = t;
        const rest = allAttrs(tag, ['name', 't']);
        if (hasAttrs(rest)) key.attrs = rest;
        keys.push(key);
      }
      out.push({ keys });
    }
  } catch {
    // best-effort
  }
  return out;
}

/** Parse an rvTypes part (root `<rvTypes>`) into its type definitions. */
export function parseRichValueTypesXml(xml: string): RichValueTypeDef[] {
  const out: RichValueTypeDef[] = [];
  try {
    const den = denamespaceXml(xml);
    const root = element(den, 'rvTypes');
    if (!root) return out;
    for (const typeBlock of blocks(root, 'type')) {
      out.push({ attrs: allAttrs(openTag(typeBlock, 'type'), []), innerXml: innerOf(typeBlock, 'type') });
    }
  } catch {
    // best-effort
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse: worksheet vm references.
// ---------------------------------------------------------------------------

/** Parse one worksheet part's `<c vm="N">` cells into refs (vm absent/unparseable → skipped). */
export function parseCellRichValueRefs(
  sheetXml: string,
  sheetName: string,
  sheetIndex: number,
): CellRichValueRef[] {
  const out: CellRichValueRef[] = [];
  try {
    const den = denamespaceXml(sheetXml);
    for (const cBlock of blocks(den, 'c')) {
      const tag = openTag(cBlock, 'c');
      const vm = intAttr(tag, 'vm');
      if (vm === null) continue;
      const ref = attr(tag, 'r');
      if (ref === null) continue;
      const cellRef: CellRichValueRef = { sheetName, sheetIndex, ref, vm };
      const v = /<v>([\s\S]*?)<\/v>/.exec(cBlock);
      if (v) cellRef.cachedValue = unescapeXml(v[1]!);
      const t = attr(tag, 't');
      if (t !== null) cellRef.cellType = t;
      out.push(cellRef);
    }
  } catch {
    // best-effort
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolve: cell → metadata → rich value → typed fields.
// ---------------------------------------------------------------------------

function typedValue(keyType: string | undefined, rawText: string): string | number | boolean {
  if (keyType === 'd' || keyType === 'i') {
    const n = Number(rawText);
    if (rawText.trim() !== '' && Number.isFinite(n)) return n;
    return rawText;
  }
  if (keyType === 'b') {
    if (rawText === '1' || rawText.toLowerCase() === 'true') return true;
    if (rawText === '0' || rawText.toLowerCase() === 'false') return false;
    return rawText;
  }
  return rawText;
}

/**
 * Resolve every cell ref that reaches a rich-value record. Unresolvable
 * refs (vm out of range, non-rich metadata type, dangling rvb index) are
 * omitted — the raw ref stays in `model.cellRefs` for diagnosis.
 */
export function resolveRichValues(model: RichValuesModel): ResolvedRichValue[] {
  const out: ResolvedRichValue[] = [];
  for (const cell of model.cellRefs) {
    const block = model.metadata.valueMetadata[cell.vm - 1];
    if (!block) continue;
    for (const rc of block.records) {
      const typeName = model.metadata.types[rc.t - 1]?.name;
      if (!typeName) continue;
      const future = model.metadata.futureMetadata.find((f) => f.name === typeName);
      if (!future) continue;
      const fmBlock = future.blocks[rc.v];
      if (!fmBlock || fmBlock.rvbIndex === undefined) continue;
      const record = model.values[fmBlock.rvbIndex];
      if (!record) continue;
      const structure =
        record.structureIndex !== undefined ? model.structures[record.structureIndex] : undefined;
      const fields: ResolvedRichValueField[] = [];
      record.values.forEach((raw, i) => {
        const key = structure?.keys[i];
        if (!key) return;
        const field: ResolvedRichValueField = {
          key: key.name,
          value: typedValue(key.type ?? raw.t, raw.text),
          rawText: raw.text,
        };
        if (key.type !== undefined) field.type = key.type;
        fields.push(field);
      });
      const resolved: ResolvedRichValue = {
        cell,
        richValueIndex: fmBlock.rvbIndex,
        typeName,
        fields,
        ...(record.structureIndex !== undefined ? { structureIndex: record.structureIndex } : {}),
        ...(record.fallback !== undefined
          ? { fallback: record.fallback.text }
          : cell.cachedValue !== undefined
            ? { fallback: cell.cachedValue }
            : {}),
      };
      out.push(resolved);
      break; // first resolvable record in the block wins
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialize: model → part XML (exactly what the model carries).
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_DECLS =
  `xmlns="${MAIN_NAMESPACE}" xmlns:mc="${MC_NAMESPACE}" ` +
  `xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"`;
const RICH_DATA_DECLS =
  `xmlns="${RICH_DATA_NAMESPACE}" xmlns:mc="${MC_NAMESPACE}" mc:Ignorable="x14ac" ` +
  `xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"`;
const RICH_DATA2_DECLS =
  `xmlns="${RICH_DATA2_NAMESPACE}" xmlns:mc="${MC_NAMESPACE}" mc:Ignorable="x14ac" ` +
  `xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"`;

function attrsXml(attrs: Record<string, string> | undefined): string {
  if (!attrs) return '';
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`)
    .join('');
}

export function metadataToXml(metadata: MetadataModel): string {
  const types =
    metadata.types.length > 0
      ? `<metadataTypes count="${metadata.types.length}">` +
        metadata.types
          .map((t) => `<metadataType name="${escapeXmlAttr(t.name)}"${attrsXml(t.attrs)}/>`)
          .join('') +
        `</metadataTypes>`
      : '';
  const future = metadata.futureMetadata
    .map(
      (fm) =>
        `<futureMetadata name="${escapeXmlAttr(fm.name)}" count="${fm.blocks.length}">` +
        fm.blocks
          .map((b) => {
            const ext =
              b.rvbIndex !== undefined || b.extUri !== undefined
                ? `<extLst><ext${b.extUri !== undefined ? ` uri="${escapeXmlAttr(b.extUri)}"` : ''}>` +
                  (b.rvbIndex !== undefined ? `<rvb i="${b.rvbIndex}"/>` : '') +
                  `</ext></extLst>`
                : '';
            return ext ? `<bk>${ext}</bk>` : `<bk/>`;
          })
          .join('') +
        `</futureMetadata>`,
    )
    .join('');
  const blocksXml = (blocksList: MetadataBlock[]): string =>
    blocksList
      .map(
        (b) =>
          `<bk>${b.records.map((r) => `<rc t="${r.t}" v="${r.v}"/>`).join('')}</bk>`,
      )
      .join('');
  const valueMeta =
    metadata.valueMetadata.length > 0
      ? `<valueMetadata count="${metadata.valueMetadata.length}">${blocksXml(metadata.valueMetadata)}</valueMetadata>`
      : '';
  const cellMeta =
    metadata.cellMetadata.length > 0
      ? `<cellMetadata count="${metadata.cellMetadata.length}">${blocksXml(metadata.cellMetadata)}</cellMetadata>`
      : '';
  const strings =
    metadata.strings.length > 0
      ? `<metadataStrings count="${metadata.strings.length}">` +
        metadata.strings.map((s) => `<s><v>${escapeXmlText(s)}</v></s>`).join('') +
        `</metadataStrings>`
      : '';
  const inner = types + future + valueMeta + cellMeta + strings;
  return inner
    ? `${XML_DECL}<metadata ${MAIN_DECLS} xmlns:xlrd="${RICH_DATA_NAMESPACE}">${inner}</metadata>`
    : `${XML_DECL}<metadata ${MAIN_DECLS} xmlns:xlrd="${RICH_DATA_NAMESPACE}"/>`;
}

export function richValueDataToXml(values: RichValueRecord[]): string {
  const inner = values
    .map((r) => {
      const sAttr = r.structureIndex !== undefined ? ` s="${r.structureIndex}"` : '';
      const vals = r.values
        .map(
          (v) =>
            `<${v.tag}${v.t !== undefined ? ` t="${escapeXmlAttr(v.t)}"` : ''}${attrsXml(v.attrs)}>${escapeXmlText(v.text)}</${v.tag}>`,
        )
        .join('');
      const fb = r.fallback
        ? `<fb${r.fallback.t !== undefined ? ` t="${escapeXmlAttr(r.fallback.t)}"` : ''}>${escapeXmlText(r.fallback.text)}</fb>`
        : '';
      return `<rv${sAttr}>${vals}${fb}</rv>`;
    })
    .join('');
  return `${XML_DECL}<rvData ${RICH_DATA_DECLS} count="${values.length}">${inner}</rvData>`;
}

export function richValueStructuresToXml(structures: RichValueStructure[]): string {
  const inner = structures
    .map(
      (s) =>
        `<s>${s.keys
          .map(
            (k) =>
              `<k name="${escapeXmlAttr(k.name)}"${k.type !== undefined ? ` t="${escapeXmlAttr(k.type)}"` : ''}${attrsXml(k.attrs)}/>`,
          )
          .join('')}</s>`,
    )
    .join('');
  return `${XML_DECL}<rvStructures ${RICH_DATA_DECLS} count="${structures.length}">${inner}</rvStructures>`;
}

export function richValueTypesToXml(types: RichValueTypeDef[]): string {
  const inner = types
    .map((t) => (t.innerXml ? `<type${attrsXml(t.attrs)}>${t.innerXml}</type>` : `<type${attrsXml(t.attrs)}/>`))
    .join('');
  return `${XML_DECL}<rvTypes ${RICH_DATA2_DECLS}>${inner}</rvTypes>`;
}

// ---------------------------------------------------------------------------
// Read: whole package.
// ---------------------------------------------------------------------------

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

/** r:id → resolved part path for relationships whose Type ends with `suffix`. */
function relTargets(
  files: Record<string, Uint8Array>,
  relsPath: string,
  typeSuffix: string,
  ownerPart: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const raw = files[relsPath];
  if (!raw) return out;
  const rels = denamespaceXml(decoder.decode(raw));
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    const type = attr(tag, 'Type') ?? '';
    if (id && target && type.endsWith(typeSuffix)) out.set(id, resolveTarget(ownerPart, target));
  }
  return out;
}

interface SheetPartInfo {
  name: string;
  path: string;
  sheetId: number;
}

/** Sheets via xl/workbook.xml + workbook rels (exact — no sheetN guessing). */
function sheetPartPaths(files: Record<string, Uint8Array>): SheetPartInfo[] {
  const out: SheetPartInfo[] = [];
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) return out;
  const wb = denamespaceXml(decoder.decode(wbXml));
  const targetByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/worksheet', 'xl/workbook.xml');
  for (const tag of wb.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id');
    if (name && rid) {
      const path = targetByRid.get(rid);
      if (path) out.push({ name, path, sheetId: intAttr(tag, 'sheetId') ?? -1 });
    }
  }
  return out;
}

function emptyMetadata(): MetadataModel {
  return { types: [], futureMetadata: [], valueMetadata: [], cellMetadata: [], strings: [] };
}

function emptyResult(): ReadRichValuesResult {
  return {
    metadata: emptyMetadata(),
    structures: [],
    values: [],
    types: [],
    cellRefs: [],
    partPaths: {},
    rawParts: { parts: {} },
  };
}

/** Classify a rich-data part by its root element; null when not a rich-data part. */
function classifyRichDataPart(xml: string): 'data' | 'structures' | 'types' | null {
  if (openTag(xml, 'rvData')) return 'data';
  if (openTag(xml, 'rvStructures')) return 'structures';
  if (openTag(xml, 'rvTypes')) return 'types';
  return null;
}

/**
 * Read every rich-value part + worksheet vm reference in an unzipped
 * OOXML package. Never throws.
 */
export function readRichValues(files: Record<string, Uint8Array>): ReadRichValuesResult {
  const result = emptyResult();
  try {
    const stash = (path: string): void => {
      const bytes = files[path];
      if (bytes) result.rawParts.parts[path] = u8ToBase64(bytes);
    };

    // Metadata part: workbook relationship first, xl/metadata.xml fallback.
    let metadataPath: string | undefined;
    const metaByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/metadata', 'xl/workbook.xml');
    if (metaByRid.size > 0) metadataPath = [...metaByRid.values()].sort()[0];
    else if (files['xl/metadata.xml']) metadataPath = 'xl/metadata.xml';
    if (metadataPath && files[metadataPath]) {
      const parsed = parseMetadataXml(decoder.decode(files[metadataPath]));
      if (parsed) {
        result.metadata = parsed;
        result.partPaths.metadata = metadataPath;
        stash(metadataPath);
      }
    }

    // Rich-data parts: every part under xl/richData/, classified by root.
    const richPaths = Object.keys(files)
      .filter((p) => /^xl\/richData\/[^/]+\.xml$/.test(p))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const path of richPaths) {
      let xml: string;
      try {
        xml = decoder.decode(files[path]!);
      } catch {
        continue;
      }
      const kind = classifyRichDataPart(denamespaceXml(xml));
      if (kind === 'data' && !result.partPaths.data) {
        result.values = parseRichValueDataXml(xml);
        result.partPaths.data = path;
        stash(path);
      } else if (kind === 'structures' && !result.partPaths.structures) {
        result.structures = parseRichValueStructuresXml(xml);
        result.partPaths.structures = path;
        stash(path);
      } else if (kind === 'types' && !result.partPaths.types) {
        result.types = parseRichValueTypesXml(xml);
        result.partPaths.types = path;
        stash(path);
      }
    }

    // Worksheet vm references.
    const sheets = sheetPartPaths(files);
    sheets.forEach((sheet, sheetIndex) => {
      const raw = files[sheet.path];
      if (!raw) return;
      result.cellRefs.push(...parseCellRichValueRefs(decoder.decode(raw), sheet.name, sheetIndex));
    });
    result.cellRefs.sort(
      (a, b) => a.sheetIndex - b.sheetIndex || a.ref.localeCompare(b.ref, undefined, { numeric: true }),
    );
  } catch {
    // Best-effort: rich-value import must never break the open.
  }
  return result;
}

/** The metadata model for a read result (everything except raw part bytes). */
export function richValuesModelOf(result: ReadRichValuesResult): RichValuesModel {
  return {
    metadata: result.metadata,
    structures: result.structures,
    values: result.values,
    types: result.types,
    cellRefs: result.cellRefs,
    partPaths: result.partPaths,
  };
}

/** Read rich values from a whole .xlsx package (bytes). Never throws. */
export function readRichValuesPackage(packageBytes: Uint8Array): ReadRichValuesResult {
  try {
    return readRichValues(unzipSync(packageBytes.slice()));
  } catch {
    return emptyResult();
  }
}

// ---------------------------------------------------------------------------
// Write: inject model parts into a package.
// ---------------------------------------------------------------------------

const RICH_CONTENT_TYPES: Record<string, string> = {
  metadata: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
  data: 'application/vnd.ms-excel.richValue',
  structures: 'application/vnd.ms-excel.richValueStructure',
  types: 'application/vnd.ms-excel.richValueTypes',
};

function ensureContentType(files: Record<string, Uint8Array>, path: string, contentType: string): void {
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return;
  let xml = decoder.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return;
  if (!xml.includes('</Types>')) return;
  xml = xml.replace('</Types>', `<Override PartName="/${path}" ContentType="${contentType}"/></Types>`);
  files[ctPath] = encoder.encode(xml);
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

function ensureWorkbookMetadataRel(files: Record<string, Uint8Array>, metadataPath: string): void {
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const raw = files[relsPath];
  if (!raw) return;
  let xml = decoder.decode(raw);
  if (xml.includes(METADATA_REL_TYPE)) return;
  if (!xml.includes('</Relationships>')) return;
  const target = metadataPath.startsWith('xl/') ? metadataPath.slice(3) : metadataPath;
  const rid = freshRid(xml);
  xml = xml.replace(
    '</Relationships>',
    `<Relationship Id="${rid}" Type="${METADATA_REL_TYPE}" Target="${target}"/></Relationships>`,
  );
  files[relsPath] = encoder.encode(xml);
}

/**
 * Inject a rich-values model's parts into an unzipped package (mutates
 * `files`). Writes only parts whose model section is non-empty, at the
 * model's recorded part paths when present, else at the default paths.
 * Sheet `vm` stamping is NOT done here (see module header). Returns the
 * list of part paths written. Never throws; a failure leaves `files`
 * unchanged for that part.
 */
export function injectRichValueParts(
  files: Record<string, Uint8Array>,
  model: RichValuesModel,
): string[] {
  const written: string[] = [];
  try {
    const hasMetadata =
      model.metadata.types.length > 0 ||
      model.metadata.futureMetadata.length > 0 ||
      model.metadata.valueMetadata.length > 0 ||
      model.metadata.cellMetadata.length > 0 ||
      model.metadata.strings.length > 0;
    if (hasMetadata) {
      const path = model.partPaths.metadata ?? 'xl/metadata.xml';
      files[path] = encoder.encode(metadataToXml(model.metadata));
      ensureContentType(files, path, RICH_CONTENT_TYPES.metadata!);
      ensureWorkbookMetadataRel(files, path);
      written.push(path);
    }
    if (model.values.length > 0) {
      const path = model.partPaths.data ?? 'xl/richData/richValue.xml';
      files[path] = encoder.encode(richValueDataToXml(model.values));
      ensureContentType(files, path, RICH_CONTENT_TYPES.data!);
      written.push(path);
    }
    if (model.structures.length > 0) {
      const path = model.partPaths.structures ?? 'xl/richData/richValueStructure.xml';
      files[path] = encoder.encode(richValueStructuresToXml(model.structures));
      ensureContentType(files, path, RICH_CONTENT_TYPES.structures!);
      written.push(path);
    }
    if (model.types.length > 0) {
      const path = model.partPaths.types ?? 'xl/richData/richValueTypes.xml';
      files[path] = encoder.encode(richValueTypesToXml(model.types));
      ensureContentType(files, path, RICH_CONTENT_TYPES.types!);
      written.push(path);
    }
  } catch {
    // best-effort: a failed injection must never break the save
  }
  return written;
}

/** Decode raw-part bytes stashed by readRichValues (inverse of the stash). */
export function richValueRawPartBytes(rawParts: RichValueRawParts, path: string): Uint8Array | null {
  const b64 = rawParts.parts[path];
  if (!b64) return null;
  try {
    return base64ToU8(b64);
  } catch {
    return null;
  }
}
