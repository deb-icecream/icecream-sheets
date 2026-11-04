/**
 * ETL service: recipe execution behind HTTP.
 *
 * Runs runRecipe() (packages/service/src/etl/runner.ts) with minimal local
 * deps:
 * - fetchText: global fetch (node 20+).
 * - connectors: an EMPTY ConnectorRegistry — connector-backed sources fail
 *   closed with "unknown connector". PROD WIRES THE REAL CONNECTORS HERE
 *   (the connector registry from packages/service/src/connectors/, with the
 *   credential vault seam), never in this local stub.
 * - vault: fail-closed credential resolver — credentialRef sources need the
 *   real vault service in prod.
 * - writer: in-memory atomic table writer (per targetKey).
 * - versions: in-memory VersionStore (retention for failed-run recovery).
 * - runCode: absent — `custom` transform steps fail closed, per the runner.
 * - checkPermission: absent locally. Prod enforces design-docs/etl-pipeline.md
 *   §6 here: read on the credential + write on the target, via the host's
 *   checkPermission callback.
 *
 * Endpoints:
 * - GET  /health
 * - POST /run { recipe: EtlRecipe } → the RunRecord as JSON
 */
import type { RequestListener } from 'node:http';
export declare function createEtlListener(): RequestListener;
