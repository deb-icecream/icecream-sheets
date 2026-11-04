/**
 * Python script generation for the data-analysis component.
 *
 * The AI does generation; execution stays deterministic (design-docs:
 * data-analysis component, deterministic-inference.md). A PythonGenerator
 * takes (DataSchema, AnalysisPlan) and returns Python source. The generated
 * script's contract is strict:
 *
 *   in:  the sandbox injects `args` = {"columns": string[], "rows": scalar[][]}
 *   out: the script MUST assign `result` = {"analysis": {...}, "chartSpec": {...}}
 *
 * The sandbox prints the assigned `result` as the ONE JSON object on
 * stdout. `chartSpec` follows the AnalysisChartSpec subset (see
 * chartspec.ts): plain JSON the host validates and renders via ChartCanvas.
 *
 * Shipped default: TemplatePythonGenerator — deterministic, dependency-free
 * templates covering the whole intent grammar, so the pipeline works
 * end-to-end today. Freeform generation plugs in later by implementing
 * PythonGenerator (the interface already accepts async); FreeformPythonGenerator
 * below is a real implementation of that seam against a FreeformSource, so
 * a ModelBackend-backed source can be dropped in without rework.
 */

import type { AnalysisChartSpec } from './chartspec.js';
import type { AnalysisIntentKind, AnalysisPlan } from './planner.js';
import { categoricalColumns, numericColumns, type DataSchema } from './schema.js';

/** Version of the shipped generator templates, stamped into every script. */
export const ANALYSIS_SCRIPT_VERSION = 1;

/**
 * Generates Python source from a data schema + analysis plan.
 * May be sync (templates) or async (model-backed) — the pipeline awaits.
 */
export type PythonGenerator = (
  schema: DataSchema,
  plan: AnalysisPlan,
) => string | Promise<string>;

/** Max generated source size (abuse guard, matches MCP code size caps). */
export const MAX_GENERATED_BYTES = 100_000;

// ---------------------------------------------------------------------------
// Column resolution: plan hints -> concrete schema columns
// ---------------------------------------------------------------------------

export interface ResolvedPlan {
  intentKind: AnalysisIntentKind;
  /** Role -> column name(s), in the schema's own naming. */
  roles: Record<string, string | string[]>;
  params: Record<string, unknown>;
}

const norm = (s: string): string => s.trim().toLowerCase();

function findColumn(schema: DataSchema, hint: string): string | null {
  const h = norm(hint);
  return (
    schema.columns.find((c) => norm(c.name) === h)?.name ??
    schema.columns.find((c) => norm(c.name).includes(h) || h.includes(norm(c.name)))?.name ??
    null
  );
}

function hinted(schema: DataSchema, hints: string[], pool: { name: string }[]): string | null {
  for (const h of hints) {
    const hit = findColumn(schema, h);
    if (hit && pool.some((c) => c.name === hit)) return hit;
  }
  return null;
}

/**
 * Exact-name hint match, regardless of the column's inferred type. A
 * dimension the user named ("revenue by year") is the group even when its
 * values look numeric — years stored as numbers (or numeric strings) infer
 * as numeric, so they never appear in the categorical pool, and without
 * this fallback the plan would group by an unrelated first category column
 * or fail outright. Exact match only (never substring): a merely similar
 * numeric column must not steal the group role.
 */
function exactHinted(schema: DataSchema, hints: string[]): string | null {
  for (const h of hints) {
    const hit = schema.columns.find((c) => norm(c.name) === norm(h));
    if (hit) return hit.name;
  }
  return null;
}

function need(what: string): never {
  throw new Error(`analysis plan cannot be satisfied: ${what}`);
}

/** Resolve an AnalysisPlan against a concrete DataSchema. Throws when unsatisfiable. */
export function resolvePlan(schema: DataSchema, plan: AnalysisPlan): ResolvedPlan {
  const hints = plan.targetColumns;
  const nums = numericColumns(schema);
  const cats = categoricalColumns(schema);
  const params = { ...plan.params };
  const roles: Record<string, string | string[]> = {};

  switch (plan.intentKind) {
    case 'summarize': {
      if (nums.length === 0) need('summarize needs at least one numeric column');
      roles['numerics'] = nums.map((c) => c.name);
      break;
    }
    case 'aggregate': {
      const group =
        hinted(schema, hints, cats) ??
        exactHinted(schema, hints) ??
        cats[0]?.name ??
        need('group-by needs a category column');
      // The measure must not be the group itself: a user-named dimension
      // whose values infer numeric ('Year') would otherwise match the
      // numeric pool and be picked as its own measure. Drop hints that
      // resolved to the group, then take the first remaining numeric.
      const valueHints = hints.filter((h) => norm(h) !== norm(group));
      const value =
        hinted(schema, valueHints, nums) ??
        nums.find((c) => c.name !== group)?.name ??
        need('group-by needs a numeric measure');
      roles['group'] = group;
      roles['value'] = value;
      break;
    }
    case 'trend': {
      const dateCols = schema.columns.filter((c) => c.inferredType === 'date');
      const x =
        hinted(schema, hints, schema.columns) ??
        dateCols[0]?.name ??
        cats[0]?.name ??
        need('trend needs an x-axis (date or category) column');
      const y = hinted(schema, hints.filter((h) => norm(h) !== norm(x as string)), nums) ?? nums[0]?.name ?? need('trend needs a numeric column');
      roles['x'] = x;
      roles['y'] = y;
      if (typeof params.forecastHorizon !== 'number') params.forecastHorizon = 3;
      break;
    }
    case 'distribution': {
      const column =
        hinted(schema, hints, nums) ?? nums[0]?.name ?? need('distribution needs a numeric column');
      roles['column'] = column;
      break;
    }
    case 'correlation': {
      if (nums.length < 2) need('correlation needs at least two numeric columns');
      roles['numerics'] = nums.map((c) => c.name);
      break;
    }
    case 'compare': {
      const category = hinted(schema, hints, cats) ?? cats[0]?.name ?? need('compare needs a category column');
      const measures = nums.filter((c) => c.name !== category).map((c) => c.name);
      if (measures.length === 0) need('compare needs at least one numeric measure');
      roles['category'] = category;
      roles['measures'] = measures.slice(0, 8);
      break;
    }
    case 'top-n': {
      const value = hinted(schema, hints, nums) ?? nums[0]?.name ?? need('top-N needs a numeric column');
      const label =
        hinted(
          schema,
          hints.filter((h) => norm(h) !== norm(value)),
          cats,
        ) ??
        cats[0]?.name ??
        need('top-N needs a label column');
      roles['label'] = label;
      roles['value'] = value;
      if (typeof params.n !== 'number') params.n = 10;
      break;
    }
  }
  return { intentKind: plan.intentKind, roles, params };
}

// ---------------------------------------------------------------------------
// Script emission
// ---------------------------------------------------------------------------

/** Emit a Python string literal for an arbitrary column name. */
const pyStr = (s: string): string => JSON.stringify(s);
const pyList = (ss: string[]): string => `[${ss.map(pyStr).join(', ')}]`;

const SCRIPT_HEADER = `# icecream-sheets analysis script — generated, versioned, deterministic.
# analysis-script-version: ${ANALYSIS_SCRIPT_VERSION}
# Contract: reads sandbox-injected \`args\` = {"columns": [...], "rows": [[...]]};
# assigns \`result\` = {"analysis": {...}, "chartSpec": {...}} (AnalysisChartSpec subset).
# The sandbox prints \`result\` as the ONE JSON object on stdout.
# Allowed imports only: math, json, re, itertools, functools, datetime, statistics.
`;

const PRELUDE = `
import json as _json
import math as _math
import statistics as _stats

_cols = args["columns"]
_rows = args["rows"]

def _idx(name):
    return _cols.index(name)

def _cell(row, name):
    v = row[_idx(name)]
    if v is None:
        return None
    if isinstance(v, float) and _math.isnan(v):
        return None
    return v

def _nums(name):
    out = []
    for _r in _rows:
        _v = _cell(_r, name)
        if isinstance(_v, bool):
            continue
        if isinstance(_v, (int, float)):
            out.append(_v)
    return out

def _mean(xs):
    return sum(xs) / len(xs) if xs else None

def _describe(xs):
    if not xs:
        return {"count": 0, "min": None, "max": None, "mean": None, "stdev": None}
    _m = _mean(xs)
    _var = sum((_x - _m) ** 2 for _x in xs) / (len(xs) - 1) if len(xs) > 1 else 0.0
    return {
        "count": len(xs),
        "min": min(xs),
        "max": max(xs),
        "mean": _m,
        "stdev": _math.sqrt(_var) if len(xs) > 1 else None,
    }
`;

type Template = (r: ResolvedPlan) => string;

const TEMPLATES: Record<AnalysisIntentKind, Template> = {
  summarize: (r) => {
    const cols = r.roles['numerics'] as string[];
    return `
_num_cols = ${pyList(cols)}
_summary = {"rowCount": len(_rows), "columns": {}}
_means = []
for _c in _num_cols:
    _d = _describe(_nums(_c))
    _summary["columns"][_c] = _d
    _means.append(_d["mean"])
result = {
    "analysis": _summary,
    "chartSpec": {
        "type": "bar",
        "title": "Column means",
        "labels": _num_cols,
        "datasets": [{"label": "mean", "data": _means}],
    },
}
`;
  },

  aggregate: (r) => {
    const group = r.roles['group'] as string;
    const value = r.roles['value'] as string;
    return `
_group = ${pyStr(group)}
_value = ${pyStr(value)}
_groups = {}
for _r in _rows:
    _g = _cell(_r, _group)
    _v = _cell(_r, _value)
    if _g is None or isinstance(_v, bool) or not isinstance(_v, (int, float)):
        continue
    _g = str(_g)
    _groups[_g] = _groups.get(_g, 0.0) + _v
_labels = sorted(_groups.keys())
_data = [_groups[_k] for _k in _labels]
result = {
    "analysis": {
        "groupBy": _group,
        "measure": _value,
        "groups": {_k: _groups[_k] for _k in _labels},
        "groupCount": len(_labels),
        "grandTotal": sum(_data),
    },
    "chartSpec": {
        "type": "bar",
        "title": "Sum of " + _value + " by " + _group,
        "labels": _labels,
        "datasets": [{"label": _value, "data": _data}],
    },
}
`;
  },

  trend: (r) => {
    const x = r.roles['x'] as string;
    const y = r.roles['y'] as string;
    const horizon = r.params.forecastHorizon as number;
    return `
_x = ${pyStr(x)}
_y = ${pyStr(y)}
_h = ${Math.max(1, Math.min(24, Math.floor(horizon)))}
_pairs = []
for _r in _rows:
    _xv = _cell(_r, _x)
    _yv = _cell(_r, _y)
    if _xv is None or isinstance(_yv, bool) or not isinstance(_yv, (int, float)):
        continue
    _pairs.append((str(_xv), _yv))
_n = len(_pairs)
_ys = [_p[1] for _p in _pairs]
_xs = list(range(_n))
if _n >= 2:
    _mx = _mean(_xs)
    _my = _mean(_ys)
    _den = sum((_t - _mx) ** 2 for _t in _xs)
    _slope = sum((_t - _mx) * (_v - _my) for _t, _v in zip(_xs, _ys)) / _den if _den else 0.0
    _icept = _my - _slope * _mx
else:
    _slope, _icept = 0.0, _ys[0] if _ys else 0.0
_fore = [_slope * (_n + _i) + _icept for _i in range(_h)]
_labels = [_p[0] for _p in _pairs] + ["forecast " + str(_i + 1) for _i in range(_h)]
_actual = _ys + [None] * _h
_fore_series = [None] * max(0, _n - 1) + ([_ys[-1]] if _ys else []) + _fore
result = {
    "analysis": {
        "x": _x,
        "y": _y,
        "points": _n,
        "slope": _slope,
        "intercept": _icept,
        "forecastHorizon": _h,
        "forecast": _fore,
    },
    "chartSpec": {
        "type": "line",
        "title": _y + " over " + _x,
        "labels": _labels,
        "datasets": [
            {"label": _y, "data": _actual},
            {"label": "forecast", "data": _fore_series, "borderDash": [6, 4]},
        ],
    },
}
`;
  },

  distribution: (r) => {
    const column = r.roles['column'] as string;
    const bins = r.params.bins as number | undefined;
    return `
_col = ${pyStr(column)}
_xs = _nums(_col)
${bins === undefined ? '_bins = max(2, round(1 + 3.322 * _math.log10(len(_xs)))) if _xs else 2' : `_bins = ${Math.max(2, Math.min(50, Math.floor(bins)))}`}
if _xs:
    _lo, _hi = min(_xs), max(_xs)
    _w = (_hi - _lo) / _bins if _hi > _lo else 1.0
    _counts = [0] * _bins
    for _x in _xs:
        _i = min(int((_x - _lo) / _w), _bins - 1) if _w else 0
        _counts[_i] += 1
    _labels = ["%.4g-%.4g" % (_lo + _i * _w, _lo + (_i + 1) * _w) for _i in range(_bins)]
else:
    _lo, _hi, _counts, _labels = None, None, [], []
result = {
    "analysis": {
        "column": _col,
        "bins": _bins,
        "counts": _counts,
        "min": _lo,
        "max": _hi,
        "describe": _describe(_xs),
    },
    "chartSpec": {
        "type": "bar",
        "title": "Distribution of " + _col,
        "labels": _labels,
        "datasets": [{"label": "count", "data": _counts}],
    },
}
`;
  },

  correlation: (r) => {
    const cols = r.roles['numerics'] as string[];
    return `
_num_cols = ${pyList(cols)}
_mat = []
for _r in _rows:
    _vs = [_cell(_r, _c) for _c in _num_cols]
    if all(isinstance(_v, (int, float)) and not isinstance(_v, bool) for _v in _vs):
        _mat.append(_vs)

def _pearson(_xs, _ys):
    _n = len(_xs)
    if _n < 2:
        return None
    _mx, _my = _mean(_xs), _mean(_ys)
    _dx = sum((_x - _mx) ** 2 for _x in _xs)
    _dy = sum((_y - _my) ** 2 for _y in _ys)
    _den = _math.sqrt(_dx * _dy)
    if not _den:
        return None
    return sum((_x - _mx) * (_y - _my) for _x, _y in zip(_xs, _ys)) / _den

_matrix = {}
for _i, _a in enumerate(_num_cols):
    _matrix[_a] = {}
    for _j, _b in enumerate(_num_cols):
        _xs = [_row[_i] for _row in _mat]
        _ys = [_row[_j] for _row in _mat]
        _matrix[_a][_b] = _pearson(_xs, _ys)

_best = None
for _i in range(len(_num_cols)):
    for _j in range(_i + 1, len(_num_cols)):
        _r = _matrix[_num_cols[_i]][_num_cols[_j]]
        if _r is not None and (_best is None or abs(_r) > abs(_best[2])):
            _best = (_num_cols[_i], _num_cols[_j], _r)

if _best:
    _ai = _num_cols.index(_best[0])
    _bi = _num_cols.index(_best[1])
    _pts = [{"x": _row[_ai], "y": _row[_bi]} for _row in _mat]
    _chart = {
        "type": "scatter",
        "title": "%s vs %s (r=%.3f)" % (_best[0], _best[1], _best[2]),
        "datasets": [{"label": _best[0] + " vs " + _best[1], "data": _pts}],
    }
else:
    _chart = {"type": "scatter", "title": "Correlation", "datasets": [{"label": "pairs", "data": []}]}

result = {
    "analysis": {
        "columns": _num_cols,
        "pairs": len(_mat),
        "matrix": _matrix,
        "strongest": {"x": _best[0], "y": _best[1], "r": _best[2]} if _best else None,
    },
    "chartSpec": _chart,
}
`;
  },

  compare: (r) => {
    const category = r.roles['category'] as string;
    const measures = r.roles['measures'] as string[];
    return `
_cat = ${pyStr(category)}
_measures = ${pyList(measures)}
_groups = {}
for _r in _rows:
    _g = _cell(_r, _cat)
    if _g is None:
        continue
    _g = str(_g)
    _row = _groups.setdefault(_g, {})
    for _m in _measures:
        _v = _cell(_r, _m)
        if isinstance(_v, bool) or not isinstance(_v, (int, float)):
            continue
        _row[_m] = _row.get(_m, 0.0) + _v
_labels = sorted(_groups.keys())
_datasets = [{"label": _m, "data": [_groups[_g].get(_m) for _g in _labels]} for _m in _measures]
result = {
    "analysis": {
        "category": _cat,
        "measures": _measures,
        "table": {_g: _groups[_g] for _g in _labels},
    },
    "chartSpec": {
        "type": "bar",
        "title": "Comparison by " + _cat,
        "labels": _labels,
        "datasets": _datasets,
    },
}
`;
  },

  'top-n': (r) => {
    const label = r.roles['label'] as string;
    const value = r.roles['value'] as string;
    const n = Math.max(1, Math.min(100, Math.floor(r.params.n as number)));
    return `
_label = ${pyStr(label)}
_value = ${pyStr(value)}
_n = ${n}
_totals = {}
for _r in _rows:
    _l = _cell(_r, _label)
    _v = _cell(_r, _value)
    if _l is None or isinstance(_v, bool) or not isinstance(_v, (int, float)):
        continue
    _l = str(_l)
    _totals[_l] = _totals.get(_l, 0.0) + _v
_ranked = sorted(_totals.items(), key=lambda _kv: _kv[1], reverse=True)[:_n]
_labels = [_k for _k, _ in _ranked]
_data = [_v for _, _v in _ranked]
result = {
    "analysis": {
        "label": _label,
        "value": _value,
        "n": _n,
        "ranking": [{"label": _k, "value": _v} for _k, _v in _ranked],
    },
    "chartSpec": {
        "type": "bar",
        "title": "Top " + str(_n) + " by " + _value,
        "labels": _labels,
        "datasets": [{"label": _value, "data": _data}],
    },
}
`;
  },
};

/**
 * Deterministic template generator: same (schema, plan) -> same source,
 * byte for byte. Covers the full intent grammar so the pipeline works
 * end-to-end without a model in the loop.
 */
export class TemplatePythonGenerator {
  readonly name = 'template-v1';

  generate(schema: DataSchema, plan: AnalysisPlan): string {
    const resolved = resolvePlan(schema, plan);
    const body = TEMPLATES[resolved.intentKind](resolved);
    const source = `${SCRIPT_HEADER}${PRELUDE}\n# plan: ${resolved.intentKind} roles=${JSON.stringify(resolved.roles)}\n${body}`;
    if (source.length > MAX_GENERATED_BYTES) {
      throw new Error(`generated script exceeds ${MAX_GENERATED_BYTES} bytes`);
    }
    return source;
  }
}

// ---------------------------------------------------------------------------
// Freeform seam (ModelBackend plugs in later — no rework needed)
// ---------------------------------------------------------------------------

/** A model-backed source of Python code (e.g. an LLM via ModelBackend). */
export interface FreeformSource {
  generateCode(prompt: string): Promise<string>;
}

/**
 * Build the prompt a model uses to write an analysis script. Carries the
 * strict stdout contract, the sandbox allowlist, the data schema and the
 * plan — everything the model needs, nothing it doesn't.
 */
export function buildFreeformPrompt(schema: DataSchema, plan: AnalysisPlan): string {
  return [
    'You write a deterministic Python analysis script for Icecream Sheets.',
    '',
    'STRICT CONTRACT:',
    '- The sandbox injects `args` = {"columns": string[], "rows": scalar[][]} (JSON).',
    '- Your script MUST assign `result` = {"analysis": {...}, "chartSpec": {...}}.',
    '- `chartSpec` must be {"type": one of bar|line|pie|doughnut|scatter|radar, "title"?: string, "labels"?: string[], "datasets": [{"label": string, "data": (number|{x,y}|null)[]}]}.',
    '- The sandbox prints `result` as the ONE JSON object on stdout.',
    '- Allowed imports ONLY: math, json, re, itertools, functools, datetime, statistics.',
    '- No I/O, no network, no randomness, no wall-clock reads. Deterministic: same data -> same output.',
    '',
    'DATA SCHEMA:',
    JSON.stringify(schema, null, 2),
    '',
    'ANALYSIS PLAN:',
    JSON.stringify(plan, null, 2),
    '',
    'Write ONLY the Python source, no prose.',
  ].join('\n');
}

/**
 * Light source validation for freeform output (the sandbox enforces the
 * real capability boundary at execution time).
 */
export function validatePythonSource(source: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, error: 'generated source must be a non-empty string' };
  }
  if (source.length > MAX_GENERATED_BYTES) {
    return { ok: false, error: `generated source exceeds ${MAX_GENERATED_BYTES} bytes` };
  }
  if (!/\bresult\s*=/.test(source)) {
    return { ok: false, error: 'generated source must assign `result`' };
  }
  return { ok: true };
}

/**
 * Freeform generator: delegates code authorship to a FreeformSource
 * (wired to a ModelBackend when one ships) and validates the result
 * against the stdout contract before returning it. The execution path
 * is identical to template scripts — generation is the only AI step.
 */
export class FreeformPythonGenerator {
  readonly name = 'freeform-v1';

  constructor(private readonly source: FreeformSource) {}

  async generate(schema: DataSchema, plan: AnalysisPlan): Promise<string> {
    const prompt = buildFreeformPrompt(schema, plan);
    const source = await this.source.generateCode(prompt);
    const checked = validatePythonSource(source);
    if (!checked.ok) throw new Error(`freeform generation failed validation: ${checked.error}`);
    return source;
  }
}

/** Validate a chartSpec the way the executor will (re-exported convenience). */
export type { AnalysisChartSpec };
