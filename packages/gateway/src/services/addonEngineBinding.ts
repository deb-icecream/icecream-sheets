/**
 * Production document binding for the add-on service: a DocumentBinding
 * that resolves against the engine service's open workbook over HTTP
 * (design-docs/add-on-model.md §5 — "resolved through the adapter's
 * metadata capabilities").
 *
 * The add-ons service runs in its own process; the open workbook lives in
 * the engine service. Every op the binding performs is an engine-service
 * call made AS THE GRANTING USER (x-principal, plus an engine-access
 * token minted for the user's own session on this document — see
 * createProductionAddonResolveBinding; the caller's gateway JWT is NOT
 * forwarded: in signed mode the engine verifies bearer tokens as
 * engine-access tokens and rejects the 3-part gateway JWT as malformed):
 * - reads  → POST /read   (host.readCell/readRange: typed view through
 *            authorize() per cell, hidden-cell filtering, #PERM! on denial)
 * - writes → POST /execute (host.execute: cell.write through authorize())
 * - sheets → GET  /snapshot (permission-filtered per principal)
 *
 * That is the same code path the UI uses (RemoteEngineHost calls the same
 * endpoints), and the engine service is the enforcement point for its data:
 * the add-on can only touch what the granting user is allowed to touch —
 * it never elevates. Error values (including #PERM!) and images never cross
 * the add-on boundary: they coerce to null.
 *
 * The add-on worker's op-level authorize() in the add-ons service uses
 * createDelegatingAddonAuthorizer() below: it records every decision with
 * both identities (user principal + addon:<id>) and allows, because
 * object-level enforcement happens inside the binding, in the engine
 * service, with the real principal. The grant + capability gates in
 * AddonService.run()/executeOp() still apply on top.
 */

import {
  AddonAuthError,
  type AuthorizerLike,
  type CellAddress,
  type CellValue,
  type DocumentBinding,
  type RangeAddress,
} from '@icecream-sheets/service';
import {
  engineAccessSecret,
  issueEngineAccessToken,
} from '../deploy/engineAccess.js';
import {
  createFileSessionResolver,
  type AgentSessionRecordSource,
  type ResolvedAgentSession,
} from './agentSessionResolver.js';
import type { FileRegistry } from '../deploy/fileRegistry.js';

export interface EngineServiceBindingOptions {
  /** Base URL of the engine service, e.g. http://127.0.0.1:8101. */
  engineBaseUrl: string;
  /** The bound document's id (matches the grant's documentId). */
  documentId: string;
  /** The granting user's principal — enforced by the engine service. */
  principal: string;
  /**
   * Static bearer header value, sent verbatim when no getAuthorization
   * is configured (tests / unsigned deployments). Production wiring
   * uses getAuthorization instead: the gateway JWT must never be
   * forwarded to a signed-mode engine (it is not an engine-access
   * token and verifies as "malformed").
   */
  authorization?: string;
  /**
   * Per-call bearer header value (e.g. "Bearer <engine-access token>").
   * Called fresh for EVERY engine request, so a short-lived token can
   * be re-minted per call and never expires mid-run. Wins over the
   * static `authorization` when both are set. Returning undefined
   * sends no bearer header (unsigned engine: x-principal only).
   */
  getAuthorization?: () => string | undefined | Promise<string | undefined>;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Coerce an engine-service TypedValue to a CellValue. Errors/images → null. */
function toCellValue(v: unknown): CellValue {
  if (v !== null && typeof v === 'object') {
    const tv = v as { kind?: unknown; value?: unknown };
    if (
      (tv.kind === 'number' || tv.kind === 'string' || tv.kind === 'boolean' || tv.kind === 'null') &&
      (tv.value === null ||
        typeof tv.value === 'string' ||
        typeof tv.value === 'number' ||
        typeof tv.value === 'boolean')
    ) {
      return tv.value as CellValue;
    }
  }
  // 'error' (incl. #PERM! from authorize()/hidden checks) and 'image':
  // never cross the add-on boundary.
  return null;
}

export function createEngineServiceBinding(opts: EngineServiceBindingOptions): DocumentBinding {
  const base = opts.engineBaseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const headers = async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'x-principal': opts.principal,
    };
    const authz = opts.getAuthorization
      ? await opts.getAuthorization()
      : opts.authorization;
    if (authz) h['authorization'] = authz;
    return h;
  };

  async function call(path: string, method: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: await headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new AddonAuthError('denied', `engine service unreachable: ${(e as Error).message}`);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // leave null
    }
    if (!res.ok) {
      const msg =
        json !== null && typeof json === 'object' && 'error' in json
          ? String((json as { error: unknown }).error)
          : `engine service ${res.status}`;
      throw new AddonAuthError('denied', msg);
    }
    return json;
  }

  const cellRef = (a: CellAddress) => ({ sheet: a.sheet, row: a.row, col: a.col });

  async function writeOne(sheet: string, row: number, col: number, value: CellValue): Promise<void> {
    const result = (await call('/execute', 'POST', {
      cmd: { cmd: 'setCell', ref: { sheet, row, col }, value },
    })) as { ok?: unknown; error?: unknown };
    // The engine service stamps the real principal into cmd.auth and runs
    // authorize('cell.write', ...) — a denial arrives here as { ok: false }.
    if (!result || result.ok !== true) {
      throw new AddonAuthError(
        'denied',
        `engine refused write: ${typeof result?.error === 'string' ? result.error : 'unknown'}`,
      );
    }
  }

  return {
    documentId: opts.documentId,
    listSheets: async () => {
      const snap = (await call('/snapshot', 'GET')) as {
        sheets?: { name?: unknown }[];
      };
      return (snap.sheets ?? []).map((s) => String(s.name ?? ''));
    },
    readCell: async (a: CellAddress) => {
      const out = (await call('/read', 'POST', { kind: 'cell', ref: cellRef(a) })) as {
        value?: unknown;
      };
      return toCellValue(out?.value);
    },
    readRange: async (r: RangeAddress) => {
      const out = (await call('/read', 'POST', {
        kind: 'range',
        range: {
          sheet: r.sheet,
          startRow: r.startRow,
          startCol: r.startCol,
          endRow: r.endRow,
          endCol: r.endCol,
        },
      })) as { values?: unknown[][] };
      const values = out?.values ?? [];
      return values.map((row) => row.map(toCellValue));
    },
    writeCell: async (a: CellAddress, value: CellValue) => {
      await writeOne(a.sheet, a.row, a.col, value);
    },
    writeRange: async (r: RangeAddress, values: CellValue[][]) => {
      for (let i = 0; i < values.length; i++) {
        const rowVals = values[i];
        for (let j = 0; j < rowVals.length; j++) {
          await writeOne(r.sheet, r.startRow + i, r.startCol + j, rowVals[j]);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Production /run binding resolver (FIX-R3)
// ---------------------------------------------------------------------------

/**
 * Engine-access tokens for add-on runs: SHORT-lived (2 min, the agent
 * path's TTL) and re-minted on EVERY engine call by the binding's
 * getAuthorization callback — never cached, never logged. The role is
 * the granting user's OWN session role from the registry record: the
 * add-on acts as the user (add-on-model.md §5), so a user who joined
 * the document as a viewer gets a viewer-scoped token and the engine
 * refuses its writes ('viewer-role'), while their reads still work.
 */
const ADDON_ENGINE_TOKEN_TTL_SECONDS = 120;

export interface ProductionAddonBindingOptions {
  /** Session resolver override (tests). Default: the registry file-scoped resolver. */
  resolveSession?: (
    principal: string,
    fileId: string,
  ) => Promise<ResolvedAgentSession | null>;
  /** Registry record source override (tests), forwarded to the default resolver. */
  records?: AgentSessionRecordSource;
  /**
   * The session ownership registry the default resolver enumerates
   * (listAll) — the production wiring: in prod the registry is
   * Firestore-backed and there is no on-disk registry file. Forwarded
   * to the default resolver; an explicit `records` source still wins.
   */
  fileRegistry?: FileRegistry;
  /** Env for the registry source + the engine-access secret. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Clock override (tests). Default Date.now(). */
  nowMs?: () => number;
  /** Token TTL override (tests). Default ADDON_ENGINE_TOKEN_TTL_SECONDS. */
  tokenTtlSeconds?: number;
}

/**
 * The production resolveBinding shared by bin/addons.ts and the combined
 * service package (servicePackage.ts) — one wiring, by construction.
 *
 * Per /run: resolve the document's LIVE session for the requesting
 * principal from the session ownership registry (file-scoped: the
 * principal must be the session's creator or a recorded participant).
 * No live session → throw, and addonSvc fails the run closed (502):
 * an add-on binds to the OPEN workbook, and a document that is not
 * open has nothing to bind to. The binding targets the session's
 * owning engine endpoint and authenticates with a freshly minted
 * engine-access token scoped { sub: principal, sid, fid, role } —
 * NEVER the caller's gateway JWT (the pre-FIX-R3 wiring forwarded it,
 * and a signed-mode engine rejects it as "malformed"; the original
 * case-11 failure). When no ENGINE_ACCESS_SECRET is configured the
 * binding sends no bearer header — the unsigned-engine contract
 * (x-principal only), identical to the agent path's posture.
 */
export function createProductionAddonResolveBinding(
  engineBaseUrl: string,
  opts: ProductionAddonBindingOptions = {},
): (
  documentId: string,
  reqCtx: { principal: string; authorization?: string },
) => Promise<DocumentBinding> {
  const env = opts.env ?? process.env;
  const resolveSession =
    opts.resolveSession ??
    createFileSessionResolver({
      records: opts.records,
      registry: opts.fileRegistry,
      env,
      nowMs: opts.nowMs,
    });
  const ttlSeconds = opts.tokenTtlSeconds ?? ADDON_ENGINE_TOKEN_TTL_SECONDS;
  return async (documentId, reqCtx) => {
    const session = await resolveSession(reqCtx.principal, documentId);
    if (!session) {
      throw new Error(
        `no live engine session for document ${documentId} for this user (open the document first)`,
      );
    }
    const principal = reqCtx.principal;
    return createEngineServiceBinding({
      engineBaseUrl: session.engineUrl || engineBaseUrl,
      documentId,
      principal,
      getAuthorization: () => {
        const secret = engineAccessSecret(env);
        if (!secret) return undefined;
        return `Bearer ${
          issueEngineAccessToken({
            secret,
            principal,
            sessionId: session.sessionId,
            fid: documentId,
            role: session.role,
            tier: 'standard',
            ttlSeconds,
          }).token
        }`;
      },
    });
  };
}

// ---------------------------------------------------------------------------
// Production authorizer for the engine-service binding
// ---------------------------------------------------------------------------

export interface AddonAuthRecord {
  principal: string;
  addonId: string | null;
  action: string;
  target: string;
  allowed: boolean;
  at: string;
}

/**
 * The add-on worker's op-level authorizer for the production (engine-service)
 * binding. Every decision is recorded with both identities — the granting
 * user's principal and the add-on id from the auth context's grants field —
 * and allowed: object-level enforcement is delegated to the engine service,
 * which runs authorize() with the real principal on the same code path the
 * UI uses (host.readCell/readRange/execute). The add-on never elevates
 * beyond the granting user because the binding itself cannot return or
 * write anything the user is not allowed to touch.
 *
 * This is NOT the local-dev allow-all seam: that one records nothing and
 * documents "no enforcement anywhere". Here enforcement is real — it just
 * lives in the binding, one hop away.
 */
export function createDelegatingAddonAuthorizer(): AuthorizerLike & {
  auditLog(): AddonAuthRecord[];
} {
  const log: AddonAuthRecord[] = [];
  const authorizer: AuthorizerLike = {
    authorize(action: string, target: string, ctx: { principal: string; grants?: string[] }): boolean {
      if (!ctx || typeof ctx.principal !== 'string' || ctx.principal.length === 0) {
        throw new Error('authorize: missing principal (fail closed)');
      }
      const addonId =
        ctx.grants?.find((g) => g.startsWith('addon:'))?.slice('addon:'.length) ?? null;
      log.push({
        principal: ctx.principal,
        addonId,
        action,
        target,
        allowed: true,
        at: new Date().toISOString(),
      });
      return true;
    },
  };
  return Object.assign(authorizer, {
    auditLog: () => [...log],
  });
}
