# Test-Coverage Audit — Phase 2 (function-coverage workstream)

*2026-10-21. Companion to `FUNCTION-LIST-AND-GAPS.md` (Phase 1). Audit
script: `audit-coverage.mjs` (this directory); raw matrices:
`audit-before.json`, `audit-after.json`. Per the 2026-10-21 user
ruling: everything implemented must be properly tested; legacy
functions that are implemented are KEPT and tested.*

## 1. Method

- **Implemented set (511)** = the 523-function Microsoft list
  (`microsoft-functions.json` / `target523.json`) minus the 12 known
  gaps: GROUPBY, PIVOTBY, ODDFPRICE, ODDFYIELD, ODDLPRICE, ODDLYIELD,
  FINDB, LEFTB, MIDB, REPLACEB, RIGHTB, SEARCHB.
- **Layers** (a partition of the 511; definitions fixed here):
  - *legacy-compatibility* — exactly the 41 names in Microsoft's
    Compatibility category.
  - *add-in/external* — 19 names: the Add-in and Automation category
    (CALL, EUROCONVERT, REGISTER.ID), the 7 Cube functions, and the
    provider-dependent functions in modern categories (WEBSERVICE,
    FILTERXML, STOCKHISTORY, FIELDVALUE, COPILOT, PY, TRANSLATE,
    DETECTLANGUAGE, RTD).
  - *living/modern* — the remaining 451 (including LENB, the one byte
    function kept for modern use).
- **Covered** = the function name appears as a formula token in
  (a) the gold corpus — `test-data/gold/functions-plan.json` formulas
  (the manifest linking every `functions-expected.json` entry to its
  formula) or any `samples/*.mjs` gold generator — OR (b) an engine
  unit test in `packages/engine/tests/*.test.ts`.
  Token match is the regex `(?<![A-Z0-9_.])NAME\s*\(` (NAME escaped,
  case-insensitive): word-boundary matching, so SUM does not match
  inside SUMIF, CEILING does not match CEILING.MATH(, T does not
  match T.DIST(. (The gold expected-JSON files themselves contain only
  `Sheet!Cell` keys and expected values — no function names; this was
  verified by scan, so gold attribution necessarily goes through the
  plan/generators.) Spot-checks confirmed the matcher: external-layer
  hits are dedicated test files (cube-functions.test.ts,
  extended-functions10/11.test.ts), T/N/TRUE/FALSE hits are real
  formula uses.
- The "before" run excludes `coverage-*.test.ts` (the new files); the
  "after" run includes them.

## 2. Coverage before → after

| Layer | Total | Covered before | Uncovered before | Covered after | Uncovered after |
|---|---|---|---|---|---|
| living/modern | 451 | 405 | **46** | **451** | **0** |
| legacy-compatibility | 41 | 33 | **8** | **41** | **0** |
| add-in/external | 19 | 19 | 0 | 19 | 0 |
| **Total** | **511** | **457** | **54** | **511** | **0** |

(Before, living/modern coverage split: 260 gold-only, 47 unit-only,
98 both. The add-in/external layer needed no work: every one of its
19 functions already had provider-seam unit tests — cube functions
against a pivot fixture, STOCKHISTORY/WEBSERVICE/COPILOT/PY/CALL/
REGISTER.ID/RTD against the engine's test providers in
extended-functions11.test.ts, TRANSLATE/DETECTLANGUAGE/FIELDVALUE/
EUROCONVERT/FILTERXML in extended-functions10.test.ts. The volatile
living functions RAND, RANDBETWEEN, TODAY, NOW were likewise already
covered by gold cases and tracks.test.ts, so no volatile function
appears in the gap lists below.)

### Uncovered before — living/modern (46)

ACCRINT, ACCRINTM, AREAS, ASC, BAHTTEXT, CEILING.MATH, CHISQ.TEST,
COUPDAYS, COUPNUM, COVARIANCE.P, COVARIANCE.S, DBCS, DISC, DPRODUCT,
DURATION, F.TEST, FLOOR.PRECISE, GAMMALN.PRECISE, GROWTH, INFO,
INTRATE, ISO.CEILING, ISOMITTED, LINEST, LOGEST, MDURATION, MINVERSE,
MUNIT, NETWORKDAYS.INTL, PERCENTILE.EXC, PERCENTOF, PERCENTRANK.EXC,
PHONETIC, PRICE, PRICEDISC, QUARTILE.EXC, RECEIVED, STDEV.P, STDEV.S,
T.TEST, TREND, VAR.P, VAR.S, VDB, YIELD, YIELDDISC

### Uncovered before — legacy-compatibility (8)

BETADIST, CHITEST, FTEST, PERCENTRANK, QUARTILE, STDEV, TTEST, VAR

(8 ≤ 15, so per the task the legacy gaps were closed in this phase
too, in `coverage-legacy.test.ts`.)

## 3. Tests added (112 new tests, 4 new files; no existing file edited)

| File | Tests | Functions covered |
|---|---|---|
| `packages/engine/tests/coverage-financial.test.ts` | 34 | ACCRINT, ACCRINTM, COUPDAYS, COUPNUM, DISC, DURATION, INTRATE, MDURATION, PRICE, PRICEDISC, RECEIVED, VDB, YIELD, YIELDDISC |
| `packages/engine/tests/coverage-stats.test.ts` | 36 | CHISQ.TEST, COVARIANCE.P, COVARIANCE.S, F.TEST, GAMMALN.PRECISE, GROWTH, LINEST, LOGEST, PERCENTILE.EXC, PERCENTRANK.EXC, QUARTILE.EXC, STDEV.P, STDEV.S, T.TEST, TREND, VAR.P, VAR.S |
| `packages/engine/tests/coverage-math-text-info.test.ts` | 29 | AREAS, ASC, BAHTTEXT, CEILING.MATH, DBCS, DPRODUCT, FLOOR.PRECISE, INFO, ISO.CEILING, ISOMITTED, MINVERSE, MUNIT, NETWORKDAYS.INTL, PERCENTOF, PHONETIC |
| `packages/engine/tests/coverage-legacy.test.ts` | 13 | BETADIST, CHITEST, FTEST, PERCENTRANK, QUARTILE, STDEV, TTEST, VAR |

### Test kinds, and why

- **Exact value vs Microsoft's worked example** (fetched from the
  function's Microsoft Support page during this phase): ACCRINT,
  ACCRINTM, COUPDAYS, COUPNUM, DURATION, MDURATION, INTRATE, PRICE,
  YIELD, VDB, T.TEST (and TTEST on the same data), BETADIST, ASC,
  CEILING.MATH, ISO.CEILING, YIELDDISC.
- **Exact value vs the formula Microsoft documents, computed
  independently in the test** (plain JS, never via the engine —
  including a Numerical-Recipes incomplete beta validated against
  Microsoft's documented BETADIST value, a least-squares fitter, and
  a NETWORKDAYS.INTL day-loop implementing Microsoft's weekend
  table): DISC, RECEIVED, PRICEDISC, CHISQ.TEST, CHITEST, F.TEST,
  FTEST, STDEV.P/S, VAR.P/S, STDEV, VAR, COVARIANCE.P/S,
  PERCENTILE.EXC, QUARTILE.EXC, QUARTILE, PERCENTRANK,
  PERCENTRANK.EXC, GAMMALN.PRECISE (closed forms ln(3√π/4), ln 24),
  LINEST, LOGEST, TREND, GROWTH, NETWORKDAYS.INTL, FLOOR.PRECISE,
  DBCS, DPRODUCT, AREAS, MINVERSE, MUNIT, PERCENTOF, ISOMITTED.
- **Structural / behavioral** (only where an exact value is not
  well-defined offline):
  - INFO — its values are installation facts by design (Microsoft
    defines them per environment); tested for type, the plausible
    `numfile` ≥ 1, `recalc` = "Automatic", and the #VALUE! contract
    for unknown types.
  - PHONETIC — furigana output depends on phonetic data attached to
    source cells, which no fixture in the repo carries; tested for
    the engine's documented-in-code behavior (returns the text when
    no furigana exists) and string type.
  - BAHTTEXT — an exact Thai assertion exists (as a defect case,
    D20); a type check accompanies it.
  - Error contracts (#NUM! / #VALUE! / #N/A / #DIV/0! per Microsoft)
    are asserted alongside the value tests for several functions.

**Run evidence** (related-tests rule — new files +
`tests/function-registry.test.ts` only):
`npx vitest run tests/coverage-financial.test.ts tests/coverage-stats.test.ts tests/coverage-math-text-info.test.ts tests/coverage-legacy.test.ts tests/function-registry.test.ts`
→ **5 files passed, 118 tests passed** (112 new + 6 registry).

## 4. FOUND DEFECTS (not fixed — recorded per task instructions)

45 of the new tests are `it.fails(...)`: they assert Microsoft's
documented result, fail against the current engine exactly as
recorded below (every "actual" was probed through `EngineWorkbook`
before the test was written), and will turn red when the defect is
fixed — at which point the expectation should be promoted to a
plain `it`. All other 67 new tests pass outright.

| ID | Function | Case | Expected (documented) | Engine actual | Root cause (source) |
|---|---|---|---|---|---|
| D1 | ACCRINT | `ACCRINT(DATE(2011,3,1),DATE(2011,8,31),DATE(2011,5,1),0.1,1000,2,0)` (+ the two calc_method examples) | 16.666667 (15.555556 / 7.2222222) | 16.43835616438356 (15.342465753424658 / 7.123287671232877) | `financial-functions.ts`: `daysPerYear` returns 365 for basis 0 (must be 360); `accrint()` ignores calc_method / quasi-coupon periods |
| D2 | ACCRINTM | `ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)`; basis 0 | 20.54794521; 20.555556 (74 days 30/360) | 20.833333333333336 both | `extended-functions7.ts` `accrintm()`: hardcodes actual-days/360, ignores basis |
| D3 | COUPDAYS | `COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,1)`; basis 0 | 181; 180 | 182.5 (constant) | `extended-functions7.ts` `coupdays()`: returns `365/freq`, ignores dates and basis |
| D4 | DISC | `DISC(DATE(2007,1,25),DATE(2007,6,15),97.975,100,0)` | 0.05207142857142857 (formula, DIM 140) | 0.052794642857143005 | `financial-functions.ts` `daysPerYear` (basis 0 → 365). Basis 2 verified correct (0.2 exact) |
| D5 | DURATION | MS example `(2018-07-01, 2048-01-01, 8%, 9%, 2, 1)`; par bond `(2016→2031, 9%, 9%, 1, 1)` | 10.9191453; 8.786150388541124 | 10.580916720886348; 7.827276303346905 | `financial-functions.ts` `duration()`: discount times built from total settlement→maturity days instead of days-to-next-coupon (DSC/E). Also inconsistent with the engine's own (correct) MDURATION |
| D6 | PRICE | MS example `(2008-02-15, 2017-11-15, 5.75%, 6.50%, 100, 2, 0)`; par bond | 94.63436162; 100 | 97.29206554985694; 108.61437287253827 | `financial-functions.ts` `price()`/`bondPrice()`: same DSC flaw as D5 |
| D7 | YIELD | MS example `(2008-02-15, 2016-11-15, 5.75%, 95.04287, 100, 2, 0)` | 0.065 | 0.0693664812168384 | Inherits D6 (Newton solve over `bondPrice`) |
| D8 | RECEIVED | MS example, basis 0 | 1014584.6544071021 | 1014381.9912457445 | `daysPerYear` (basis 0 → 365). Basis 2 verified correct |
| D9 | INTRATE | MS example terms with basis 0 (DIM also 90) | 0.05768 | 0.05848111111111111 | `daysPerYear` (basis 0 → 365). The documented basis-2 example passes |
| D10 | VDB | `VDB(2400,300,10,0,1,2)`; period 1–2 | 480; 384 | 210; 210 | `financial-functions.ts` `vdb()`: depreciation taken on (book − salvage) and `Math.min(ddb, sln)` switch picks the smaller every year |
| D11 | LINEST | `INDEX(LINEST({2,4,5,7},{1,2,3,4}),1,1)` etc. | slope 1.6 / intercept 0.5 / R² 0.9846… | #N/A for every input | `extended-functions7.ts` `linest()`: stub — always returns #N/A ("Use SLOPE/INTERCEPT") |
| D12 | LOGEST | `INDEX(LOGEST({2,4,8,16},{1,2,3,4}),1,1)` | m = 2, b = 1 | #N/A for every input | `extended-functions7.ts` `logest()`: stub — always returns #N/A |
| D13 | TREND | `TREND({2,4,5,7},{1,2,3,4},5)`; `SUM(TREND(...,{5,6}))` | 8.5; 18.6 | 6.9; 13.8 | `extended-functions5.ts` `trend()`: ignores new_xs, returns fitted value at the last known x as a scalar |
| D14 | GROWTH | `GROWTH({2,4,8,16},{1,2,3,4},5)`; `SUM(GROWTH(...,{5,6}))` | 32; 96 | 15.999999999999991; 31.999999999999982 | `extended-functions5.ts` `growth()`: same pattern as D13 |
| D15 | MINVERSE | `SUM(MINVERSE([[1,2],[3,4]]))`; `INDEX(MINVERSE(...),2,1)` | 0 (entries −2, 1, 1.5, −0.5); 1.5 | −2; #NUM! | `extended-functions4.ts` `minverse()`: returns only the (1,1) cofactor as a scalar ("return the (0,0) element") |
| D16 | MUNIT | `SUM(MUNIT(3))`; `INDEX(MUNIT(3),2,2)` / `(1,2)` | 3; 1 / 0 | 1; #NUM! | `extended-functions4.ts` `munit()`: returns scalar 1 for any dimension |
| D17 | PERCENTRANK.EXC | `{10,20,30,40}` at x = 20 / 25 / 40 | 0.4 / 0.5 / 0.8 | 0.2 / 0.3 / #N/A | `extended-functions2.ts` `percentrankExc()`: rank off by one (countLess-based; inconsistent with the engine's own PERCENTILE.EXC) and endpoints wrongly rejected as #N/A |
| D18 | PERCENTRANK (legacy) | `{10,20,30,40}` at 30; `{13,12,11,8,4,3,2,1,1,1}` at 4 | 0.667 (2/3); 0.556 (5/9) | 0.8333333333333334; 0.6111111111111112 | `extended-functions4.ts` `percentrankAlias()`: mid-rank convention (+0.5 for exact matches) — the convention the gold README already flagged as not Excel's. (PERCENTRANK.INC itself is correct.) |
| D19 | BETADIST (legacy) | `BETADIST(2,8,10,1,3)`; `BETADIST(0.5,8,10)` | 0.6854705810546873 (Microsoft example) | #NUM!; #N/A | No working implementation behind the documented legacy signature (name present in registry metadata only) |
| D20 | BAHTTEXT | `BAHTTEXT(1)` | หนึ่งบาทถ้วน (Thai text, per Microsoft) | `"1.00 Baht"` | `extended-functions7.ts` `bahttext()`: returns `` `${num.toFixed(2)} Baht` `` ("full Thai text is complex") |
| D21 | CEILING.MATH | `CEILING.MATH(-5.5,2,-1)` | −6 (any nonzero mode rounds negatives away from zero) | −4 | HyperFormula built-in mode handling (only mode > 0 reverses direction); inherited upstream behavior |
| D22 | PERCENTOF | `PERCENTOF({10,20},{10,20,30})` | 0.5 (SUM subset / SUM all) | 1 | `extended-functions7.ts` `percentof()`: parameters declared SCALAR — ranges collapse to their first element, nothing is summed. Scalar form verified correct (0.25) |
| D23 | PRICEDISC | basis 3 `(2008-02-15→2008-05-15, 5%, 100)`; basis 0 `(2008-02-16→2008-03-01, 5.25%, 100)` | 98.76712328767124; 99.78125 | 98.75; 99.79583333333333 | `extended-functions7.ts` `pricedisc()`: ignores basis entirely (always actual-days/360). The basis-2 Microsoft terms pass |
| D24 | YIELDDISC | same terms, basis 3 / basis 0 | 0.05355621882000915 / 0.04930106718773444 | 0.05282257198685834 both | `extended-functions7.ts` `yielddisc()`: ignores basis (always 360/actual-days). The basis-2 Microsoft example passes (0.052823) |
| D25 | ISOMITTED | named `LAMBDA(x,y,ISOMITTED(y))` called as `Check(5)` | TRUE | #N/A (and FALSE for empty-cell references) | `lambda-functions.ts` `isomittedFn()`: self-described shim — the argument never evaluates to `EmptyValue` through the call machinery, so omission is never detected. The provided-argument case (FALSE) works |

Verified-correct highlights among the newly covered (pass
outright): MDURATION (both Microsoft examples to full precision),
COUPNUM, INTRATE/DISC/RECEIVED at basis 2, PRICEDISC/YIELDDISC at
basis 2, ACCRINT at basis 3, T.TEST/TTEST (matches the independent
incomplete-beta computation to 1e-9; Microsoft's printed 0.196016 is
its rounding), CHISQ.TEST/CHITEST (df-2 closed form e^−5), F.TEST/
FTEST, all moment functions (STDEV.P/S, VAR.P/S, STDEV, VAR,
COVARIANCE.P/S), PERCENTILE.EXC/QUARTILE.EXC/QUARTILE incl. error
contracts, GAMMALN.PRECISE, NETWORKDAYS.INTL (incl. holidays and
reversed ranges), CEILING.MATH (except D21), FLOOR.PRECISE,
ISO.CEILING (full Microsoft table), ASC/DBCS, DPRODUCT, AREAS.

## 5. Remaining backlog

- **Uncovered functions: none.** All 511 implemented functions now
  have gold and/or unit coverage (511/511; living 451/451, legacy
  41/41, external 19/19).
- **Fix backlog (out of scope here — no src was edited):** the 25
  FOUND DEFECTS above, each pinned by an `it.fails` test that flips
  red when fixed. Highest impact: D11/D12 (LINEST/LOGEST are
  non-functional stubs), D15/D16 (MINVERSE/MUNIT scalar stubs),
  D5/D6/D7 (PRICE/DURATION/YIELD bond math), D1–D4/D8/D9 (the shared
  `daysPerYear` basis-0 defect and the constant-return COUPDAYS).

---

## Resolution (2026-10-21, Phase 2)

All 25 defects (D1–D25) are FIXED and validated: the 49 `it.fails`
cases in the four coverage suites were promoted to plain `it` tests
and pass (112/112). Fixes landed in financial-functions.ts (shared
basis/coupon-schedule rewrite: ACCRINT, DISC, RECEIVED, INTRATE,
PRICE, DURATION, YIELD, VDB), extended-functions7.ts (ACCRINTM,
COUPDAYS, PRICEDISC, YIELDDISC, PERCENTOF, Thai BAHTTEXT, and real
LINEST/LOGEST regression implementations replacing #N/A stubs),
extended-functions4.ts (real MINVERSE/MUNIT replacing scalar stubs),
extended-functions5.ts (TREND/GROWTH honoring new_xs),
extended-functions2.ts (PERCENTRANK.EXC), hf-overrides.ts
(CEILING.MATH mode, legacy PERCENTRANK, legacy BETADIST — new
override plugins), and lambda-functions.ts (ISOMITTED). Four array
functions (LINEST, LOGEST, TREND, GROWTH, MINVERSE, MUNIT) also
gained HyperFormula ArrayVertex size predictors so their results
spill from anchors exactly like native array functions. One
platform behavior recorded during the fixes: a blocked spill range
reports #SPILL! even when the function's own result is an error
(verified as HyperFormula-native behavior).
