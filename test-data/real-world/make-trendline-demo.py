"""
Fixture provenance: test-data/real-world/trendline-demo.xlsx

Created 2026-10-19 with openpyxl 3.1.2 (no Excel needed) because the only
real-world file with a <c:trendline> (xlsxpopulate-ranges-out.xlsx) puts its
trendline on a dynamic OFFSET/COUNTA defined-name series, which the
drawingML chart importer does not bind yet (chart-import lane's active
work). This file carries trendlines on plain A1 ranges so the trendline
import -> render path can be validated end to end.

Contents:
  Sheet "Data": 8 months (A2:A9) + two value columns:
    B: quadratic-ish  [3, 5, 9, 15, 23, 33, 45, 59]
    C: linear-ish     [10, 14, 17, 21, 26, 30, 33, 38]
  One LineChart anchored at E2:
    Series "Quadratic" (B) + polynomial order-2 trendline, equation + R² shown
    Series "Linear"    (C) + linear trendline, forecast forward 2 periods

Run: python3 make-trendline-demo.py   (writes trendline-demo.xlsx next to it)
"""
from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.chart.trendline import Trendline

wb = Workbook()
ws = wb.active
ws.title = "Data"

months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"]
quad = [3, 5, 9, 15, 23, 33, 45, 59]
lin = [10, 14, 17, 21, 26, 30, 33, 38]
ws.append(["Month", "Quadratic", "Linear"])
for m, q, l in zip(months, quad, lin):
    ws.append([m, q, l])

chart = LineChart()
chart.title = "Trendline demo"
chart.style = 2
chart.y_axis.title = "Value"
chart.x_axis.title = "Month"

cats = Reference(ws, min_col=1, min_row=2, max_row=9)
for col, title, tl in [
    (2, "Quadratic", Trendline(
        trendlineType="poly", order=2,
        dispEq=True, dispRSqr=True)),
    (3, "Linear", Trendline(
        trendlineType="linear", forward=2)),
]:
    vals = Reference(ws, min_col=col, min_row=1, max_row=9)
    chart.add_data(vals, titles_from_data=True)
    ser = chart.series[-1]
    ser.trendline = tl
chart.set_categories(cats)

ws.add_chart(chart, "E2")
wb.save("trendline-demo.xlsx")
print("wrote trendline-demo.xlsx")
