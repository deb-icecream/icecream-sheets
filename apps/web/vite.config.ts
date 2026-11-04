import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Use HyperFormula's ESM build in the web bundle. The CommonJS build's
      // TypeScript enums (e.g. Cell.ErrorType) break under Vite/Rollup's
      // CommonJS transform (tree-shaken to `void 0`), crashing
      // TranslationPackage.checkErrors() at startup.
      { find: /^hyperformula$/, replacement: 'hyperformula/es/index.js' },
      { find: /^hyperformula\/commonjs\/(.*)$/, replacement: 'hyperformula/es/$1' },
    ],
  },
  // Relative asset paths: the desktop shell loads the built index.html via
  // file://, where absolute "/assets/..." URLs would resolve to the
  // filesystem root and 404. Relative paths work in both browser and
  // Electron.
  base: './',
  worker: {
    // The parallel-recalc worker (new URL(..., import.meta.url)) must be
    // emitted as ES modules: Vite's default iife worker format is rejected
    // for code-splitting builds ("Invalid value iife for option
    // output.format").
    format: 'es',
  },
  optimizeDeps: {
    // Pre-bundle the linked workspace packages for `vite dev`.
    include: [
      '@icecream-sheets/engine',
      '@icecream-sheets/xlsx-adapter',
      '@icecream-sheets/csv-adapter',
      '@icecream-sheets/ods-adapter',
      'hyperformula',
      'hyperformula/commonjs/i18n/languages/enGB.js',
      'hyperformula/commonjs/i18n/languages/enUS.js',
      'hyperformula/commonjs/i18n/languages/esES.js',
      'hyperformula/commonjs/i18n/languages/frFR.js',
      'hyperformula/commonjs/i18n/languages/deDE.js',
    ],
  },
  build: {
    commonjsOptions: {
      // @icecream-sheets/engine ships CommonJS dist. It is a symlinked
      // workspace package, so its real path is outside node_modules and the
      // default commonjs filter would skip it — include it explicitly.
      include: [/node_modules/, /packages\/engine/],
    },
  },
});
