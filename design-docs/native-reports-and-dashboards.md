# Native reports and dashboards

Decided October 13, 2026. The native component that builds reports and dashboards from sheet tables. Not a link out, not a separate product.

## 1. Placement

The report builder and renderer are service-layer components. They read through the typed computational view and never touch the engine or storage directly.

## 2. Report spec

A report is a versioned, serializable spec: data bindings, visuals, filters, layout and refresh settings. The spec lives in the service metadata store.

## 3. Fields

Drag fields from bound tables onto the canvas. Fields are typed by the computational view. Calculated fields use the formula language.

## 4. Visuals in v1

Table, bar chart, line chart, pie chart and KPI card. Each visual binds to a table or query. More visual types are v2.

## 5. Filters

Slicers filter all visuals on the page. Filters are typed and validate against the view schema.

## 6. Freshness

Manual refresh, refresh on open, or scheduled refresh. ETL-backed tables refresh through the pipeline. The report shows the data timestamp.

## 7. Permissions

The report is an object in the permission tree. Viewers see only what their table permissions allow, through per-subject filtered views.

## 8. Export

Export to PDF through the Download as PDF path. The layout renderer handles pagination.

## 9. Out of scope for v1

Custom visual SDK. Real-time streaming visuals. Report-level calculated tables.

## Native reports and dashboards v2

Tracked v2 backlog. Custom visual SDK. Real-time streaming visuals. Report-level calculated tables. Cross-workbook report data sources.
