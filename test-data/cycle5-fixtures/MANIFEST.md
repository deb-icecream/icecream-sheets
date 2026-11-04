# Cycle 5 Validation Fixtures

Downloaded 2026-10-19. Each file verified by unzipping and inspecting the raw XML — not trusted by filename.

## 1. Pivot table — `pivot-table-closedxml.xlsx`
- **Source:** https://github.com/ClosedXML/ClosedXML (ClosedXML.Tests/Resource/Examples/PivotTables/PivotTables.xlsx)
- **Scenario:** Pivot table import (pivot cache + table parsing, layout engine, round-trip)
- **Verification evidence:**
  - `xl/pivotTables/pivotTable.xml` through `pivotTable7.xml` — 7 pivot table definitions present
  - `pivotCache/pivotCacheDefinition1.xml` + `pivotCache/pivotCacheRecords1.xml` — pivot cache with records present

## 2. OLAP cube functions — `olap-cube-closedxml.xlsx`
- **Source:** https://github.com/ClosedXML/ClosedXML (ClosedXML.Tests/Resource/Other/Cubes/CubeFromRange-Output.xlsx)
- **Scenario:** OLAP cube functions (CUBEVALUE, CUBEMEMBER, etc.)
- **Verification evidence:**
  - `xl/worksheets/sheet2.xml` contains 6× `CUBEMEMBER(` and 8× `CUBEVALUE(` formulas
  - `xl/connections.xml` contains `ThisWorkbookDataModel` OLAP connection (`<olapPr>`, Data Model)

## 3. External workbook references — `external-link-closedxml.xlsx`
- **Source:** https://github.com/ClosedXML/ClosedXML (ClosedXML.Tests/Resource/Other/ExternalLinks/WorkbookWithExternalLink.xlsx)
- **Scenario:** External workbook references (`[N]Sheet!Cell` format, external link resolution, cached values)
- **Verification evidence:**
  - `xl/worksheets/sheet1.xml` contains formula `<f>[1]Sheet1!$A$1</f>`
  - `xl/externalLinks/externalLink1.xml` present with cached value "hello world" in A1
  - Note: the referenced external file itself is embedded as cached sheet data (no separate file needed)

## 4. BINOM.DIST / F.INV.RT — `binom-dist-libretexts.xlsx`
- **Source:** https://stats.libretexts.org (Fresno City College Business Statistics, Ch. 3.2 Binomial Probability)
- **Scenario:** Statistical precision (BINOM.DIST; F.INV.RT shares the same high-precision code path)
- **Verification evidence:**
  - `xl/worksheets/sheet1.xml` contains `BINOM.DIST(A5,$B$1,$B$2,FALSE)` and `BINOM.DIST(A6,$B$1,$B$2,TRUE)` formulas (both cumulative and non-cumulative forms)
