/**
 * Automation surface — trigger management HTTP API (triggers program;
 * design-docs/automation-lane.md §§1/3; contract in
 * hidden_files/triggers/REPORT.md).
 *
 * Mounted by the service package behind /api/automation (gateway family
 * route). The gateway proxy sets x-principal from the verified JWT;
 * this surface is only reachable through that authenticated proxy, so
 * a missing principal header is a 401 (fail closed). Authorization is
 * the registry rule implemented by TriggerSupervisor.authorizeFile:
 * the file's creator and its editor participants may mutate; viewer
 * participants are read-only; a file with no registry record is a 404.
 *
 * Routes (paths arrive prefix-stripped by the package dispatcher):
 *   GET    /triggers?fileId=            → { ok, events, triggers }
 *   POST   /triggers                    { fileId, spec } → { ok, trigger }
 *   POST   /triggers/:id/enabled        { fileId, enabled } → { ok, trigger }
 *   POST   /triggers/:id/grant          { fileId } → { ok, trigger }
 *   DELETE /triggers/:id?fileId=        → { ok }
 *   POST   /tick                        → { ok, ...tick summary }
 *     (Scope update 2: the Cloud Scheduler waker. Authenticated ONLY
 *     by the scheduler's OIDC token — verified audience + service
 *     account identity; no x-principal. Fail closed when the tick
 *     auth is not configured.)
 * A null supervisor or a prod-broken one answers 503 on every route —
 * never a silent local/in-memory fallback.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { TriggerSpecInit } from '@icecream-sheets/service';
import { handlePreflight, readBody, sendError, sendJson } from '../httpUtils.js';
import type { TriggerSupervisor } from './triggerSupervisor.js';
import {
  tickAuthConfig,
  verifySchedulerOidc,
  type TickAuthEnv,
} from './tickAuth.js';

/** Events the hosted runtime can fire in this topology (REPORT.md). */
export const AUTOMATION_EVENT_CAPABILITIES = [
  'onOpen',
  'onEdit',
  'onInterval',
  'onAtTime',
] as const;

export interface AutomationServiceDeps {
  supervisor: TriggerSupervisor | null;
  /** Env for the tick endpoint's OIDC config. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Tick authorization override (tests): return true for an
   * authorized scheduler call. Default: real OIDC verification
   * against the env config (tickAuth.ts).
   */
  tickAuthorize?: (authorization: string | undefined) => Promise<boolean>;
  /** Tick auth config override (tests); null = not configured. */
  tickAuth?: TickAuthEnv | null;
}

function rawPrincipal(req: IncomingMessage): string | null {
  const h = req.headers['x-principal'];
  return typeof h === 'string' && h.length > 0 ? h : null;
}

export function createAutomationListener(deps: AutomationServiceDeps): RequestListener {
  const supervisor = deps.supervisor;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://automation');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (path === '/health' && method === 'GET') {
        return sendJson(res, 200, { ok: true, service: 'automation' });
      }
      // -- scheduler tick (Scope update 2) ------------------------------
      // Authenticated ONLY by the Cloud Scheduler OIDC token (no
      // x-principal). Fail closed: unconfigured → 503, bad or missing
      // token → 401, broken store → 503 (the tick retries later).
      if (path === '/tick' && method === 'POST') {
        if (!supervisor) {
          return sendJson(res, 503, { ok: false, error: 'trigger supervisor unavailable' });
        }
        const config =
          deps.tickAuth !== undefined
            ? deps.tickAuth
            : tickAuthConfig(deps.env ?? process.env);
        if (!config && !deps.tickAuthorize) {
          return sendJson(res, 503, {
            ok: false,
            error: 'tick auth not configured (TRIGGER_TICK_AUDIENCE / TRIGGER_TICK_SA_EMAIL)',
          });
        }
        const authorized = deps.tickAuthorize
          ? await deps.tickAuthorize(req.headers.authorization)
          : await verifySchedulerOidc(req.headers.authorization, config!);
        if (!authorized) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized tick' });
        }
        if (supervisor.prodBrokenReason !== null) {
          return sendJson(res, 503, {
            ok: false,
            error: `trigger store unavailable (fail closed): ${supervisor.prodBrokenReason}`,
          });
        }
        const summary = await supervisor.tick();
        return sendJson(res, 200, { ok: true, ...summary });
      }
      if (path !== '/triggers' && !path.startsWith('/triggers/')) {
        return sendError(res, 404, `not found: ${path}`);
      }
      if (!supervisor) {
        return sendJson(res, 503, { ok: false, error: 'trigger supervisor unavailable' });
      }
      if (supervisor.prodBrokenReason !== null) {
        return sendJson(res, 503, {
          ok: false,
          error: `trigger store unavailable (fail closed): ${supervisor.prodBrokenReason}`,
        });
      }
      const principal = rawPrincipal(req);
      if (principal === null) {
        return sendJson(res, 401, { ok: false, error: 'x-principal header required' });
      }

      // Shared gate: file must be known (any registry record), caller
      // must hold a role on it, mutations require 'editor'.
      const gate = async (
        fileId: string,
        mutation: boolean,
      ): Promise<'editor' | 'viewer' | null> => {
        if (!(await supervisor.fileKnown(fileId))) {
          sendJson(res, 404, { ok: false, error: `unknown file: ${fileId}` });
          return null;
        }
        const role = await supervisor.authorizeFile(principal, fileId);
        if (role === null) {
          sendJson(res, 403, {
            ok: false,
            error: 'caller is not a participant of this file\u2019s session',
          });
          return null;
        }
        if (mutation && role !== 'editor') {
          sendJson(res, 403, {
            ok: false,
            error: 'viewer participants cannot manage triggers',
          });
          return null;
        }
        return role;
      };

      // -- list ---------------------------------------------------------
      if (path === '/triggers' && method === 'GET') {
        const fileId = url.searchParams.get('fileId') ?? '';
        if (!fileId) return sendError(res, 400, 'fileId query parameter required');
        if ((await gate(fileId, false)) === null) return;
        const triggers = await supervisor.listForFile(fileId);
        return sendJson(res, 200, {
          ok: true,
          events: [...AUTOMATION_EVENT_CAPABILITIES],
          triggers,
        });
      }

      // -- create -------------------------------------------------------
      if (path === '/triggers' && method === 'POST') {
        const body = (await readBody(req)) as
          | { fileId?: unknown; spec?: unknown }
          | undefined;
        if (!body || typeof body.fileId !== 'string' || body.fileId.length === 0) {
          return sendError(res, 400, '{ fileId: string, spec: TriggerSpecInit } required');
        }
        if (typeof body.spec !== 'object' || body.spec === null) {
          return sendError(res, 400, '{ fileId: string, spec: TriggerSpecInit } required');
        }
        if ((await gate(body.fileId, true)) === null) return;
        try {
          const trigger = await supervisor.createForFile(
            body.fileId,
            body.spec as TriggerSpecInit,
          );
          return sendJson(res, 200, { ok: true, trigger });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('createTriggerSpec')) return sendError(res, 400, msg);
          throw e;
        }
      }

      // -- per-trigger routes -------------------------------------------
      const m = /^\/triggers\/([^/]+)(\/enabled|\/grant)?$/.exec(path);
      if (m && (method === 'POST' || method === 'DELETE')) {
        const id = decodeURIComponent(m[1]!);
        const action = m[2] ?? '';
        if (method === 'DELETE' && action === '') {
          const fileId = url.searchParams.get('fileId') ?? '';
          if (!fileId) return sendError(res, 400, 'fileId query parameter required');
          if ((await gate(fileId, true)) === null) return;
          const removed = await supervisor.removeForFile(fileId, id);
          if (!removed) {
            return sendJson(res, 404, { ok: false, error: `unknown trigger: ${id}` });
          }
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'POST' && (action === '/enabled' || action === '/grant')) {
          const body = (await readBody(req)) as
            | { fileId?: unknown; enabled?: unknown }
            | undefined;
          if (!body || typeof body.fileId !== 'string' || body.fileId.length === 0) {
            return sendError(res, 400, '{ fileId: string, ... } required');
          }
          if ((await gate(body.fileId, true)) === null) return;
          try {
            if (action === '/enabled') {
              if (typeof body.enabled !== 'boolean') {
                return sendError(res, 400, '{ fileId: string, enabled: boolean } required');
              }
              const trigger = await supervisor.setEnabledForFile(body.fileId, id, body.enabled);
              return sendJson(res, 200, { ok: true, trigger });
            }
            const trigger = await supervisor.grantForFile(body.fileId, id, principal);
            return sendJson(res, 200, { ok: true, trigger });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.startsWith('unknown trigger')) {
              return sendJson(res, 404, { ok: false, error: msg });
            }
            throw e;
          }
        }
      }

      return sendError(res, 404, `not found: ${method} ${path}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return sendError(res, 500, `automation error: ${msg}`);
    }
  };
}
