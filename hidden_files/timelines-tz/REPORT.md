# Timelines timezone fix — record

Started: 2026-10-22 (worker session 121a32d3)
Scope: apps/web/src/features/timelines.test.ts — 5 tests fail under
TZ=America/Los_Angeles, 22/22 pass under TZ=UTC (parent diagnosis).
Constraint: failed + related tests only; no full suite; no push.

## Initial read
- parseDateCell (timelines.ts) parses strings via Date.parse, which per
  spec reads a date-only ISO string ('2026-03-14') as UTC midnight.
- Every consumer in the module reads LOCAL calendar fields: bucketKey
  (getFullYear/getMonth/getDate), formatTimelineDate (local getters),
  presets build bounds with local constructors new Date(y, m, d).
- Hypothesis: implementation bug — date-only strings must parse to the
  local calendar day they name. Pending: repro + consumer grep.

## Log

## Reproduction (confirmed)
- TZ=UTC: 22/22 pass. TZ=America/Los_Angeles: exactly the 5 named
  failures (parseDateCell ISO, timelinePasses days/quarters/years,
  timelineExtent min/max). 17 others pass in both.

## Diagnosis — the IMPLEMENTATION is wrong (timelines.ts), tests stand
A timeline filters spreadsheet date cells by the calendar day the user
sees, and the module's whole contract is local calendar days: range
bounds are local Dates, bucketKey/formatTimelineDate read local fields,
presets build local midnights. parseDateCell broke that contract by
handing date-only strings to Date.parse, which per spec reads
'2026-03-14' as UTC midnight — March 13 local west of UTC — so a
Pacific user's March-14 cell silently filtered as March 13 (real
product path: Grid.tsx timelinePasses, App.tsx timelineExtent).

## Fix (timelines.ts, parseDateCell only; test file untouched)
- Date-only ISO strings (YYYY-MM-DD) now construct the local-midnight
  Date for the named day, with a component round-trip check so
  overflow dates (2026-02-30) still return null.
- The Excel-serial branch had the identical defect (a serial is a
  calendar-day number returned as a UTC-midnight instant); it now
  returns the serial's calendar day as local midnight the same way.
- Date-time strings still go through Date.parse (instant semantics).

## Validation
- timelines.test.ts: 22/22 under TZ=UTC AND 22/22 under
  TZ=America/Los_Angeles (was 22/22 and 17/22).
- Related (src/features/*.test.ts): 76 files / 1006 tests — ALL PASS
  under TZ=UTC and ALL PASS under TZ=America/Los_Angeles. Only
  timelines.test.ts imports the timelines module among feature tests,
  so the blast radius of the change is exactly the fixed file.

## Verdict
DONE. Implementation fixed in apps/web/src/features/timelines.ts
(parseDateCell only); apps/web/src/features/timelines.test.ts
untouched. No full suite run, nothing pushed (per tasking).
