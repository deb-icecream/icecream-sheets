import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

// Same HyperFormula dual-build alias as packages/mcp-server/vitest.config.ts:
// forces the production-consistent commonjs build so the engine, the MCP
// server, and the tests share one HyperFormula instance and one global
// function registry.
export default defineConfig({
  resolve: {
    alias: {
      hyperformula: path.resolve(root, '../../node_modules/hyperformula/commonjs/index.js'),
    },
  },
  test: {
    testTimeout: 30_000,
  },
});
