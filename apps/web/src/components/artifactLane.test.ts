// @vitest-environment node
/**
 * #145 regression guard: the generated-app artifact lane (.agent-artifact
 * in index.css) must keep a readable width floor. It used to be
 * `flex: 0 1 560px; min-width: 0`, which let the grid squeeze it to a
 * 161px strip — a dashboard app rendered in 161px is unreadable. The
 * lane keeps basis 560px and a min-width floor of at least 420px
 * (currently min(480px, 60vw)); the grid absorbs the shrink instead.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function artifactBlock(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, '..', 'index.css'), 'utf8');
  const m = css.match(/\.agent-artifact\s*\{([^}]*)\}/);
  if (!m) throw new Error('.agent-artifact block not found in index.css');
  return m[1];
}

describe('artifact lane width floor (#145)', () => {
  it('keeps a 560px basis and a min-width floor of at least 420px', () => {
    const block = artifactBlock();
    expect(block).toMatch(/flex:\s*1\s+1\s+560px/);
    const mw = block.match(/min-width:\s*min\((\d+)px/);
    expect(mw).not.toBeNull();
    expect(Number(mw![1])).toBeGreaterThanOrEqual(420);
  });
});
