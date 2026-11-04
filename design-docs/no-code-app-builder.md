# No-code app builder

Decided October 13, 2026. The native no-code component that generates data apps from sheet tables. Apps are clients of the typed computational view and run inside the web-service boundary.

## 1. Placement

The builder and the app runtime are service-layer components, like ETL. The runtime never touches the engine or storage directly. It reads and writes through the typed computational view and the storage adapters' read and write capabilities. Formulas in bound tables evaluate normally through the engine.

## 2. App spec

An app is a versioned, serializable spec: data bindings naming tables by stable object id, views, actions, navigation and display options. The spec lives in the service metadata store, never in workbook bytes. Versioning lets the format grow, for example with new view types later, without breaking existing apps.

## 3. Generation from tables

Point the builder at a table and get a working app immediately. Default views are derived from the typed view's column types: text, numeric, date, image URL and reference columns, where a reference column becomes a linked detail view into the related table. The user refines from the generated starting point. The AI Agent can generate and edit app specs through MCP app-builder tools, acting as the user under the shared permission model.

## 4. Views in v1

Table (grid), detail (single record), form (add and edit with type-driven inputs and validation) and cards. Each view binds to a table or a filtered slice of one. Calendar, map and dashboard views are v2.

## 5. Actions in v1

Add row, edit row, delete row and navigate between views. Deleting a row requires confirmation. Every write goes through authorize() as the end user before any mutation, exactly like any other client. Custom actions, webhooks, automation rules and triggering ETL recipes are v2.

## 6. Permissions

The app is an object in the permission tree. The manage right is required to edit the app spec. End users see exactly what their own table permissions allow: every data access runs through authorize() as the end user, and the app renders the per-subject filtered view. Sharing an app with someone who cannot read the underlying table shows them nothing until table access is granted. There is no parallel permission universe for apps.

## 7. Templates and learning

Sample apps ship as product-owned templates written in the same spec format. Guidance content is product-owned with no external service dependency.

## 8. Out of scope for v1

Calendar, map and dashboard views. Row-level slice rules per role. Custom actions, webhooks and automation. Offline packaging.

## No-code app builder v2

Tracked v2 backlog. Calendar, map and dashboard views. Row-level slice rules per role. Custom actions, webhooks and automation rules. Offline packaging.
