# ETL pipeline

Decided October 13, 2026. The service-layer component that runs repeatable extract-transform-load recipes and materializes typed tables.

## 1. Recipe and execution model

A recipe is a versioned, serializable typed DAG: exactly one source node, zero or more transform nodes and exactly one load node, with typed table edges. The recipe is schema-validated at design time, before anything executes.

Execution triggers are manual, on workbook open or on a schedule. Runs are asynchronous with progress and per-step row counts. When a run completes it emits a change event and the engine recalculates normally. Formulas never trigger a refresh.

There is no engine-boundary question in this design. After transform and load, the engine simply evaluates ordinary typed data.

## 2. Source node and connector SDK

The source node pulls from either the built-in fetch component (uploaded files and public URLs) or the connector registry (authenticated external sources, following the connector versus component distinction).

Connector authors implement a small SDK surface: authenticate using a credential reference, describe the source schema and extract with pagination and incremental cursors.

## 3. Transform nodes

The fixed typed operation library covers select and drop, rename, type conversion, filtering, sorting, split and merge of columns, pivot and unpivot, merge and append of tables, grouping, fill down and deduplication.

A custom operation runs user-supplied Python, JavaScript or TypeScript in the sandbox with typed table-in and table-out contracts, callable the same way formulas can call sandboxed code.

## 4. Load node

The load node writes into a workbook table or any supported adapter target. Every run materializes a full copy and swaps it in atomically, so readers never see a partially written table. Old versions are retained according to the retention policy, and a failed run never replaces the last good load.

## 5. Failure behavior

Retry transient failures with backoff. Quarantine rows that fail transformation along with their reasons. Abort the run when a configured error threshold is exceeded. Always preserve the previous loaded table on failed runs.

## 6. Credentials and permissions

Credentials live in the service vault. The recipe stores only credential references. A scheduled run executes as the pipeline owner.

Permissions follow the permission model: the recipe is an object in the permission tree, the manage right is required to edit it and running it requires read on the credential and write on the target.

## 7. Editor UI and shared substrate

The editor UI is an applied-step list with expandable parameters, a live output preview per step, refresh and schedule controls and a run history.

IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTXML and IMAGE share one substrate with ETL: the same fetch component and the same connector SDK.

## 8. Out of scope for v1

Streaming or incremental merge into the loaded table. Cross-workbook pipeline references. Multi-target fan-out.

## Resolved decisions (2026-10-18)

**Single connector registry:** §2's "connector registry" is exactly one
registry — packages/service/src/connectors/registry.ts. The ETL-local
registry class was removed; ETL source nodes consume the canonical
registry via its spec-driven `fetch()` (validated ConnectorSpec, vault
credentialRef, row caps). Connector authors who prefer the paginated SDK
surface (`EtlConnector`: authenticate/describeSchema/extract) register via
`adaptEtlConnector()`, which wraps them as a canonical `Connector`.
Custom kinds validate (shape/secrets/URL checks; required-params checks
apply to built-in kinds only).

**Chart attachments through the gateway:** the AI agent's chart attachment
(`reply.chart`: `{ title, config }`) travels through the gateway as plain
versioned JSON — no binary encoding. The gateway `/message` handler
forwards it (it previously dropped the field); covered by a round-trip
test in packages/gateway/tests/services.test.ts.

**Heatmap matrix visual:** Excel has no native heatmap chart type, but data
analysis needs it (correlation matrices). It ships as a first-class
**matrix visual** in the reports component (`heatmap.ts`), not a chart
kind: versioned HeatmapSpec, sequential + diverging color scales backed by
the chart color-scale logic, `heatmapFromRecords` and `correlationHeatmap`
builders, rendered as a labeled grid in the web Reports UI and print path.

## ETL pipeline v2

Tracked v2 backlog. Streaming or incremental merge into the loaded table. Cross-workbook pipeline references. Multi-target fan-out.
