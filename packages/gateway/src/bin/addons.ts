#!/usr/bin/env node
/**
 * Add-on service runner. PORT env, default 8107.
 *
 * Production document binding (design-docs/add-on-model.md §5): /run
 * resolves the add-on's document binding against the engine service's
 * open workbook via createProductionAddonResolveBinding — the document's
 * live session is looked up in the session ownership registry for the
 * requesting principal, and every engine call carries a freshly minted
 * engine-access token scoped to that session with the user's own role
 * (FIX-R3). The caller's gateway JWT is never forwarded to the engine:
 * in signed mode it verifies as "malformed". The add-on never elevates
 * beyond the granting user — a viewer's add-on reads but cannot write.
 *
 * Usage: PORT=8107 node dist/bin/addons.js
 */
import http from 'node:http';
import { createAddonListener } from '../services/addonSvc.js';
import {
  createDelegatingAddonAuthorizer,
  createProductionAddonResolveBinding,
} from '../services/addonEngineBinding.js';

const port = Number(process.env.PORT ?? '8107');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
const engineBaseUrl = process.env.ENGINE_SERVICE_URL ?? 'http://127.0.0.1:8101';

const server = http.createServer(
  createAddonListener({
    authorizer: createDelegatingAddonAuthorizer(),
    resolveBinding: createProductionAddonResolveBinding(engineBaseUrl),
  }),
);
server.listen(port, host, () => {
  console.log(`[addons] listening on ${host}:${port} (engine: ${engineBaseUrl})`);
});
