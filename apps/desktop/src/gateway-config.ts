/**
 * Gateway base-URL seam (issue #85).
 *
 * The URL is resolved from, in order:
 *
 *   1. ICECREAM_GATEWAY_URL — environment override (local stacks,
 *      self-hosted deployments, support diagnostics).
 *   2. <userData>/gateway.config.json — the Electron userData
 *      directory (per-user; never checked into the repo), shaped
 *      {"gatewayUrl": "https://…" }.
 *   3. The BUNDLED production default (issue #85,
 *      ./gateway-config-bundled) — the deployed gateway the hosted
 *      web bundle ships. This is what a clean install uses, so
 *      sign-in works with zero operator setup.
 *
 * Overrides always win over the bundled default, and an override that
 * is SET but invalid fails closed (GatewayConfigError): there is no
 * silent fallthrough — not to localhost, and not to production
 * either — because a mistyped override that quietly repointed the
 * app would be worse than a loud config error. The default applies
 * only when no override was provided at all — which includes a
 * userData file that EXISTS but does not parse/validate (a present
 * file is an override attempt, not an absence).
 *
 * There is deliberately NO localhost fallback: local development
 * points at its stack explicitly via ICECREAM_GATEWAY_URL (the web
 * local-stack build does the same via VITE_GATEWAY_URL).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUNDLED_GATEWAY_URL } from './gateway-config-bundled';

/** Thrown when a gateway URL override is set but invalid. Carries the fix. */
export class GatewayConfigError extends Error {
  readonly checked: string[];
  constructor(checked: string[]) {
    super(
      'The gateway URL configuration is invalid. Fix or remove the ' +
        'ICECREAM_GATEWAY_URL environment variable, or the gateway.config.json ' +
        'file in the app userData directory (expected shape: ' +
        '{"gatewayUrl": "https://…"}) — the app refuses to guess a gateway. ' +
        `Checked: ${checked.join('; ')}.`,
    );
    this.name = 'GatewayConfigError';
    this.checked = checked;
  }
}

/**
 * Validate + normalize a candidate gateway base URL: a non-empty
 * http(s) URL with a host, returned without trailing slashes (callers
 * append paths). Returns null for anything else.
 */
export function normalizeGatewayUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return trimmed.replace(/\/+$/, '');
}

export interface GatewayConfigDeps {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to node:fs.readFileSync. */
  readFile?: (p: string) => string;
  /** Defaults to app.getPath('userData') — pass explicitly in tests. */
  userDataPath?: string;
}

/**
 * Resolve the gateway base URL from the seam. Falls back to the
 * bundled production default (issue #85) when no override is provided;
 * throws GatewayConfigError (fail closed) when an override IS provided
 * but invalid, or if even the bundled default fails validation.
 */
export function loadGatewayUrl(deps: GatewayConfigDeps = {}): string {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const checked: string[] = [];

  // 1. Environment override.
  const envUrl = env['ICECREAM_GATEWAY_URL'];
  if (envUrl && envUrl.trim().length > 0) {
    checked.push('ICECREAM_GATEWAY_URL (env)');
    const normalized = normalizeGatewayUrl(envUrl);
    if (normalized) return normalized;
    throw new GatewayConfigError([
      ...checked,
      `ICECREAM_GATEWAY_URL was set but "${envUrl}" is not a valid http(s) URL`,
    ]);
  }
  checked.push('ICECREAM_GATEWAY_URL (env, unset)');

  // 2. Per-user config file in the Electron userData directory.
  const userDataPath = deps.userDataPath;
  const userFile = userDataPath ? path.join(userDataPath, 'gateway.config.json') : null;
  checked.push(userFile ?? '<userData>/gateway.config.json (no userData path available)');
  if (userFile) {
    let raw: string | null = null;
    try {
      raw = readFile(userFile);
    } catch {
      raw = null; // Missing file → not an override; fall through to (3).
    }
    if (raw !== null) {
      // The file EXISTS: it is an override attempt. Invalid content
      // fails closed rather than silently talking to another gateway.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      const candidate =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)['gatewayUrl']
          : undefined;
      const normalized = normalizeGatewayUrl(candidate);
      if (normalized) return normalized;
      throw new GatewayConfigError([
        ...checked,
        `"${userFile}" exists but does not contain a valid {"gatewayUrl": "https://…"}`,
      ]);
    }
  }

  // 3. Bundled default (issue #85): the production gateway, shipped in
  // the package so clean installs reach the deployed service.
  checked.push('bundled default (gateway-config-bundled)');
  const bundled = normalizeGatewayUrl(BUNDLED_GATEWAY_URL);
  if (bundled) return bundled;

  throw new GatewayConfigError(checked);
}
