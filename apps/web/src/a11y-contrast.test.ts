/**
 * Contrast assertions (design-docs/accessibility.md §2.6, §5.1).
 *
 * Every text/background pair used by the app chrome must meet WCAG 2.2 AA:
 * >= 4.5:1 for normal text, >= 3:1 for large text (>= 18pt) and focus
 * indicators. The pairs below are enumerated from apps/web/src/index.css
 * and the component inline styles; add new pairs here when new chrome
 * colors are introduced.
 */
import { describe, expect, it } from 'vitest';

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

interface Pair {
  name: string;
  fg: string;
  bg: string;
  min: number;
}

const PAIRS: Pair[] = [
  { name: 'body text', fg: '#1c2530', bg: '#f4f6f8', min: 4.5 },
  { name: 'muted text on app bg', fg: '#64707d', bg: '#f4f6f8', min: 4.5 },
  { name: 'muted text on white', fg: '#64707d', bg: '#ffffff', min: 4.5 },
  { name: 'dialog tab', fg: '#555555', bg: '#ffffff', min: 4.5 },
  { name: 'dialog tab active', fg: '#217346', bg: '#ffffff', min: 4.5 },
  { name: 'dialog hint', fg: '#6e6e6e', bg: '#ffffff', min: 4.5 },
  { name: 'dialog close', fg: '#475569', bg: '#ffffff', min: 4.5 },
  { name: 'dialog close hover', fg: '#0f172a', bg: '#f1f5f9', min: 4.5 },
  { name: 'audit empty/seq text', fg: '#767676', bg: '#ffffff', min: 4.5 },
  { name: 'skip link', fg: '#ffffff', bg: '#1d4ed8', min: 4.5 },
  { name: 'status error', fg: '#b91c1c', bg: '#ffffff', min: 4.5 },
  { name: 'secondary text #666', fg: '#666666', bg: '#ffffff', min: 4.5 },
  { name: 'focus ring vs white', fg: '#2563eb', bg: '#ffffff', min: 3 },
];

describe('WCAG 2.2 AA contrast', () => {
  for (const p of PAIRS) {
    it(`${p.name}: ${p.fg} on ${p.bg} >= ${p.min}:1`, () => {
      const r = ratio(p.fg, p.bg);
      expect(r, `${p.name} contrast ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(p.min);
    });
  }
});
