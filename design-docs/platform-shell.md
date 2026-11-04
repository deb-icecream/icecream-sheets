# Platform shell

Decided October 15, 2026. The host layer around the engine: workbook lifecycle, menus, settings, help, shortcuts and offline behavior. One headless engine core behind a versioned protocol; every host supplies the same computational-view and storage-adapter boundaries.

## 1. One engine core, many hosts

The web client hosts the engine as a service. Desktop and mobile package the identical core for local execution. Workbook behavior comes from one engine that can run hosted or packaged; no host forks calculation semantics.

## 2. Workbook lifecycle

New, Open, Make a copy and Move to trash operate on the service metadata store. Open lists the user's workbooks with owner, created and modified times, size and storage backend. Make a copy duplicates bytes and metadata under a new id and needs the manage right on the workbook. Move to trash soft-deletes with restore inside the retention window, then permanent delete.

## 3. Structural permissions

Sheet tab operations go through the permission model. Duplicating, hiding and reordering sheets are structural operations needing the manage right on the workbook. Renaming a sheet needs write on the sheet. The tab bar renders tabs in order from the service metadata store.

## 4. Settings and profile

Settings are per-user preferences in the user profile, never in workbook bytes. A workbook opened by another user never carries the owner's preferences with it.

## 5. Help and docs

Help opens product-owned docs and the product-owned changelog. There is no external service dependency. The function list opens the function reference generated from the versioned function registry.

## 6. Menu search and shortcuts

Global menu search and keyboard shortcuts resolve against the same command registry on every host, so shortcuts behave identically on web and desktop.

## 7. Offline

Offline logs replay typed operations through the engine when connectivity returns. Persistence remains adapter-owned. Conflicts surface to the user and are never silently merged.

## 8. MCP surface

Typed cell, range, formula and recalculation operations are exposed through the MCP server on every host, so third-party clients get the same operations as the built-in UI.

## 9. Out of scope for v1

Native mobile clients. Multi-window desktop.

## Platform shell v2

Tracked v2 backlog. Native mobile clients. Multi-window desktop.
