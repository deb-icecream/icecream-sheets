/**
 * Workbook themes (Page Layout > Themes).
 *
 * A theme is a named triple: a 12-slot color set (4 text/background +
 * 8 accents… Excel uses 2 text/bg pairs + 6 accents; we keep 4 + 6 and two
 * hyperlink colors = 12), a heading/body font pair, and an effect style.
 * The active theme persists in workbook metadata (`icecream.theme`) and is
 * applied to cell styles and chart palettes through the helpers below.
 */

export interface ThemeColorSet {
  name: string;
  /** 12 colors: [dark1, light1, dark2, light2, accent1..6, hyperlink, followedHyperlink]. */
  colors: string[];
}

export interface ThemeFontPair {
  name: string;
  heading: string;
  body: string;
}

export interface ThemeEffectSet {
  name: string;
  /** Bevel/line treatment for shapes and chart elements. */
  lineStyle: 'subtle' | 'moderate' | 'intense';
  shadow: boolean;
}

export interface WorkbookTheme {
  name: string;
  colors: ThemeColorSet;
  fonts: ThemeFontPair;
  effects: ThemeEffectSet;
}

export const THEME_METADATA_KEY = 'icecream.theme';

function colorSet(name: string, colors: string[]): ThemeColorSet {
  if (colors.length !== 12) throw new Error(`color set ${name} needs exactly 12 colors`);
  return { name, colors };
}

/** Built-in theme gallery (mirrors Excel's theme names). */
export const BUILT_IN_THEMES: WorkbookTheme[] = [
  {
    name: 'Office',
    colors: colorSet('Office', [
      '#000000', '#ffffff', '#1f3864', '#d9d9d9',
      '#2e75b6', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Office', heading: 'Calibri Light', body: 'Calibri' },
    effects: { name: 'Office', lineStyle: 'subtle', shadow: false },
  },
  {
    name: 'Facet',
    colors: colorSet('Facet', [
      '#000000', '#ffffff', '#2e2e2e', '#e7e6e6',
      '#00b0f0', '#92d050', '#ffc000', '#ff0000', '#7030a0', '#00b050',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Facet', heading: 'Trebuchet MS', body: 'Trebuchet MS' },
    effects: { name: 'Facet', lineStyle: 'moderate', shadow: true },
  },
  {
    name: 'Integral',
    colors: colorSet('Integral', [
      '#111111', '#ffffff', '#404040', '#d0cece',
      '#4f81bd', '#c0504d', '#9bbb59', '#8064a2', '#4bacc6', '#f79646',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Integral', heading: 'Calibri', body: 'Calibri' },
    effects: { name: 'Integral', lineStyle: 'subtle', shadow: false },
  },
  {
    name: 'Ion',
    colors: colorSet('Ion', [
      '#0f0f0f', '#ffffff', '#595959', '#d9d9d9',
      '#255e13', '#5a7d1e', '#a3a341', '#c55a11', '#2e75b6', '#8e7cc3',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Ion', heading: 'Calibri', body: 'Calibri' },
    effects: { name: 'Ion', lineStyle: 'intense', shadow: true },
  },
  {
    name: 'Organic',
    colors: colorSet('Organic', [
      '#000000', '#ffffff', '#3a3a3a', '#e2e2e2',
      '#7f6000', '#9c5700', '#b45f06', '#78350f', '#38761d', '#134f5c',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Organic', heading: 'Garamond', body: 'Garamond' },
    effects: { name: 'Organic', lineStyle: 'subtle', shadow: false },
  },
  {
    name: 'Retrospect',
    colors: colorSet('Retrospect', [
      '#000000', '#ffffff', '#404040', '#bfbfbf',
      '#808080', '#404040', '#c00000', '#bf8f00', '#4f81bd', '#9bbb59',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Retrospect', heading: 'Calibri', body: 'Calibri' },
    effects: { name: 'Retrospect', lineStyle: 'moderate', shadow: false },
  },
  {
    name: 'Slice',
    colors: colorSet('Slice', [
      '#000000', '#ffffff', '#262626', '#d9d9d9',
      '#e81123', '#ff8c00', '#ffb900', '#bad80a', '#00b7c3', '#0078d4',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Slice', heading: 'Calibri Light', body: 'Calibri' },
    effects: { name: 'Slice', lineStyle: 'intense', shadow: true },
  },
  {
    name: 'Wisp',
    colors: colorSet('Wisp', [
      '#000000', '#ffffff', '#595959', '#f2f2f2',
      '#82b366', '#d6b656', '#b85450', '#9673a6', '#5496cf', '#e2a266',
      '#0563c1', '#954f72',
    ]),
    fonts: { name: 'Wisp', heading: 'Century Gothic', body: 'Century Gothic' },
    effects: { name: 'Wisp', lineStyle: 'subtle', shadow: false },
  },
];

export const DEFAULT_THEME: WorkbookTheme = BUILT_IN_THEMES[0];

export function themeToMetadata(theme: WorkbookTheme): unknown {
  return JSON.parse(JSON.stringify(theme)) as unknown;
}

export function themeFromMetadata(meta: unknown): WorkbookTheme | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const r = meta as Record<string, unknown>;
  const colors = r.colors as { name?: unknown; colors?: unknown } | undefined;
  const fonts = r.fonts as { name?: unknown; heading?: unknown; body?: unknown } | undefined;
  const effects = r.effects as { name?: unknown; lineStyle?: unknown; shadow?: unknown } | undefined;
  if (
    typeof r.name !== 'string' ||
    !colors ||
    typeof colors.name !== 'string' ||
    !Array.isArray(colors.colors) ||
    colors.colors.length !== 12 ||
    !colors.colors.every((c) => typeof c === 'string') ||
    !fonts ||
    typeof fonts.name !== 'string' ||
    typeof fonts.heading !== 'string' ||
    typeof fonts.body !== 'string' ||
    !effects ||
    typeof effects.name !== 'string'
  ) {
    return null;
  }
  return {
    name: r.name,
    colors: { name: colors.name, colors: colors.colors as string[] },
    fonts: { name: fonts.name, heading: fonts.heading, body: fonts.body },
    effects: {
      name: effects.name,
      lineStyle: effects.lineStyle === 'moderate' || effects.lineStyle === 'intense' ? effects.lineStyle : 'subtle',
      shadow: effects.shadow === true,
    },
  };
}

/** The 6 accent colors — the working palette for charts and cell fills. */
export function themeAccentColors(theme: WorkbookTheme): string[] {
  return theme.colors.colors.slice(4, 10);
}

/** Build a customized theme from a built-in base with overrides. */
export function customizeTheme(
  base: WorkbookTheme,
  overrides: {
    name?: string;
    colors?: Partial<Pick<ThemeColorSet, 'name' | 'colors'>>;
    fonts?: Partial<ThemeFontPair>;
    effects?: Partial<ThemeEffectSet>;
  },
): WorkbookTheme {
  const colors = overrides.colors?.colors;
  if (colors && colors.length !== 12) throw new Error('custom color set needs exactly 12 colors');
  return {
    name: overrides.name ?? `Custom (${base.name})`,
    colors: {
      name: overrides.colors?.name ?? `${base.colors.name} (custom)`,
      colors: colors ?? [...base.colors.colors],
    },
    fonts: { ...base.fonts, ...overrides.fonts },
    effects: { ...base.effects, ...overrides.effects },
  };
}

/**
 * Apply the theme's body font to a cell format patch: the App calls this
 * when the theme changes so new/updated cell styles pick up theme fonts.
 */
export function themeFontForCell(theme: WorkbookTheme): { fontName: string } {
  return { fontName: theme.fonts.body };
}

/** Chart.js-friendly palette derived from the theme accents. */
export function themeChartPalette(theme: WorkbookTheme): { background: string[]; border: string[] } {
  const accents = themeAccentColors(theme);
  return { background: accents.map((c) => c + 'b3'), border: accents };
}
