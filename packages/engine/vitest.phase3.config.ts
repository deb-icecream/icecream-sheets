// TEMPORARY Phase 3 verification config: cache disabled because this
// VM's write mediation EPERM-blocks vitest's results-cache write.
// Delete after the run.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cache: false,
  test: { cache: false },
});
