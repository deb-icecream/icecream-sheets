# Perf Benchmarking Fixtures

Downloaded/generated 2026-10-19. Four workbooks at increasing size percentiles for
performance benchmarking of the web app + services APIs (file open, parse, recalc,
grid render, save). All files verified as valid xlsx (`[Content_Types].xml` present).

| Percentile | File | Size | Sheets | Cells | Source |
|---|---|---|---|---|---|
| P50 (medium) | `perf-p50.xlsx` | 150,657 bytes (0.14 MB) | 21 | 5,646 | Real-world: `test-data/real-world/compressexcel-saas-3statement.xlsx` — 3-statement financial model with formulas and charts |
| P75 (large) | `perf-p75.xlsx` | 1,285,214 bytes (1.23 MB) | 13 | 5,076 | Real-world: `test-data/real-world/beyond-excel-bxl3way.xlsx` |
| P95 (very large) | `perf-p95.xlsx` | 12,691,810 bytes (12.10 MB) | 3 | 1,800,036 | Generated (`/tmp/gen_perf.py`): Sales/Inventory/Ledger sheets × 60k rows — numbers, dates, strings, formulas (SUM/IF), money/percent formatting, header styles |
| P99 (huge) | `perf-p99.xlsx` | 46,185,796 bytes (44.05 MB) | 5 | 6,500,062 | Generated (`/tmp/gen_perf.py`): 5 sheets × 100–150k rows — same realistic mix as P95, stress-test territory |

## Suggested perf scenarios per fixture

- **Open**: time from file bytes → parsed workbook → rendered grid
- **Recalc**: full recalculation after opening (formula-heavy P95/P99)
- **Edit**: single-cell edit → incremental recalc latency
- **Save**: workbook → xlsx bytes round-trip time
- **Scroll**: grid virtualization smoothness on the large sheets

## Notes

- P50/P75 are real files (better represent production shapes: charts, pivot tables, mixed content).
- P95/P99 are synthetic but realistic: order/inventory/ledger tables with FK-like IDs,
  dates, money/percent formats, per-row formulas (`LineTotal`, `Tax`, `GrandTotal`,
  `Status`, running `Balance`) plus summary-row aggregates.
- Cell counts measured via `<c ` occurrences in sheet XMLs.
