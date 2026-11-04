# @icecream-sheets/csv-adapter

CSV/TSV storage adapter for Icecream Sheets (track 9: file-format).

## Features

- RFC 4180 compliant parsing: quoted fields, escaped quotes (`""`), embedded newlines, CRLF/LF line endings, BOM stripping
- Delimiter auto-detection: comma, tab, semicolon, pipe (first non-empty line decides)
- `CsvAdapter` with configurable delimiter; `TsvAdapter` forces tab
- Single-sheet workbooks: read returns one sheet named "Sheet1"; write serializes the first sheet

## Limitations

- Formulas are NOT reconstituted: a cell starting with `=` reads as a plain string (matches Excel's CSV import behavior)
- Extra sheets are dropped on write (noted in metadata)
- No encryption support
