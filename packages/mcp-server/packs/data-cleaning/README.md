# Data Cleaning — Icecream Sheets skill pack

**Pack id:** `data-cleaning` · **Version:** 1.0.0 · **Manifest:** [pack.json](./pack.json)

Clean messy sheet data through MCP tools. Every tool reads a sheet's
used range as a table (first row = header), transforms it, and writes
the result back as a table — to `targetSheet` when given, otherwise
over the source sheet. Reads and writes go through the server's
authorized engine view, so protected cells behave exactly as they do
for the core tools: denied cells read as empty and never leak.

## Tools

| Tool | What it does |
|---|---|
| `clean_dedupe_rows` | Remove duplicate rows. Duplicates match on the named `columns` (all columns when omitted); `keep` is `first` (default) or `last`. Reports rows in/out and how many were removed. |
| `clean_normalize_text` | Trim whitespace, collapse internal whitespace runs, and optionally change case (`lower` \| `upper` \| `title`) on the named columns — or every column when none are named. Reports cells changed. |
| `clean_coerce_types` | Coerce columns to real types: `number` parses human formats (`$1,234.56`, `(500)`, `12%`, `1.2e3`); `date` normalizes ISO and `MM/DD/YYYY` to ISO `yyyy-mm-dd` text; `text` stringifies. Unparseable cells are left unchanged and reported per column with examples. |
| `clean_fill_missing` | Fill or drop missing values in one column: `constant` (with `value`), `mean`, `median`, `mode`, `forward` (carry last value down), or `drop-row`. |
| `clean_split_column` | Split a text column on a `delimiter` into several columns, in place. Extra parts are joined back into the last column; names default to `<column> 1`, `<column> 2`, … or pass `newColumns`. |
| `clean_merge_columns` | Join 2+ columns into a new appended column with a `separator`; sources are kept unless `dropSource` is true. |

All tools take `sheet` (the table's sheet) plus an optional
`principal`, like every Icecream Sheets MCP tool.

## Example prompts

These ship with the pack and are also registered as MCP prompts
(`data-cleaning.dedupe-and-tidy-orders`,
`data-cleaning.make-columns-numeric`):

> Clean the "Orders" sheet: first remove duplicate rows with
> clean_dedupe_rows, then trim and title-case the text columns with
> clean_normalize_text, and report how many duplicates were removed
> and how many cells changed.

> The "Import" sheet was pasted from a web page, so amounts like
> $1,234.56 are stored as text. Use clean_coerce_types to convert the
> amount and quantity columns to numbers, fill any missing amounts
> with the column median via clean_fill_missing, then verify the
> total with a SUM formula.

## Try it

[`example-messy-orders.csv`](./example-messy-orders.csv) is a small
messy table (duplicates, padded names, `$`-formatted amounts, a
missing amount, mixed date formats). Load it as a sheet named
`Orders`, then run:

1. `clean_dedupe_rows { "sheet": "Orders" }` → removes 1 duplicate.
2. `clean_normalize_text { "sheet": "Orders", "columns": ["Customer"], "case": "title" }`
3. `clean_coerce_types { "sheet": "Orders", "conversions": [{ "column": "Amount", "type": "number" }, { "column": "Date", "type": "date" }] }`
4. `clean_fill_missing { "sheet": "Orders", "column": "Amount", "strategy": "median" }`

The `Amount` column is then real numbers that `SUM` can total.

## Installing / extending

See the [Skill Pack Install Guide](../README.md) for installation,
versioning, and how to add a tool to this pack.
