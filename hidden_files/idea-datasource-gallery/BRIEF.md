# Open Data Source Gallery — BRIEF (Idea idea_25cc935038eb4b54925282084333a76d)

User accepted 2026-10-21. This also answers the user's in-chat
question about setting up connectors (incl. SQL via connection
string): the gallery IS the setup surface. Build in apps/web over the
existing connector registry (packages/service/src/connectors:
registry.ts, csv.ts, json.ts, rest.ts, sql.ts + the credential vault
seam) and the existing features/dataSources.ts wiring.

## Outcome
An "Open data source" gallery in the app: one-click templates for the
registry's three source types — SQL database, REST API, CSV/JSON URL —
each with a setup flow, a SCHEMA PREVIEW (columns + types) shown
BEFORE any data loads, and opening the source renders it in the SAME
Excel grid view (existing grid; no separate/simplified grid), with
formulas, charts, and pivots working on its data.

## Requirements
- No new connector types beyond the registry's SQL / REST / CSV-JSON.
- Credentials ONLY through the vault seam: never persisted in app
  storage, never logged, never written to disk outside the vault. A
  test must assert a entered secret appears nowhere in storage/logs.
- SQL setup accepts a connection string (and/or field form); the flow
  tests the connection and lists tables before opening.
- Existing file open/save flows are NOT changed (regression-proof).
- No stubs: every template completes a LIVE round-trip.

## Validation (live round-trips, real browser, screenshots)
1. CSV/JSON URL: a real CSV served over HTTP locally → schema preview
   → opens in grid → add a formula over the data (computes), insert a
   chart, build a pivot.
2. REST API: a local test API endpoint returning JSON → same flow.
3. SQL: a local SQL database seeded on the VM (SQLite file or local
   Postgres) via connection string → tables listed → schema preview →
   table opens in grid → formula/chart/pivot proof.
4. Vault-seam test: credential entered for SQL/REST never appears in
   localStorage, logs, or files (grep evidence).
5. Regression: standard xlsx open + save still works; related suites
   green (connectors, dataSources).

## Coordination
Other coordinators are active; one browser process per output dir;
never rebuild apps/web/dist mid-tour of another coordinator. The
agent-features coordinator runs agent queries against CSV + SQL
sources — coordinate the seeded SQL database and CSV fixture so both
workstreams can use them. NO git push — the parent pushes and
byte-verifies. Final report: per-template round-trip verdicts with
evidence paths, the vault-seam proof, regression result, and anything
NOT done stated plainly. Also note how the gallery maps to a future
Workspace "Data sources" section (product layer) in one short section.
