/**
 * Filled Map (choropleth) geometry — the map-geometry provider that makes
 * `map-filled` a real renderable chart kind (user demand: 100% Excel parity
 * on diagrams, no out-of-scope kinds).
 *
 * - Boundaries come from the bundled WORLD_COUNTRIES (world-atlas 110m,
 *   simplified to 0.1°); no network, no map-geometry service dependency.
 * - Country lookup accepts display names, common aliases, ISO alpha-2,
 *   alpha-3 and numeric codes (case-insensitive).
 * - Rendering is pure SVG via an equirectangular projection, so the map is
 *   fully unit-testable in node and the web UI just injects the string.
 *
 * Data convention (Excel's filled map): the first text column is the
 * geography (country/region label), the first numeric column is the value.
 * Unmatched labels are listed, not silently dropped, so the caller can
 * surface them.
 */

import { WORLD_COUNTRIES, type WorldCountry } from './worldGeo.js';
import { lerpColor, type ChartSeries } from './chartModel.js';

/** Light -> dark sequential scale, matching the product's blue ramp. */
export const MAP_LOW_COLOR = '#DCE9F7';
export const MAP_HIGH_COLOR = '#1F4E79';
/** Fill for countries with no data, and for unmatched labels (never rendered). */
export const MAP_NO_DATA_COLOR = '#E8E8E8';

/** Common aliases -> natural-earth name or ISO alpha-2, lower-cased keys. */
const ALIASES: Record<string, string> = {
  usa: 'us',
  'u.s.a.': 'us',
  'u.s.': 'us',
  'united states': 'us',
  uk: 'gb',
  'u.k.': 'gb',
  'great britain': 'gb',
  england: 'gb',
  russia: 'ru',
  'russian federation': 'ru',
  'south korea': 'kr',
  'republic of korea': 'kr',
  'north korea': 'kp',
  "dprk": 'kp',
  "d.p.r.k.": 'kp',
  iran: 'ir',
  venezuela: 've',
  bolivia: 'bo',
  tanzania: 'tz',
  'united republic of tanzania': 'tz',
  syria: 'sy',
  vietnam: 'vn',
  'viet nam': 'vn',
  moldova: 'md',
  macedonia: 'mk',
  'north macedonia': 'mk',
  czechia: 'cz',
  'czech republic': 'cz',
  eswatini: 'sz',
  swaziland: 'sz',
  laos: 'la',
  'lao pdr': 'la',
  brunei: 'bn',
  turkey: 'tr',
  türkiye: 'tr',
  'cape verde': 'cv',
  'cabo verde': 'cv',
  'ivory coast': 'ci',
  "côte d'ivoire": 'ci',
  'cote divoire': 'ci',
  'democratic republic of the congo': 'cd',
  'democratic republic of congo': 'cd',
  'dr congo': 'cd',
  drc: 'cd',
  'republic of the congo': 'cg',
  'republic of congo': 'cg',
  bosnia: 'ba',
  'bosnia and herzegovina': 'ba',
  'bosnia-herzegovina': 'ba',
  'central african republic': 'cf',
  car: 'cf',
  'dominican republic': 'do',
  'dominican rep.': 'do',
  'el salvador': 'sv',
  'equatorial guinea': 'gq',
  'sao tome and principe': 'st',
  'são tomé and príncipe': 'st',
  'sierra leone': 'sl',
  'south sudan': 'ss',
  's. sudan': 'ss',
  'saint helena': 'sh',
  'st. helena': 'sh',
  'w. sahara': 'eh',
  'western sahara': 'eh',
  'puerto rico': 'pr',
  'new caledonia': 'nc',
  'fr. s. antarctic lands': 'tf',
  'french southern and antarctic lands': 'tf',
  'norfolk island': 'nf',
  'christmas island': 'cx',
  'cocos islands': 'cc',
  'british indian ocean territory': 'io',
  'u.s. virgin islands': 'vi',
  'us virgin islands': 'vi',
  'british virgin islands': 'vg',
  'falkland islands': 'fk',
  'south georgia and the south sandwich islands': 'gs',
  's. georgia and s. sandwich is.': 'gs',
};

const byName = new Map<string, WorldCountry>();
const byA2 = new Map<string, WorldCountry>();
const byA3 = new Map<string, WorldCountry>();
const byNum = new Map<string, WorldCountry>();
for (const c of WORLD_COUNTRIES) {
  byName.set(c.n.toLowerCase(), c);
  if (c.a2) byA2.set(c.a2.toLowerCase(), c);
  if (c.a3) byA3.set(c.a3.toLowerCase(), c);
  if (c.num) byNum.set(c.num, c);
}

/**
 * Resolve a user label to a country: exact name, alias, ISO alpha-2,
 * alpha-3 or numeric code. Returns null when nothing matches.
 */
export function resolveCountry(label: string): WorldCountry | null {
  const key = label.trim().toLowerCase();
  if (key === '') return null;
  const direct =
    byName.get(key) ?? byA2.get(key) ?? byA3.get(key) ?? byNum.get(key.padStart(3, '0'));
  if (direct) return direct;
  const alias = ALIASES[key];
  if (alias) {
    return (
      byA2.get(alias) ?? byA3.get(alias) ?? byName.get(alias) ?? null
    );
  }
  return null;
}

export interface MapRegion {
  country: WorldCountry;
  /** The label as given in the data (for tooltips). */
  label: string;
  value: number | null;
  /** Fill color after color scaling (MAP_NO_DATA_COLOR when value is null). */
  fill: string;
}

export interface MapData {
  regions: MapRegion[];
  /** Labels that did not resolve to any country. */
  unmatched: string[];
  min: number;
  max: number;
}

/**
 * Build a linear sequential color scale over [min, max]. Values outside
 * clamp; when min === max every value gets the high color.
 */
export function mapColorScale(min: number, max: number): (value: number) => string {
  const span = max - min;
  return (value: number): string => {
    const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (value - min) / span));
    // Uppercase to match the MAP_*_COLOR constants exactly.
    return lerpColor(MAP_LOW_COLOR, MAP_HIGH_COLOR, t).toUpperCase();
  };
}

/**
 * Map an extracted chart series to countries. Uses the first numeric
 * dataset as values; labels are geography names/codes.
 */
export function mapSeriesToCountries(series: ChartSeries): MapData {
  const dataset = series.datasets[0];
  const values = dataset ? dataset.data : [];
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const min = nums.length > 0 ? Math.min(...nums) : 0;
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  const scale = mapColorScale(min, max);
  const regions: MapRegion[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  series.labels.forEach((label, i) => {
    const country = resolveCountry(label);
    if (!country) {
      if (!seen.has(label)) {
        seen.add(label);
        unmatched.push(label);
      }
      return;
    }
    if (seen.has(country.num)) return; // first occurrence wins
    seen.add(country.num);
    const raw = values[i];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    regions.push({
      country,
      label,
      value,
      fill: value === null ? MAP_NO_DATA_COLOR : scale(value),
    });
  });
  return { regions, unmatched, min, max };
}

/** Equirectangular projection: lon/lat -> SVG x/y. */
export function projectLonLat(lon: number, lat: number, w: number, h: number): [number, number] {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}

/** A country's polygons as SVG path data (all rings concatenated). */
export function countryPathData(country: WorldCountry, w: number, h: number): string {
  const parts: string[] = [];
  for (const ring of country.p) {
    for (let i = 0; i < ring.length; i += 2) {
      const [x, y] = projectLonLat(ring[i] ?? 0, ring[i + 1] ?? 0, w, h);
      parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    parts.push('Z');
  }
  return parts.join(' ');
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface MapSvgOptions {
  width: number;
  height: number;
  /** Draw country borders. */
  borders?: boolean;
  /** Extra label under the map (e.g. unmatched warnings are the caller's job). */
  title?: string;
}

/**
 * Render the full filled-map SVG: every bundled country as a path (data
 * countries get their scaled fill, the rest MAP_NO_DATA_COLOR), plus a
 * gradient legend. Pure string — no DOM.
 */
export function buildMapSvg(data: MapData, opts: MapSvgOptions): string {
  const { width: w, height: h, borders = true, title = '' } = opts;
  const byNum = new Map(data.regions.map((r) => [r.country.num, r]));
  const paths: string[] = [];
  for (const c of WORLD_COUNTRIES) {
    const region = byNum.get(c.num);
    const fill = region ? region.fill : MAP_NO_DATA_COLOR;
    const tip = region
      ? `${region.label}: ${region.value === null ? 'no data' : region.value}`
      : c.n;
    paths.push(
      `<path d="${countryPathData(c, w, h)}" fill="${fill}"` +
        (borders ? ' stroke="#ffffff" stroke-width="0.4"' : '') +
        `><title>${escXml(tip)}</title></path>`,
    );
  }
  // Gradient legend.
  const legendY = h - 18;
  const legendX = 12;
  const legendW = Math.min(220, w - 24);
  const legend = [
    `<defs><linearGradient id="icecream-map-scale" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="${MAP_LOW_COLOR}"/>`,
    `<stop offset="1" stop-color="${MAP_HIGH_COLOR}"/>`,
    `</linearGradient></defs>`,
    `<rect x="${legendX}" y="${legendY}" width="${legendW}" height="8" fill="url(#icecream-map-scale)" rx="2"/>`,
    `<text x="${legendX}" y="${legendY - 4}" font-size="10" fill="#555">${escXml(String(data.min))}</text>`,
    `<text x="${legendX + legendW}" y="${legendY - 4}" font-size="10" fill="#555" text-anchor="end">${escXml(String(data.max))}</text>`,
  ].join('');
  const titleSvg = title
    ? `<text x="${w / 2}" y="16" font-size="13" text-anchor="middle" fill="#222">${escXml(title)}</text>`
    : '';
  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escXml(title || 'Filled map')}">` +
    titleSvg +
    paths.join('') +
    legend +
    `</svg>`
  );
}
