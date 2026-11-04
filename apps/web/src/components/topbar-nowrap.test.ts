// @vitest-environment node
/**
 * Top-bar no-wrap guard (owner directive 2026-10-25): the app header
 * (.app-header in index.css) must NEVER go multi-line — when the side
 * panel or an app narrows the main area, excess content is hidden, not
 * wrapped. Repro: at 820px with the panel open the header measured 61px
 * tall (two lines: brand, file name, and sign-in text all wrapped
 * internally); at 390px with the panel open it measured 165px, 245px
 * with an app open (the old @media wrap rule). The row is nowrap +
 * overflow hidden at every width, and direct children are nowrap too.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function css(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', 'index.css'), 'utf8');
}

function headerBlock(): string {
  const m = css().match(/\.app-header\s*\{([^}]*)\}/);
  if (!m) throw new Error('.app-header block not found in index.css');
  return m[1];
}

describe('top bar never wraps (owner directive 2026-10-25)', () => {
  it('is nowrap with hidden overflow at every width', () => {
    const block = headerBlock();
    expect(block).toMatch(/flex-wrap:\s*nowrap/);
    expect(block).toMatch(/overflow:\s*hidden/);
  });

  it('has no wrap rule for the header left anywhere (incl. media queries)', () => {
    expect(css()).not.toMatch(/\.app-header\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('keeps direct children on one line so text cannot wrap internally', () => {
    const m = css().match(/\.app-header\s*>\s*\*\s*\{([^}]*)\}/);
    if (!m) throw new Error('.app-header > * block not found in index.css');
    expect(m[1]).toMatch(/white-space:\s*nowrap/);
  });
});
