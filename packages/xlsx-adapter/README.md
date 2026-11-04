# @icecream-sheets/xlsx-adapter

XLSX (OOXML spreadsheet) storage adapter for Icecream Sheets, built on the
SheetJS community edition (`xlsx`). Implements the engine's `StorageAdapter`
contract: parse XLSX bytes into `WorkbookData`, and serialize `WorkbookData`
back to XLSX bytes.

## Capabilities

| Capability | Value | Notes |
|---|---|---|
| `readable` | true | Parses `.xlsx` packages (ZIP/OOXML). |
| `writable` | true | Serializes `WorkbookData` to `.xlsx`. |
| `transactional` | false | Each `write` produces a fresh byte array; no atomic commit protocol. |
| `preservesUnknownParts` | **false** | See below. |
| `supportsEncryption` | false | Password-protected workbooks are rejected. |

## Known limitation: unknown parts are not preserved

SheetJS parses a workbook into its own object model and re-serializes from
scratch on write. Anything it does not understand — embedded objects, custom
XML parts, unknown extensions — is **dropped**, not preserved byte-for-byte.
The `original` parameter of `write()` is accepted per the `StorageAdapter`
contract but intentionally unused. If you need lossless round-trips of
arbitrary OOXML features, this adapter is not the right tool.

## Macro projects are preserved as opaque hints (exception to the above)

A `.xlsm`'s VBA macro project (`xl/vbaProject.bin`) **is** preserved across
`read` → `write`, per design-docs/automation-lane.md §6 ("preserved
byte-for-byte as hints"):

- On `read`, the raw `vbaProject.bin` bytes are stashed in `WorkbookData`
  metadata under `icecream.macroProject.vbaProjectBin` (base64) with the
  flag `icecream.macroProject.present = true`.
- On `write`, the bytes are re-injected into the freshly written package
  along with the `[Content_Types].xml` override and the workbook
  relationship Excel needs to recognize the macro project.

The bytes are **opaque and non-executable**: they are never parsed or run —
Icecream Sheets has no VBA runtime, and the macros cannot execute inside
the engine process. They exist so the file stays macro-capable when
reopened in Excel. Macro signatures (`vbaProjectSignature.bin`) are not
preserved, so re-saved files report their macros as unsigned. If injection
fails, the save still succeeds without the macro project: a hint must
never break a save.

Related, also by design:

- **Pivot tables are imported and round-tripped** (`pivotTables.ts`):
  SheetJS CE drops `pivotCache`/`pivotTable` parts, so on `read` the
  adapter parses them directly — cache field names + shared items +
  records from `pivotCacheDefinition*.xml` / `pivotCacheRecords*.xml`,
  and row/column/page/data fields, hidden-item filters, location and
  style from `pivotTable*.xml` — into `WorkbookData` metadata under
  `icecream.pivots` (JSON). The layout itself is computed by the service
  pivot component (`createPivot`), which the web app runs over the
  imported records. On `write`, the raw part bytes captured on read
  (`xlsx.pivotParts` metadata) are re-injected byte-for-byte — content
  types, `<pivotCaches>`, and relationships included — so pivots survive
  the save. A pivot whose cache is missing from the file is reported
  with a warning instead of crashing the open.

- **Formulas are not calculated by the adapter.** Formula inputs (`"=A1+B1"`)
  are written as real formula cells with a placeholder cached value (`0`); any
  conforming reader (Excel, or the Icecream engine loading the data back)
  recalculates them.
- **Error cells** (`#DIV/0!`, etc.) have no `CellInput` representation and read
  back as `null`.
- **Page/print setup** round-trips natively: `<pageSetup>`, `<pageMargins>`,
  `<headerFooter>` and the `_xlnm.Print_Area` / `_xlnm.Print_Titles` defined
  names are parsed from / injected into the OOXML package directly
  (`pageSetupXml.ts`), because SheetJS CE drops everything except a subset
  of `<pageSetup>`. Native settings are carried through `metadata` under
  `xlsx.pageSetup.<SheetName>` and seed the app-owned
  `icecream.pagesetup.<SheetName>` / `icecream.printtitles.<SheetName>`
  dialog models.

## Usage

```ts
import { EngineWorkbook } from '@icecream-sheets/engine';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';

const adapter = new XlsxAdapter();

// Engine -> XLSX bytes
const wb = new EngineWorkbook({ Sheet1: [[1, 2, '=A1+B1']] });
const bytes: Uint8Array = adapter.write(workbookToData(wb.toSnapshot()));

// XLSX bytes -> data -> engine (formulas re-evaluate)
const data = adapter.read(bytes);
const wb2 = new EngineWorkbook(Object.fromEntries(data.sheets.map((s) => [s.name, s.rows])));
console.log(wb2.getValue({ sheet: 'Sheet1', row: 0, col: 2 })); // { kind: 'number', value: 3 }
```

## Development

```sh
npm run build   # tsc -p tsconfig.json (strict, zero `any` in src)
npm test        # vitest run
```
