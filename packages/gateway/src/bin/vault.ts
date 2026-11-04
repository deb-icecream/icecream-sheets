#!/usr/bin/env node
/**
 * Vault service runner. PORT env, default 8102.
 * Usage: PORT=8102 node dist/bin/vault.js
 */
import http from 'node:http';
import { createVaultListener } from '../services/vaultSvc.js';

const port = Number(process.env.PORT ?? '8102');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
const server = http.createServer(createVaultListener());
server.listen(port, host, () => {
  console.log(`[vault] listening on ${host}:${port}`);
});
