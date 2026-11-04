# Print and page layout

Decided October 15, 2026. Paper output for workbooks: pagination, page setup and PDF export. A deterministic pagination engine measures the same typed content and drawing snapshot the screen renders, so page breaks stay stable across platforms.

## 1. Deterministic pagination

The pagination engine lays out pages from the versioned engine snapshot: the same typed content and drawing data the grid renders. Identical content produces identical pages on every host.

## 2. Page setup

Print areas, scaling, margins, headers, footers and manual page breaks are page setup. Setup persists as adapter metadata through storage adapters that support it; it is never stored in cell data.

## 3. Single print path

Download-as-PDF is the single print path. Print-ready pages are produced as a client of the engine protocol, not as a fork of the rendering code.

## 4. Screen parity

Print preview renders from the same snapshot as the grid. There is no separate layout implementation to drift.

## 5. XLSX round-trip

Page setup round-trips through XLSX natively: print areas, scaling, margins, headers, footers and breaks survive the round trip.

## 6. Out of scope for v1

Custom page-render plugins. Server-side bulk print queues.

## Print and page layout v2

Tracked v2 backlog. Custom page-render plugins. Server-side bulk print queues.
