# @icecream-sheets/ods-adapter

ODS (OpenDocument Spreadsheet) storage adapter for Icecream Sheets (track 9: file-format).

## Features

- Reads/writes the core ODS table model (`table:table` / `table:table-row` / `table:table-cell` in `content.xml`)
- Handles `table:number-rows-repeated` and `table:number-columns-repeated` (expanded on read)
- Formula cells: OpenFormula `of:=` prefix converted to/from the engine's `=` convention
- Types: float, percentage, currency, boolean, string
- Minimal XML parser/serializer (no external XML dependency); ZIP via fflate

## Limitations

- Styles, merged cells, column widths, print settings: not preserved
- Repeated rows/cells are expanded on read, not emitted on write
- No encryption support (password-protected ODS not supported)
