/**
 * Imported drawingML SmartArt → picture-overlay conversion.
 *
 * The xlsx-adapter extracts every embedded SmartArt diagram (layout
 * identity, node text, anchor) into metadata; this module resolves each
 * diagram to a SmartArt family, renders it with the existing SmartArt SVG
 * renderer, and returns a Picture overlay the grid can float.
 *
 * User-locked requirement (2026-10-19): NO diagram may be silently
 * dropped. Every layout maps to a family (the adapter never fails the
 * mapping); layouts without an exact renderer fall back to the closest
 * family and the substitution is reported three ways: the visible caption
 * baked into the SVG, a console entry, and the mapping report returned by
 * `smartArtLayoutMappingReport`.
 */
import type {
  ImportedSmartArt,
  SmartArtFamily,
} from '@icecream-sheets/xlsx-adapter';
import { smartArtSvg, type SmartArtLayout } from '../components/SmartShapes';
import type { Picture } from '../components/Pictures';

/** Deterministic overlay name so re-opening a saved file does not duplicate.
 *  ASCII-only: names round-trip through XLSX custom properties, which
 *  mangle non-ASCII (mojibake) — a non-ASCII separator would break the
 *  save → re-open dedup. */
export function importedSmartArtPictureName(d: ImportedSmartArt): string {
  return `SmartArt - ${d.sheetName} - ${d.layoutName || d.layoutId} - ${d.items.length} items`;
}

/**
 * Parse the `icecream.smartart` metadata value into ImportedSmartArt[].
 * Returns [] for missing/corrupt metadata (never throws).
 */
export function importedSmartArtFromMetadata(value: unknown): ImportedSmartArt[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is ImportedSmartArt =>
        !!d &&
        typeof d === 'object' &&
        typeof (d as ImportedSmartArt).sheetName === 'string' &&
        typeof (d as ImportedSmartArt).layoutId === 'string' &&
        typeof (d as ImportedSmartArt).family === 'string' &&
        Array.isArray((d as ImportedSmartArt).items) &&
        !!(d as ImportedSmartArt).anchor &&
        typeof (d as ImportedSmartArt).anchor.fromCol === 'number',
    );
  } catch {
    return [];
  }
}

/** Adapter family → SmartArt renderer layout (1:1 by construction). */
export function familyToLayout(family: SmartArtFamily): SmartArtLayout {
  const layouts: SmartArtLayout[] = [
    'list',
    'process',
    'cycle',
    'hierarchy',
    'relationship',
    'pyramid',
    'matrix',
  ];
  return layouts.includes(family as SmartArtLayout) ? (family as SmartArtLayout) : 'process';
}

/**
 * Convert one imported diagram to a floating picture overlay. The anchor
 * cells from the drawingML anchor set the grid position (same px scale as
 * imported charts); the fallback note, when present, is baked into the SVG
 * as a visible caption strip.
 */
export function importedSmartArtToPicture(d: ImportedSmartArt, id: number): Picture {
  const layout = familyToLayout(d.family);
  const { svg, width, height } = smartArtSvg(layout, d.items, {
    note: d.fallbackNote ?? undefined,
  });
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  const a = d.anchor;
  return {
    id,
    x: a.fromCol * 64,
    y: a.fromRow * 20,
    w: width,
    h: height,
    dataUrl,
    name: importedSmartArtPictureName(d),
    sheet: d.sheetName,
  };
}

/**
 * Pass through the raw diagram parts (`xlsx.smartartParts`) captured on
 * open, so the save path can re-attach them for byte-for-byte round-trip.
 * Returns undefined for missing/corrupt values (never throws).
 */
export function smartArtPartsFromMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as { diagrams?: unknown; parts?: unknown };
  if (!Array.isArray(r.diagrams) || !r.parts || typeof r.parts !== 'object') return undefined;
  return value;
}

export interface SmartArtMappingEntry {
  sheetName: string;
  layoutId: string;
  layoutName: string;
  family: SmartArtFamily;
  /** True when the layout mapped to its exact renderer. */
  exact: boolean;
  /** The substitution note for closest-kind fallbacks ('' when exact). */
  note: string;
}

/**
 * The layout-mapping report: one entry per imported diagram. Every
 * diagram appears — exact or fallback — so the report doubles as the
 * proof that nothing was silently dropped.
 */
export function smartArtLayoutMappingReport(diagrams: ImportedSmartArt[]): SmartArtMappingEntry[] {
  return diagrams.map((d) => ({
    sheetName: d.sheetName,
    layoutId: d.layoutId,
    layoutName: d.layoutName,
    family: d.family,
    exact: !d.fallbackNote,
    note: d.fallbackNote ?? '',
  }));
}
