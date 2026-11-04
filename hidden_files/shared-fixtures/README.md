# Shared fixtures — Open Data Source Gallery (+ agent-features)

Canonical test data for the data-source gallery validation and the
agent-features workstream (their case 7). Everything here is shared:
both workstreams use the SAME dataset, the SAME SQLite database, and
the SAME fixture HTTP server.

## Dataset

`sales(order_id number, order_date date, region text, product text,
units number, unit_price number, revenue number)` — 24 rows,
2026-01…03, regions North/South/East/West, revenue = units × unit_price.
Plus `products(product text, category text, unit_price number)` —
4 rows (Widget/Gadget = Hardware, Gizmo/Doohickey = Electronics).

## Files

| File | What |
|---|---|
| `sales-data.json` | Canonical dataset: `{ records: [...24 sales rows], products: [...4] }`. |
| `sales.csv` | The same 24 sales rows as CSV (header + 24 lines). |
| `seed-sales-db.mjs` | Builds `sales.db` (tables `sales`, `products`) from `sales-data.json` via `node:sqlite`. Run: `node seed-sales-db.mjs [out-path]`. |
| `sales.db` | The seeded SQLite database (generated; regenerate any time with the seed script). |
| `rest-server.mjs` | Fixture HTTP server on `127.0.0.1:8199`. Run: `node rest-server.mjs [port]`. |

## Fixture server endpoints (127.0.0.1:8199)

- `GET /health` — open. `{ ok: true }`.
- `GET /sales.csv` — open, `Access-Control-Allow-Origin: *`. Serves
  `sales.csv`. Gallery CSV/JSON-URL template target:
  `http://127.0.0.1:8199/sales.csv`.
- `GET /api/sales` — returns `{ records: [...] }` (the 24 sales rows).
  Requires `Authorization: Bearer TESTSECRET-ds-gallery-7f3a`, else
  401. CORS allows the `Authorization` header. Gallery REST template
  target: URL `http://127.0.0.1:8199/api/sales`, path `records`, API
  token = the marker above.

## SQL gallery target

- Seed: `node seed-sales-db.mjs` → `sales.db` in this directory.
- Connection name (example): `sales-fixture`.
- Connection string: `sqlite://<absolute path to sales.db>` (also
  accepted: `sqlite:<path>` or the bare absolute path). Stored in the
  vault by the connectors service; the spec carries only the name.
- Tables: `sales` (24 rows), `products` (4 rows).

## Vault-seam marker

`TESTSECRET-ds-gallery-7f3a` is the test secret for the vault-seam
proof: entered through the gallery's REST and SQL flows, it must
appear NOWHERE in browser localStorage, persisted source bindings,
captured console output, service logs, or the repo tree (outside this
fixtures directory, where it is the fixture's own credential).
