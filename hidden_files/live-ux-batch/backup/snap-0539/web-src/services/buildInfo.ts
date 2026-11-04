/**
 * Build identity stamp (Phase 2 fix — the dist-baking landmine).
 *
 * The local-stack web dist MUST be built with the gateway URL and the
 * signed engine-access mode baked in (VITE_GATEWAY_URL +
 * VITE_ENGINE_ACCESS_MODE=signed). A dist rebuilt with a plain
 * `vite build` silently boots in LOCAL mode (no gateway client at all)
 * or in proxy mode against a signed-mode engine (every engine call
 * 401s) — both failures look like product bugs and burned a §10 matrix
 * leg before the cause was found. This module makes the baked
 * configuration DETECTABLE at runtime: a console banner plus
 * `data-icecream-*` attributes on <html> that test harnesses assert
 * before running (see scripts/verify-dist.mjs for the build-time
 * check, and `npm run build:local-stack` for the correct build).
 */
/// <reference types="vite/client" />

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

export const BUILD_INFO = {
  /** The baked gateway base URL, or null for a local-mode build. */
  gatewayUrl: env?.['VITE_GATEWAY_URL'] ?? null,
  /** 'signed' (direct engine access) or 'proxy' (gateway-proxied). */
  engineAccessMode: (env?.['VITE_ENGINE_ACCESS_MODE'] ?? 'proxy').toLowerCase(),
} as const;

/** Stamp the baked build identity where a harness can read it. */
export function stampBuildInfo(): void {
  try {
    console.info(
      `[icecream] build: gateway=${BUILD_INFO.gatewayUrl ?? '(none)'} engineAccess=${BUILD_INFO.engineAccessMode}`,
    );
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-icecream-gateway', BUILD_INFO.gatewayUrl ?? '');
      document.documentElement.setAttribute(
        'data-icecream-engine-access',
        BUILD_INFO.engineAccessMode,
      );
    }
  } catch {
    // Stamping must never break boot.
  }
}
