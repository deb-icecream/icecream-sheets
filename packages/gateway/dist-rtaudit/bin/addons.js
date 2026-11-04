#!/usr/bin/env node
/**
 * Add-on service runner. PORT env, default 8107.
 *
 * Production document binding (design-docs/add-on-model.md §5): /run
 * resolves the add-on's document binding against the engine service's open
 * workbook (ENGINE_SERVICE_URL, default http://127.0.0.1:8101). The
 * granting user's principal travels as x-principal and the caller's bearer
 * token is forwarded, so the engine service enforces authorize() with the
 * real principal on the same code path the UI uses. The add-on never
 * elevates beyond the granting user.
 *
 * Usage: PORT=8107 node dist/bin/addons.js
 */
import http from 'node:http';
import { createAddonListener } from '../services/addonSvc.js';
import { createDelegatingAddonAuthorizer, createEngineServiceBinding, } from '../services/addonEngineBinding.js';
const port = Number(process.env.PORT ?? '8107');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
const engineBaseUrl = process.env.ENGINE_SERVICE_URL ?? 'http://127.0.0.1:8101';
const server = http.createServer(createAddonListener({
    authorizer: createDelegatingAddonAuthorizer(),
    resolveBinding: (documentId, reqCtx) => createEngineServiceBinding({
        engineBaseUrl,
        documentId,
        principal: reqCtx.principal,
        authorization: reqCtx.authorization,
    }),
}));
server.listen(port, host, () => {
    console.log(`[addons] listening on ${host}:${port} (engine: ${engineBaseUrl})`);
});
