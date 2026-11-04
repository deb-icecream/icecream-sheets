#!/usr/bin/env node
/**
 * Regenerate packs/<id>/pack.json from the registered pack manifests.
 *
 * The TypeScript manifest in src/packs/<id>.ts is the source of truth;
 * pack.json is its on-disk mirror for third-party tooling. The
 * registry test (tests/packs-registry.test.ts) fails when the two
 * drift, so run this after changing a pack's manifest (name, version,
 * tools, or prompts):
 *
 *   npm run build && node scripts/gen-pack-manifests.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { SKILL_PACKS, manifestOf } from '../dist/packs/index.js';

const base = new URL('../packs/', import.meta.url);
for (const pack of SKILL_PACKS) {
  const dir = new URL(`${pack.id}/`, base);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    new URL('pack.json', dir),
    JSON.stringify(manifestOf(pack), null, 2) + '\n',
  );
  console.log(`packs/${pack.id}/pack.json — ${pack.name} ${pack.version}, ${pack.tools.length} tools`);
}
