# smartart-diagrams.xlsx — SmartArt import validation fixture

A real OOXML package containing **three SmartArt drawingML diagrams**
(`xl/diagrams/dataN.xml` + `layoutN.xml` + `colorsN.xml` + `quickStyleN.xml`
per diagram), wired through drawing parts and sheet rels exactly the way
Excel writes them:

| Sheet      | Layout (`layoutDef` name / uniqueId tail) | Family     | Mapping |
|------------|-------------------------------------------|------------|---------|
| `Process`  | Basic Process / `basicProcess`            | process    | exact   |
| `Org`      | Organization Chart / `orgChart`           | hierarchy  | exact   |
| `Fallback` | Mystic Funnel Widget / `mysticFunnelWidget` | process  | closest-kind fallback (reported, never silent) |

Text content (verified by `packages/xlsx-adapter/tests/smartart.test.ts`):

- Process: "Gather requirements", "Design", "Build", "Validate & ship"
- Org: "Ava Chen (CEO)", "Ben Ortiz (CTO)", "Cara Lin (CFO)", "Dan Wu (COO)"
- Fallback: "Awareness", "Interest", "Decision"

## How it was made

No test file in the collection contained `xl/diagrams/` parts, and no
download source was used. The fixture was generated programmatically:

```
python3 test-data/real-world/make-smartart-fixture.py
```

The script builds the OPC package from scratch: `[Content_Types].xml`,
`_rels/.rels`, `xl/workbook.xml` (+ rels), one worksheet + sheet rels +
drawing part + drawing rels per sheet, and the four diagram parts per
diagram. The drawing anchors use `xdr:twoCellAnchor` with a
`xdr:graphicFrame` → `a:graphicData uri="…/2006/diagram"` →
`dgm:relIds r:dm/r:lo/r:qs/r:cs`, resolved through the drawing rels —
the same structure the importer (`packages/xlsx-adapter/src/smartart.ts`)
parses.

Fidelity note: the `layoutDef` parts are minimal-but-valid identity
skeletons (`name` + `uniqueId` only). A production glox layoutDef carries
the full layout-node tree, which Excel needs to *paint* the graphic — so
Excel opens this file but does not render the diagrams. The data model
(`dgm:ptLst` text) is fully faithful, which is what the importer reads.
Regenerating is deterministic apart from the random `modelId` GUIDs.
