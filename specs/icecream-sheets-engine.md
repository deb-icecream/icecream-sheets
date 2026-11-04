# Icecream Sheets Technology Spec

Decided October 14, 2026 by Deb.

## Languages

**TypeScript everywhere product-side:**
- Calculation engine (HyperFormula integration)
- Web client (React)
- Desktop app (Electron bundles the TS engine)
- Backend services (Node.js: MCP server, ETL runner, API layer, AI Agent host)
- Storage adapters, automation lane, all integrations

**Python where needed:**
- Sandboxed user code: custom functions, ETL transforms, automation scripts
- Data science style workloads users bring

**JavaScript and TypeScript (sandboxed):**
- Same sandbox as Python: custom functions, ETL transforms, automation scripts
- User's choice; TS compiles to JS before running

**Excel formula language:**
- What users type in cells (`=SUM(A1:A10)`, `=VLOOKUP(...)`, etc.)
- Evaluated by HyperFormula

**Generated (not hand-written):**
- SQL: produced by TypeScript storage adapters
- HTML/CSS: rendered by the React client

## Engine: HyperFormula on TypeScript

The calculation engine builds on HyperFormula, the open-source TypeScript spreadsheet engine from Handsontable. 400+ Excel-compatible functions, dependency graph, recalculation orchestration.

SheetJS (`xlsx` package) handles XLSX file reading and writing. It does file format I/O only, not formula evaluation.

## Key decisions

- No Rust. The earlier Rust candidate assumed a custom multithreaded engine built from scratch. With HyperFormula as the base, that work doesn't exist and Rust adds nothing.
- No custom multithreaded engine. The multithreading requirement is superseded by the HyperFormula decision. HyperFormula is single-threaded; performance is acceptable for target workbook sizes.
- Desktop bundles the TypeScript engine via Electron. No native binary, no FFI.
- Web server runs the same TypeScript engine on Node.js. One codebase, both targets.
- No native dependencies for the engine core.

## Dependencies

- `hyperformula`: formula parsing, evaluation, dependency tracking, recalculation
- `xlsx` (SheetJS): XLSX file format reading and writing

## Connector vs component taxonomy (from design notes)

- A connector connects to a separate service with authentication (third-party integration work).
- A component is Icecream Sheets' own code (native, first-party).
- Connectors: mail connector (Email submenu), Google connectors (GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE, IMPORTRANGE).
- Components: fetch component (IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTXML, IMAGE), macro UI, download serializers, form controls.
