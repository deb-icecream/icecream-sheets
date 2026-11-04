import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME,
  customizeTheme,
  themeAccentColors,
  themeChartPalette,
  themeFontForCell,
  themeFromMetadata,
  themeToMetadata,
  THEME_METADATA_KEY,
} from './themes';

describe('built-in themes', () => {
  it('ships a non-empty gallery with 12-color sets', () => {
    expect(BUILT_IN_THEMES.length).toBeGreaterThanOrEqual(6);
    for (const t of BUILT_IN_THEMES) {
      expect(t.colors.colors).toHaveLength(12);
      expect(t.fonts.heading).toBeTruthy();
      expect(t.fonts.body).toBeTruthy();
    }
  });

  it('defaults to the Office theme', () => {
    expect(DEFAULT_THEME.name).toBe('Office');
  });
});

describe('theme metadata persistence', () => {
  it('round-trips through metadata', () => {
    const back = themeFromMetadata(themeToMetadata(BUILT_IN_THEMES[3]));
    expect(back).toEqual(BUILT_IN_THEMES[3]);
  });

  it('rejects malformed metadata', () => {
    expect(themeFromMetadata(null)).toBeNull();
    expect(themeFromMetadata({ name: 'x' })).toBeNull();
    expect(
      themeFromMetadata({ name: 'x', colors: { name: 'c', colors: ['#000'] }, fonts: { name: 'f', heading: 'a', body: 'b' }, effects: { name: 'e' } }),
    ).toBeNull();
  });

  it('uses a stable metadata key', () => {
    expect(THEME_METADATA_KEY).toBe('icecream.theme');
  });
});

describe('theme application helpers', () => {
  it('exposes the 6 accent colors', () => {
    expect(themeAccentColors(DEFAULT_THEME)).toHaveLength(6);
    expect(themeAccentColors(DEFAULT_THEME)[0]).toBe('#2e75b6');
  });

  it('builds a chart palette with translucent backgrounds', () => {
    const pal = themeChartPalette(DEFAULT_THEME);
    expect(pal.background).toHaveLength(6);
    expect(pal.border).toHaveLength(6);
    expect(pal.background[0].endsWith('b3')).toBe(true);
  });

  it('maps the body font onto cell formats', () => {
    expect(themeFontForCell(DEFAULT_THEME)).toEqual({ fontName: 'Calibri' });
  });
});

describe('customizeTheme', () => {
  it('overrides accents and renames the theme', () => {
    const custom = customizeTheme(DEFAULT_THEME, {
      name: 'Brand',
      colors: { name: 'Brand colors', colors: Array(12).fill('#123456') },
      fonts: { body: 'Inter' },
    });
    expect(custom.name).toBe('Brand');
    expect(custom.colors.colors.every((c) => c === '#123456')).toBe(true);
    expect(custom.fonts.body).toBe('Inter');
    expect(custom.fonts.heading).toBe('Calibri Light');
  });

  it('rejects color sets that are not 12 long', () => {
    expect(() => customizeTheme(DEFAULT_THEME, { colors: { colors: ['#000'] } })).toThrow();
  });
});
