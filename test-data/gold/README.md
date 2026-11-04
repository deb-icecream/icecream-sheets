# test-data/gold — formula golden set

Comprehensive formula coverage for the Icecream Sheets calculation engine.

## Contents

| File | Description |
|------|-------------|
| `functions.xlsx` | 421 formulas across 13 sheets, covering 413 of 523 Excel functions |
| `functions-expected.json` | Independently computed expected values (`{value}`, `{error}`, or `{smoke,type}`) |
| `functions-plan.json` | Build manifest (debugging aid) |

## Coverage

- **421 formulas** covering **413 of 523 unique Excel functions (79%)**
- **Wave 1** (sheets Math, Stats, Text, Logic, Lookup, Dates, Finance, Info, Eng): exact expected values computed in plain JS (no HyperFormula), compared with 1e-9 tolerance
- **Wave 2** (sheet More): smoke tests — each function evaluates without `#NAME?` and returns the expected type
- **Wave 3** (sheet More3): tests for engine-implemented functions (XLOOKUP, TEXTJOIN, AVERAGEIFS, database functions, etc.)

## How to run

```bash
# regenerate the workbook
node samples/generate-golden.mjs
# validate against the engine
node samples/validate-golden.mjs
```

## Current status

**419/421 pass.** The 2 failures are upstream HyperFormula gaps, not engine bugs:

| Formula | Got | Excel expects | Notes |
|---------|-----|---------------|-------|
| `INT(-7.1)` | `-7` | `-8` | HyperFormula truncates instead of flooring negatives |
| `MOD(-10,3)` | `-1` | `2` | HyperFormula uses JS `%` (sign of dividend); Excel uses sign of divisor |

### Record corrections (2026-10-21)

- This status previously read **413/421** with 8 failures. Six of those
  were smoke cases that now pass because the functions were implemented
  in the engine after this README was written (2026-10-18): `SORT`,
  `UNIQUE`, `SEQUENCE`, `RANDARRAY` (dynamic arrays), `CONVERT`, and
  `CELL` each score 1/1. Only the two upstream sign-semantics cases
  above remain.
- `functions-batch2.xlsx`: previously recorded 44/44 with
  `StatsFuncs!B9` `PERCENTRANK.INC(A1:A8,30)` expected as 0.5. That
  expected value was wrong: per Microsoft's PERCENTRANK.INC
  documentation, the rank of a matching value is
  countLess/(countLess+countGreater) = 3/(3+4) = 3/7 ≈ 0.429 for this
  data — exactly what the engine returns. The 0.5 figure used a
  mid-rank convention Excel does not use. The expected value in
  `functions-batch2-expected.json` is corrected to 0.429; batch2 status
  is **44/44** against the corrected record.

## Excel functions not yet implemented (110)

Beyond the 8 above, these Excel functions are not in the engine:
- **Financial (28):** Bond functions (ACCRINT, DISC, DURATION, PRICE, YIELD, etc.), IRR/XIRR — specialized day-count conventions
- **Dynamic arrays (14):** SORTBY, DROP, TAKE, HSTACK, VSTACK, etc. — require spill support
- **Lambda (10):** LAMBDA, LET, MAP, REDUCE, etc. — require lambda engine
- **Cube (7):** CUBEVALUE, etc. — require OLAP (not applicable)
- **External (17):** STOCKHISTORY, WEBSERVICE, COPILOT, etc. — require network/AI
- **Other (34):** Various specialized functions

## Excel-compat functions added to the engine

These were missing from HyperFormula and are implemented in
`packages/engine/src/function-aliases.ts` and `extended-functions.ts`:

- `CONCAT`, `VALUE`, `N`, `GESTEP`, `DOLLAR`
- `XLOOKUP`, `TEXTJOIN`, `AVERAGEIFS`, `ERROR.TYPE`, `TYPE`, `FIXED`, `RANK.EQ`, `LOOKUP`
- Database: `DSUM`, `DAVERAGE`, `DCOUNT`, `DCOUNTA`, `DMAX`, `DMIN`, `DPRODUCT`

## Regenerating

The generator is deterministic. Edit `samples/generate-golden.mjs` (wave 1),
`samples/wave2.mjs` (wave 2), or `samples/wave3.mjs` (wave 3), then re-run
both scripts above.
