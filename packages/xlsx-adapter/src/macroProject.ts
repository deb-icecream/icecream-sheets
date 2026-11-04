/**
 * Macro project preservation for the XLSX adapter.
 *
 * Design (design-docs/automation-lane.md §6): "The XLSX adapter preserves
 * original macro projects byte-for-byte as hints." A .xlsm's vbaProject.bin
 * is opaque to Icecream Sheets: it is carried through open/save without
 * being parsed or executed, so the file stays macro-capable in Excel while
 * the macros can never run inside our engine process.
 *
 * Mechanism: SheetJS (community edition) rebuilds the OOXML package from
 * its own object model on write and drops anything it does not understand,
 * so the adapter extracts xl/vbaProject.bin on read (via fflate, which
 * works in Node and browsers alike), stashes the bytes in WorkbookData
 * metadata, and re-injects the entry into the freshly written ZIP on save
 * — including the [Content_Types].xml override and the workbook
 * relationship Excel requires to recognize the macro project.
 *
 * Honest limits:
 * - Only the vbaProject.bin part is preserved. Other unknown parts
 *   (custom XML, embedded objects) are still dropped — the adapter's
 *   preservesUnknownParts capability stays false.
 * - The bytes are a hint, not a promise: SheetJS re-compresses the package
 *   on write, so the vbaProject *entry* is byte-identical but the package
 *   is rebuilt. A macro signature (vbaProjectSignature.bin) is NOT
 *   preserved and is dropped — signed macros will show as unsigned.
 * - If injection fails for any reason, the save still succeeds without
 *   the macro project (a save must never fail because of a hint).
 */

import { strFromU8, strToU8, unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';

/** OOXML part path of the VBA project inside the package. */
export const VBA_PROJECT_PATH = 'xl/vbaProject.bin';

/** WorkbookData metadata keys carrying the preserved macro project. */
export const MACRO_PROJECT_KEY = 'icecream.macroProject.vbaProjectBin';
export const MACRO_PROJECT_PRESENT_KEY = 'icecream.macroProject.present';

const VBA_CONTENT_TYPE = 'application/vnd.ms-office.vbaProject';
const VBA_REL_TYPE = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';

/**
 * Extract the raw vbaProject.bin bytes from an OOXML package, or null when
 * the package has no macro project (or is not a readable ZIP).
 */
export function extractMacroProject(
  packageBytes: Uint8Array,
  preunzipped?: Record<string, Uint8Array>,
): Uint8Array | null {
  let files: Record<string, Uint8Array>;
  try {
    files = preunzipped ?? unzipSync(packageBytes);
  } catch {
    return null;
  }
  const entry = files[VBA_PROJECT_PATH];
  return entry && entry.length > 0 ? entry : null;
}

function ensureContentTypeOverride(files: Record<string, Uint8Array>): void {
  const name = '[Content_Types].xml';
  const raw = files[name];
  if (!raw) return;
  let xml = strFromU8(raw);
  if (xml.includes('vbaProject')) return;
  const override =
    `  <Override PartName="/${VBA_PROJECT_PATH}" ContentType="${VBA_CONTENT_TYPE}"/>\n`;
  if (xml.includes('</Types>')) {
    xml = xml.replace('</Types>', `${override}</Types>`);
  } else {
    // Not a recognizable content-types part; leave it alone.
    return;
  }
  files[name] = strToU8(xml);
}

function ensureWorkbookRel(files: Record<string, Uint8Array>): void {
  const name = 'xl/_rels/workbook.xml.rels';
  const raw = files[name];
  if (!raw) return;
  let xml = strFromU8(raw);
  if (xml.includes('vbaProject')) return;
  const rel =
    `  <Relationship Id="rIdVbaProject" Type="${VBA_REL_TYPE}" Target="vbaProject.bin"/>\n`;
  if (xml.includes('</Relationships>')) {
    xml = xml.replace('</Relationships>', `${rel}</Relationships>`);
  } else {
    return;
  }
  files[name] = strToU8(xml);
}

/**
 * Inject a preserved vbaProject.bin into freshly written OOXML bytes.
 * Returns the patched package. Throws on malformed input — callers that
 * must not fail a save should catch.
 */
export function injectMacroProject(packageBytes: Uint8Array, vbaProject: Uint8Array): Uint8Array {
  const files = unzipSync(packageBytes);
  // Copy: fflate's record is typed Uint8Array<ArrayBuffer>.
  files[VBA_PROJECT_PATH] = Uint8Array.from(vbaProject);
  ensureContentTypeOverride(files);
  ensureWorkbookRel(files);
  return zipSyncStable(files);
}

/** Chunked Uint8Array -> base64 (btoa-safe, works in Node and browsers). */
export function u8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** Base64 -> Uint8Array (atob-safe, works in Node and browsers). */
export function base64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
