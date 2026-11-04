# Financial Modeling — Icecream Sheets skill pack

**Pack id:** `financial-modeling` · **Version:** 1.0.0 · **Manifest:** [pack.json](./pack.json)

Forecasting, valuation, and what-if analysis as MCP tools. The pack
builds **live** spreadsheet models: forecast and valuation cells are
written as engine formulas over the source ranges, so the model
recalculates when inputs change. The tools read the computed values
back and return them alongside the model parameters.

## Tools

| Tool | What it does |
|---|---|
| `fin_forecast` | Project a numeric column `periods` ahead, appending forecast rows below the data. `method: "linear"` (default) writes `=INTERCEPT(y,x)+SLOPE(y,x)*x` formulas over the source ranges (with a `periodColumn`) or pinned least-squares coefficient formulas (without one — reported as `coefficientsPinned`). `method: "growth"` compounds at the historical CAGR (`=previous*(1+CAGR)` chained formulas). Returns the forecast values read back from the sheet. |
| `fin_npv_irr` | Value a cash-flow column: writes a `Valuation` table (or `outputSheet`) with live formulas — NPV as `=NPV(rate, flows) − initialInvestment`, IRR as `=IRR(series)` over a staged series including the time-0 outlay — and returns the computed NPV and IRR. |
| `fin_scenario_sweep` | What-if analysis: set one input cell (`inputCell`, A1) to each of `values` in turn, recalculate, and record `outputCell` (A1) — the sheet's own formulas do the math. The original input is always restored, even on failure. Results are written to `targetSheet` (default `Scenarios`) and returned. |

All tools take an optional `principal`, like every Icecream Sheets
MCP tool.

## Example prompts

These ship with the pack and are also registered as MCP prompts
(`financial-modeling.project-revenue`,
`financial-modeling.value-this-project`,
`financial-modeling.stress-test-price`):

> In the "Model" sheet, use fin_forecast to project the Revenue
> column 6 periods ahead with the linear method, then read back the
> forecast rows and summarize the trend (slope per period and the
> final projected value).

> The "Project" sheet has a CashFlow column and an initial investment
> of 10000. Use fin_npv_irr at a 10% discount rate to compute NPV and
> IRR, and tell me whether the project clears a 12% hurdle rate.

> In the "Pricing" sheet the unit price is in B2 and profit is
> computed in B10. Use fin_scenario_sweep to vary B2 over 8, 9, 10,
> 11, 12 and show me the profit at each price.

## Try it

- [`example-revenue.csv`](./example-revenue.csv): `Period, Revenue`
  1–5 → 100…140. As sheet `Model`:
  `fin_forecast { "sheet": "Model", "valueColumn": "Revenue", "periodColumn": "Period", "periods": 3 }`
  forecasts 150, 160, 170 — and editing any Revenue cell moves them.
- [`example-cashflows.csv`](./example-cashflows.csv): cash flows
  400 / 500 / 600. As sheet `Project`:
  `fin_npv_irr { "sheet": "Project", "cashflowColumn": "CashFlow", "rate": 0.1, "initialInvestment": 1000 }`
  → NPV ≈ 227.65, IRR ≈ 20.7%.

## Installing / extending

See the [Skill Pack Install Guide](../README.md) for installation,
versioning, and how to add a tool to this pack.
