import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * HyperFormula ships dual builds (`main` = commonjs, `module` = es) with no
 * "exports" map. Plain Node ESM (production: `node dist/index.js`) resolves
 * the `main` entry for everyone, so the engine and this package share one
 * HyperFormula instance and one global function registry. Vite, however,
 * prefers the `module` entry for ESM imports, which would load a SECOND
 * HyperFormula copy in tests — and function plugins registered on one copy
 * are invisible to the other ("Function name ICEEVAL not recognized").
 *
 * This alias forces the production-consistent `commonjs` build everywhere.
 */
export default defineConfig({
  resolve: {
    alias: {
      hyperformula: path.resolve(root, '../../node_modules/hyperformula/commonjs/index.js'),
    },
  },
});
