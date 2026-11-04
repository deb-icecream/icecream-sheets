# AGENT.md — Build instructions for Icecream Sheets

Read this file first. It is the single source of truth for how to build this
product. The design docs in `design-docs/` say WHAT to build; this file says
HOW to build it and in what order. When this file and a design doc disagree,
this file wins on process and the design doc wins on product behavior. When
either disagrees with Deb, Deb wins.

## 0. Design-Doc Compliance (NON-NEGOTIABLE RULE)

**Always read the design docs before building.** The 17 design docs in
`design-docs/` specify WHERE components live, WHAT interfaces they expose,
and HOW they integrate. Every implementation MUST follow the designs.

Rules:
1. Before building anything new, read ALL relevant design docs first.
2. Before modifying existing code, verify it matches the design docs. If it
   doesn't, redo it according to the design.
3. When a design doc specifies placement (e.g., "service-layer component"),
   interfaces, or architecture — follow it exactly. Do not invent alternatives.
4. The design docs are the authority on product behavior and architecture.
   This file (AGENT.md) is the authority on build process and order.
5. When in doubt, re-read the design doc. Never guess.

Design docs index:
- `accessibility.md` — accessibility (WCAG 2.2 AA, native AX trees)
- `add-on-model.md` — add-on architecture
- `ai-agent.md` — AI-native agent design
- `automation-lane.md` — automation components
- `connector-vs-component.md` — component vs connector pattern (READ THIS FIRST)
- `deployment-architecture.md` — deployment (Cloud Run, gateway, signed-URL engine access)
- `deterministic-inference.md` — deterministic AI inference
- `etl-pipeline.md` — ETL pipeline design
- `named-ranges-and-named-functions.md` — named ranges
- `native-reports-and-dashboards.md` — charts, pivots, reports
- `no-code-app-builder.md` — app builder
- `permission-model.md` — permissions
- `platform-shell.md` — desktop (Mac/Windows) shell
- `print-and-page-layout.md` — print layout
- `report-duplicates-preserved.md` — duplicate handling
- `revision-model-save-and-coauthoring.md` — revision model: save/autosave/download, session ownership, co-authoring (AUTHORITATIVE for all save and co-authoring work)
- `workbook-protection-and-encryption.md` — protection

## 1. What you are building

Icecream Sheets: a spreadsheet product with Excel-class calculation and a
modern architecture. Free Mac and Windows desktop apps; a web version is
planned. This is not a clone of any existing product: Excel parity means
behavioral compatibility where users depend on it, not imitation.

Public writing rule: use generic category terms (spreadsheet, presentation
software, word processor). Never name competing products in anything
user-facing.

## 2. Non-negotiable architecture (decided by Deb, do not relitigate)

- **Engine separate from UI.** One headless TypeScript engine core runs
  everywhere: desktop (Electron bundles it), web (Node.js service), and any
  future host. No host forks calculation semantics.
- **Typed computational view.** The engine projects a typed view over
  storage and computes over that view. The grid UI and MCP agents are
  consumers of the view, never of storage internals.
- **Pluggable storage backends**, independent of the engine. Storage
  adapters implement a capability interface; the engine never assumes which
  adapter backs the view.
- **MCP server on the engine.** The engine exposes a versioned MCP surface.
  The product-native AI Agent acts as the user ONLY through MCP tools.
  Third-party agents stay outside the product boundary as MCP clients.
- **Sandboxed code evaluation callable from formulas.** Python and
  JavaScript/TypeScript run in a capability-secured sandbox: no ambient
  network, filesystem, clock, or randomness; CPU, memory, and recursion
  limits enforced. Deterministic and side-effect-free.
- **ETL is a separate component beside the pure engine**, not inside it.
- **Apps and add-ons are clients of the typed view through `authorize()`.**
  Every read and mutation goes through authorization. There is no
  privileged scripting path.
- **Materialized, event-driven refresh in v1.** No lazy half-refresh.
- **Download-as-PDF is the single print path.** No OS print dialog
  integration in v1.
- **v2 tracking:** anything pushed out of v1 goes in `backlog/v2-backlog.md`,
  never silently dropped.

## 3. Locked stack (decided October 14, 2026)

- **TypeScript everywhere product-side.** Engine, React web client, Electron
  desktop shell, Node.js backend services (MCP server, ETL runner, API
  layer, AI Agent host), storage adapters, automation lane, integrations.
- **`hyperformula`** — formula parsing, evaluation, dependency tracking,
  recalculation (400+ Excel-compatible functions). This IS the calculation
  core; do not build a formula engine from scratch.
- **`xlsx` (SheetJS)** — XLSX file reading and writing. I/O only, never
  evaluation.
- **Python and JS/TS in the sandbox** — user custom functions, ETL
  transforms, automation scripts. User's choice of language.
- **No Rust. No custom multithreaded engine. No native dependencies in the
  engine core.** HyperFormula is single-threaded; that is acceptable.
- SQL is generated by TypeScript storage adapters, never hand-written.
  HTML/CSS is rendered by the React client, never hand-written.

## 4. Connector vs component (taxonomy, decided October 13, 2026)

- A **connector** connects to a separate service with authentication
  (third-party integration work).
- A **component** is our own code (native, first-party).
- External-reaching functions (IMPORTDATA, GOOGLEFINANCE-style, and
  equivalents) go through permissioned connectors, never the engine
  directly. Fetch/import functions are a first-party fetch component.
- AppSheet-equivalents become a native app-builder component; Data
  Studio-equivalents become a native reports component.

## 5. How to read this repo

| Path | What it is | How to use it |
|---|---|---|
| `specs/icecream-sheets-engine.md` | Technology spec: languages, engine decisions, dependencies | Constraints; do not violate |
| `design-docs/` (15 files) | Product designs, each with v1 design + v2 section | Build the v1 sections; v2 sections are backlog, not scope |
| `design-docs/connector-vs-component.md` | Taxonomy note | Apply when classifying new work |
| `catalog/tracks.md` + `catalog/capabilities.json` | 29 capability tracks with feasibility, xlsx compat, stage, verdict | Build sequencing input; `capabilities.json` is machine-readable |
| `inventory/feature-inventory.json` | 718 entries (259 features + 459 functions) with per-entry fit | 712 native fit, 5 adapter fit, 1 no-fit, 0 needing new design. The no-fit entry stays out. |
| `backlog/v2-backlog.md` | 36 deferred items compiled from design-note v2 sections | Explicitly OUT of v1 scope |

## 6. Build order

Build in phases. Do not start a later phase until the earlier one has
passing tests. Each phase ends with a demoable, test-covered increment.

**Phase 1 — Engine core.** HyperFormula integration behind the engine
boundary: workbook model, formula parsing and evaluation, dependency graph,
recalculation, the typed computational view, versioned engine protocol
(commands, snapshots, subscriptions). Headless package with no UI or
persistence imports. Success: open a workbook in memory, set formulas,
recalculate, read results through the view.

**Phase 2 — XLSX round-trip.** SheetJS storage adapter: read and write
`.xlsx` preserving what we support; preserve unsupported OOXML records
byte-for-byte for round-trip. Page setup stored as adapter metadata.
Success: open real-world `.xlsx` files, recalculate, save, reopen
identically.

**Phase 3 — MCP server + sandbox.** Versioned MCP surface over the engine
protocol; capability-secured sandbox for Python and JS/TS custom functions
callable from formulas. Success: an MCP client can read/write cells and
invoke a sandboxed custom function.

**Phase 4 — Grid UI (web).** React client as a pure consumer of the engine
protocol: virtualized grid, formula bar, sheet tabs, formatting, clipboard,
undo/redo, find/replace. No calculation logic in the client. Success:
edit a workbook in the browser against the Phase 1 engine.

**Phase 5 — Desktop shell.** Electron packaging of the identical engine
core plus platform shell behaviors (workbook lifecycle, menus, settings,
offline replay). Success: same workbook behaves identically on web and
desktop.

**Phase 6 — Tracks in catalog order.** Work through `catalog/tracks.md`
foundation stage first (calculation engine details, formula language
coverage bands, grid completeness), then product stage (charts, pivots,
reports), then ecosystem (connectors, ETL pipeline, automation lane,
add-on model, AI Agent). Each track ships against behavioral tests from
the inventory entries mapped to it.

**Out of scope for v1:** everything in `backlog/v2-backlog.md`.

## 7. Working conventions

- TypeScript strict mode. No `any` in engine or protocol code; sandbox
  boundaries get explicit types.
- Tests are mandatory per phase: unit tests for engine behavior,
  behavioral fixture tests for formula compatibility (use the inventory's
  function entries as the corpus), round-trip fixtures for XLSX.
- The engine core must have zero native dependencies. If a dependency
  needs a native binding, it does not go in the core.
- Every storage adapter implements the capability interface and declares
  what it supports; the engine adapts, never assumes.
- Permissions: `authorize()` on every mutation path, including automation
  scripts, add-ons, and the AI Agent. Record grants.
- Deterministic builds: no network, clock, or randomness in the
  calculation path. Seeded where determinism matters (see
  `design-docs/deterministic-inference.md`).
- Commit messages reference the design doc or track being implemented.

## 8. Definition of done for the whole build

A user can open an `.xlsx` file on Mac or Windows desktop or the web,
edit formulas with Excel-compatible behavior, save and round-trip the
file, automate via the automation lane, extend via sandboxed custom
functions, and drive everything through the MCP server, with all v1
design docs implemented and their behavioral tests green, and nothing
from `backlog/v2-backlog.md` started.
