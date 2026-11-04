#!/usr/bin/env node
/**
 * Build the fixed generated-app iframe stylesheet (Phase 1 design system).
 *
 * Compiles apps/web/src/components/artifact-iframe.css with the Tailwind
 * CLI (minified) into artifact-iframe.compiled.css in the same directory.
 * ArtifactHost imports the compiled file via ?raw and inlines it into the
 * iframe srcDoc. The compiled file is checked in so vite builds and
 * vitest runs work without running this script first; `npm run build`
 * regenerates it so production never serves a stale file.
 *
 * Fails closed: non-zero exit when the CLI binary is missing, the build
 * fails, or the output exceeds the 100 KB raw size budget.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE_BUDGET_BYTES = 100 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..');
const input = join(webDir, 'src', 'components', 'artifact-iframe.css');
const output = join(webDir, 'src', 'components', 'artifact-iframe.compiled.css');

// Resolve the CLI binary by walking up from this script (workspace root
// node_modules wins; fall back to the web package's own node_modules).
function findCli() {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'node_modules', '.bin', 'tailwindcss');
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const cli = findCli();
if (!cli) {
  console.error('build-iframe-css: tailwindcss CLI binary not found under node_modules/.bin');
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`build-iframe-css: missing input ${input}`);
  process.exit(1);
}
execFileSync(cli, ['-i', input, '-o', output, '--minify'], { cwd: webDir, stdio: 'inherit' });
const size = statSync(output).size;
console.log(`build-iframe-css: ${output} (${size} bytes)`);
if (size > SIZE_BUDGET_BYTES) {
  console.error(
    `build-iframe-css: iframe stylesheet ${size} bytes exceeds the ${SIZE_BUDGET_BYTES}-byte budget — trim the allow-list or DaisyUI theme set.`,
  );
  process.exit(1);
}
