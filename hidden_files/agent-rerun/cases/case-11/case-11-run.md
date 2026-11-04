# Case 11 rerun — run log (alice, live browser)

Verdict: **FAIL** — binding fix VERIFIED, but the UI run is blocked by a separate, pre-existing residual defect (signed-token forwarding). See `result.json` (`failureReason`).

## Fixture (mirrors TOUR-W4 exactly)
- Created through the gateway for **alice** via `apiSetupSession`, sheet Sheet1: header Units/Product/Region/Price + rows (10,Widget,North,5), (20,Gadget,South,5), (5,Widget,South,5), (15,Gadget,North,10), (8,Widget,North,10).
- Hand-computed expected sum (Sum Reporter default ref Sheet1 A1:A10, numeric cells only): 10+20+5+15+8 = **58** (count 5).
- Final-run fixture: `file-b29841ac-50c8-4086-88c6-c449a0cccef1`, session `sess_c5a1e8bc-62f8-4a15-a86d-02989f1f583f`.
- Engine API read-back (pre + post, with the session access token): exact match to the seeded grid, col-A sum 58 (`result.json.apiReadBack`, `apiMatch: true`).

## What passed
- Browser opened the file via `#file=<id>` deep link; grid painted (A1 = Units), no reload retry needed in the final run.
- **Add-ons dialog shows "Signed in as owner on file-b29841ac-50c8-4086-88c6-c449a0cccef1"** — `documentIdShown == expectedDocumentId`, NOT `local-workbook`. The case-11 binding fix works (screenshot `03-manager-catalog.png`, also visible in `09-after-run.png`).
- Sum Reporter installed, grant requested, grant approved, "Granted on this document", Run button visible and clicked (screenshots 04-09).

## Where it failed
- UI run outcome (screenshot `09-after-run.png`, red banner): **"Run failed: engine access denied: malformed"** -> `reportedSum = null`.
- Root cause isolated (code + diagnostic, not a guess):
  - `packages/gateway/src/services/addonEngineBinding.ts` forwards the caller's bearer token — the **3-part gateway JWT** — to the engine.
  - Signed engine access requires a **2-part engine-access token** (`packages/gateway/src/deploy/engineAccess.ts`: verify rejects any token whose split is not exactly 2 parts as `malformed`).
  - Diagnostic (explicitly non-UI): direct `POST http://localhost:8107/run` for the same document + grant, presenting this session's valid engine-access token, returned **200 `{ok:true, value:{sum:58, count:5}}`** (`result.json.diagnosticDirectRun`). Add-on, grant, and document binding all work when a valid engine token is presented; only the UI path's token forwarding is broken.
  - This residual predates the binding fix: the ORIGINAL case-11 screenshot (`agent-features/cases/case-11/08-after-run.png`) shows the identical "malformed" banner under the `local-workbook` binding. Suggested fix (not done — validation only): the add-ons service must mint/resolve a proper engine-access token for (user, session, file) like the agent session resolver does, instead of forwarding the gateway JWT.

## Friction
- Run 1 (fixture `file-4fdff55a-6769-4622-9ac9-37530367b8fd`): same documentId match and same "malformed" UI failure (kept as `result-run1.json.bak` / `09-after-run-run1.png.bak`). Its API read-back returned 401/{} because the harness `apiReadRange` does not fall back to `s.accessToken` when passed `null` (the same quirk visible in w4's results); the final run passes the real token and reads back cleanly.
- The whole local stack went down mid-task (~02:28 PDT, all ports 000, no node processes) and was restarted externally; I did not restart or rebuild anything. The corrected final run was executed after the stack returned.
- No join stalls; no reload retries in either completed run. Previous owner released before fixture setup in both runs (run 1 released `file-3cc45da2-d7c1-4dd3-b95d-f3cab687a1c7`; final run: none to release).

## Evidence
- Screenshots `01-fixture-open.png` ... `09-after-run.png` in this directory.
- `result.json` — { documentIdShown, expectedDocumentId, expectedSum, reportedSum (null, UI), apiReadBack, diagnosticDirectRun, pass:false, verdict:"FAIL", steps }.
- Script: `run-case11.mjs`; raw log: `run.log.txt`.
