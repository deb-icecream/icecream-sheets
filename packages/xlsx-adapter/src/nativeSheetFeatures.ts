/**
 * Native worksheet-feature orchestration (mergeCells, autoFilter,
 * sortState, dataValidations, conditionalFormatting, sparklines) — the
 * file-layer half of audit §§4.3, 5.1, 5.2, 6.1, 14.3, 14.4 for the
 * CLASSIC adapter.
 *
 * MODEL: the features live on the sheet objects themselves as OPTIONAL
 * fields (`SheetDataWithNativeFeatures`). SheetData is defined by the
 * engine package; the adapter carries these fields as an intersection
 * extension so existing consumers (which never read them) are
 * unaffected, and both read paths attach them in
 * `XlsxAdapter.assembleFromParsedSheets` — the one funnel the SheetJS
 * read and the fast parallel parse share. Fields are set only when the
 * file actually carries the feature (absent = the file had none).
 *
 * READ (`attachNativeSheetFeatures`): parse each worksheet part +
 * styles.xml `<dxfs>` directly from the package (SheetJS drops all of
 * it) and attach the models. Best-effort: never breaks an open.
 *
 * WRITE (`injectNativeSheetFeatures`): one unzip/modify/re-zip pass over
 * the SheetJS-produced package that (a) allocates every rule's dxf in
 * styles.xml `<dxfs>` (append/dedupe via allocateDxfs), and (b) replaces
 * each sheet's feature blocks with the model's serialization, inserted
 * in CT_Worksheet sequence order (§18.3.1.99):
 *   sheetData, sheetCalcPr, sheetProtection, protectedRanges,
 *   scenarios, autoFilter, sortState, dataConsolidation,
 *   customSheetViews, mergeCells, phoneticPr, conditionalFormatting,
 *   dataValidations, hyperlinks, printOptions, pageMargins, …
 * Sheets whose model carries no feature field are left byte-identical,
 * EXCEPT that stale blocks of a feature whose field is present-but-empty
 * (e.g. `merges: []`, `dataValidations: []`) are stripped — a present
 * field is authoritative for that feature (see mergeCellsXml.ts for the
 * merges precedence rule, which applies uniformly here).
 *
 * Sparklines differ from the other features in placement only: they are
 * an x14 extension ([MS-XLSX] §2.3.2) living in the worksheet `<extLst>`
 * — the last CT_Worksheet child — not in the post-`</sheetData>` block,
 * so they are spliced by sparklinesXml.spliceSparklineGroups (which
 * also maintains the worksheet root's x14 namespace declarations),
 * never by nativeFeaturesBlockXml.
 *
 * The streaming/direct save path is NOT covered by this injector: it
 * copies a changed sheet's source tail verbatim, so a source file's
 * native blocks survive untouched there, and sheetXmlChunks accepts
 * replacement blocks via SheetGenOptions.nativeFeatures (dxf allocation
 * for that path stays with the source styles, append-only). This module
 * is the classic path's writer, which previously dropped everything.
 */
import { unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';
import { sheetPartPaths, type ZipLike } from './formulaRecovery.js';
import type { SheetData } from '@icecream-sheets/engine';
import { mergeCellsToXml, parseMergeCells } from './mergeCellsXml.js';
import {
  autoFilterToXml,
  parseAutoFilter,
  parseSortState,
  sortStateToXml,
  type NativeAutoFilter,
  type NativeSortState,
} from './autoFilterXml.js';
import {
  dataValidationsToXml,
  parseDataValidations,
  type NativeDataValidation,
} from './dataValidationXml.js';
import {
  allocateDxfs,
  conditionalFormattingToXml,
  parseConditionalFormatting,
  parseDxfs,
  type CfRule,
  type DxfFormat,
  type NativeConditionalFormatting,
} from './conditionalFormattingXml.js';
import {
  parseSparklineGroups,
  spliceSparklineGroups,
  type SparklineGroup,
} from './sparklinesXml.js';
import { stripBlocks } from './nativeXmlUtil.js';

export type {
  NativeAutoFilter,
  NativeSortState,
  NativeDataValidation,
  NativeConditionalFormatting,
  SparklineGroup,
};

/** The optional native-feature fields a sheet object may carry. */
export interface NativeSheetFeatureFields {
  /** `<mergeCell ref>` list, canonical A1 (mergeCellsXml.ts). */
  merges?: string[];
  autoFilter?: NativeAutoFilter;
  sortState?: NativeSortState;
  dataValidations?: NativeDataValidation[];
  conditionalFormatting?: NativeConditionalFormatting[];
  /** `<x14:sparklineGroup>` list from the sheet's `<extLst>` (sparklinesXml.ts). */
  sparklineGroups?: SparklineGroup[];
}

/** SheetData plus the adapter's native-feature extension fields. */
export type SheetDataWithNativeFeatures = SheetData & NativeSheetFeatureFields;

/** The feature subset sheetXmlChunks can splice into a generated sheet. */
export interface NativeFeaturesModel extends NativeSheetFeatureFields {}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse native worksheet features from the package onto each sheet
 * (mutates the sheet objects). Never throws.
 */
export function attachNativeSheetFeatures(
  sheets: SheetData[],
  files: ZipLike | undefined,
): void {
  try {
    if (!files) return;
    const parts = sheetPartPaths(files);
    if (parts.size === 0) return;
    const decoder = new TextDecoder();
    const stylesRaw = files['xl/styles.xml'];
    const dxfs: DxfFormat[] = stylesRaw ? parseDxfs(decoder.decode(stylesRaw)) : [];
    for (const sheet of sheets) {
      const path = parts.get(sheet.name);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      const xml = decoder.decode(raw);
      const target = sheet as SheetDataWithNativeFeatures;
      const merges = parseMergeCells(xml);
      if (merges.length > 0) target.merges = merges;
      const af = parseAutoFilter(xml);
      if (af) target.autoFilter = af;
      const ss = parseSortState(xml);
      if (ss) target.sortState = ss;
      const dvs = parseDataValidations(xml);
      if (dvs.length > 0) target.dataValidations = dvs;
      const cfs = parseConditionalFormatting(xml, dxfs);
      if (cfs.length > 0) target.conditionalFormatting = cfs;
      const sgs = parseSparklineGroups(xml);
      if (sgs.length > 0) target.sparklineGroups = sgs;
    }
  } catch {
    // Best-effort: native features must never break the open.
  }
}

/* ------------------------------------------------------------------ */
/* Block assembly (shared with the streaming writer)                   */
/* ------------------------------------------------------------------ */

const FEATURE_BLOCK_TAGS = [
  'autoFilter',
  'sortState',
  'mergeCells',
  'conditionalFormatting',
  'dataValidations',
] as const;

/**
 * Serialize a sheet's feature model into the ordered block that follows
 * `</sheetData>` in CT_Worksheet sequence. `dxfIdFor` resolves CF dxf
 * indices (the classic path allocates them in styles.xml first; the
 * streaming path passes ids resolved against the source styles).
 */
export function nativeFeaturesBlockXml(
  features: NativeSheetFeatureFields,
  dxfIdFor: (rule: CfRule) => number | undefined,
): string {
  let out = '';
  if (features.autoFilter) out += autoFilterToXml(features.autoFilter);
  if (features.sortState) out += sortStateToXml(features.sortState);
  if (features.merges && features.merges.length > 0) out += mergeCellsToXml(features.merges);
  for (const cf of features.conditionalFormatting ?? []) {
    out += conditionalFormattingToXml(cf, dxfIdFor);
  }
  if (features.dataValidations && features.dataValidations.length > 0) {
    out += dataValidationsToXml(features.dataValidations);
  }
  return out;
}

/**
 * Splice a serialized feature block into a worksheet XML string:
 * existing feature blocks are stripped first (idempotent re-saves), and
 * the block lands after `</sheetData>` + any sheetProtection /
 * protectedRanges / scenarios elements, before the first element that
 * follows dataValidations in CT_Worksheet order.
 */
export function spliceNativeFeaturesBlock(sheetXml: string, block: string): string {
  let xml = sheetXml;
  for (const tag of FEATURE_BLOCK_TAGS) xml = stripBlocks(xml, tag);
  if (block === '') return xml;
  // Insertion floor: end of </sheetData>, extended past any elements
  // that precede autoFilter in the sequence and may already exist.
  let floor = xml.indexOf('</sheetData>');
  if (floor < 0) return xml;
  floor += '</sheetData>'.length;
  for (const tag of ['sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios']) {
    const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`);
    const m = re.exec(xml.slice(floor));
    if (m && m.index === 0) floor += m[0].length;
  }
  // Insertion ceiling: the first following element that must come after
  // dataValidations (or the end of the worksheet).
  let ceiling = xml.indexOf('</worksheet>');
  if (ceiling < 0) ceiling = xml.length;
  for (const marker of [
    '<dataConsolidation', '<customSheetViews', '<phoneticPr', '<hyperlinks',
    '<printOptions', '<pageMargins', '<pageSetup', '<headerFooter',
    '<rowBreaks', '<colBreaks', '<drawing', '<legacyDrawing', '<tableParts',
    '<oleObjects', '<controls', '<extLst',
  ]) {
    const i = xml.indexOf(marker, floor);
    if (i >= 0 && i < ceiling) ceiling = i;
  }
  const at = Math.max(floor, Math.min(ceiling, xml.length));
  return xml.slice(0, at) + block + xml.slice(at);
}

/* ------------------------------------------------------------------ */
/* Write (classic package pass)                                        */
/* ------------------------------------------------------------------ */

/**
 * Write every sheet's native-feature model into the package: dxfs are
 * allocated in xl/styles.xml, then each touched sheet's blocks are
 * replaced by the model's serialization. Sheets with NO feature field
 * at all are left untouched. Never throws.
 */
export function injectNativeSheetFeatures(
  packageBytes: Uint8Array,
  sheets: readonly SheetData[],
): Uint8Array {
  try {
    const featured = sheets as readonly SheetDataWithNativeFeatures[];
    const any = featured.some(
      (s) =>
        s.merges !== undefined || s.autoFilter !== undefined || s.sortState !== undefined ||
        s.dataValidations !== undefined || s.conditionalFormatting !== undefined ||
        s.sparklineGroups !== undefined,
    );
    if (!any) return packageBytes;
    const files = unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files as unknown as Record<string, Uint8Array>);
    if (parts.size === 0) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // 1. Allocate dxfs for every CF rule that carries a dxf payload.
    const wanted: DxfFormat[] = [];
    for (const sheet of featured) {
      for (const cf of sheet.conditionalFormatting ?? []) {
        for (const rule of cf.rules) if (rule.dxf) wanted.push(rule.dxf);
      }
    }
    const dxfIdByRule = new Map<CfRule, number>();
    if (wanted.length > 0) {
      const stylesRaw = files['xl/styles.xml'];
      if (!stylesRaw) return packageBytes;
      const { stylesXml, dxfIds } = allocateDxfs(decoder.decode(stylesRaw), wanted);
      let k = 0;
      for (const sheet of featured) {
        for (const cf of sheet.conditionalFormatting ?? []) {
          for (const rule of cf.rules) {
            if (rule.dxf) dxfIdByRule.set(rule, dxfIds[k++] as number);
          }
        }
      }
      files['xl/styles.xml'] = encoder.encode(stylesXml);
    }
    const dxfIdFor = (rule: CfRule): number | undefined => dxfIdByRule.get(rule) ?? rule.dxfId;

    // 2. Replace each featured sheet's blocks.
    let touched = wanted.length > 0;
    for (const sheet of featured) {
      const hasField =
        sheet.merges !== undefined || sheet.autoFilter !== undefined || sheet.sortState !== undefined ||
        sheet.dataValidations !== undefined || sheet.conditionalFormatting !== undefined ||
        sheet.sparklineGroups !== undefined;
      if (!hasField) continue;
      const path = parts.get(sheet.name);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      const xml = decoder.decode(raw);
      const block = nativeFeaturesBlockXml(sheet, dxfIdFor);
      let out = spliceNativeFeaturesBlock(xml, block);
      // Sparklines live in <extLst>, outside the post-sheetData block.
      if (sheet.sparklineGroups !== undefined) {
        out = spliceSparklineGroups(out, sheet.sparklineGroups);
      }
      if (out !== xml) {
        files[path] = encoder.encode(out);
        touched = true;
      }
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}
