/**
 * Generate packages/service/src/inference/functions.generated.ts —
 * the static function-name catalog used by deterministic formula
 * autocomplete (design-docs/deterministic-inference.md §5).
 *
 * Sourced from the engine's versioned function registry
 * (packages/engine/src/function-registry.ts — design-docs/platform-shell.md
 * §5): importing the registry pulls in every HyperFormula function plugin
 * (built-ins + all custom extended/financial/lambda/cube plugins), so this
 * catalog is exactly the set of functions the engine can evaluate, with
 * registry-owned categories and signature hints. There are no
 * hand-maintained name lists here, and — unlike the previous version of
 * this script — categories are NOT parsed back out of the web app's
 * generated functionList.ts (that dependency was backwards: both generated
 * files derive from the registry now).
 *
 * Usage: node scripts/gen-function-catalog.mjs
 * (run from packages/service; requires packages/engine/dist built)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const outFile = resolve(pkgDir, 'src/inference/functions.generated.ts');

let registry;
try {
  registry = await import(resolve(pkgDir, '../engine/dist/function-registry.js'));
} catch (e) {
  console.error(
    'gen-function-catalog: cannot import the engine function registry — run `npm run build` in packages/engine first.',
  );
  throw e;
}
const { getFunctionRegistry, FUNCTION_REGISTRY_VERSION } = registry;
const entries = getFunctionRegistry();

const esc = (s) =>
  String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

const lines = [
  '/**',
  ' * GENERATED — do not edit by hand.',
  ' *',
  ' * Function-name catalog for deterministic formula autocomplete',
  ' * (design-docs/deterministic-inference.md §5). Generated from the engine',
  ' * versioned function registry (packages/engine/src/function-registry.ts)',
  ' * by scripts/gen-function-catalog.mjs: the registry enumerates the',
  ' * actual HyperFormula plugin registrations, so this list is exactly the',
  ' * set of functions the engine can evaluate.',
  ' */',
  '',
  'export interface FunctionCatalogEntry {',
  '  /** Uppercase function name, e.g. SUM. */',
  '  name: string;',
  '  /** Category for grouping in the autocomplete dropdown. */',
  '  category: string;',
  '  /** Short signature hint shown next to the name. */',
  '  signature: string;',
  '}',
  '',
  '/** Engine function-registry version this catalog was generated from. */',
  `export const FUNCTION_CATALOG_VERSION = ${FUNCTION_REGISTRY_VERSION} as const;`,
  '',
  'export const FUNCTION_CATALOG: readonly FunctionCatalogEntry[] = [',
];
for (const e of entries) {
  lines.push(`  { name: '${esc(e.name)}', category: '${esc(e.category)}', signature: '${esc(e.signature)}' },`);
}
lines.push('];', '');

writeFileSync(outFile, lines.join('\n'));
console.log(
  `gen-function-catalog: wrote ${outFile} (${entries.length} functions, registry v${FUNCTION_REGISTRY_VERSION})`,
);
