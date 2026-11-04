# Icecream Sheets v2 backlog

Compiled 2026-10-15 from the "v2" sections of the design notes. No consolidated v2 backlog document exists in the artifact; each item below is verbatim from the named design note's v2 section.

## Permission model

Tracked v2 backlog. Explicit deny entries, only if a real case demands them.

## ETL pipeline

Tracked v2 backlog. Streaming or incremental merge into the loaded table. Cross-workbook pipeline references. Multi-target fan-out.

## AI Agent

Tracked v2 backlog. Agent-initiated sharing or permission changes. Cross-workbook agent actions. Third-party agents inside the product boundary: resolved October 13, 2026. Rejected by design principle. Third parties remain MCP clients outside the web-service boundary. The boundary is the trust line and exactly one product-native agent lives inside it.

## No-code app builder

Tracked v2 backlog. Calendar, map and dashboard views. Row-level slice rules per role. Custom actions, webhooks and automation rules. Offline packaging.

## Named ranges and named functions

Tracked v2 backlog. Cross-workbook name references. A function library shared across workbooks. Name-scoped access distinct from the underlying range permissions.

## Add-on model

Tracked v2 backlog. Paid add-ons and billing. Scheduled and event-driven add-on triggers. Add-on to add-on communication.

## Native reports and dashboards

Tracked v2 backlog. Custom visual SDK. Real-time streaming visuals. Report-level calculated tables. Cross-workbook report data sources.

## Deterministic inference

Tracked v2 backlog. Learning across workbooks. Custom inference rules defined by the user.

## Workbook protection and encryption

Tracked v2 backlog. Customer-managed keys. Field-level encryption. Digital signatures for workbooks.

## Automation lane

Added 2026-10-15. Tracked v2 backlog. Byte-faithful VBA execution. Cross-workbook automation references. Long-running queued jobs.

## Print and page layout

Added 2026-10-15. Tracked v2 backlog. Custom page-render plugins. Server-side bulk print queues.

## Platform shell

Added 2026-10-15. Tracked v2 backlog. Native mobile clients. Multi-window desktop.
