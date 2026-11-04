/**
 * Phase 1 design-system tests: the compiled iframe stylesheet (Tailwind +
 * DaisyUI) stays within budget, carries the vocabulary, and reaches the
 * iframe document with the host theme.
 *
 * The stylesheet is read from disk (not via ?raw import): vitest's CSS
 * handling returns an empty module for ?raw CSS imports, while the real
 * vite build inlines it — the bundle check below (web build) proves the
 * ?raw path separately.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildArtifactSrcDoc, IFRAME_THEME_MAP } from './artifactFrame';

const iframeCss = readFileSync(new URL('./artifact-iframe.compiled.css', import.meta.url), 'utf-8');

const SIZE_BUDGET_BYTES = 100 * 1024;
const RUNTIME = { reactUmd: '/*react*/', reactDomUmd: '/*react-dom*/' };
const SOURCE = 'function App() { return null; }';

describe('iframe design stylesheet budget', () => {
  it('stays within the 100 KB raw budget', () => {
    expect(iframeCss.length).toBeGreaterThan(0);
    expect(iframeCss.length).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });

  it('carries the DaisyUI vocabulary + both themes', () => {
    for (const cls of ['.btn', '.btn-primary', '.card', '.card-body', '.stats', '.stat-value', '.table', '.table-zebra', '.input', '.badge', '.alert', '.alert-error']) {
      expect(iframeCss).toContain(cls);
    }
    expect(iframeCss).toContain('icecream-light');
    expect(iframeCss).toContain('icecream-dark');
  });

  it('cannot break out of the srcDoc style/script blocks', () => {
    expect(iframeCss).not.toContain('</style');
    expect(iframeCss).not.toContain('</script');
  });
});

describe('buildArtifactSrcDoc design-system wiring', () => {
  it('inlines the stylesheet and maps the host theme', () => {
    const doc = buildArtifactSrcDoc(SOURCE, RUNTIME, 'App', undefined, {
      css: iframeCss,
      theme: 'dark',
    });
    expect(doc).toContain('data-theme="icecream-dark"');
    expect(doc).toContain('.btn');
  });

  it('defaults to the light theme with no stylesheet', () => {
    const doc = buildArtifactSrcDoc(SOURCE, RUNTIME, 'App');
    expect(doc).toContain('data-theme="icecream-light"');
    expect(doc).not.toContain('.btn-primary');
  });

  it('maps both host themes', () => {
    expect(IFRAME_THEME_MAP).toEqual({ light: 'icecream-light', dark: 'icecream-dark' });
  });
});
