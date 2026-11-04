# Icecream Sheets Skill Packs — Install Guide

*A guide for third-party builders: what skill packs are, how to
install and select them, how they are versioned, and how to add your
own tools and packs.*

## What a skill pack is

A skill pack is an installable bundle of related MCP tools — plus
example prompts — for the Icecream Sheets MCP server. A pack is not a
plugin sandbox or a side channel: pack tools register into the server
through the exact same mechanism as the 39 core tools, run against
the same workbook, and obey the same rules:

- Every response uses the standard envelope:
  `{ protocolVersion: 1, ok: true, ... }` on success,
  `{ protocolVersion: 1, ok: false, error }` with `isError: true` on
  failure. Handlers never throw.
- Every read and write goes through the engine's authorization with
  the caller's principal. Cells the principal cannot read surface as
  empty — pack computations never see denied values.
- A pack's example prompts are registered as real MCP prompts, named
  `<pack-id>.<prompt-name>`, so any MCP client can list and fetch
  them.

The bundled packs:

| Pack id | Tools | Guide |
|---|---|---|
| `data-cleaning` | `clean_dedupe_rows`, `clean_normalize_text`, `clean_coerce_types`, `clean_fill_missing`, `clean_split_column`, `clean_merge_columns` | [data-cleaning/README.md](./data-cleaning/README.md) |
| `financial-modeling` | `fin_forecast`, `fin_npv_irr`, `fin_scenario_sweep` | [financial-modeling/README.md](./financial-modeling/README.md) |
| `survey-analysis` | `survey_code_responses`, `survey_frequencies`, `survey_crosstab`, `survey_chart_results` | [survey-analysis/README.md](./survey-analysis/README.md) |

## Bundle layout

Each pack ships two halves that belong together:

```
packages/mcp-server/
  src/packs/
    types.ts               PackContext / SkillPack contracts
    grid.ts                Shared authorized table read/write helpers
    index.ts               The registry (bundled set + selection)
    data-cleaning.ts       Pack implementation + manifest
    financial-modeling.ts
    survey-analysis.ts
  packs/
    README.md              This guide
    data-cleaning/
      pack.json            Machine-readable manifest (mirror — see Versioning)
      README.md            Pack documentation + example prompts
      example-messy-orders.csv
    financial-modeling/    …
    survey-analysis/       …
```

The TypeScript module is the implementation and the manifest's
source of truth; the `packs/<id>/` directory is the distributable
bundle a third party reads: manifest, docs, example data.

## Installing packs

Packs are part of the `@icecream-sheets/mcp-server` package — there
is nothing separate to download. "Installing" a pack means selecting
it when the server starts. **With no selection, every bundled pack
is installed.**

### Building from a fresh checkout

This package type-checks and runs against the built output of its
workspace dependencies (`@icecream-sheets/engine`,
`@icecream-sheets/service`, and the adapters the service consumes),
so on a fresh clone those must be built first, in dependency order,
from the repository root:

```bash
npm ci
npm run build -w @icecream-sheets/engine -w @icecream-sheets/xlsx-adapter \
  -w @icecream-sheets/csv-adapter -w @icecream-sheets/service
npm run build -w @icecream-sheets/mcp-server   # or `npm run build` in this directory
```

(The root `npm run build` builds every workspace in glob order,
which is not dependency order — on a fresh tree it can reach a
package before its dependencies have been built.)

### The shipped runners: `MCP_PACKS`

Both production entrypoints read the `MCP_PACKS` environment
variable: a comma-separated list of pack ids.

```bash
# stdio runner — only the data-cleaning pack
MCP_PACKS=data-cleaning npm run build && MCP_PACKS=data-cleaning node dist/index.js

# Streamable HTTP runner (auth secret required, as always)
MCP_AUTH_SECRET=<your secret> MCP_PACKS=data-cleaning,financial-modeling \
  node dist/bin/http.js
```

Selection is validated at startup: an unknown id makes the shipped
HTTP runner refuse to start with a clear error (fail closed), and
makes `createServer` throw for embedders. A typo can never silently
start a server with fewer tools than you asked for.

### Embedding the library

```ts
import { createServer } from '@icecream-sheets/mcp-server';

// Only the survey pack:
const server = createServer(undefined, { packs: ['survey-analysis'] });

// HTTP listener:
import { startMcpHttp } from '@icecream-sheets/mcp-server/http';
startMcpHttp(8106, { packs: ['data-cleaning'] });
```

### Verifying an install

Call the `list_skill_packs` tool (installed with the core tools). It
returns the manifest of every installed pack: id, name, version,
tool names, and example prompts. `tools/list` shows the pack tools
next to the core tools, and `prompts/list` shows the example
prompts. If a pack you selected is missing from `list_skill_packs`,
it is not installed — check the selection for typos (startup would
have failed closed on an unknown id, so a missing pack means the
selection never reached the server).

## Versioning

Each pack carries its own **semantic version** in its manifest
(`version` field), versioned independently of the server's version
and of the other packs.

- **Major** — a tool is removed or renamed, an argument is removed
  or changes meaning, or a result field clients rely on changes
  shape.
- **Minor** — a tool or prompt is added, or an existing tool gains a
  new optional argument or result field.
- **Patch** — behavior fixes that keep the documented contract,
  documentation, and example-data changes.

Guidance for clients: pin the pack **id**, read the installed
**version** from `list_skill_packs` at session start, and treat a
major-version change as a contract change. The wire envelope's
`protocolVersion` is the server's engine protocol version — it is
unrelated to pack versions and changes far more rarely.

`pack.json` is a generated mirror of the manifest in
`src/packs/<id>.ts`. After changing a manifest, regenerate it:

```bash
npm run build && node scripts/gen-pack-manifests.mjs
```

The test suite (`tests/packs-registry.test.ts`) fails if `pack.json`
and the registered manifest drift apart.

## Adding a tool to a pack — worked example

We will add `clean_remove_blank_rows` to the data-cleaning pack: it
removes rows in which every cell is empty. (Trailing blank rows are
already ignored by the pack's table reader; this removes interior
blank rows.)

### 1. Implement the tool in the pack's `register`

In `src/packs/data-cleaning.ts`, inside `register(ctx)`, alongside
the other tools (the module already imports `zod`, `readTable`,
`writeTable`, and the module-private `isMissing` helper):

```ts
ctx.tool(
  'clean_remove_blank_rows',
  'Remove rows from a sheet where every cell is empty. Writes the result to the target sheet (default: the source sheet) and reports how many rows were removed.',
  {
    sheet: sheetArg,
    targetSheet: targetArg,
    principal: P,
  },
  async (args: { sheet: string; targetSheet?: string; principal?: string }) => {
    try {
      const auth = ctx.authOf(args);
      const table = await readTable(ctx.engine, args.sheet, auth);
      const rows = table.rows.filter((row) => row.some((v) => !isMissing(v)));
      const target = args.targetSheet ?? args.sheet;
      await writeTable(ctx.engine, target, table.headers, rows, auth);
      return ctx.ok({
        sheet: args.sheet,
        targetSheet: target,
        rowsIn: table.rows.length,
        rowsOut: rows.length,
        removed: table.rows.length - rows.length,
      });
    } catch (e) {
      return ctx.error(e instanceof Error ? e.message : String(e));
    }
  },
);
```

The pattern every pack tool follows:

- Resolve the caller with `ctx.authOf(args)` and pass that auth to
  every engine helper — never call the engine unauthenticated.
- Read and write whole tables with the helpers in `src/packs/grid.ts`
  (`readTable`, `writeTable`, `columnIndex`, …) so authorization,
  `#PERM!` handling, and the cell caps stay uniform.
- Validate with the zod schema (bounds included), fail with
  `ctx.error(...)` — never throw out of a handler.
- Return a summary of what changed (counts, targets), not just
  success: agents plan their next step from it.

### 2. Add the name to the manifest

In the same file, add `'clean_remove_blank_rows'` to the pack's
`tools` array, in registration order, and bump the version — a new
tool is a **minor** bump: `1.0.0` → `1.1.0`.

### 3. Regenerate `pack.json`

```bash
npm run build && node scripts/gen-pack-manifests.mjs
```

### 4. Test it

Add a case to `tests/packs-data-cleaning.test.ts` that drives the
tool through the real protocol (the file's `makeClient`/`call`
harness) — seed a table with an interior blank row, call the tool,
read the sheet back, and assert:

```ts
const res = await call(client, 'clean_remove_blank_rows', { sheet: 'Orders' });
expect(res.ok).toBe(true);
expect(res.removed).toBe(1);
```

### 5. Document it

Add a row to the tool table in `packs/data-cleaning/README.md`, and
regenerate the server README's generated tool table:

```bash
node scripts/list-tools.mjs   # after npm run build
```

### 6. Run the suite

```bash
npm run build && npm test
```

The registry tests re-check the manifest ↔ `pack.json` mirror and
the installed-tool lists, so a forgotten step fails loudly.

## Adding a whole new pack

1. Create `src/packs/<your-pack-id>.ts` exporting a `SkillPack`
   (manifest + `register`), following the contracts in
   `src/packs/types.ts`.
2. Add one line to the registry in `src/packs/index.ts`
   (`SKILL_PACKS`).
3. Create the bundle directory `packs/<your-pack-id>/` with a
   `README.md` (tools, example prompts, a try-it example); generate
   its `pack.json` with `node scripts/gen-pack-manifests.mjs` after
   building.
4. Add `tests/packs-<your-pack-id>.test.ts` exercising the pack's
   headline workflow end to end through the MCP protocol.
5. Build, run the full suite, and update this guide's bundled-pack
   table.

## Troubleshooting

- **"unknown skill pack" at startup** — the id in `MCP_PACKS` (or
  `ServerOptions.packs`) is not bundled. The error lists the valid
  ids. This is deliberate: selection fails closed.
- **`survey_chart_results` says "chart creation is not available in
  this session"** — native chart creation needs the session's chart
  sink, exactly like the core `create_chart` tool. Hosts that wire a
  workbook session provide it; a bare MCP server does not, and the
  tool refuses rather than pretending to chart.
- **A column "does not exist"** — pack tools address columns by
  header name (case-insensitive). The error lists the headers the
  sheet actually has.
- **Cells read as empty that should have values** — the caller lacks
  read permission on them. Authorization applies to pack tools
  exactly as to `read_cells`.
