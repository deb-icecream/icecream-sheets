/**
 * Data-model part round-trip (#114 save constraint).
 *
 * SheetJS rebuilds the OOXML package from scratch on write, so unknown
 * parts do not survive — including the data-model parts: xl/connections.xml
 * and the xl/model/* blob (the embedded Power Pivot model). Losing them
 * on save would make Excel drop the file's data model on round-trip.
 *
 * This module follows the established raw-part hint pattern
 * (pivotParts, SmartArt): at load, capture the original part bytes PLUS
 * the exact workbook relationship elements and content-type overrides
 * that reference them; at save, re-inject all three verbatim. Nothing
 * is guessed: a part with no content-type override in the original
 * (xl/model/item.data is referenced by relationship only) gets none
 * restored either. Files without model parts produce no hint and gain
 * no parts. Never throws.
 */
import { unzipSync } from 'fflate';
import { base64ToU8, u8ToBase64 } from './macroProject.js';
import { zipSyncStable } from './zipStable.js';

export const MODEL_PARTS_METADATA_KEY = 'icecream.modelParts';

export interface ModelPartsHint {
  /** Part path -> base64 bytes. */
  parts: Record<string, string>;
  /** Original <Relationship .../> elements referencing those parts. */
  rels: string[];
  /** Original <Override .../> elements for those parts. */
  contentTypes: string[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function isModelPart(path: string): boolean {
  return path === 'xl/connections.xml' || path.startsWith('xl/model/');
}

function targetOf(relElement: string): string | null {
  return /Target="([^"]*)"/.exec(relElement)?.[1] ?? null;
}

function partNameOf(overrideElement: string): string | null {
  return /PartName="([^"]*)"/.exec(overrideElement)?.[1] ?? null;
}

/**
 * Capture a file's data-model parts from its unzipped package. Returns
 * null when the file carries none.
 */
export function captureModelParts(files: Record<string, Uint8Array>): ModelPartsHint | null {
  try {
    const parts: Record<string, string> = {};
    for (const path of Object.keys(files)) {
      if (!isModelPart(path)) continue;
      const bytes = files[path];
      if (bytes) parts[path] = u8ToBase64(bytes);
    }
    if (Object.keys(parts).length === 0) return null;
    const rels: string[] = [];
    const relsRaw = files['xl/_rels/workbook.xml.rels'];
    if (relsRaw) {
      const relsXml = decoder.decode(relsRaw);
      for (const el of relsXml.match(/<Relationship\b[^>]*\/>/g) ?? []) {
        const target = targetOf(el);
        if (!target) continue;
        // Relationship targets are relative to xl/.
        const partPath = `xl/${target}`;
        if (parts[partPath] !== undefined) rels.push(el);
      }
    }
    const contentTypes: string[] = [];
    const ctRaw = files['[Content_Types].xml'];
    if (ctRaw) {
      const ctXml = decoder.decode(ctRaw);
      for (const el of ctXml.match(/<Override\b[^>]*\/>/g) ?? []) {
        const partName = partNameOf(el);
        if (!partName) continue;
        const partPath = partName.startsWith('/') ? partName.slice(1) : partName;
        if (parts[partPath] !== undefined) contentTypes.push(el);
      }
    }
    return { parts, rels, contentTypes };
  } catch {
    return null;
  }
}

/**
 * Re-inject captured data-model parts (bytes + relationships +
 * content-type overrides) into a rebuilt package. Returns the input
 * unchanged when the hint is missing or malformed.
 */
export function injectModelParts(packageBytes: Uint8Array, rawParts: ModelPartsHint | unknown): Uint8Array {
  try {
    // Metadata travels as a JSON string through most save paths; accept
    // a parsed object too (direct callers, tests).
    let hint: ModelPartsHint | null = null;
    if (typeof rawParts === 'string' && rawParts.length > 0) {
      try {
        hint = JSON.parse(rawParts) as ModelPartsHint;
      } catch {
        return packageBytes;
      }
    } else if (rawParts && typeof rawParts === 'object') {
      hint = rawParts as ModelPartsHint;
    }
    if (!hint || typeof hint.parts !== 'object' || hint.parts === null) {
      return packageBytes;
    }
    const partPaths = Object.keys(hint.parts);
    if (partPaths.length === 0) return packageBytes;
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    let touched = false;
    for (const path of partPaths) {
      const b64 = hint.parts[path];
      if (typeof b64 !== 'string' || b64.length === 0) continue;
      try {
        files[path] = base64ToU8(b64);
      } catch {
        continue;
      }
      touched = true;
    }
    if (!touched) return packageBytes;
    const relsRaw = files['xl/_rels/workbook.xml.rels'];
    if (relsRaw && Array.isArray(hint.rels)) {
      let relsXml = decoder.decode(relsRaw);
      if (relsXml.includes('</Relationships>')) {
        let changed = false;
        for (const el of hint.rels) {
          const target = targetOf(el);
          if (!target || relsXml.includes(`Target="${target}"`)) continue;
          relsXml = relsXml.replace('</Relationships>', `${el}</Relationships>`);
          changed = true;
        }
        if (changed) files['xl/_rels/workbook.xml.rels'] = encoder.encode(relsXml);
      }
    }
    const ctRaw = files['[Content_Types].xml'];
    if (ctRaw && Array.isArray(hint.contentTypes)) {
      let ctXml = decoder.decode(ctRaw);
      if (ctXml.includes('</Types>')) {
        let changed = false;
        for (const el of hint.contentTypes) {
          const partName = partNameOf(el);
          if (!partName || ctXml.includes(`PartName="${partName}"`)) continue;
          ctXml = ctXml.replace('</Types>', `${el}</Types>`);
          changed = true;
        }
        if (changed) files['[Content_Types].xml'] = encoder.encode(ctXml);
      }
    }
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}
