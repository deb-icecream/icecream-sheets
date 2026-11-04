#!/usr/bin/env node
/**
 * Combined service-package runner (production form of the service
 * family): ONE process hosting the vault, meta, etl, agent and addons
 * HTTP surfaces on ONE PORT behind their /api/<name> prefixes — the
 * single stateless Cloud Run "service package" service from the user's
 * service inventory (2026-10-20). Local dev keeps the five separate
 * bins (8102–8107) unchanged; this runner is additive.
 *
 * PORT env, default 8108. HOST env: listen host, default 127.0.0.1;
 * Cloud Run sets HOST=0.0.0.0 (startup probes require 0.0.0.0:$PORT).
 * ENGINE_SERVICE_URL: the engine service base for the add-on /run
 * binding (default http://127.0.0.1:8101), as in bin/addons.js.
 *
 * Usage: PORT=8108 HOST=0.0.0.0 node dist/bin/service.js
 */
import http from 'node:http';
import { createServicePackageListener } from '../services/servicePackage.js';

const port = Number(process.env.PORT ?? '8108');
// HOST env: listen host. Default 127.0.0.1 (local dev, byte-identical
// to before); Cloud Run sets HOST=0.0.0.0 — its startup probes require
// listening on 0.0.0.0:$PORT.
const host = process.env.HOST ?? '127.0.0.1';

const server = http.createServer(createServicePackageListener());
server.listen(port, host, () => {
  console.log(`[service-package] listening on ${host}:${port} (vault, meta, etl, agent, addons)`);
});
