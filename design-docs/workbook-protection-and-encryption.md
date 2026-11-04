# Workbook protection and encryption

Decided October 13, 2026. Protection model for workbooks at rest and in transit. Real enforcement in the service boundary; file-embedded protection is hint-only.

## 1. Permission enforcement

The permission model is enforced by the service boundary. Every access goes through authorize(). There is no bypass.

## 2. UI indicators

Protected ranges show visual indicators. The UI explains why an action was denied. Users can request access through the sharing flow.

LOCK BADGE — SELECTION-ACTIVATED (user's ruling, 2026-10-21): the per-cell lock indication (the 🔒 badge and its amber edge highlight in the grid) is shown ONLY within the current selection. Selection activates the showing: a selected cell shows its badge if locked; a selected row shows badges on the locked cells of that row; a selected column likewise; select-all shows badges on every locked cell (today's behavior, but only under select-all). Unselected areas show NO badge — a protected sheet (where Excel's locked flag defaults to true nearly everywhere) must not render as a wall of padlocks. This rule applies identically to the WEB APP and the DESKTOP APPS (shared grid). Accessibility is unaffected: the aria-label still announces "(locked)" for the focused cell regardless of badge visibility.

## 3. At-rest encryption

Workbook data is encrypted at rest in the service storage. Keys are managed by the service key management system.

## 4. Password protection

Workbooks can require a password to open. The password derives an encryption key. Passwords are never stored.

## 5. XLSX round-trip

Protection flags round-trip through XLSX. Service-enforced permissions do not travel in the file; file-embedded protection is preserved as hints.

## 6. Downloads

Downloads respect permissions. A user who cannot read a range gets a file without that data. The download action checks authorize() for the full workbook.

## 7. Key management

Encryption keys are per-workbook. Key rotation is supported. Compromised keys can be revoked and reissued.

## 8. Audit

Protection changes are audit-logged: who changed what, when. Failed access attempts are logged.

## 9. Out of scope for v1

Customer-managed keys. Field-level encryption. Digital signatures.

## Workbook protection and encryption v2

Tracked v2 backlog. Customer-managed keys. Field-level encryption. Digital signatures for workbooks.
