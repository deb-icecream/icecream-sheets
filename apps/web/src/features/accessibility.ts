/**
 * Check Accessibility (Review > Accessibility).
 *
 * Pure scan over a workbook model supplied by the UI layer (the dialog
 * gathers pictures/alt-text, chart titles, merged ranges, text colors and
 * header rows from App/Grid state). Rules mirror Excel's accessibility checker:
 *  - pictures/shapes without alternate text
 *  - charts without a title (screen readers announce charts by title)
 *  - merged cells (screen readers read them unreliably)
 *  - text/background color contrast below WCAG AA 4.5:1
 *  - first row empty while data exists below (missing table headers)
 *  - default sheet names ("Sheet1", …) that carry no meaning
 *
 * Each issue carries an optional fix descriptor; the UI resolves fixes
 * through onFix (e.g. focus the picture to edit alt text).
 */

export type A11ySeverity = 'error' | 'warning';

export interface A11yIssue {
  id: string;
  severity: A11ySeverity;
  rule: 'missing-alt-text' | 'missing-chart-alt' | 'merged-cells' | 'low-contrast' | 'empty-header-row' | 'default-sheet-name';
  message: string;
  /** Cell/range/picture the issue points at. */
  target?: string;
  /** Fix action the UI should offer; `action` is a fix verb the parent handles. */
  fix?: { label: string; action: 'edit-alt-text' | 'edit-chart-title' | 'unmerge' | 'fix-contrast' | 'add-headers' };
}

export interface A11yPicture {
  id: string;
  alt: string;
  /** A1-ish location label for messages, e.g. "B4". */
  at?: string;
}

export interface A11yChart {
  id: string;
  title: string;
}

export interface A11yTextRun {
  /** A1 cell address. */
  cell: string;
  /** CSS color of the text. */
  color: string;
  /** CSS background color behind the text. */
  background: string;
}

export interface A11yModel {
  sheetName: string;
  pictures: A11yPicture[];
  charts: A11yChart[];
  mergedRanges: string[];
  textRuns: A11yTextRun[];
  /** True when row 1 has no values but lower rows do. */
  headerRowEmpty: boolean;
  /** True when the sheet has any data at all. */
  hasData: boolean;
}

// -- Color contrast (WCAG 2.1) ------------------------------------------------

function parseCssColor(css: string): [number, number, number] | null {
  const t = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(t);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
    green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
    gray: [128, 128, 128], grey: [128, 128, 128],
  };
  return named[t] ?? null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two CSS colors; null when unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseCssColor(a);
  const cb = parseCssColor(b);
  if (!ca || !cb) return null;
  const l1 = luminance(ca);
  const l2 = luminance(cb);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// -- Scan ---------------------------------------------------------------------

export function checkAccessibility(model: A11yModel): A11yIssue[] {
  const issues: A11yIssue[] = [];
  for (const pic of model.pictures) {
    if (pic.alt.trim() === '') {
      issues.push({
        id: `alt-${pic.id}`,
        severity: 'error',
        rule: 'missing-alt-text',
        message: `Picture${pic.at ? ` at ${pic.at}` : ''} is missing alternate text. Screen readers will skip it.`,
        target: pic.at ?? pic.id,
        fix: { label: 'Add alt text', action: 'edit-alt-text' },
      });
    }
  }
  for (const chart of model.charts) {
    if (chart.title.trim() === '') {
      issues.push({
        id: `chartalt-${chart.id}`,
        severity: 'error',
        rule: 'missing-chart-alt',
        message: `Chart is missing a title. Screen readers announce charts by their title.`,
        target: chart.id,
        fix: { label: 'Add chart title', action: 'edit-chart-title' },
      });
    }
  }
  for (const range of model.mergedRanges) {
    issues.push({
      id: `merge-${range}`,
      severity: 'warning',
      rule: 'merged-cells',
      message: `Merged cells ${range}: screen readers may not read merged ranges reliably.`,
      target: range,
      fix: { label: 'Unmerge', action: 'unmerge' },
    });
  }
  for (const run of model.textRuns) {
    const ratio = contrastRatio(run.color, run.background);
    if (ratio !== null && ratio < 4.5) {
      issues.push({
        id: `contrast-${run.cell}`,
        severity: 'warning',
        rule: 'low-contrast',
        message: `Cell ${run.cell} has low text contrast (${ratio.toFixed(1)}:1; needs 4.5:1).`,
        target: run.cell,
        fix: { label: 'Use automatic color', action: 'fix-contrast' },
      });
    }
  }
  if (model.headerRowEmpty && model.hasData) {
    issues.push({
      id: 'headers-row1',
      severity: 'warning',
      rule: 'empty-header-row',
      message: `Row 1 of ${model.sheetName} is empty but data exists below — add header labels so screen readers can announce columns.`,
      target: '1:1',
      fix: { label: 'Go to row 1', action: 'add-headers' },
    });
  }
  // Default sheet names ("Sheet1", …) carry no meaning for screen-reader users
  // navigating by sheet. Warning only — renaming is not supported by the engine.
  if (/^sheet\d+$/i.test(model.sheetName.trim())) {
    issues.push({
      id: 'sheetname-default',
      severity: 'warning',
      rule: 'default-sheet-name',
      message: `Sheet "${model.sheetName}" has a default name. Give it a descriptive name so screen-reader users can find it.`,
      target: model.sheetName,
    });
  }
  return issues;
}
