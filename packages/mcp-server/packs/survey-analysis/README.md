# Survey Analysis — Icecream Sheets skill pack

**Pack id:** `survey-analysis` · **Version:** 1.0.0 · **Manifest:** [pack.json](./pack.json)

Response coding, tabulation, and charting for survey data, through
MCP tools. Matching is canonical: answers are compared trimmed,
whitespace-collapsed, and case-insensitively, so `" friend "`,
`"Friend"`, and `"FRIEND"` are the same answer. Missing (empty)
answers are counted and reported, never silently dropped.

## Tools

| Tool | What it does |
|---|---|
| `survey_code_responses` | Code a response column into a code column (default `<column> Code`). With a `mapping` (answer text → code), matched answers get the mapped code and unmatched ones are reported; without one, each distinct answer becomes its own code (its canonical label). Returns the codebook: code, label, and count for every code. |
| `survey_frequencies` | Frequency table for one column — count, percent of valid responses, cumulative percent — written to `targetSheet` (default `Frequencies`) and returned. `sortBy` is `count` (default) or `label`; missing answers are excluded unless `includeMissing` is true. |
| `survey_crosstab` | Cross-tabulate two columns: counts for every row × column answer pair with row/column totals and a grand total, written to `targetSheet` (default `Crosstab`) and returned. `values` can be `count` (default), `row-percent`, or `column-percent` for the sheet cells. |
| `survey_chart_results` | Chart one response column: computes the frequency table, writes it to `targetSheet` (default `Chart Data`), and creates a **native** chart over it in the workbook (`kind`: column, bar, line, area, pie, doughnut). Uses the same session chart mechanism as the core `create_chart` tool and fails closed when the session has no chart sink. |

All tools take an optional `principal`, like every Icecream Sheets
MCP tool.

## Example prompts

These ship with the pack and are also registered as MCP prompts
(`survey-analysis.code-open-text`,
`survey-analysis.satisfaction-by-plan`):

> On the "Responses" sheet, use survey_code_responses on the "How
> did you hear about us?" column to canonicalize the messy answers
> into a code column, and show me the codebook with counts.

> On the "Responses" sheet, cross-tabulate "Plan" by "Satisfaction"
> with survey_crosstab, build the satisfaction frequency table with
> survey_frequencies, and chart it with survey_chart_results.

## Try it

[`example-responses.csv`](./example-responses.csv) holds 8 responses
with messy `Heard` answers. As sheet `Responses`:

1. `survey_code_responses { "sheet": "Responses", "column": "Heard", "mapping": { "Friend": "Referral", "Google": "Search", "Google Search": "Search" } }`
   → codebook Referral 3, Search 3; `Podcast` reported unmapped; 1 missing.
2. `survey_frequencies { "sheet": "Responses", "column": "Satisfaction" }`
   → Happy 4 (50%), Neutral 2, Sad 2.
3. `survey_crosstab { "sheet": "Responses", "rowColumn": "Plan", "columnColumn": "Satisfaction" }`
   → a 2×3 matrix, grand total 8.

## Installing / extending

See the [Skill Pack Install Guide](../README.md) for installation,
versioning, and how to add a tool to this pack.
