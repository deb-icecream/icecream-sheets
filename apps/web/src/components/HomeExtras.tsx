/**
 * Extra Home-tab dialogs and option lists for icecream-sheets.
 *
 * These are wired into the ribbon/ribbon controls by the parent; they only
 * render UI and report results through callbacks. Dialog markup follows the
 * dialog-overlay / dialog / dialog-title / dialog-row / dialog-actions CSS
 * classes defined in index.css (same pattern as FormatDialogs.tsx).
 */
import { useState } from 'react';
import type { BorderStyle } from '../features/formatting';
import A11yDialog from './A11yDialog';

// ---------------------------------------------------------------------------
// Row height dialog
// ---------------------------------------------------------------------------

export interface RowHeightDialogProps {
  /** Currently active row height (used as the input default). */
  current: number;
  onClose: () => void;
  onApply: (height: number) => void;
}

export const MIN_ROW_HEIGHT = 5;
export const MAX_ROW_HEIGHT = 200;

export function RowHeightDialog({ current, onClose, onApply }: RowHeightDialogProps) {
  const [value, setValue] = useState(String(current));

  const parsed = Number(value);
  const valid =
    value.trim() !== '' && Number.isFinite(parsed) && parsed >= MIN_ROW_HEIGHT && parsed <= MAX_ROW_HEIGHT;

  return (
    <A11yDialog title={<>Row height</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Height ({MIN_ROW_HEIGHT}–{MAX_ROW_HEIGHT}):</span>
          <input
            autoFocus
            type="number"
            min={MIN_ROW_HEIGHT}
            max={MAX_ROW_HEIGHT}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button disabled={!valid} onClick={() => { onApply(parsed); onClose(); }}>
            Apply
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Column width dialog
// ---------------------------------------------------------------------------

export interface ColumnWidthDialogProps {
  /** Currently active column width (used as the input default). */
  current: number;
  onClose: () => void;
  onApply: (width: number) => void;
}

export const MIN_COLUMN_WIDTH = 20;
export const MAX_COLUMN_WIDTH = 400;

export function ColumnWidthDialog({ current, onClose, onApply }: ColumnWidthDialogProps) {
  const [value, setValue] = useState(String(current));

  const parsed = Number(value);
  const valid =
    value.trim() !== '' && Number.isFinite(parsed) && parsed >= MIN_COLUMN_WIDTH && parsed <= MAX_COLUMN_WIDTH;

  return (
    <A11yDialog title={<>Column width</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Width ({MIN_COLUMN_WIDTH}–{MAX_COLUMN_WIDTH}):</span>
          <input
            autoFocus
            type="number"
            min={MIN_COLUMN_WIDTH}
            max={MAX_COLUMN_WIDTH}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button disabled={!valid} onClick={() => { onApply(parsed); onClose(); }}>
            Apply
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Rename sheet dialog
// ---------------------------------------------------------------------------

export interface RenameSheetDialogProps {
  /** Current sheet name (used as the input default). */
  current: string;
  onClose: () => void;
  onApply: (name: string) => void;
}

export function RenameSheetDialog({ current, onClose, onApply }: RenameSheetDialogProps) {
  const [value, setValue] = useState(current);

  const valid = value.trim() !== '';

  return (
    <A11yDialog title={<>Rename sheet</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Name:</span>
          <input
            autoFocus
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Sheet name"
          />
        </label>
        <div className="dialog-actions">
          <button disabled={!valid} onClick={() => { onApply(value.trim()); onClose(); }}>
            Rename
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Home-tab option lists
// ---------------------------------------------------------------------------

export interface AutoSumFn {
  name: string;
  fn: string;
}

/** Functions offered by the AutoSum dropdown (the parent inserts the formula). */
export const AUTOSUM_FNS: AutoSumFn[] = [
  { name: 'Sum', fn: 'SUM' },
  { name: 'Average', fn: 'AVERAGE' },
  { name: 'Count Numbers', fn: 'COUNT' },
  { name: 'Max', fn: 'MAX' },
  { name: 'Min', fn: 'MIN' },
];

export interface AccountingCurrency {
  code: string;
  symbol: string;
  label: string;
}

/** Currency choices for the Accounting number-format dropdown. */
export const ACCOUNTING_CURRENCIES: AccountingCurrency[] = [
  { code: 'USD', symbol: '$', label: 'US Dollar' },
  { code: 'GBP', symbol: '£', label: 'British Pound' },
  { code: 'EUR', symbol: '€', label: 'Euro' },
  { code: 'JPY', symbol: '¥', label: 'Japanese Yen' },
  { code: 'CHF', symbol: 'CHF ', label: 'Swiss Franc' },
];

/** Border color swatches. The first entry means "no explicit color". */
export const BORDER_COLORS: string[] = [
  'Automatic',
  '#000000',
  '#FF0000',
  '#00B050',
  '#0070C0',
  '#FFC000',
  '#7030A0',
  '#FFFFFF',
  '#808080',
  '#404040',
];

export interface BorderStyleOption {
  id: BorderStyle;
  label: string;
}

/** Border line styles for the borders menu. */
export const BORDER_STYLES: BorderStyleOption[] = [
  { id: 'thin', label: 'Solid Thin' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
  { id: 'medium', label: 'Medium' },
  { id: 'thick', label: 'Thick' },
  { id: 'double', label: 'Double' },
];

export interface PasteSpecialItem {
  id: 'values' | 'formulas' | 'formats' | 'all';
  label: string;
  enabled: boolean;
  reason?: string;
}

/**
 * Paste Special options. Only "values" is implemented; the rest are listed
 * but disabled with an explanatory reason.
 */
export const PASTE_SPECIAL_ITEMS: PasteSpecialItem[] = [
  { id: 'values', label: 'Values', enabled: true },
  { id: 'formulas', label: 'Formulas', enabled: true },
  { id: 'formats', label: 'Formats', enabled: true },
  { id: 'all', label: 'All', enabled: true },
];
