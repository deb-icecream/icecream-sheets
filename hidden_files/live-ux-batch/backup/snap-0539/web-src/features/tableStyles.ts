/**
 * "Format as Table" style gallery model (Home > Styles).
 *
 * Excel ships ~60 table styles across Light / Medium / Dark families. This
 * module defines 24 real styles with banded-row rendering: each style maps
 * a row index to a concrete CellFormat (header row vs banded body rows),
 * which the app applies through the format store (setRangeFormat).
 */
import type { CellFormat } from './formatting';

export type TableStyleCategory = 'Light' | 'Medium' | 'Dark';

export interface TableStyle {
  id: string;
  name: string;
  category: TableStyleCategory;
  /** Header row fill / text. */
  headerBg: string;
  headerColor: string;
  /** Alternating body-row fills (banded rows). */
  bandBg1: string;
  bandBg2: string;
  bodyColor: string;
  /** Grid border color drawn between body cells. */
  borderColor: string;
}

function style(
  id: string,
  name: string,
  category: TableStyleCategory,
  headerBg: string,
  headerColor: string,
  bandBg1: string,
  bandBg2: string,
  bodyColor: string,
  borderColor: string,
): TableStyle {
  return { id, name, category, headerBg, headerColor, bandBg1, bandBg2, bodyColor, borderColor };
}

/** 24 built-in table styles: 9 Light, 9 Medium, 6 Dark. */
export const TABLE_STYLES: TableStyle[] = [
  // ---- Light ----
  style('light-blue', 'Table Style Light 1', 'Light', '#4472C4', '#FFFFFF', '#FFFFFF', '#D9E2F3', '#1F3864', '#B4C6E7'),
  style('light-orange', 'Table Style Light 2', 'Light', '#ED7D31', '#FFFFFF', '#FFFFFF', '#FBE5D6', '#833C0B', '#F4B084'),
  style('light-gray', 'Table Style Light 3', 'Light', '#A6A6A6', '#FFFFFF', '#FFFFFF', '#EDEDED', '#404040', '#D9D9D9'),
  style('light-green', 'Table Style Light 4', 'Light', '#70AD47', '#FFFFFF', '#FFFFFF', '#E2EFDA', '#375623', '#C6E0B4'),
  style('light-yellow', 'Table Style Light 5', 'Light', '#FFC000', '#404040', '#FFFFFF', '#FFF2CC', '#7F6000', '#FFE699'),
  style('light-teal', 'Table Style Light 6', 'Light', '#2E75B6', '#FFFFFF', '#FFFFFF', '#DDEBF7', '#1F4E78', '#BDD7EE'),
  style('light-red', 'Table Style Light 7', 'Light', '#C00000', '#FFFFFF', '#FFFFFF', '#FCE4E4', '#7A0000', '#F4A8A8'),
  style('light-purple', 'Table Style Light 8', 'Light', '#7030A0', '#FFFFFF', '#FFFFFF', '#E9D9F5', '#3B1B59', '#D3B8EA'),
  style('light-slate', 'Table Style Light 9', 'Light', '#404040', '#FFFFFF', '#FFFFFF', '#F2F2F2', '#262626', '#D9D9D9'),
  // ---- Medium ----
  style('med-blue', 'Table Style Medium 1', 'Medium', '#305496', '#FFFFFF', '#D9E2F3', '#FFFFFF', '#1F3864', '#8EA9DB'),
  style('med-orange', 'Table Style Medium 2', 'Medium', '#C55A11', '#FFFFFF', '#FBE5D6', '#FFFFFF', '#833C0B', '#F4B084'),
  style('med-gray', 'Table Style Medium 3', 'Medium', '#7F7F7F', '#FFFFFF', '#EDEDED', '#FFFFFF', '#262626', '#BFBFBF'),
  style('med-green', 'Table Style Medium 4', 'Medium', '#548235', '#FFFFFF', '#E2EFDA', '#FFFFFF', '#375623', '#A9D08E'),
  style('med-gold', 'Table Style Medium 5', 'Medium', '#BF8F00', '#FFFFFF', '#FFF2CC', '#FFFFFF', '#7F6000', '#FFD966'),
  style('med-teal', 'Table Style Medium 6', 'Medium', '#1F4E78', '#FFFFFF', '#DDEBF7', '#FFFFFF', '#1F4E78', '#9BC2E6'),
  style('med-red', 'Table Style Medium 7', 'Medium', '#833C0B', '#FFFFFF', '#FCE4E4', '#FFFFFF', '#7A0000', '#EA9999'),
  style('med-purple', 'Table Style Medium 8', 'Medium', '#4B1F6E', '#FFFFFF', '#E9D9F5', '#FFFFFF', '#3B1B59', '#B45FD6'),
  style('med-navy', 'Table Style Medium 9', 'Medium', '#1F3864', '#FFFFFF', '#D6DCE4', '#FFFFFF', '#1F3864', '#8EA9DB'),
  // ---- Dark ----
  style('dark-blue', 'Table Style Dark 1', 'Dark', '#1F3864', '#FFFFFF', '#2E75B6', '#255A8C', '#FFFFFF', '#1F3864'),
  style('dark-orange', 'Table Style Dark 2', 'Dark', '#833C0B', '#FFFFFF', '#C55A11', '#A84A0E', '#FFFFFF', '#833C0B'),
  style('dark-gray', 'Table Style Dark 3', 'Dark', '#262626', '#FFFFFF', '#595959', '#404040', '#FFFFFF', '#262626'),
  style('dark-green', 'Table Style Dark 4', 'Dark', '#375623', '#FFFFFF', '#548235', '#43682C', '#FFFFFF', '#375623'),
  style('dark-red', 'Table Style Dark 5', 'Dark', '#7A0000', '#FFFFFF', '#A63232', '#8C2828', '#FFFFFF', '#7A0000'),
  style('dark-purple', 'Table Style Dark 6', 'Dark', '#3B1B59', '#FFFFFF', '#5F2D91', '#4E2478', '#FFFFFF', '#3B1B59'),
];

export function tableStyleById(id: string): TableStyle | undefined {
  return TABLE_STYLES.find((s) => s.id === id);
}

export function tableStylesByCategory(category: TableStyleCategory): TableStyle[] {
  return TABLE_STYLES.filter((s) => s.category === category);
}

/**
 * Concrete CellFormat for one row of a styled table. Row 0 is the header;
 * body rows alternate bandBg1/bandBg2 (Excel banded rows).
 */
export function rowFormatFor(styleDef: TableStyle, rowIndex: number, isHeader: boolean): CellFormat {
  if (isHeader) {
    return {
      fillColor: styleDef.headerBg,
      fontColor: styleDef.headerColor,
      bold: true,
      borders: {
        bottom: { style: 'medium', color: styleDef.borderColor },
      },
    };
  }
  const thin = { style: 'thin' as const, color: styleDef.borderColor };
  return {
    fillColor: rowIndex % 2 === 0 ? styleDef.bandBg1 : styleDef.bandBg2,
    fontColor: styleDef.bodyColor,
    borders: { top: thin, bottom: thin, left: thin, right: thin },
  };
}

/**
 * Expand a table style over a row range into per-row CellFormats, ready for
 * setRangeFormat. `headerRow` is the 0-based row treated as the header.
 */
export function tableStyleFormats(
  styleDef: TableStyle,
  headerRow: number,
  endRow: number,
): { row: number; format: CellFormat }[] {
  const out: { row: number; format: CellFormat }[] = [];
  for (let r = headerRow; r <= endRow; r++) {
    out.push({
      row: r,
      format: rowFormatFor(styleDef, r - headerRow - 1, r === headerRow),
    });
  }
  return out;
}
