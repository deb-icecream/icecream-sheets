# Icecream Sheets

Icecream Sheets is a spreadsheet product: Excel-class calculation with a modern
architecture. The engine is separate from the UI, storage is pluggable, and the
engine projects a typed view over storage that the grid UI and MCP agents
consume. The engine exposes an MCP server and sandboxed code evaluation that
formulas can call.

## Stack (decided October 14, 2026)

- TypeScript everywhere product-side: engine, web client (React), desktop app
  (Electron bundles the TypeScript engine), backend services (Node.js: MCP
  server, ETL runner, API layer, AI Agent host), storage adapters, automation
  lane, integrations.
- `hyperformula`: formula parsing, evaluation, dependency tracking,
  recalculation (400+ Excel-compatible functions).
- `xlsx` (SheetJS): XLSX file format reading and writing (I/O only, not
  evaluation).
- Python and sandboxed JavaScript/TypeScript for user code: custom functions,
  ETL transforms, automation scripts.
- One codebase runs on desktop (Electron) and web (Node.js). No native
  dependencies in the engine core, no Rust, no custom multithreaded engine.

Planned distribution: free Mac and Windows desktop apps; web version planned.

## What's in this repo

| Folder | Contents |
|---|---|
| `specs/` | The technology spec: languages, engine decisions, dependencies, connector-vs-component taxonomy |
| `design-docs/` | Design notes from the catalog (12 canonical docs plus preserved duplicate report sections), each with its v1 design and v2 section |
| `catalog/` | The 29-track component catalog: `capabilities.json` (machine data) and `tracks.md` (readable overview with feasibility, xlsx compatibility, stage, verdict per track) |
| `inventory/` | The 718-entry feature/function inventory: `feature-inventory.json` (259 features + 459 functions with per-entry fit), `function-categories.json`, and the original `google-sheets-feature-inventory.md` source |
| `backlog/` | `v2-backlog.md`, compiled 2026-10-15 from the v2 sections of the design notes (no consolidated backlog document exists yet) |

## Inventory fit (2026-10-15)

Against the engine / typed-view / storage-adapter architecture:

- 712 entries: native fit
- 5 entries: fit via adapter work
- 1 entry: does not fit
- 0 entries: need new design

The per-entry notes name the design doc or adapter each item belongs to.

## Notes

- A connector connects to a separate service with authentication
  (third-party integration work). A component is Icecream Sheets' own code
  (native, first-party).
- External-reaching functions (e.g. IMPORTDATA, GOOGLEFINANCE) go through
  permissioned connectors, never the engine directly.
- One product-native AI agent lives inside the product boundary; third parties
  remain MCP clients outside it.
