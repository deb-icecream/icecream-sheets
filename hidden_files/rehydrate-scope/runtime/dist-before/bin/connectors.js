#!/usr/bin/env node
/**
 * Connectors service runner. PORT env, default 8108.
 * Usage: PORT=8108 node dist/bin/connectors.js
 */
import http from 'node:http';
import { createConnectorListener } from '../services/connectorSvc.js';
const port = Number(process.env.PORT ?? '8108');
// HOST env: listen host. Default 127.0.0.1 (local dev); Cloud Run sets
// HOST=0.0.0.0 — its startup probes require listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
const server = http.createServer(createConnectorListener());
server.listen(port, host, () => {
    console.log(`[connectors] listening on ${host}:${port}`);
});
