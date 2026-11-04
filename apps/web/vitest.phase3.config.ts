// TEMPORARY Phase 3 verification config (not part of the build): aliases
// @icecream-sheets/engine to its SOURCE because this VM's write mediation
// zeroed packages/engine/dist during a tsc emit attempt and subprocess
// writes (tsc/git/node) are currently EPERM-blocked, so dist cannot be
// rebuilt in-session. Delete once dist is restored.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@icecream-sheets\/engine$/,
        replacement: path.resolve(root, '../../packages/engine/src/index.ts'),
      },
      { find: /^hyperformula$/, replacement: 'hyperformula/es/index.js' },
      { find: /^hyperformula\/commonjs\/(.*)$/, replacement: 'hyperformula/es/$1' },
    ],
  },
});
