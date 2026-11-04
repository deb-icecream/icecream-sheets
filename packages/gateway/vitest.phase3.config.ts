// TEMPORARY Phase 3 verification config (not part of the build): aliases
// @icecream-sheets/engine to its SOURCE because this VM's write mediation
// zeroed packages/engine/dist during a tsc emit attempt and subprocess
// writes are currently EPERM-blocked. Delete once dist is restored.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@icecream-sheets/engine': path.resolve(root, '../engine/src/index.ts'),
      hyperformula: path.resolve(root, '../../node_modules/hyperformula/commonjs/index.js'),
    },
  },
  test: { testTimeout: 30_000 },
});
