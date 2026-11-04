#!/usr/bin/env node
/**
 * Agent service runner. PORT env, default 8105.
 * Usage: PORT=8105 node dist/bin/agent.js
 */
import http from 'node:http';
import { createAgentListener } from '../services/agentSvc.js';

const port = Number(process.env.PORT ?? '8105');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';
const server = http.createServer(createAgentListener());
server.listen(port, host, () => {
  console.log(`[agent] listening on ${host}:${port}`);
});
