# Named ranges and named functions

Decided October 13, 2026. Stable named identities in the typed computational view: named ranges that bind a name to a range, and named functions that bind a name to user-defined logic.

## 1. Named range identity

Every named range has a stable object id, independent of the cells it currently covers. The name binds to the identity and the identity tracks the range as rows and columns are inserted, deleted or moved. Deleting all covered cells leaves a dangling name that resolves to a reference error, never to whatever moves into the address.

## 2. Scope and rules

Names are workbook-scoped by default. A sheet-scoped name is addressed with its sheet prefix and shadows the workbook name within that sheet. Names are case-insensitive and must not parse as a cell reference or a function name. Creating a colliding name is rejected, never silently renamed.

## 3. Storage and XLSX round-trip

Definitions live in the service metadata store, keyed by the stable id. They are never the source of truth inside workbook bytes. The XLSX adapter mirrors them into the file's defined-names table on save and reads them back on open, so workbooks round-trip through Excel with names intact.

## 4. Permissions on named objects

A named range is an object in the permission tree at the range, table or named range level. Defining or editing a name requires write on the underlying range. Reading through a name enforces the same per-cell authorize() checks as addressing the cells directly.

## 5. Formula resolution

The engine resolves a name to its stable id when the formula is parsed. If the range moves, the formula follows the identity without edits. Referencing a name the user cannot read evaluates to a permission error value, matching the permission model.

## 6. Named functions

A named function binds a name to user-defined logic written in Python, JavaScript or TypeScript. It compiles to the sandboxed custom-function runtime, the same sandbox formulas can call. Every named function declares a typed signature with argument types and a return type, checked at definition time against the typed view.

## 7. Function versioning and permissions

Definitions are versioned. Formulas always evaluate against the current version and old versions are retained for audit and rollback. Editing a function requires the manage right on the workbook. Using one in a formula requires read on the workbook. The XLSX adapter maps named functions to defined names holding LAMBDA expressions where the target shape allows, best effort.

## 8. Out of scope for v1

Cross-workbook name references. Sharing or publishing named functions beyond the workbook. Name-scoped access distinct from the underlying range permissions.

## Named ranges and named functions v2

Tracked v2 backlog. Cross-workbook name references. A function library shared across workbooks. Name-scoped access distinct from the underlying range permissions.
