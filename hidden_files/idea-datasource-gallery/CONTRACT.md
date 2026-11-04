# Open Data Source Gallery — CONTRACT (coordinator's working plan)

Brief: hidden_files/idea-datasource-gallery/BRIEF.md. Existing state
(code-verified 2026-10-21): OpenDataSourceDialog.tsx exists (kind tabs,
test→preview rows, open→sheet via App.handleOpenDataSource) but:
(1) preview shows rows, NO column types — no true schema preview;
(2) dialog + App refresh call registry.fetch(spec) with NO deps — no
resolveCredential, no sqlDriver, so credentialed REST fails and SQL
always throws "no SQL driver configured" in the web app;
(3) no way to ENTER a secret: only a raw credentialRef text field.

## Design (follows existing patterns exactly)

Secrets: ALL ref derivation is server-side from the gateway-injected
x-principal (vaultSvc rule: refs must start with `${principal}:`).
The browser sends a secret exactly once, over the authenticated
gateway route, to the connectors service, which stores it in the
vault service (VAULT_URL, default http://127.0.0.1:8102, forwarding
x-principal). Refs: `${principal}:ds:sql:<connectionName>` and
`${principal}:ds:rest:<name>`. Specs carry only credentialRef.

New connectors service (packages/gateway, service-family pattern):
- src/services/connectorSvc.ts — createConnectorListener():
  - GET /health
  - POST /credential/store { name, secret } → vault store under
    `${principal}:ds:rest:<name>`; returns { ref }. (Generic: kind
    field 'rest'|'sql' selects the ds:<kind>: segment.)
  - POST /sql/store-connection { connection, connectionString } →
    vault store under `${principal}:ds:sql:<connection>`; { ref }.
  - POST /sql/tables { connection } → connection string from vault;
    list tables+views from sqlite_master.
  - POST /sql/schema { connection, table } → PRAGMA table_info:
    [{ name, type, notnull, pk }].
  - POST /sql/query { connection, query, params } → { columns, rows }
    (SqlRow objects). Driver: node:sqlite DatabaseSync readOnly.
    Connection string forms: sqlite://<path>, sqlite:<path>, bare
    absolute path; other schemes → clear error (only the sqlite
    driver ships in this build). Read-only enforcement: single
    statement only; must start SELECT / WITH…SELECT / EXPLAIN /
    read PRAGMA; hard row cap 10_000 with truncated flag.
- src/bin/connectors.ts — PORT default 8108, HOST env (mirror vault bin).
- Gateway wiring: bin/gateway.ts routes add '/api/connectors' →
  CONNECTOR_URL ?? http://127.0.0.1:8108; gateway.ts
  SERVICE_FAMILY_ROUTE_PREFIXES += '/api/connectors';
  services/servicePackage.ts: SERVICE_PACKAGE_SERVICES += 'connectors',
  surfaces.connectors = createConnectorListener(). (Production runs
  SERVICE_COMBINED, so servicePackage is the deploy-relevant surface.)

Web (apps/web):
- services/gatewayClient.ts: methods connectorsStoreCredential,
  connectorsStoreSqlConnection, connectorsSqlTables, connectorsSqlSchema,
  connectorsSqlQuery — thin this.call wrappers.
- services/httpSqlDriver.ts: SqlDriver { id: 'sqlite' } whose
  query(connection, sql, params) → connectorsSqlQuery. Browser never
  sees the connection string after the one store call.
- features/dataSources.ts: export buildConnectorDeps(gateway) →
  { resolveCredential: { resolveCredential: async (ref) =>
    (await gateway.vaultRetrieve(ref)).secret }, sqlDriver } when a
  gateway client exists; {} otherwise. Mirror App.tsx:6641's pattern.
- App.tsx: dialog fetch + refreshOneBinding pass these deps.
- OpenDataSourceDialog.tsx rework:
  - Gallery template cards: "CSV / JSON URL" (one card; format select
    CSV|JSON → kind csv-url|json-url), "REST API", "SQL database",
    "Google Sheets" (existing capability kept).
  - Secret inputs (type=password): REST "API token" (optional);
    SQL "Connection string" (required for SQL) + connection NAME.
    On Test/Open: store secret via connectors service FIRST, then
    spec.credentialRef = returned ref. Local (non-gateway) mode:
    secret fields disabled with hint; public sources still work;
    SQL shows the existing clear no-driver error.
  - SCHEMA PREVIEW step: "Test connection & preview schema" →
    schema panel (Column | Type table + row count) BEFORE Open is
    enabled/completed; sample rows remain below the schema. SQL:
    test → tables list → pick table (query auto-fills
    SELECT * FROM t) → schema via /sql/schema (declared types);
    URL kinds: schema = TableData columns + inferred types.
  - Open materializes via existing onOpen path (unchanged).

## Shared fixtures (hidden_files/shared-fixtures/) — shared with the
agent-features workstream (their case 7):
- sales-data.json (canonical dataset), sales.csv (same rows),
  seed-sales-db.mjs → sales.db (tables: sales, products),
  rest-server.mjs on 127.0.0.1:8199: GET /health (open),
  GET /sales.csv (open, CORS *), GET /api/sales (JSON {records:[…]};
  requires Authorization: Bearer TESTSECRET-ds-gallery-7f3a, else 401;
  CORS incl. Authorization header). README.md documenting all of it.
Dataset: sales(order_id number, order_date date, region text,
product text, units number, unit_price number, revenue number) ~24
rows + products(product text, category text, unit_price number).

## Tests
- packages/gateway/tests/connectorSvc.test.ts: listener + stub vault
  HTTP server: store→tables→schema→query round-trip; read-only
  rejections (INSERT/DELETE/DROP/multi-statement); unknown
  connection → clear error; non-sqlite scheme rejected.
- apps/web dialog tests: gallery cards render; schema preview shows
  columns+types before open; SQL flow lists tables; secret-store
  called before fetch; spec carries ref only.
- VAULT-SEAM test (web): enter marker secret TESTSECRET-ds-gallery-7f3a
  through both flows (mocked gateway client), then assert the marker
  appears NOWHERE in localStorage keys/values, persisted bindings
  JSON, or captured console output.
- Regression: packages/service connectors tests, apps/web
  dataSources.test.ts, web + gateway tsc/build clean.

## Validation (worker B, after build; real browser, local stack)
Stack via hidden_files/idea-datasource-gallery/start-stack.sh
(finisher pattern + connectors bin on 8108 + fixture server + vite
preview :4173 of a FRESH dist — coordinate: never rebuild dist while
another coordinator tours; check phase2/product-layer activity first).
Gateway login (test user) → per template: schema preview screenshot →
open in grid → formula (=SUM over a numeric column) computes → insert
chart → build pivot → screenshots. Vault evidence: grep marker in
browser localStorage dump, service logs, repo tree → absent. XLSX
open+save regression. Verdicts + evidence paths in final report.
