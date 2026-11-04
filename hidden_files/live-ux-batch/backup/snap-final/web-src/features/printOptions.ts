/**
 * Sheet Options print flags (Page Layout > Sheet Options).
 *
 * Excel's Sheet Options group has View and Print checkboxes for Gridlines
 * and Headings. The view toggles already exist in App state; these are the
 * Print flags. They persist per sheet in workbook metadata
 * (`icecream.printflags.<sheet>`) and the print path consults them when
 * rendering pages (gridline borders / heading labels on printed output).
 */
export interface PrintFlags {
  printGridlines: boolean;
  printHeadings: boolean;
}

export const PRINT_FLAGS_METADATA_PREFIX = 'icecream.printflags.';
export const DEFAULT_PRINT_FLAGS: PrintFlags = { printGridlines: false, printHeadings: false };

export function printFlagsMetadataKey(sheet: string): string {
  return `${PRINT_FLAGS_METADATA_PREFIX}${sheet}`;
}

export function printFlagsToMetadata(flags: PrintFlags): unknown {
  return JSON.parse(JSON.stringify(flags)) as unknown;
}

export function printFlagsFromMetadata(meta: unknown): PrintFlags {
  if (typeof meta !== 'object' || meta === null) return { ...DEFAULT_PRINT_FLAGS };
  const r = meta as Record<string, unknown>;
  return {
    printGridlines: r.printGridlines === true,
    printHeadings: r.printHeadings === true,
  };
}
