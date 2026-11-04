#!/usr/bin/env node
/**
 * Metadata service runner. PORT env, default 8103.
 * Usage: PORT=8103 node dist/bin/meta.js
 */
import http from 'node:http';
import { createMetaListener } from '../services/metaSvc.js';
const port = Number(process.env.PORT ?? '8103');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
const server = http.createServer(createMetaListener());
server.listen(port, host, () => {
    console.log(`[meta] listening on ${host}:${port}`);
});
