# Icecream Sheets

Icecream Sheets is a spreadsheet product with a modern architecture. The
calculation engine is separate from the UI, storage is pluggable, and the
engine projects a typed view over storage that the grid UI and AI agents
consume. The engine exposes an MCP server and sandboxed code evaluation that
formulas can call. It ships as a desktop app and a web app from one codebase,
with a product-native AI assistant that works through the same tools you do.

## Why it's different

- **An agent that does the work, not just suggests it.** The assistant reads
  ranges, computes, writes values and formulas, recalculates, and builds
  charts — calling the same permissioned tools as any other client, with every
  step recorded in an audit log. Multi-step jobs run against verifiable
  checks, and each spreadsheet keeps its own chat thread with history that
  restores across sessions and devices.
- **Apps generated from your data.** The app builder turns a sheet into a
  working dashboard or React app that reads the exact cells, with cited data
  sources — not a mockup, a runnable artifact.
- **Research built in.** The agent can search the web and fetch public pages
  through server-side providers, so it can ground answers in live sources
  without leaking keys to the browser.
- **Safe by construction.** User code runs sandboxed; anything reaching an
  outside service goes through a permissioned connector, never the engine
  directly. Secrets stay server-side.
- **Engine separated from UI.** A typed view over pluggable storage adapters
  (CSV and common spreadsheet file formats), consumed identically by the
  grid, the automation lane, and external MCP clients.
- **One codebase, desktop and web.** The engine core has no native
  dependencies, so the same product runs in Electron and the browser.

## Stack

- TypeScript everywhere product-side: engine, web client (React), desktop app
  (Electron bundles the TypeScript engine), backend services (Node.js: MCP
  server, ETL runner, API layer, AI Agent host), storage adapters, automation
  lane, integrations.
- `hyperformula`: formula parsing, evaluation, dependency tracking,
  recalculation (400+ spreadsheet functions).
- `xlsx` (SheetJS): spreadsheet file format reading and writing (I/O only,
  not evaluation).
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
| `catalog/` | The 29-track component catalog: `capabilities.json` (machine data) and `tracks.md` (readable overview with feasibility, file-format compatibility, stage, verdict per track) |
| `inventory/` | The 718-entry feature/function inventory: `feature-inventory.json` (259 features + 459 functions with per-entry fit), `function-categories.json`, and the original inventory source |
| `backlog/` | `v2-backlog.md`, compiled from the v2 sections of the design notes (no consolidated backlog document exists yet) |

## Inventory fit

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
- External-reaching functions (e.g. IMPORTDATA, finance quotes) go through
  permissioned connectors, never the engine directly.
- One product-native AI agent lives inside the product boundary; third parties
  remain MCP clients outside it.
