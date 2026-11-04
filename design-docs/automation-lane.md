# Automation lane

Decided October 15, 2026. Scripted behavior for workbooks: macro recording, user scripts and event triggers. All automation runs in the sandbox through the permissioned automation API; there is no privileged scripting path.

## 1. Permissioned automation API

A TypeScript automation API sits over the engine protocol and the typed computational view. Every read and mutation goes through authorize(). Scripts declare the permissions they need; the user grants them once and the grant is recorded.

## 2. Action recorder

The recorder captures user actions as editable scripts. Recorded scripts replay through the same automation API as hand-written code, so a recording can never do what a script cannot.

## 3. Event runtime

Workbook and sheet events (on open, on edit, on selection change, timed triggers) fire inside the sandbox. Handlers receive a frozen event object and mutate only through the automation API.

## 4. Sandboxed execution

Scripts run in the same sandbox as custom functions: Python and JavaScript/TypeScript at the user's choice. No direct storage, network or process access. External calls go through permissioned connectors only.

## 5. Persistence

Automation writes persist through storage adapter capabilities and transactions. Adapters without transaction support get serialized, single-writer access from the automation runtime.

## 6. Migration

Common VBA and Apps Script patterns translate to the automation lane with declared permissions and typed-view access. The XLSX adapter preserves original macro projects byte-for-byte as hints. Unmigrated Windows automation runs isolated in a compatibility runner, never inside the engine process.

## 7. Agent boundary

The product-native AI Agent acts through MCP tools, never through the automation lane. User scripts and agent actions do not share a privilege path and cannot escalate each other.

## 8. Out of scope for v1

Byte-faithful VBA execution. Cross-workbook automation references. Long-running queued jobs.

## Automation lane v2

Tracked v2 backlog. Byte-faithful VBA execution. Cross-workbook automation references. Long-running queued jobs.
