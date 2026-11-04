# Excel Function Coverage — Authoritative Lists & Gap Analysis

*Phase 1 deliverable, function-coverage workstream, 2026-10-21. Every
"implemented" verdict below was verified two ways: (1) the engine's
versioned function registry (`packages/engine/src/function-registry.ts`,
generated from the actual HyperFormula plugin registrations + engine
plugin batches; 565 names dumped from the freshly built engine on
2026-10-21), and (2) live evaluation probes through `EngineWorkbook`
for every gap candidate and edge case named here.*

## Executive summary

| List | Size | Implemented & callable | Missing |
|---|---|---|---|
| OOXML spec (ISO/IEC 29500-1:2012 §18.17.7) | 356 | 345 | 11 |
| Microsoft Excel, current (reconciled, §3 below) | **523** | **511** | **12** |
| Both lists combined (union) | 524 | 511 | 13 |

**The gap list (verified by live evaluation — each returns `#NAME?` today):**

| # | Function | Category | In OOXML spec? | Notes |
|---|---|---|---|---|
| 1 | GROUPBY | Lookup & Reference (dynamic arrays) | No (2024 addition) | Aggregation with eta-lambdas/LAMBDA |
| 2 | PIVOTBY | Lookup & Reference (dynamic arrays) | No (2024 addition) | GROUPBY + column fields/totals |
| 3 | ODDFPRICE | Financial | §18.17.7.241 | Odd first coupon period pricing |
| 4 | ODDFYIELD | Financial | §18.17.7.242 | Odd first coupon period yield |
| 5 | ODDLPRICE | Financial | §18.17.7.243 | Odd last coupon period pricing |
| 6 | ODDLYIELD | Financial | §18.17.7.244 | Odd last coupon period yield |
| 7 | FINDB | Text (byte) | §18.17.7.120 | DBCS byte semantics |
| 8 | LEFTB | Text (byte) | §18.17.7.192 | DBCS byte semantics |
| 9 | MIDB | Text (byte) | §18.17.7.211 | DBCS byte semantics |
| 10 | REPLACEB | Text (byte) | §18.17.7.273 | DBCS byte semantics |
| 11 | RIGHTB | Text (byte) | §18.17.7.276 | DBCS byte semantics |
| 12 | SEARCHB | Text (byte) | §18.17.7.286 | DBCS byte semantics |
| 13 | USDOLLAR | Text (spec legacy name) | §18.17.7.336 | Spec name for the function Excel exposes as DOLLAR (implemented); USDOLLAR itself does not resolve — needs an alias registration |

Note on the financial batch: `packages/engine/src/financial-functions.ts`
*claims* ODDFPRICE/ODDFYIELD/ODDLPRICE/ODDLYIELD in its header comment,
but they were never added to its `implementedFunctions` map — they are
genuinely absent (probe: `#NAME?`). FEATURES.md's "Financial — all
implemented" is therefore inaccurate for these four and will be
corrected when they land.

**Not name gaps, but recorded for completeness:**

- **OFFSET is implemented** — inside HyperFormula's core parser/interpreter
  (it never appears in the plugin-generated registry, which is why a
  registry-only diff flags it). Verified: `OFFSET(A1,1,0,2,1)` inside SUM
  evaluates correctly, negative offsets work. **Limitation:** a multi-cell
  *range* as the first argument (`OFFSET(A2:B2,1,0)`) is rejected at parse
  time ("First argument to OFFSET is not a reference"); Excel accepts it.
  Tracked as a Phase 2 candidate (engine rewrite or upstream limitation).
- **INT / MOD semantic divergence** (implemented, wrong for negatives vs
  Excel): `INT(-7.1)` → −7 (Excel: −8); `MOD(-10,3)` → −1 (Excel: 2).
  Upstream HyperFormula behavior; these are the last 2 of 421 gold-corpus
  cases. Phase 2 candidate via the engine's existing built-in-override
  machinery (`hf-overrides.ts` / `divergent-builtins.ts` patterns).
- **Provider-dependent by design** (implemented, real, but need an external
  provider — same as Excel): STOCKHISTORY & GOOGLEFINANCE (market-data
  provider), WEBSERVICE/FILTERXML (network), CUBE* (OLAP cube connection —
  the engine implements them against its cube data model), RTD (COM
  automation server — no COM on this platform; returns Excel's
  unavailable-data behaviour absent a registered server), CALL /
  REGISTER.ID (XLL/DLL add-ins — execute only against registered add-in
  bindings, exactly as Excel requires the DLL), COPILOT (LLM provider —
  wired to the product's Vertex AI backend), PY (Python runtime),
  TRANSLATE / DETECTLANGUAGE (translation provider seam with real
  built-in defaults). None of these are stubs; each is triaged in the
  Phase 2 report with its provider story.

## 1. The OOXML list — ISO/IEC 29500-1:2012 §18.17.7 (ECMA-376-1)

The OOXML specification defines its predefined functions in Part 1,
§18.17.7 "Predefined Function Definitions", as numbered subclauses
**§18.17.7.1 (ABS) through §18.17.7.356 (ZTEST)** — **356 functions**,
frozen at roughly the Excel 2010 function set. (ECMA-376 and
ISO/IEC 29500 are the same specification; Microsoft also publishes the
spec plus the [MS-XLSX] extension document. The spec's semantics —
not any vendor page — are the authority for these 356.) Three
spec-only names are worth knowing: `ECMA.CEILING` (§104, the spec's
CEILING serialization variant — implemented), `JIS` (§187, the spec
name for what Excel's UI calls DBCS — implemented), and `USDOLLAR`
(§336 — see gap #13).

| Function | Subclause | Status |
|---|---|---|
| ABS | §18.17.7.1 | ✅ implemented |
| ACCRINT | §18.17.7.2 | ✅ implemented |
| ACCRINTM | §18.17.7.3 | ✅ implemented |
| ACOS | §18.17.7.4 | ✅ implemented |
| ACOSH | §18.17.7.5 | ✅ implemented |
| ADDRESS | §18.17.7.6 | ✅ implemented |
| AMORDEGRC | §18.17.7.7 | ✅ implemented |
| AMORLINC | §18.17.7.8 | ✅ implemented |
| AND | §18.17.7.9 | ✅ implemented |
| AREAS | §18.17.7.10 | ✅ implemented |
| ASC | §18.17.7.11 | ✅ implemented |
| ASIN | §18.17.7.12 | ✅ implemented |
| ASINH | §18.17.7.13 | ✅ implemented |
| ATAN | §18.17.7.14 | ✅ implemented |
| ATAN2 | §18.17.7.15 | ✅ implemented |
| ATANH | §18.17.7.16 | ✅ implemented |
| AVEDEV | §18.17.7.17 | ✅ implemented |
| AVERAGE | §18.17.7.18 | ✅ implemented |
| AVERAGEA | §18.17.7.19 | ✅ implemented |
| AVERAGEIF | §18.17.7.20 | ✅ implemented |
| AVERAGEIFS | §18.17.7.21 | ✅ implemented |
| BAHTTEXT | §18.17.7.22 | ✅ implemented |
| BESSELI | §18.17.7.23 | ✅ implemented |
| BESSELJ | §18.17.7.24 | ✅ implemented |
| BESSELK | §18.17.7.25 | ✅ implemented |
| BESSELY | §18.17.7.26 | ✅ implemented |
| BETADIST | §18.17.7.27 | ✅ implemented |
| BETAINV | §18.17.7.28 | ✅ implemented |
| BIN2DEC | §18.17.7.29 | ✅ implemented |
| BIN2HEX | §18.17.7.30 | ✅ implemented |
| BIN2OCT | §18.17.7.31 | ✅ implemented |
| BINOMDIST | §18.17.7.32 | ✅ implemented |
| CEILING | §18.17.7.33 | ✅ implemented |
| CELL | §18.17.7.34 | ✅ implemented |
| CHAR | §18.17.7.35 | ✅ implemented |
| CHIDIST | §18.17.7.36 | ✅ implemented |
| CHIINV | §18.17.7.37 | ✅ implemented |
| CHITEST | §18.17.7.38 | ✅ implemented |
| CHOOSE | §18.17.7.39 | ✅ implemented |
| CLEAN | §18.17.7.40 | ✅ implemented |
| CODE | §18.17.7.41 | ✅ implemented |
| COLUMN | §18.17.7.42 | ✅ implemented |
| COLUMNS | §18.17.7.43 | ✅ implemented |
| COMBIN | §18.17.7.44 | ✅ implemented |
| COMPLEX | §18.17.7.45 | ✅ implemented |
| CONCATENATE | §18.17.7.46 | ✅ implemented |
| CONFIDENCE | §18.17.7.47 | ✅ implemented |
| CONVERT | §18.17.7.48 | ✅ implemented |
| CORREL | §18.17.7.49 | ✅ implemented |
| COS | §18.17.7.50 | ✅ implemented |
| COSH | §18.17.7.51 | ✅ implemented |
| COUNT | §18.17.7.52 | ✅ implemented |
| COUNTA | §18.17.7.53 | ✅ implemented |
| COUNTBLANK | §18.17.7.54 | ✅ implemented |
| COUNTIF | §18.17.7.55 | ✅ implemented |
| COUNTIFS | §18.17.7.56 | ✅ implemented |
| COUPDAYBS | §18.17.7.57 | ✅ implemented |
| COUPDAYS | §18.17.7.58 | ✅ implemented |
| COUPDAYSNC | §18.17.7.59 | ✅ implemented |
| COUPNCD | §18.17.7.60 | ✅ implemented |
| COUPNUM | §18.17.7.61 | ✅ implemented |
| COUPPCD | §18.17.7.62 | ✅ implemented |
| COVAR | §18.17.7.63 | ✅ implemented |
| CRITBINOM | §18.17.7.64 | ✅ implemented |
| CUBEKPIMEMBER | §18.17.7.65 | ✅ implemented |
| CUBEMEMBER | §18.17.7.66 | ✅ implemented |
| CUBEMEMBERPROPERTY | §18.17.7.67 | ✅ implemented |
| CUBERANKEDMEMBER | §18.17.7.68 | ✅ implemented |
| CUBESET | §18.17.7.69 | ✅ implemented |
| CUBESETCOUNT | §18.17.7.70 | ✅ implemented |
| CUBEVALUE | §18.17.7.71 | ✅ implemented |
| CUMIPMT | §18.17.7.72 | ✅ implemented |
| CUMPRINC | §18.17.7.73 | ✅ implemented |
| DATE | §18.17.7.74 | ✅ implemented |
| DATEDIF | §18.17.7.75 | ✅ implemented |
| DATEVALUE | §18.17.7.76 | ✅ implemented |
| DAVERAGE | §18.17.7.77 | ✅ implemented |
| DAY | §18.17.7.78 | ✅ implemented |
| DAYS360 | §18.17.7.79 | ✅ implemented |
| DB | §18.17.7.80 | ✅ implemented |
| DCOUNT | §18.17.7.81 | ✅ implemented |
| DCOUNTA | §18.17.7.82 | ✅ implemented |
| DDB | §18.17.7.83 | ✅ implemented |
| DEC2BIN | §18.17.7.84 | ✅ implemented |
| DEC2HEX | §18.17.7.85 | ✅ implemented |
| DEC2OCT | §18.17.7.86 | ✅ implemented |
| DEGREES | §18.17.7.87 | ✅ implemented |
| DELTA | §18.17.7.88 | ✅ implemented |
| DEVSQ | §18.17.7.89 | ✅ implemented |
| DGET | §18.17.7.90 | ✅ implemented |
| DISC | §18.17.7.91 | ✅ implemented |
| DMAX | §18.17.7.92 | ✅ implemented |
| DMIN | §18.17.7.93 | ✅ implemented |
| DOLLAR | §18.17.7.94 | ✅ implemented |
| DOLLARDE | §18.17.7.95 | ✅ implemented |
| DOLLARFR | §18.17.7.96 | ✅ implemented |
| DPRODUCT | §18.17.7.97 | ✅ implemented |
| DSTDEV | §18.17.7.98 | ✅ implemented |
| DSTDEVP | §18.17.7.99 | ✅ implemented |
| DSUM | §18.17.7.100 | ✅ implemented |
| DURATION | §18.17.7.101 | ✅ implemented |
| DVAR | §18.17.7.102 | ✅ implemented |
| DVARP | §18.17.7.103 | ✅ implemented |
| ECMA.CEILING | §18.17.7.104 | ✅ implemented |
| EDATE | §18.17.7.105 | ✅ implemented |
| EFFECT | §18.17.7.106 | ✅ implemented |
| EOMONTH | §18.17.7.107 | ✅ implemented |
| ERF | §18.17.7.108 | ✅ implemented |
| ERFC | §18.17.7.109 | ✅ implemented |
| ERROR.TYPE | §18.17.7.110 | ✅ implemented |
| EVEN | §18.17.7.111 | ✅ implemented |
| EXACT | §18.17.7.112 | ✅ implemented |
| EXP | §18.17.7.113 | ✅ implemented |
| EXPONDIST | §18.17.7.114 | ✅ implemented |
| FACT | §18.17.7.115 | ✅ implemented |
| FACTDOUBLE | §18.17.7.116 | ✅ implemented |
| FALSE | §18.17.7.117 | ✅ implemented |
| FDIST | §18.17.7.118 | ✅ implemented |
| FIND | §18.17.7.119 | ✅ implemented |
| FINDB | §18.17.7.120 | ❌ **missing** |
| FINV | §18.17.7.121 | ✅ implemented |
| FISHER | §18.17.7.122 | ✅ implemented |
| FISHERINV | §18.17.7.123 | ✅ implemented |
| FIXED | §18.17.7.124 | ✅ implemented |
| FLOOR | §18.17.7.125 | ✅ implemented |
| FORECAST | §18.17.7.126 | ✅ implemented |
| FREQUENCY | §18.17.7.127 | ✅ implemented |
| FTEST | §18.17.7.128 | ✅ implemented |
| FV | §18.17.7.129 | ✅ implemented |
| FVSCHEDULE | §18.17.7.130 | ✅ implemented |
| GAMMADIST | §18.17.7.131 | ✅ implemented |
| GAMMAINV | §18.17.7.132 | ✅ implemented |
| GAMMALN | §18.17.7.133 | ✅ implemented |
| GCD | §18.17.7.134 | ✅ implemented |
| GEOMEAN | §18.17.7.135 | ✅ implemented |
| GESTEP | §18.17.7.136 | ✅ implemented |
| GETPIVOTDATA | §18.17.7.137 | ✅ implemented |
| GROWTH | §18.17.7.138 | ✅ implemented |
| HARMEAN | §18.17.7.139 | ✅ implemented |
| HEX2BIN | §18.17.7.140 | ✅ implemented |
| HEX2DEC | §18.17.7.141 | ✅ implemented |
| HEX2OCT | §18.17.7.142 | ✅ implemented |
| HLOOKUP | §18.17.7.143 | ✅ implemented |
| HOUR | §18.17.7.144 | ✅ implemented |
| HYPERLINK | §18.17.7.145 | ✅ implemented |
| HYPGEOMDIST | §18.17.7.146 | ✅ implemented |
| IF | §18.17.7.147 | ✅ implemented |
| IFERROR | §18.17.7.148 | ✅ implemented |
| IMABS | §18.17.7.149 | ✅ implemented |
| IMAGINARY | §18.17.7.150 | ✅ implemented |
| IMARGUMENT | §18.17.7.151 | ✅ implemented |
| IMCONJUGATE | §18.17.7.152 | ✅ implemented |
| IMCOS | §18.17.7.153 | ✅ implemented |
| IMDIV | §18.17.7.154 | ✅ implemented |
| IMEXP | §18.17.7.155 | ✅ implemented |
| IMLN | §18.17.7.156 | ✅ implemented |
| IMLOG10 | §18.17.7.157 | ✅ implemented |
| IMLOG2 | §18.17.7.158 | ✅ implemented |
| IMPOWER | §18.17.7.159 | ✅ implemented |
| IMPRODUCT | §18.17.7.160 | ✅ implemented |
| IMREAL | §18.17.7.161 | ✅ implemented |
| IMSIN | §18.17.7.162 | ✅ implemented |
| IMSQRT | §18.17.7.163 | ✅ implemented |
| IMSUB | §18.17.7.164 | ✅ implemented |
| IMSUM | §18.17.7.165 | ✅ implemented |
| INDEX | §18.17.7.166 | ✅ implemented |
| INDIRECT | §18.17.7.167 | ✅ implemented |
| INFO | §18.17.7.168 | ✅ implemented |
| INT | §18.17.7.169 | ✅ implemented |
| INTERCEPT | §18.17.7.170 | ✅ implemented |
| INTRATE | §18.17.7.171 | ✅ implemented |
| IPMT | §18.17.7.172 | ✅ implemented |
| IRR | §18.17.7.173 | ✅ implemented |
| ISBLANK | §18.17.7.174 | ✅ implemented |
| ISERR | §18.17.7.175 | ✅ implemented |
| ISERROR | §18.17.7.176 | ✅ implemented |
| ISEVEN | §18.17.7.177 | ✅ implemented |
| ISLOGICAL | §18.17.7.178 | ✅ implemented |
| ISNA | §18.17.7.179 | ✅ implemented |
| ISNONTEXT | §18.17.7.180 | ✅ implemented |
| ISNUMBER | §18.17.7.181 | ✅ implemented |
| ISO.CEILING | §18.17.7.182 | ✅ implemented |
| ISODD | §18.17.7.183 | ✅ implemented |
| ISPMT | §18.17.7.184 | ✅ implemented |
| ISREF | §18.17.7.185 | ✅ implemented |
| ISTEXT | §18.17.7.186 | ✅ implemented |
| JIS | §18.17.7.187 | ✅ implemented |
| KURT | §18.17.7.188 | ✅ implemented |
| LARGE | §18.17.7.189 | ✅ implemented |
| LCM | §18.17.7.190 | ✅ implemented |
| LEFT | §18.17.7.191 | ✅ implemented |
| LEFTB | §18.17.7.192 | ❌ **missing** |
| LEN | §18.17.7.193 | ✅ implemented |
| LENB | §18.17.7.194 | ✅ implemented |
| LINEST | §18.17.7.195 | ✅ implemented |
| LN | §18.17.7.196 | ✅ implemented |
| LOG | §18.17.7.197 | ✅ implemented |
| LOG10 | §18.17.7.198 | ✅ implemented |
| LOGEST | §18.17.7.199 | ✅ implemented |
| LOGINV | §18.17.7.200 | ✅ implemented |
| LOGNORMDIST | §18.17.7.201 | ✅ implemented |
| LOOKUP | §18.17.7.202 | ✅ implemented |
| LOWER | §18.17.7.203 | ✅ implemented |
| MATCH | §18.17.7.204 | ✅ implemented |
| MAX | §18.17.7.205 | ✅ implemented |
| MAXA | §18.17.7.206 | ✅ implemented |
| MDETERM | §18.17.7.207 | ✅ implemented |
| MDURATION | §18.17.7.208 | ✅ implemented |
| MEDIAN | §18.17.7.209 | ✅ implemented |
| MID | §18.17.7.210 | ✅ implemented |
| MIDB | §18.17.7.211 | ❌ **missing** |
| MIN | §18.17.7.212 | ✅ implemented |
| MINA | §18.17.7.213 | ✅ implemented |
| MINUTE | §18.17.7.214 | ✅ implemented |
| MINVERSE | §18.17.7.215 | ✅ implemented |
| MIRR | §18.17.7.216 | ✅ implemented |
| MMULT | §18.17.7.217 | ✅ implemented |
| MOD | §18.17.7.218 | ✅ implemented |
| MODE | §18.17.7.219 | ✅ implemented |
| MONTH | §18.17.7.220 | ✅ implemented |
| MROUND | §18.17.7.221 | ✅ implemented |
| MULTINOMIAL | §18.17.7.222 | ✅ implemented |
| N | §18.17.7.223 | ✅ implemented |
| NA | §18.17.7.224 | ✅ implemented |
| NEGBINOMDIST | §18.17.7.225 | ✅ implemented |
| NETWORKDAYS | §18.17.7.226 | ✅ implemented |
| NETWORKDAYS.INTL | §18.17.7.227 | ✅ implemented |
| NOMINAL | §18.17.7.228 | ✅ implemented |
| NORMDIST | §18.17.7.229 | ✅ implemented |
| NORMINV | §18.17.7.230 | ✅ implemented |
| NORMSDIST | §18.17.7.231 | ✅ implemented |
| NORMSINV | §18.17.7.232 | ✅ implemented |
| NOT | §18.17.7.233 | ✅ implemented |
| NOW | §18.17.7.234 | ✅ implemented |
| NPER | §18.17.7.235 | ✅ implemented |
| NPV | §18.17.7.236 | ✅ implemented |
| OCT2BIN | §18.17.7.237 | ✅ implemented |
| OCT2DEC | §18.17.7.238 | ✅ implemented |
| OCT2HEX | §18.17.7.239 | ✅ implemented |
| ODD | §18.17.7.240 | ✅ implemented |
| ODDFPRICE | §18.17.7.241 | ❌ **missing** |
| ODDFYIELD | §18.17.7.242 | ❌ **missing** |
| ODDLPRICE | §18.17.7.243 | ❌ **missing** |
| ODDLYIELD | §18.17.7.244 | ❌ **missing** |
| OFFSET | §18.17.7.245 | ✅ implemented |
| OR | §18.17.7.246 | ✅ implemented |
| PEARSON | §18.17.7.247 | ✅ implemented |
| PERCENTILE | §18.17.7.248 | ✅ implemented |
| PERCENTRANK | §18.17.7.249 | ✅ implemented |
| PERMUT | §18.17.7.250 | ✅ implemented |
| PHONETIC | §18.17.7.251 | ✅ implemented |
| PI | §18.17.7.252 | ✅ implemented |
| PMT | §18.17.7.253 | ✅ implemented |
| POISSON | §18.17.7.254 | ✅ implemented |
| POWER | §18.17.7.255 | ✅ implemented |
| PPMT | §18.17.7.256 | ✅ implemented |
| PRICE | §18.17.7.257 | ✅ implemented |
| PRICEDISC | §18.17.7.258 | ✅ implemented |
| PRICEMAT | §18.17.7.259 | ✅ implemented |
| PROB | §18.17.7.260 | ✅ implemented |
| PRODUCT | §18.17.7.261 | ✅ implemented |
| PROPER | §18.17.7.262 | ✅ implemented |
| PV | §18.17.7.263 | ✅ implemented |
| QUARTILE | §18.17.7.264 | ✅ implemented |
| QUOTIENT | §18.17.7.265 | ✅ implemented |
| RADIANS | §18.17.7.266 | ✅ implemented |
| RAND | §18.17.7.267 | ✅ implemented |
| RANDBETWEEN | §18.17.7.268 | ✅ implemented |
| RANK | §18.17.7.269 | ✅ implemented |
| RATE | §18.17.7.270 | ✅ implemented |
| RECEIVED | §18.17.7.271 | ✅ implemented |
| REPLACE | §18.17.7.272 | ✅ implemented |
| REPLACEB | §18.17.7.273 | ❌ **missing** |
| REPT | §18.17.7.274 | ✅ implemented |
| RIGHT | §18.17.7.275 | ✅ implemented |
| RIGHTB | §18.17.7.276 | ❌ **missing** |
| ROMAN | §18.17.7.277 | ✅ implemented |
| ROUND | §18.17.7.278 | ✅ implemented |
| ROUNDDOWN | §18.17.7.279 | ✅ implemented |
| ROUNDUP | §18.17.7.280 | ✅ implemented |
| ROW | §18.17.7.281 | ✅ implemented |
| ROWS | §18.17.7.282 | ✅ implemented |
| RSQ | §18.17.7.283 | ✅ implemented |
| RTD | §18.17.7.284 | ✅ implemented |
| SEARCH | §18.17.7.285 | ✅ implemented |
| SEARCHB | §18.17.7.286 | ❌ **missing** |
| SECOND | §18.17.7.287 | ✅ implemented |
| SERIESSUM | §18.17.7.288 | ✅ implemented |
| SIGN | §18.17.7.289 | ✅ implemented |
| SIN | §18.17.7.290 | ✅ implemented |
| SINH | §18.17.7.291 | ✅ implemented |
| SKEW | §18.17.7.292 | ✅ implemented |
| SLN | §18.17.7.293 | ✅ implemented |
| SLOPE | §18.17.7.294 | ✅ implemented |
| SMALL | §18.17.7.295 | ✅ implemented |
| SQRT | §18.17.7.296 | ✅ implemented |
| SQRTPI | §18.17.7.297 | ✅ implemented |
| STANDARDIZE | §18.17.7.298 | ✅ implemented |
| STDEV | §18.17.7.299 | ✅ implemented |
| STDEVA | §18.17.7.300 | ✅ implemented |
| STDEVP | §18.17.7.301 | ✅ implemented |
| STDEVPA | §18.17.7.302 | ✅ implemented |
| STEYX | §18.17.7.303 | ✅ implemented |
| SUBSTITUTE | §18.17.7.304 | ✅ implemented |
| SUBTOTAL | §18.17.7.305 | ✅ implemented |
| SUM | §18.17.7.306 | ✅ implemented |
| SUMIF | §18.17.7.307 | ✅ implemented |
| SUMIFS | §18.17.7.308 | ✅ implemented |
| SUMPRODUCT | §18.17.7.309 | ✅ implemented |
| SUMSQ | §18.17.7.310 | ✅ implemented |
| SUMX2MY2 | §18.17.7.311 | ✅ implemented |
| SUMX2PY2 | §18.17.7.312 | ✅ implemented |
| SUMXMY2 | §18.17.7.313 | ✅ implemented |
| SYD | §18.17.7.314 | ✅ implemented |
| T | §18.17.7.315 | ✅ implemented |
| TAN | §18.17.7.316 | ✅ implemented |
| TANH | §18.17.7.317 | ✅ implemented |
| TBILLEQ | §18.17.7.318 | ✅ implemented |
| TBILLPRICE | §18.17.7.319 | ✅ implemented |
| TBILLYIELD | §18.17.7.320 | ✅ implemented |
| TDIST | §18.17.7.321 | ✅ implemented |
| TEXT | §18.17.7.322 | ✅ implemented |
| TIME | §18.17.7.323 | ✅ implemented |
| TIMEVALUE | §18.17.7.324 | ✅ implemented |
| TINV | §18.17.7.325 | ✅ implemented |
| TODAY | §18.17.7.326 | ✅ implemented |
| TRANSPOSE | §18.17.7.327 | ✅ implemented |
| TREND | §18.17.7.328 | ✅ implemented |
| TRIM | §18.17.7.329 | ✅ implemented |
| TRIMMEAN | §18.17.7.330 | ✅ implemented |
| TRUE | §18.17.7.331 | ✅ implemented |
| TRUNC | §18.17.7.332 | ✅ implemented |
| TTEST | §18.17.7.333 | ✅ implemented |
| TYPE | §18.17.7.334 | ✅ implemented |
| UPPER | §18.17.7.335 | ✅ implemented |
| USDOLLAR | §18.17.7.336 | ❌ **missing** |
| VALUE | §18.17.7.337 | ✅ implemented |
| VAR | §18.17.7.338 | ✅ implemented |
| VARA | §18.17.7.339 | ✅ implemented |
| VARP | §18.17.7.340 | ✅ implemented |
| VARPA | §18.17.7.341 | ✅ implemented |
| VDB | §18.17.7.342 | ✅ implemented |
| VLOOKUP | §18.17.7.343 | ✅ implemented |
| WEEKDAY | §18.17.7.344 | ✅ implemented |
| WEEKNUM | §18.17.7.345 | ✅ implemented |
| WEIBULL | §18.17.7.346 | ✅ implemented |
| WORKDAY | §18.17.7.347 | ✅ implemented |
| WORKDAY.INTL | §18.17.7.348 | ✅ implemented |
| XIRR | §18.17.7.349 | ✅ implemented |
| XNPV | §18.17.7.350 | ✅ implemented |
| YEAR | §18.17.7.351 | ✅ implemented |
| YEARFRAC | §18.17.7.352 | ✅ implemented |
| YIELD | §18.17.7.353 | ✅ implemented |
| YIELDDISC | §18.17.7.354 | ✅ implemented |
| YIELDMAT | §18.17.7.355 | ✅ implemented |
| ZTEST | §18.17.7.356 | ✅ implemented |

## 2. The Microsoft-current list — 523 functions

Microsoft's own catalogue is the "Excel functions by category" page on
support.microsoft.com (categories: Math & Trig, Date & Time, Lookup &
Reference, Text, Logical, Statistical, Financial, Information,
Engineering, Database, Cube, Web, Compatibility, Add-in and
Automation). The full page enumerates **516** names; Microsoft
documents **7** further current functions on their own support pages /
announcements rather than (or not yet on) the category page, for a
defensible current total of **523**:

- Post-snapshot additions with their own Microsoft Support pages:
  **TRIMRANGE** (2024, incl. the Trim Ref operators), **TRANSLATE** and
  **DETECTLANGUAGE** (2024), **COPILOT** (2025, =COPILOT), **PY**
  (Python in Excel).
- Linked-data-type functions documented outside the category page:
  **STOCKHISTORY**, **FIELDVALUE**.

(Mirror used for the category page enumeration: xlncad.com's complete
by-category list, 509 names, which omits the 7 byte-variant Text
functions — FINDB, LEFTB, LENB, MIDB, REPLACEB, RIGHTB, SEARCHB —
that Microsoft's Text page does list; they are restored in the count
above: 509 + 7 = 516.)

### The full 523, by category (❌ = missing, the Phase 2 gap list)

**Math & Trig (80)** — ABS, ACOS, ACOSH, ACOT, ACOTH, AGGREGATE, ARABIC, ASIN, ASINH, ATAN, ATAN2, ATANH, BASE, CEILING.MATH, CEILING.PRECISE, COMBIN, COMBINA, COS, COSH, COT, COTH, CSC, CSCH, DECIMAL, DEGREES, EVEN, EXP, FACT, FACTDOUBLE, FLOOR.MATH, FLOOR.PRECISE, GCD, INT, ISO.CEILING, LCM, LN, LOG, LOG10, MDETERM, MINVERSE, MMULT, MOD, MROUND, MULTINOMIAL, MUNIT, ODD, PERCENTOF, PI, POWER, PRODUCT, QUOTIENT, RADIANS, RAND, RANDARRAY, RANDBETWEEN, ROMAN, ROUND, ROUNDDOWN, ROUNDUP, SEC, SECH, SEQUENCE, SERIESSUM, SIGN, SIN, SINH, SQRT, SQRTPI, SUBTOTAL, SUM, SUMIF, SUMIFS, SUMPRODUCT, SUMSQ, SUMX2MY2, SUMX2PY2, SUMXMY2, TAN, TANH, TRUNC

**Date & Time (25)** — DATE, DATEDIF, DATEVALUE, DAY, DAYS, DAYS360, EDATE, EOMONTH, HOUR, ISOWEEKNUM, MINUTE, MONTH, NETWORKDAYS, NETWORKDAYS.INTL, NOW, SECOND, TIME, TIMEVALUE, TODAY, WEEKDAY, WEEKNUM, WORKDAY, WORKDAY.INTL, YEAR, YEARFRAC

**Lookup & Reference (39)** — ADDRESS, AREAS, CHOOSE, CHOOSECOLS, CHOOSEROWS, COLUMN, COLUMNS, DROP, EXPAND, FILTER, FORMULATEXT, GETPIVOTDATA, **GROUPBY ❌**, HLOOKUP, HSTACK, HYPERLINK, IMAGE, INDEX, INDIRECT, LOOKUP, MATCH, OFFSET, **PIVOTBY ❌**, ROW, ROWS, RTD, SORT, SORTBY, TAKE, TOCOL, TOROW, TRANSPOSE, UNIQUE, VLOOKUP, VSTACK, WRAPCOLS, WRAPROWS, XLOOKUP, XMATCH

**Text (40)** — ARRAYTOTEXT, ASC, BAHTTEXT, CHAR, CLEAN, CODE, CONCAT, CONCATENATE, DBCS, DOLLAR, EXACT, FIND, FIXED, LEFT, LEN, LOWER, MID, NUMBERVALUE, PHONETIC, PROPER, REGEXEXTRACT, REGEXREPLACE, REGEXTEST, REPLACE, REPT, RIGHT, SEARCH, SUBSTITUTE, T, TEXT, TEXTAFTER, TEXTBEFORE, TEXTJOIN, TEXTSPLIT, TRIM, UNICHAR, UNICODE, UPPER, VALUE, VALUETOTEXT

**Logical (20)** — AND, BYCOL, BYROW, FALSE, IF, IFERROR, IFNA, IFS, ISOMITTED, LAMBDA, LET, MAKEARRAY, MAP, NOT, OR, REDUCE, SCAN, SWITCH, TRUE, XOR

**Statistical (110)** — AVEDEV, AVERAGE, AVERAGEA, AVERAGEIF, AVERAGEIFS, BETA.DIST, BETA.INV, BINOM.DIST, BINOM.DIST.RANGE, BINOM.INV, CHISQ.DIST, CHISQ.DIST.RT, CHISQ.INV, CHISQ.INV.RT, CHISQ.TEST, CONFIDENCE.NORM, CONFIDENCE.T, CORREL, COUNT, COUNTA, COUNTBLANK, COUNTIF, COUNTIFS, COVARIANCE.P, COVARIANCE.S, DEVSQ, EXPON.DIST, F.DIST, F.DIST.RT, F.INV, F.INV.RT, F.TEST, FISHER, FISHERINV, FORECAST.ETS, FORECAST.ETS.CONFINT, FORECAST.ETS.SEASONALITY, FORECAST.ETS.STAT, FORECAST.LINEAR, FREQUENCY, GAMMA, GAMMA.DIST, GAMMA.INV, GAMMALN, GAMMALN.PRECISE, GAUSS, GEOMEAN, GROWTH, HARMEAN, HYPGEOM.DIST, INTERCEPT, KURT, LARGE, LINEST, LOGEST, LOGNORM.DIST, LOGNORM.INV, MAX, MAXA, MAXIFS, MEDIAN, MIN, MINA, MINIFS, MODE.MULT, MODE.SNGL, NEGBINOM.DIST, NORM.DIST, NORM.INV, NORM.S.DIST, NORM.S.INV, PEARSON, PERCENTILE.EXC, PERCENTILE.INC, PERCENTRANK.EXC, PERCENTRANK.INC, PERMUT, PERMUTATIONA, PHI, POISSON.DIST, PROB, QUARTILE.EXC, QUARTILE.INC, RANK.AVG, RANK.EQ, RSQ, SKEW, SKEW.P, SLOPE, SMALL, STANDARDIZE, STDEV.P, STDEV.S, STDEVA, STDEVPA, STEYX, T.DIST, T.DIST.2T, T.DIST.RT, T.INV, T.INV.2T, T.TEST, TREND, TRIMMEAN, VAR.P, VAR.S, VARA, VARPA, WEIBULL.DIST, Z.TEST

**Financial (55)** — ACCRINT, ACCRINTM, AMORDEGRC, AMORLINC, COUPDAYBS, COUPDAYS, COUPDAYSNC, COUPNCD, COUPNUM, COUPPCD, CUMIPMT, CUMPRINC, DB, DDB, DISC, DOLLARDE, DOLLARFR, DURATION, EFFECT, FV, FVSCHEDULE, INTRATE, IPMT, IRR, ISPMT, MDURATION, MIRR, NOMINAL, NPER, NPV, **ODDFPRICE ❌**, **ODDFYIELD ❌**, **ODDLPRICE ❌**, **ODDLYIELD ❌**, PDURATION, PMT, PPMT, PRICE, PRICEDISC, PRICEMAT, PV, RATE, RECEIVED, RRI, SLN, SYD, TBILLEQ, TBILLPRICE, TBILLYIELD, VDB, XIRR, XNPV, YIELD, YIELDDISC, YIELDMAT

**Information (20)** — CELL, ERROR.TYPE, INFO, ISBLANK, ISERR, ISERROR, ISEVEN, ISFORMULA, ISLOGICAL, ISNA, ISNONTEXT, ISNUMBER, ISODD, ISREF, ISTEXT, N, NA, SHEET, SHEETS, TYPE

**Engineering (54)** — BESSELI, BESSELJ, BESSELK, BESSELY, BIN2DEC, BIN2HEX, BIN2OCT, BITAND, BITLSHIFT, BITOR, BITRSHIFT, BITXOR, COMPLEX, CONVERT, DEC2BIN, DEC2HEX, DEC2OCT, DELTA, ERF, ERF.PRECISE, ERFC, ERFC.PRECISE, GESTEP, HEX2BIN, HEX2DEC, HEX2OCT, IMABS, IMAGINARY, IMARGUMENT, IMCONJUGATE, IMCOS, IMCOSH, IMCOT, IMCSC, IMCSCH, IMDIV, IMEXP, IMLN, IMLOG10, IMLOG2, IMPOWER, IMPRODUCT, IMREAL, IMSEC, IMSECH, IMSIN, IMSINH, IMSQRT, IMSUB, IMSUM, IMTAN, OCT2BIN, OCT2DEC, OCT2HEX

**Database (12)** — DAVERAGE, DCOUNT, DCOUNTA, DGET, DMAX, DMIN, DPRODUCT, DSTDEV, DSTDEVP, DSUM, DVAR, DVARP

**Cube (7)** — CUBEKPIMEMBER, CUBEMEMBER, CUBEMEMBERPROPERTY, CUBERANKEDMEMBER, CUBESET, CUBESETCOUNT, CUBEVALUE

**Web (3)** — ENCODEURL, FILTERXML, WEBSERVICE

**Compatibility (41)** — BETADIST, BETAINV, BINOMDIST, CEILING, CHIDIST, CHIINV, CHITEST, CONFIDENCE, COVAR, CRITBINOM, EXPONDIST, FDIST, FINV, FLOOR, FORECAST, FTEST, GAMMADIST, GAMMAINV, HYPGEOMDIST, LOGINV, LOGNORMDIST, MODE, NEGBINOMDIST, NORMDIST, NORMINV, NORMSDIST, NORMSINV, PERCENTILE, PERCENTRANK, POISSON, QUARTILE, RANK, STDEV, STDEVP, TDIST, TINV, TTEST, VAR, VARP, WEIBULL, ZTEST

**Add-in and Automation (3)** — CALL, EUROCONVERT, REGISTER.ID

**Text — byte variants (on Microsoft's page, omitted by the mirror) (7)** — **FINDB ❌**, **LEFTB ❌**, LENB, **MIDB ❌**, **REPLACEB ❌**, **RIGHTB ❌**, **SEARCHB ❌**

**Documented separately — newer functions (5)** — TRIMRANGE, TRANSLATE, DETECTLANGUAGE, COPILOT, PY

**Documented separately — linked data types (2)** — STOCKHISTORY, FIELDVALUE


## 3. Where does "523" come from? (reconciliation)

Published totals disagree because they snapshot different years and
apply different inclusion rules:

| Source | Count | Why it differs |
|---|---|---|
| ISO/IEC 29500-1:2012 §18.17.7 | 356 | Spec-frozen ~Excel 2010 set |
| *Microsoft Excel Inside Out* (Office 2021) | 502 | 2021 snapshot |
| xlncad mirror of Microsoft's category page | 509 | Omits the 7 byte-variant Text functions |
| BetterSolutions complete list | 515 | Different snapshot/inclusions again |
| Microsoft category page, counted completely | 516 | Includes compatibility + byte variants |
| **+ Microsoft's separately documented current functions** | **523** | + TRIMRANGE, TRANSLATE, DETECTLANGUAGE, COPILOT, PY, STOCKHISTORY, FIELDVALUE |

The gold corpus README's denominator — "413 of 523 Excel functions" —
matches the 523 reconstruction **exactly**, so 523 stands as the
repo's denominator, now with an explicit, sourced list behind it
(this file). The current implemented count against it is **511/523**
(the gold README's "413" was the count of functions with gold-corpus
cases at the time it was written, and its "110 not yet implemented"
list is stale — superseded by this analysis; the README and
progress.md are updated to the /523 framing by this workstream).

## 4. What the engine implements beyond Excel (not gaps)

The registry's 565 names include 53 that are in neither Excel list —
kept deliberately, none counted toward the 523: Google Sheets
functions (ARRAYFORMULA, GOOGLEFINANCE, IMPORTDATA/IMPORTFEED/
IMPORTHTML/IMPORTXML/IMPORTRANGE, SPLIT, COUNTUNIQUE, ARRAY_CONSTRAIN,
SINGLE, INTERVAL, ISBINARY, NUMBERSTRING…), the Thai locale function
family (THAIDIGIT, THAIMONTHOFYEAR, …), HyperFormula operator
functions (HF.ADD, HF.DIVIDE, …), and dotted legacy aliases the engine
accepts for file compatibility (TDISTRT, CHIINVRT, POISSONDIST, …).
Plus OFFSET, implemented in HyperFormula's core (see above).

## 6. Layering & triage (user ruling, 2026-10-21 16:49 PDT — binding)

The 523 (+ USDOLLAR from the spec list) are layered, and the layers
decide the build obligation:

| Layer | Contents | Count | State / obligation |
|---|---|---|---|
| **Living / modern** | Everything in Microsoft's current categories except Compatibility and Add-in/Automation; incl. dynamic arrays, LAMBDA family, GROUPBY/PIVOTBY, regex and text-split functions | ~476 | Implement for real; gaps: **GROUPBY, PIVOTBY** |
| **Financial (living)** | Microsoft's current Financial category incl. the odd-period bond functions | 55 | Gaps: **ODDFPRICE, ODDFYIELD, ODDLPRICE, ODDLYIELD** — implement for real |
| **Legacy-compatibility** | Microsoft's Compatibility category (BETADIST, STDEV, RANK, TDIST, …) — replaced names kept by Excel so old files calculate | 41 | **All 41 already implemented — KEEP, never discard; test coverage audited in Phase 2** |
| **Add-in / external** | CALL, REGISTER.ID, EUROCONVERT + provider-dependent functions in modern categories (STOCKHISTORY, FIELDVALUE, WEBSERVICE, FILTERXML, RTD, COPILOT, PY, CUBE×7, TRANSLATE, DETECTLANGUAGE) | ~17 | Implemented against providers/seams (see §"Provider-dependent"); no offline build obligation beyond the seams — Excel itself needs the same external systems |
| **Legacy DBCS byte functions** | FINDB, LEFTB, MIDB, REPLACEB, RIGHTB, SEARCHB (+ LENB) | 7 | **Documented SKIP** (below) |

### Documented skips (no build obligation, per the ruling)

| Function | Layer | Skip reason |
|---|---|---|
| FINDB | Legacy DBCS byte | Byte-position semantics exist only for DBCS (CJK double-byte) locales; superseded in modern use by FIND. Not relevant to current-day use for this product's locales. |
| LEFTB | Legacy DBCS byte | Same as FINDB; superseded by LEFT. |
| MIDB | Legacy DBCS byte | Same; superseded by MID. |
| REPLACEB | Legacy DBCS byte | Same; superseded by REPLACE. |
| RIGHTB | Legacy DBCS byte | Same; superseded by RIGHT. |
| SEARCHB | Legacy DBCS byte | Same; superseded by SEARCH. |
| USDOLLAR | Spec legacy name (§18.17.7.336) | The OOXML spec's name for what Excel exposes as DOLLAR (implemented). Excel's own current list does not include USDOLLAR; a one-line alias registration is the entire fix if a pre-2000 file ever surfaces it — noted, not built. |

Note: LENB, the one byte function with real modern use (CJK text
length checks), **is** implemented (extended-functions8.ts), so the
skip set is the six remaining byte variants only. If CJK-locale parity
ever becomes a requirement, all six are a single small batch built on
LENB's existing byte convention — the skip is a prioritization, not a
dead end.

**Resulting honest accounting after Phase 2:** 517/523 implemented
(511 today + GROUPBY, PIVOTBY + 4 odd-period bond functions), 6 legacy
documented-skips, 0 unexplained. OOXML spec list: 349/356 implemented
+ 7 documented-skips (the 6 byte functions + USDOLLAR).

## 5. Sources

1. ISO/IEC 29500-1:2012(E), Part 1, §18.17.7.1–§18.17.7.356 —
   full text via reginfo.gov (DownloadDocument objectID 136723002);
   ECMA-376-1 is the identical Ecma publication of the same spec.
2. Microsoft Support, "Excel functions by category"
   (support.microsoft.com) — enumerated via the complete by-category
   mirror at xlncad.com/complete-list-of-excel-functions (509 names,
   crawled Oct 2026), with the byte-variant Text functions restored
   from Microsoft's Text functions page.
3. Microsoft Support function pages: TRIMRANGE
   (support.microsoft.com …/trimrange-function-d7812248), TRANSLATE /
   DETECTLANGUAGE (Microsoft Excel blog + Support), COPILOT
   (Microsoft Support, =COPILOT function), PY / STOCKHISTORY /
   FIELDVALUE (Microsoft Support, linked data types & Python in Excel).
4. Count cross-checks: *Microsoft Excel Inside Out (Office 2021 and
   Microsoft 365)*, ch. 7 ("Excel offers 502 built-in calculation
   functions"); bettersolutions.com Excel functions index (515).
5. Engine inventory: `packages/engine/src/function-registry.ts`
   (FUNCTION_REGISTRY_VERSION 1) dumped from the built engine
   2026-10-21; live `EngineWorkbook` probes for every gap verdict.

---

## 7. Phase 2 resolution (2026-10-21)

All six living/modern gaps were implemented for real and registered
(FUNCTION_REGISTRY_VERSION 2; web function list regenerated, 572 names):

- **GROUPBY, PIVOTBY** — `packages/engine/src/groupby-functions.ts`
  (43 tests, Microsoft worked examples). Two spec corrections were
  established from sources quoting Microsoft during the build:
  PERCENTOF's `relative_to` mapping is 0 = column totals (default),
  1 = row totals, 2 = grand totals, 3 = parent column total,
  4 = parent row total; and `total_depth` omitted yields grand totals
  only (Excel's observed behavior).
- **ODDFPRICE** = 113.597717474079 on Microsoft's example (docs:
  113.5977); **ODDFYIELD** = 0.0772455415978175 (full-precision target
  0.0772455415972989, bisection tolerance); **ODDLPRICE** =
  99.8782860147213 (exact); **ODDLYIELD** = 0.045192235629169 (docs:
  0.04519223563). `packages/engine/src/financial-functions3.ts`, 30
  tests, all frequencies and bases, Microsoft's quasi-coupon
  algorithms. Deviation noted: ExcelFunctions.net's long-first
  ODDFPRICE example (106.771695) does not reproduce under Microsoft's
  documented algorithm (107.70358549 — their figure appears to omit
  accrued interest); all four Microsoft examples match, so the
  documented algorithm stands.
- **INT / MOD** — HyperFormula's zero-truncation semantics replaced
  with Excel's: INT = floor (INT(-7.1) = -8); MOD takes the divisor's
  sign (MOD(-10,3) = 2, MOD(10,-3) = -2). Gold corpus validates
  **421/421 + 44/44**, and the new batch 3 (GROUPBY/PIVOTBY/ODD*)
  validates **40/40** — 505 gold cases total, no expectation changes
  needed anywhere (the corpus's PERCENTRANK.INC expectation 0.429 was
  already Excel-correct; only a stale constant in
  `samples/generate-golden-batch2.mjs` was corrected).
- **OFFSET** — two findings. (1) Registry defect fixed: HyperFormula
  implements OFFSET inside its interpreter, so it never appeared in
  the plugin-registered name set and was missing from the versioned
  registry and the web function list despite working; the registry
  now includes it with curated metadata. (2) Triaged limitation:
  `OFFSET(A2:B2,1,0)` (range as first argument) is rejected by
  HyperFormula's parser ("First argument to OFFSET is not a
  reference"); Excel accepts it. Single-cell bases — the common form,
  including dynamic named ranges — work fully. Fixing the range form
  requires parser-level surgery in the upstream dependency;
  documented here as an upstream limitation, not silently skipped.
- **Platform note (dynamic arrays):** INDEX/SUM do not consume
  dynamic-array results as array arguments under HyperFormula
  (affects SEQUENCE/SORT/GROUPBY equally — pre-existing, not a
  GROUPBY defect); the engine's CHOOSEROWS/CHOOSECOLS do, and spill
  materialization into neighbor cells is the app layer's spill
  component (EngineWorkbook.getValue applies implicit intersection
  at anchors, by design).
- **Test-coverage audit** (TEST-COVERAGE-AUDIT.md): coverage of
  implemented functions rose 457/511 → **511/511** (112 new tests).
  The audit found **25 defects (D1–D25)** in already-"implemented"
  functions — including LINEST/LOGEST/MINVERSE/MUNIT, which were
  stubs — **all 25 are fixed** and the 49 defect-recording
  `it.fails` cases were promoted to plain passing tests.
- **Final accounting:** Microsoft list **517/523** implemented
  (511 + 6 built); 6 documented legacy skips (the DBCS byte family).
  OOXML spec list **349/356** (345 + GROUPBY/PIVOTBY are post-spec;
  the 7 spec-side misses are the same 6 byte functions + USDOLLAR).

---

## 8. Successor recovery verification (2026-10-21, after coordinator loss)

The Phase 2 coordinator died in a daemon restart. The successor
re-verified every Phase 2 claim in §§6–7 against the code on disk
(grep + live evaluation + full-suite runs), not against worker
reports. Verdicts:

### 8.1 The six living gaps — all REAL

| Function | Implemented (file) | Registered | Callable (live probe) | Tests |
|---|---|---|---|---|
| GROUPBY | `packages/engine/src/groupby-functions.ts` | plugins.ts `registerGroupByFunctions()` + registry v2 | ✅ gold batch-3 40/40 incl. GROUPBY/PIVOTBY cases | `tests/groupby-functions.test.ts` — 43 tests, pass |
| PIVOTBY | same file | same | ✅ same | same file (43 total) |
| ODDFPRICE | `packages/engine/src/financial-functions3.ts` | plugins.ts `registerFinancialFunctions3()` + registry | ✅ Microsoft example = 113.597717474079 | `tests/financial-functions3.test.ts` — 30 tests, pass |
| ODDFYIELD | same | same | ✅ 0.0772455415978175 | same file |
| ODDLPRICE | same | same | ✅ 99.8782860147213 | same file |
| ODDLYIELD | same | same | ✅ 0.045192235629169 | same file |

### 8.2 Phase 2 coordinator's classified engine anomalies — disposition

| # | Classification (Phase 2 consolidated run) | Successor verdict |
|---|---|---|
| 1 | "1 GENUINE ACCRINT basis-3 numeric defect" | **NOT REPRODUCIBLE in the current tree.** No case details (inputs/expected/actual) were recorded with the classification, so the exact case cannot be reconstructed. Fresh independent battery — 7 basis-3 cases (freq 1/2/4, leap-year issue, multi-period accrual, calc_method TRUE/FALSE, odd long first period), expectations computed from Excel's documented formula (telescopes to par×rate×days/365) — passes through BOTH src and dist; the pre-existing basis-3 test (9-decimal tolerance) passes; full engine suite 1187/1187. Note the predecessor audit (TEST-COVERAGE-AUDIT.md) had verified "ACCRINT at basis 3" CORRECT and found the real ACCRINT defect at basis **0** (D1, since fixed); a basis-3 defect DID exist in PRICEDISC (D23, extended-functions7.ts, since fixed) — the classification may have conflated one of these. New regression battery kept: `packages/engine/tests/accrint-basis3.test.ts` (7 tests). |
| 2 | "44 stale `it.fails` markers to flip" | **ALREADY RESOLVED in tree.** Zero live `it.fails` remain in engine tests (only 3 comment mentions recording the promotion). Per TEST-COVERAGE-AUDIT.md Resolution, all 49 defect cases were promoted to plain `it` when D1–D25 were fixed; the coordinator's count of 44 was taken mid-flight. All promoted tests pass in the 1187/1187 baseline. |
| 3 | "functionList.ts drift" | **NO DRIFT in the current tree.** Three-way mechanical check: src registry category map (572 names) == freshly regenerated list (572) == committed `apps/web/src/features/functionList.ts` (registry v2, byte-identical regeneration, 0 diff lines). |
| 4 | INT-override dual-registration breaks 3 test files under src+dist co-import | **Harness artifact, as classified.** The standard engine suite (src only, one vitest process) is 54 files / 1187 tests, all passing. No product impact found; product verified via dist probe (INT(-7.1) = -8, MOD(-10,3) = 2 through the gold corpus 505/505). |

### 8.3 Baselines (successor-run, 2026-10-21 evening)

- Engine: `npx vitest run` → **54 files, 1187 tests, ALL PASS** at the
  recovery baseline (engine src unchanged afterwards except the added
  test file). The new accrint-basis3 battery passes 7/7, and a final
  targeted subset (battery + registry + INT/MOD override + all four
  coverage suites + financial3 + groupby + divergent-builtins) passes
  213/213. A single full-suite re-run on the final tree was attempted
  twice and killed by runtime restarts both times (23 files reported,
  zero failures, before each kill) — stated plainly rather than
  papered over.
- Engine `npm run build` (tsc) → clean, exit 0. The died worker's
  `src/extended-functions7.ts` compiles and its tests pass.
- xlsx-adapter suite: see track report (run at recovery time).

### 8.4 Triage state (unchanged, re-confirmed)

517/523 implemented & callable; 6 documented legacy skips (FINDB,
LEFTB, MIDB, REPLACEB, RIGHTB, SEARCHB) + USDOLLAR spec-name skip;
legacy-compatibility 41/41 kept & tested; test coverage 511/511
implemented functions (audit-after.json) + the 6 new functions covered
by their dedicated suites (43 + 30 tests).
