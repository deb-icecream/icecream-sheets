/**
 * Tests for locale configuration (locale.ts).
 * Pure functions — no engine needed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  getLocalePreset,
  LOCALE_PRESET_IDS,
  formatLocaleNumber,
  formatLocaleCurrency,
  formatLocaleDate,
} from './locale';

describe('locale presets', () => {
  it('defaults to en-US', () => {
    expect(DEFAULT_LOCALE.locale).toBe('en-US');
    expect(DEFAULT_LOCALE.currencySymbol).toBe('$');
  });

  it('has all expected presets', () => {
    for (const id of ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'iso']) {
      expect(LOCALE_PRESET_IDS).toContain(id);
    }
  });

  it('falls back to en-US for unknown ids', () => {
    expect(getLocalePreset('xx-XX').locale).toBe('en-US');
  });

  it('de-DE uses EUR after the number with comma decimals', () => {
    const de = getLocalePreset('de-DE');
    expect(de.currency).toBe('EUR');
    expect(de.currencySymbol).toBe('€');
    expect(de.currencyPosition).toBe('after');
    expect(de.decimalSeparator).toBe(',');
    expect(de.thousandsSeparator).toBe('.');
    expect(de.dateOrder).toBe('DMY');
  });
});

describe('formatLocaleNumber', () => {
  it('formats en-US with comma thousands and dot decimals', () => {
    const us = getLocalePreset('en-US');
    expect(formatLocaleNumber(1234567.891, 2, us)).toBe('1,234,567.89');
  });

  it('formats de-DE with dot thousands and comma decimals', () => {
    const de = getLocalePreset('de-DE');
    expect(formatLocaleNumber(1234567.891, 2, de)).toBe('1.234.567,89');
  });

  it('formats fr-FR with space thousands', () => {
    const fr = getLocalePreset('fr-FR');
    expect(formatLocaleNumber(1234567.891, 2, fr)).toBe('1 234 567,89');
  });

  it('returns magnitude without sign', () => {
    const us = getLocalePreset('en-US');
    expect(formatLocaleNumber(-1234.5, 2, us)).toBe('1,234.50');
  });
});

describe('formatLocaleCurrency', () => {
  it('places $ before for en-US', () => {
    const us = getLocalePreset('en-US');
    expect(formatLocaleCurrency(1234.5, us)).toBe('$1,234.50');
  });

  it('places € after for de-DE', () => {
    const de = getLocalePreset('de-DE');
    expect(formatLocaleCurrency(1234.5, de)).toBe('1.234,50 €');
  });

  it('uses explicit symbol override', () => {
    const us = getLocalePreset('en-US');
    expect(formatLocaleCurrency(1234.5, us, '£')).toBe('£1,234.50');
  });
});

describe('formatLocaleDate', () => {
  it('formats MDY for en-US', () => {
    const us = getLocalePreset('en-US');
    expect(formatLocaleDate(2023, 0, 15, us)).toBe('01/15/2023');
  });

  it('formats DMY for de-DE', () => {
    const de = getLocalePreset('de-DE');
    expect(formatLocaleDate(2023, 0, 15, de)).toBe('15.01.2023');
  });

  it('formats YMD for iso', () => {
    const iso = getLocalePreset('iso');
    expect(formatLocaleDate(2023, 0, 15, iso)).toBe('2023-01-15');
  });
});
