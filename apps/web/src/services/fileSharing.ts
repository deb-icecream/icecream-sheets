/**
 * File sharing client (issue #71): the web Share dialog's data source.
 *
 * Talks to the gateway's share contract (design-docs/
 * read-only-enforcement.md sections 5/6/8):
 *   GET  /api/engine/share?fileId=…  -> { owner, role, grants }
 *   POST /api/engine/share           -> { fileId, principal, role }
 * (role 'editor' | 'viewer', or null to revoke). The server is the
 * authority: it records grants owner-only, derives the caller's own
 * role from the registry record (aclRoleFor), and refuses self-target
 * changes. This module only transports and translates — failures are
 * mapped to plain-language FileShareErrors so no raw status code or
 * server string ever reaches the dialog's UI.
 */
import {
  GatewayAuthError,
  GatewayRateLimitError,
  getGatewayClient,
} from './gatewayClient';

export type FileAclRole = 'owner' | 'editor' | 'viewer';
export type FileGrantRole = 'editor' | 'viewer';

export interface FileGrant {
  principal: string;
  role: FileGrantRole;
}

export interface FileShareState {
  fileId: string;
  /** The file owner's principal (`user:<id>`); that entry never moves. */
  owner: string;
  /** The CALLER's role, as the server derives it for this file. */
  role: FileAclRole;
  grants: FileGrant[];
  /** Link sharing (issue #84c): null = off; set = anyone with the
   * link opens at this role. Link-only callers see grants: [] — the
   * access list is visible only to people on it. */
  linkShare: { role: FileGrantRole } | null;
}

/** Minimal seam over GatewayClient so tests can drive the mapping. */
export interface ShareGateway {
  call<T>(path: string, init?: RequestInit, body?: unknown): Promise<T>;
}

export type FileShareErrorKind =
  | 'not-signed-in'
  | 'unavailable'
  | 'not-on-server'
  | 'forbidden'
  | 'invalid'
  | 'no-such-user'
  | 'network'
  | 'unknown';

export class FileShareError extends Error {
  constructor(
    readonly kind: FileShareErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function resolveGateway(gw?: ShareGateway | null): ShareGateway {
  const client = gw ?? getGatewayClient();
  if (!client) {
    throw new FileShareError(
      'unavailable',
      'This file is only on this device right now, so it can’t be shared. Save it to your workspace to share it with other people.',
    );
  }
  return client;
}

/** Status + server error string out of a GatewayClient.call failure. */
function failureParts(e: unknown): { status: number | null; serverError: string | null } {
  if (e instanceof Error) {
    const m = /^gateway (\d+):/.exec(e.message);
    const status = m ? Number(m[1]) : null;
    const body = (e as Error & { gatewayBody?: unknown }).gatewayBody;
    let serverError: string | null = null;
    if (body && typeof body === 'object' && 'error' in body) {
      const err = (body as { error?: unknown }).error;
      if (typeof err === 'string') serverError = err;
    }
    return { status, serverError };
  }
  return { status: null, serverError: null };
}

export function toFileShareError(e: unknown): FileShareError {
  if (e instanceof FileShareError) return e;
  if (e instanceof GatewayAuthError) {
    return new FileShareError(
      'not-signed-in',
      'You’ve been signed out. Sign in again, then try once more.',
    );
  }
  if (e instanceof GatewayRateLimitError) {
    return new FileShareError('unknown', 'Too many requests just now — wait a moment and try again.');
  }
  const { status, serverError } = failureParts(e);
  if (status === 404 && serverError && serverError.includes('no account found')) {
    return new FileShareError(
      'no-such-user',
      'Nobody has signed in with that email yet. Ask them to sign in once, then try again.',
    );
  }
  if (status === 400) {
    if (serverError && serverError.includes('cannot change your own role')) {
      return new FileShareError(
        'invalid',
        'You can’t change your own access — the owner always keeps full access to their file.',
      );
    }
    if (serverError && serverError.includes('cannot transfer ownership to yourself')) {
      return new FileShareError('invalid', 'You can’t transfer a file to yourself.');
    }
    if (serverError && serverError.includes('must already have access')) {
      return new FileShareError(
        'invalid',
        'That person doesn’t have access to this file yet — share it with them first, then transfer.',
      );
    }
    return new FileShareError(
      'invalid',
      'That wasn’t accepted. Check the account ID and try again.',
    );
  }
  if (status === 403) {
    return new FileShareError(
      'forbidden',
      'Only the owner of this file can change who has access to it.',
    );
  }
  if (status === 404) {
    return new FileShareError(
      'not-on-server',
      'This file isn’t saved in the workspace yet, so there’s nobody to share it with. Save it to your workspace first.',
    );
  }
  if (status === 503) {
    return new FileShareError(
      'unavailable',
      'Sharing is unavailable right now. Please try again in a moment.',
    );
  }
  if (e instanceof TypeError) {
    return new FileShareError(
      'network',
      'Can’t reach the server. Check your connection and try again.',
    );
  }
  return new FileShareError('unknown', 'Something went wrong. Please try again.');
}

/** Read the file's owner, the caller's own role, and the grant list. */
export async function fetchFileShareState(
  fileId: string,
  gw?: ShareGateway | null,
): Promise<FileShareState> {
  const client = resolveGateway(gw);
  try {
    const res = await client.call<FileShareState & { ok: true }>(
      `/api/engine/share?fileId=${encodeURIComponent(fileId)}`,
      { method: 'GET' },
    );
    return {
      fileId: res.fileId,
      owner: res.owner,
      role: res.role,
      grants: res.grants ?? [],
      linkShare: res.linkShare ?? null,
    };
  } catch (e) {
    throw toFileShareError(e);
  }
}

/** Grant, re-role (same call), or revoke (role null) a principal. */
export async function setFileGrant(
  fileId: string,
  principal: string,
  role: FileGrantRole | null,
  gw?: ShareGateway | null,
): Promise<void> {
  const client = resolveGateway(gw);
  try {
    await client.call('/api/engine/share', { method: 'POST' }, { fileId, principal, role });
  } catch (e) {
    throw toFileShareError(e);
  }
}

/**
 * Resolve an email to a principal through the gateway directory
 * (issue #84a). The gateway requires the caller to own `fileId`, so
 * this is only ever called from the owner's invite/transfer flows.
 */
export async function resolvePrincipalByEmail(
  fileId: string,
  email: string,
  gw?: ShareGateway | null,
): Promise<{ principal: string; email: string; name?: string }> {
  const client = resolveGateway(gw);
  try {
    const res = await client.call<{ principal: string; email: string; name?: string }>(
      `/api/users/by-email?fileId=${encodeURIComponent(fileId)}&email=${encodeURIComponent(email)}`,
      { method: 'GET' },
    );
    return res;
  } catch (e) {
    throw toFileShareError(e);
  }
}

/** Switch link sharing on (role) or off (null) — owner-only server-side. */
export async function setLinkShare(
  fileId: string,
  role: FileGrantRole | null,
  gw?: ShareGateway | null,
): Promise<void> {
  const client = resolveGateway(gw);
  try {
    await client.call('/api/engine/share/link', { method: 'POST' }, { fileId, role });
  } catch (e) {
    throw toFileShareError(e);
  }
}

export interface TransferResult {
  owner: string;
  previousOwner: string;
  catalogTransferred: boolean;
}

/** Hand ownership to a principal who already holds a grant. */
export async function transferOwnership(
  fileId: string,
  principal: string,
  gw?: ShareGateway | null,
): Promise<TransferResult> {
  const client = resolveGateway(gw);
  try {
    const res = await client.call<TransferResult & { ok: true }>(
      '/api/engine/share/transfer',
      { method: 'POST' },
      { fileId, principal },
    );
    return {
      owner: res.owner,
      previousOwner: res.previousOwner,
      catalogTransferred: res.catalogTransferred,
    };
  } catch (e) {
    throw toFileShareError(e);
  }
}

/**
 * Normalize an invite entry to the canonical principal form
 * (`user:<id>` — the same normalization GatewayClient.principal applies
 * to the caller's own identity). An entry that already carries a
 * prefix (`user:…`) passes through untouched.
 */
export function toPrincipal(input: string): string {
  const t = input.trim();
  if (!t) return '';
  return t.includes(':') ? t : `user:${t}`;
}

/** Display form of a principal: the bare account ID. */
export function displayId(principal: string): string {
  return principal.startsWith('user:') ? principal.slice('user:'.length) : principal;
}
