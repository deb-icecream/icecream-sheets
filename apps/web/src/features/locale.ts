/**
 * Locale configuration for number/date/currency rendering.
 *
 * Date and currency rendering must respect the user's locale: USD ($1,234.00)
 * vs EUR (1.234,00 €), MM/DD/YYYY (US) vs DD/MM/YYYY (EU) vs YYYY-MM-DD (ISO).
 * The locale is a user-level setting (default en-US); rich types read it at
 * render time. An explicit per-cell/column/range currency symbol overrides
 * the locale default without changing the locale.
 */

export type DateOrder = 'MDY' | 'DMY' | 'YMD';

export interface LocaleConfig {
  /** BCP 47 tag, e.g. 'en-US'. */
  locale: string;
  /** ISO 4217 currency code, e.g. 'USD'. */
  currency: string;
  /** Symbol rendered for the currency, e.g. '$'. */
  currencySymbol: string;
  /** Whether the symbol goes before or after the number. */
  currencyPosition: 'before' | 'after';
  /** Decimal separator: '.' (en-US) or ',' (de-DE). */
  decimalSeparator: string;
  /** Thousands separator: ',' (en-US), '.' (de-DE), ' ' (fr-FR). */
  thousandsSeparator: string;
  /** Date component order. */
  dateOrder: DateOrder;
  /** Date separator: '/' (US), '.' (DE), '-' (ISO). */
  dateSeparator: string;
}

const PRESETS: Record<string, LocaleConfig> = {
  'en-US': {
    locale: 'en-US', currency: 'USD', currencySymbol: '$', currencyPosition: 'before',
    decimalSeparator: '.', thousandsSeparator: ',', dateOrder: 'MDY', dateSeparator: '/',
  },
  'en-GB': {
    locale: 'en-GB', currency: 'GBP', currencySymbol: '£', currencyPosition: 'before',
    decimalSeparator: '.', thousandsSeparator: ',', dateOrder: 'DMY', dateSeparator: '/',
  },
  'de-DE': {
    locale: 'de-DE', currency: 'EUR', currencySymbol: '€', currencyPosition: 'after',
    decimalSeparator: ',', thousandsSeparator: '.', dateOrder: 'DMY', dateSeparator: '.',
  },
  'fr-FR': {
    locale: 'fr-FR', currency: 'EUR', currencySymbol: '€', currencyPosition: 'after',
    decimalSeparator: ',', thousandsSeparator: ' ', dateOrder: 'DMY', dateSeparator: '/',
  },
  'ja-JP': {
    locale: 'ja-JP', currency: 'JPY', currencySymbol: '¥', currencyPosition: 'before',
    decimalSeparator: '.', thousandsSeparator: ',', dateOrder: 'YMD', dateSeparator: '/',
  },
  'iso': {
    locale: 'iso', currency: 'USD', currencySymbol: '$', currencyPosition: 'before',
    decimalSeparator: '.', thousandsSeparator: ',', dateOrder: 'YMD', dateSeparator: '-',
  },
};

export const LOCALE_PRESET_IDS = Object.keys(PRESETS);

/** Default locale: en-US. */
export const DEFAULT_LOCALE: LocaleConfig = PRESETS['en-US'];

/** Get a locale preset by id; falls back to en-US for unknown ids. */
export function getLocalePreset(id: string): LocaleConfig {
  return PRESETS[id] ?? PRESETS['en-US'];
}

/**
 * Format a number's MAGNITUDE with locale-aware separators (no sign).
 * E.g. 1234.56 → "1,234.56" (en-US) or "1.234,56" (de-DE).
 * Callers handle the sign via applyNegativeStyle.
 */
export function formatLocaleNumber(n: number, decimals: number, loc: LocaleConfig): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, fracPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, loc.thousandsSeparator);
  return grouped + (decimals > 0 ? loc.decimalSeparator + (fracPart ?? '') : '');
}

/** Format a currency value per locale (symbol position aware). */
export function formatLocaleCurrency(n: number, loc: LocaleConfig, symbol?: string): string {
  const sym = symbol ?? loc.currencySymbol;
  const body = formatLocaleNumber(n, 2, loc);
  // Negative accounting style handled by caller; here plain negative.
  return loc.currencyPosition === 'before' ? `${sym}${body}` : `${body} ${sym}`;
}

/** Format a date (y, m0-based, d) per locale date order. */
export function formatLocaleDate(y: number, m: number, d: number, loc: LocaleConfig): string {
  const mm = String(m + 1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const sep = loc.dateSeparator;
  switch (loc.dateOrder) {
    case 'DMY':
      return `${dd}${sep}${mm}${sep}${y}`;
    case 'YMD':
      return `${y}${sep}${mm}${sep}${dd}`;
    case 'MDY':
    default:
      return `${mm}${sep}${dd}${sep}${y}`;
  }
}
