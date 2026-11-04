#!/usr/bin/env python3
"""Build test-data/real-world/smartart-diagrams.xlsx.

Creates a real OOXML package containing three SmartArt drawingML diagrams
(`xl/diagrams/dataN.xml` + `layoutN.xml` + `colorsN.xml` + `quickStyleN.xml`
per diagram), wired through drawing parts and sheet rels exactly the way
Excel writes them:

  Sheet1 "Process"  — basicProcess layout, 4 steps      → family: process
  Sheet2 "Org"      — orgChart layout, CEO + 3 reports   → family: hierarchy
  Sheet3 "Fallback" — "mysticFunnelWidget" (no exact renderer in our
                       catalogue; keyword heuristic maps it to process and
                       the import reports the substitution)

The layout definitions are minimal-but-valid layoutDef skeletons (name +
uniqueId only). Excel needs a full glox layout tree to *render* them, so
Excel opens the file but does not paint the graphics; icecream-sheets
parses only the layout identity + the data model, which are fully
faithful. The diagrams render in the web app from their text content.

Regenerate:  python3 test-data/real-world/make-smartart-fixture.py
Output:     test-data/real-world/smartart-diagrams.xlsx
"""
import uuid
import zipfile
from pathlib import Path

OUT = Path(__file__).with_name("smartart-diagrams.xlsx")

DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
LAYOUT_URN = "urn:microsoft.com/office/officeart/2005/8/layout/"


def data_model(items):
    pts = []
    for t in items:
        pts.append(
            f'<dgm:pt modelId="{{{uuid.uuid4()}}}">'
            f"<dgm:prSet/>"
            f"<dgm:spPr/>"
            f"<dgm:t>{t}</dgm:t>"
            f"</dgm:pt>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<dgm:dataModel xmlns:dgm="{DGM}" xmlns:a="{A}">'
        f"<dgm:ptLst>{''.join(pts)}</dgm:ptLst>"
        "<dgm:cxnLst/>"
        f'<dgm:bg><dgm:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></dgm:spPr></dgm:bg>'
        f'<dgm:whole><dgm:spPr><a:noFill/></dgm:spPr></dgm:whole>'
        "</dgm:dataModel>"
    )


def layout_def(layout_id, layout_name):
    # Minimal layoutDef: identity only. (A production glox layoutDef would
    # carry the full layout-node tree; the importer only needs the identity.)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<dgm:layoutDef xmlns:dgm="{DGM}" xmlns:a="{A}" name="{layout_name}" '
        f'defStyle="" uniqueId="{LAYOUT_URN}{layout_id}"/>'
    )


def colors_def():
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<dgm:colorsDef xmlns:dgm="{DGM}" xmlns:a="{A}" name="Colorful"/>'
    )


def quick_style():
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<dgm:styleDef xmlns:dgm="{DGM}" xmlns:a="{A}" name="Cartoon"/>'
    )


def drawing_xml(n):
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<xdr:wsDr xmlns:xdr="{XDR}" xmlns:a="{A}" xmlns:r="{R}">'
        "<xdr:twoCellAnchor>"
        "<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>"
        "<xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"
        "<xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff>"
        "<xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"
        '<xdr:graphicFrame macro="">'
        "<xdr:nvGraphicFramePr>"
        f'<xdr:cNvPr id="2" name="SmartArt {n}"/>'
        "<xdr:cNvGraphicFramePr/>"
        "</xdr:nvGraphicFramePr>"
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
        "<a:graphic>"
        f'<a:graphicData uri="{DGM}">'
        f'<dgm:relIds xmlns:dgm="{DGM}" xmlns:r="{R}" '
        'r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/>'
        "</a:graphicData>"
        "</a:graphic>"
        "<xdr:clientData/>"
        "</xdr:graphicFrame>"
        "</xdr:twoCellAnchor>"
        "</xdr:wsDr>"
    )


def drawing_rels_for(n):
    rels = [
        ("rId1", "diagramData", f"data{n}.xml"),
        ("rId2", "diagramLayout", f"layout{n}.xml"),
        ("rId3", "diagramQuickStyle", f"quickStyle{n}.xml"),
        ("rId4", "diagramColors", f"colors{n}.xml"),
    ]
    body = "".join(
        f'<Relationship Id="{i}" Type="{R}/{t}" Target="../diagrams/{f}"/>'
        for i, t, f in rels
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PKG}">{body}</Relationships>'
    )


def sheet_xml():
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData/>"
        "</worksheet>"
    )


def sheet_rels():
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PKG}">'
        f'<Relationship Id="rId1" Type="{R}/drawing" Target="../drawings/drawing1.xml"/>'
        "</Relationships>"
    )


DIAGRAMS = [
    {
        "sheet": "Process",
        "layout_id": "basicProcess",
        "layout_name": "Basic Process",
        "items": ["Gather requirements", "Design", "Build", "Validate & ship"],
    },
    {
        "sheet": "Org",
        "layout_id": "orgChart",
        "layout_name": "Organization Chart",
        "items": ["Ava Chen (CEO)", "Ben Ortiz (CTO)", "Cara Lin (CFO)", "Dan Wu (COO)"],
    },
    {
        "sheet": "Fallback",
        "layout_id": "mysticFunnelWidget",
        "layout_name": "Mystic Funnel Widget",
        "items": ["Awareness", "Interest", "Decision"],
    },
]


def main():
    files = {}
    files["_rels/.rels"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PKG}">'
        f'<Relationship Id="rId1" Type="{R}/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    sheets_xml = "".join(
        f'<sheet name="{d["sheet"]}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
        for i, d in enumerate(DIAGRAMS)
    )
    files["xl/workbook.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'xmlns:r="{R}">'
        f"<sheets>{sheets_xml}</sheets>"
        "</workbook>"
    )
    wb_rels = "".join(
        f'<Relationship Id="rId{i + 1}" Type="{R}/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
        for i in range(len(DIAGRAMS))
    )
    files["xl/_rels/workbook.xml.rels"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PKG}">{wb_rels}</Relationships>'
    )
    for i, d in enumerate(DIAGRAMS, start=1):
        files[f"xl/worksheets/sheet{i}.xml"] = sheet_xml()
        files[f"xl/worksheets/_rels/sheet{i}.xml.rels"] = sheet_rels().replace(
            "drawings/drawing1.xml", f"drawings/drawing{i}.xml"
        )
        files[f"xl/drawings/drawing{i}.xml"] = drawing_xml(i)
        files[f"xl/drawings/_rels/drawing{i}.xml.rels"] = drawing_rels_for(i)
        files[f"xl/diagrams/data{i}.xml"] = data_model(d["items"])
        files[f"xl/diagrams/layout{i}.xml"] = layout_def(d["layout_id"], d["layout_name"])
        files[f"xl/diagrams/colors{i}.xml"] = colors_def()
        files[f"xl/diagrams/quickStyle{i}.xml"] = quick_style()

    overrides = [
        ("/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
        ("_rels/.rels", None),
    ]
    ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
          '<Default Extension="xml" ContentType="application/xml"/>']
    for i in range(len(DIAGRAMS)):
        ct.append(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" '
                  'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        ct.append(f'<Override PartName="/xl/drawings/drawing{i + 1}.xml" '
                  'ContentType="application/vnd.openxmlformats-officedocument.drawingml.drawing+xml"/>')
        ct.append(f'<Override PartName="/xl/diagrams/data{i + 1}.xml" '
                  'ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>')
        ct.append(f'<Override PartName="/xl/diagrams/layout{i + 1}.xml" '
                  'ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml"/>')
        ct.append(f'<Override PartName="/xl/diagrams/colors{i + 1}.xml" '
                  'ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml"/>')
        ct.append(f'<Override PartName="/xl/diagrams/quickStyle{i + 1}.xml" '
                  'ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramQuickStyle+xml"/>')
    ct.append('<Override PartName="/xl/workbook.xml" '
              'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>')
    ct.append("</Types>")
    files["[Content_Types].xml"] = "".join(ct)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content.encode("utf-8"))
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
