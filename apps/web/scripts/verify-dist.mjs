#!/usr/bin/env node
/**
 * Dist-baking guard (Phase 2 fix — the dist build landmine).
 *
 * A web dist for the LOCAL STACK must bake BOTH:
 *   VITE_GATEWAY_URL=http://localhost:8100
 *   VITE_ENGINE_ACCESS_MODE=signed
 * A dist rebuilt with a plain `vite build` bakes NEITHER and silently
 * boots in local mode (zero gateway requests); a dist with only the
 * URL bakes proxy mode, whose engine calls all 401 against the
 * signed-mode engine. Both misbuilds look exactly like product bugs
 * and invalidated a §10 matrix leg (leg-a, 2026-10-21) before the
 * cause was found.
 *
 * This check fails LOUDLY (exit 1) when the served dist does not carry
 * the required baked values. Run it against any dist before serving:
 *   node scripts/verify-dist.mjs [--local-stack] [--dist <dir>]
 * `npm run build:local-stack` builds AND verifies in one step.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const distArgIdx = args.indexOf('--dist');
const distDir =
  distArgIdx >= 0 && args[distArgIdx + 1]
    ? args[distArgIdx + 1]
    : fileURLToPath(new URL('../dist', import.meta.url));

const GATEWAY_URL = 'http://localhost:8100';

function collectJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) collectJs(p, out);
    else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

let jsFiles;
try {
  jsFiles = collectJs(distDir);
} catch (e) {
  console.error(`[verify-dist] cannot read dist at ${distDir}: ${e.message}`);
  process.exit(1);
}
if (jsFiles.length === 0) {
  console.error(`[verify-dist] no JS assets under ${distDir} — build first.`);
  process.exit(1);
}
const bundle = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const failures = [];
if (!bundle.includes(GATEWAY_URL)) {
  failures.push(
    `gateway URL not baked: no asset contains ${GATEWAY_URL} (VITE_GATEWAY_URL missing at build time — the app would boot in LOCAL mode)`,
  );
}
if (!/["']?VITE_ENGINE_ACCESS_MODE["']?\s*:\s*"signed"/.test(bundle)) {
  failures.push(
    'engine access mode not baked as signed: VITE_ENGINE_ACCESS_MODE="signed" not found in the bundle env (proxy-mode calls 401 against the signed-mode engine)',
  );
}

if (failures.length > 0) {
  console.error('[verify-dist] DIST CHECK FAILED — do not serve this dist to the local stack:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('Rebuild with: npm run build:local-stack');
  process.exit(1);
}
console.log(
  `[verify-dist] OK: dist bakes gateway=${GATEWAY_URL} + engineAccess=signed (${jsFiles.length} JS assets checked).`,
);
