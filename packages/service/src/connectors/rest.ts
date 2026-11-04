/**
 * rest-api connector — authenticated GET against a REST endpoint, then the
 * same JSON→table normalization as json-url.
 *
 * Params:
 * - url (required): http(s) endpoint.
 * - path (optional): dot/bracket path to the records array in the JSON
 *   response (same syntax as json-url).
 * - query (optional): JSON object of query-string parameters, e.g.
 *   '{"limit":"100","q":"sales"}'. Keys/values must be strings.
 * - headers (optional): JSON object of extra request headers, e.g.
 *   '{"X-Tenant":"acme"}'. Values must be strings. Authorization-style
 *   headers are REJECTED here — authentication goes through credentialRef.
 * - flatten (optional): 'true' (default) | 'false' (see json-url).
 *
 * AUTH: when the spec carries credentialRef, the resolver's secret is sent
 * as `Authorization: Bearer <secret>` (transient — never persisted, never
 * logged). Without a wired resolver and a credentialRef present, fetch fails
 * closed.
 */
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import { getPath, jsonToTable } from './json.js';
import type { TableData } from './table.js';
import type { Connector, ResolvedConnectorDeps } from './registry.js';

const FORBIDDEN_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'];

export class RestApiConnector implements Connector {
  readonly kind: ConnectorKind = 'rest-api';
  readonly displayName = 'REST API';
  readonly paramHelp =
    'url: endpoint. path: dot/bracket path to records (optional). query: JSON object of query params (optional). headers: JSON object of extra headers (optional, no auth headers). Auth via credentialRef → Bearer token.';

  async fetch(spec: ConnectorSpec, deps: ResolvedConnectorDeps): Promise<TableData> {
    const url = (spec.params['url'] ?? '').trim();
    const path = (spec.params['path'] ?? '').trim();
    const flatten = (spec.params['flatten'] ?? 'true').trim().toLowerCase() !== 'false';
    const query = parseStringMap(spec.params['query'], 'query');
    const headers = parseStringMap(spec.params['headers'], 'headers');
    for (const name of Object.keys(headers)) {
      if (FORBIDDEN_HEADERS.includes(name.toLowerCase())) {
        throw new Error(
          `header "${name}" is forbidden in params: authenticate with credentialRef, not params`,
        );
      }
    }
    if (spec.credentialRef) {
      if (!deps.resolveCredential) {
        throw new Error(
          `spec needs credential "${spec.credentialRef}" but no credential resolver is wired`,
        );
      }
      headers['Authorization'] = `Bearer ${await deps.resolveCredential.resolveCredential(spec.credentialRef)}`;
    }
    const finalUrl = withQuery(url, query);
    const text = await deps.fetchText(finalUrl, { headers, method: 'GET' });
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('response is not valid JSON');
    }
    const target = path === '' ? doc : getPath(doc, path);
    if (target === undefined) throw new Error(`JSON path "${path}" not found in response`);
    return jsonToTable(target, flatten);
  }
}

/** Parse an optional JSON object param into a string map (throws on misuse). */
export function parseStringMap(raw: string | undefined, name: string): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`param "${name}" must be a JSON object`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`param "${name}" must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') throw new Error(`param "${name}"."${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

function withQuery(url: string, query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.append(k, v);
  return u.toString();
}
