#!/usr/bin/env node
/**
 * ETL service runner. PORT env, default 8104.
 * Usage: PORT=8104 node dist/bin/etl.js
 */
import http from 'node:http';
import { createEtlListener } from '../services/etlSvc.js';
const port = Number(process.env.PORT ?? '8104');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
const server = http.createServer(createEtlListener());
server.listen(port, host, () => {
    console.log(`[etl] listening on ${host}:${port}`);
});
