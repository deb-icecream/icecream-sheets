# Cycle 6 Validation Fixtures

Downloaded 2026-10-19. Each file was verified by unzipping and inspecting the raw XML — not trusted by filename. Intended for Cycle 8 re-validation of the 4 Cycle 6 scenarios (open in web app → screenshot → self-inspect).

| # | File | Size | Scenario | Verification evidence |
|---|---|---|---|---|
| 1 | `trendline.xlsx` | 12.5 KB | Chart trendline | Real xlsx-populate test fixture (`xlsxpopulate-ranges-out.xlsx`). `xl/charts/chart1.xml` contains `<c:trendline>` with `<c:trendlineType val="poly"/>`, `<c:order val="2"/>`, named "CTR Trend" |
| 2 | `pivotchart.xlsx` | 1.23 MB | PivotChart (chart bound to pivot table) | Real Beyond Excel 3-statement model (`beyond-excel-bxl3way.xlsx`). 8 `<c:pivotSource>` refs across charts binding to pivot tables `pvtEarnings`, `pvtCF`, `pvtYoY`; 4 pivot table definitions in `xl/pivotTables/` |
| 3 | `geocode.xlsx` | 0.91 MB | Geocoding (location data) | 34,164 rows of real world-cities data (GeoNames via datasets/world-cities): city name, country, subcountry, geonameid. Verified: Tokyo ×120, Sydney ×3, Andorra la Vella ×2 in sheet XML |
| 4 | `smartart.xlsx` | 51 KB | SmartArt graphic | Real Vertex42 "Company Organizational Chart using SmartArt" template. `xl/diagrams/` with data1.xml, layout1.xml, drawing1.xml, colors1.xml, quickStyle1.xml; layout `urn:microsoft.com/office/officeart/2005/8/layout/pictureOrgChart+Icon` (hierarchy family); 178 `<dgm:pt>` data points |

## Sources
1. xlsx-populate GitHub test suite (already in repo at `test-data/real-world/`)
2. Beyond Excel 3-statement model (already in repo at `test-data/real-world/`)
3. https://raw.githubusercontent.com/datasets/world-cities/main/data/world-cities.csv → converted to xlsx via openpyxl
4. https://www.vertex42.com/ExcelTemplates/organizational-chart.html ("Company Organizational Chart using SmartArt" template)
