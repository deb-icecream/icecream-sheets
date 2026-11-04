/**
 * Generate apps/web/src/features/functionList.ts from the engine's
 * versioned function registry (design-docs/platform-shell.md §5).
 *
 * The registry (packages/engine/src/function-registry.ts) enumerates the
 * actual HyperFormula plugin registrations — built-ins + every engine
 * plugin batch — so the emitted list is exactly the set of functions the
 * engine can evaluate. Never hand-edit the output: rerun this script.
 *
 * Usage: node scripts/gen-function-list.mjs [--out <path>]
 *   (run from packages/engine; requires packages/engine/dist built)
 *   Default output: apps/web/src/features/functionList.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');

let outFile = resolve(pkgDir, '../../apps/web/src/features/functionList.ts');
const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0) {
  if (!process.argv[outIdx + 1]) {
    console.error('gen-function-list: --out requires a path');
    process.exit(1);
  }
  outFile = resolve(process.cwd(), process.argv[outIdx + 1]);
}

// Importing the registry pulls in ./plugins.js, registering every engine
// plugin batch with HyperFormula (built dist required).
const registryPath = resolve(pkgDir, 'dist/function-registry.js');
let registry;
try {
  registry = await import(registryPath);
} catch (e) {
  console.error(
    `gen-function-list: cannot import ${registryPath} — run 'npm run build' in packages/engine first.`,
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
  ' * Function inventory for the Insert Function dialog and the Help-pane',
  ' * function reference (design-docs/platform-shell.md §5). Generated from',
  ' * the engine versioned function registry',
  ' * (packages/engine/src/function-registry.ts), which enumerates the actual',
  ' * HyperFormula plugin registrations — built-ins + every engine plugin',
  ' * batch — so this list is exactly the set of functions the engine can',
  ' * evaluate. Regenerate: `node scripts/gen-function-list.mjs` (run from',
  ' * packages/engine; requires packages/engine/dist built).',
  ' *',
  ` * Registry version: ${FUNCTION_REGISTRY_VERSION}.`,
  ' */',
  '',
  'export interface FunctionInfo {',
  '  /** Uppercase function name, e.g. SUM. */',
  '  name: string;',
  '  /** Excel-style category for grouping. */',
  '  category: string;',
  '  /** Per-function semantic version from the engine registry. */',
  '  version: number;',
  "  /** Argument hint, e.g. 'SUM(number1, [number2], …)'. */",
  '  signature: string;',
  '  /** One-line description. */',
  '  description: string;',
  '}',
  '',
  '/**',
  ' * Registry version this list was generated from. The web app compares it',
  " * against the engine's FUNCTION_REGISTRY_VERSION at runtime",
  ' * (see ./functions.ts isFunctionListStale()) to detect stale lists.',
  ' */',
  `export const FUNCTION_LIST_VERSION = ${FUNCTION_REGISTRY_VERSION} as const;`,
  '',
  'export const ALL_FUNCTIONS: FunctionInfo[] = [',
];
for (const e of entries) {
  lines.push(
    `  { name: '${esc(e.name)}', category: '${esc(e.category)}', version: ${e.version}, signature: '${esc(e.signature)}', description: '${esc(e.description)}' },`,
  );
}
lines.push('];', '');

writeFileSync(outFile, lines.join('\n'));
console.log(
  `gen-function-list: wrote ${outFile} (${entries.length} functions, registry v${FUNCTION_REGISTRY_VERSION})`,
);
