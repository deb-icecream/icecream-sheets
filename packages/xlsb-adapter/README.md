# @icecream-sheets/xlsb-adapter

Excel Binary Workbook (`.xlsb`, BIFF12) storage adapter — a from-scratch
BIFF12 reader/writer. (SheetJS community edition cannot parse BIFF12, so
this is hand-rolled; record layouts were validated against pyxlsb's parser
and round-tripped through LibreOffice.)

## What works

- **Values**: numbers, shared strings (SST), booleans, blanks round-trip.
  Unicode sheet names and strings supported.
- **Formulas**: the common subset (arithmetic, comparisons, cell/area refs,
  function calls from a ~120-function table) compiles to Ptg tokens and
  decompiles back. Written formulas carry a placeholder cached value of 0
  (same as the xlsx adapter) — Excel recalculates on open.
- **Structure**: multiple sheets, dimensions, minimal valid styles part.

## Honest limitations

- **Error cells** read as `null` (`CellInput` cannot represent them — same
  as the xlsx adapter).
- **Formulas**: cross-sheet references, defined names, array constants, and
  functions outside the built-in table throw a clear `XlsbFormulaError` on
  write instead of being silently corrupted. `$`-absoluteness is not
  preserved (refs are stored relative).
- **Number formats are not preserved.** The BrtNumFmt record ids are
  undocumented by every independent xlsb implementation checked (pyxlsb,
  pyxlsb2), so they are not emitted (emitting guessed ids risks colliding
  with real record types and corrupting files).
- **Styles**: the styles part is structurally valid, but per-cell
  fonts/fills are not surfaced (`CellInput` has no style slot).
- **Not supported**: charts, images, pivot tables, merged cells, VBA,
  encryption. `preservesUnknownParts` is false — the package is rebuilt
  from the parsed model on write.
- **LibreOffice**: LO 24.2's xlsb import filter does not implement string
  or formula cells (verified by brute-forcing record ids 0x01–0x0B) — it
  reads numbers/booleans/blanks but drops strings and formulas. This is a
  LibreOffice limitation; the files use the same 0x0007+SST encoding that
  Excel writes (verified with pyxlsb, which parses real Excel files).

## Layout of the implementation

- `src/biff12.ts` — record framing (id/length codec), Reader/Writer
  primitives, RK decoding, BIFF error codes. Every record id used is
  verified against pyxlsb's record table.
- `src/ptg.ts` — formula text ↔ Ptg token compiler/decompiler
  (tokenizer, shunting-yard, emitter).
- `src/records.ts` — workbook / worksheet / SST / styles part
  builders and parsers.
- `src/adapter.ts` — the `XlsbAdapter` (`StorageAdapter`).
