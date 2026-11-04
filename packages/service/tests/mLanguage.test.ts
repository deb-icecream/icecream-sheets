/**
 * Tests for the Power Query M-language translator (mLanguage.ts).
 * Uses realistic M snippets copied from the shape Excel's Advanced Editor
 * produces.
 */
import { describe, expect, it } from 'vitest';
import {
  MParseError,
  MTranslateError,
  parseM,
  translateM,
} from '../src/mLanguage.js';
import { validateRecipe, type TransformNode } from '../src/etl/recipe.js';
import { applyTransform } from '../src/etl/transforms.js';
import { csvTextToTable } from '../src/etl/sources.js';

function transformsOf(recipeId: string, result: { recipes: { id: string; nodes: { kind: string }[] }[] }): TransformNode[] {
  const r = result.recipes.find((x) => x.id === recipeId)!;
  return r.nodes.filter((n): n is TransformNode => n.kind === 'transform');
}

describe('mLanguage parser', () => {
  it('parses let/in with quoted step names', () => {
    const q = parseM('let #"Filtered Rows" = 1 in #"Filtered Rows"');
    expect(q.steps.map((s) => s.name)).toEqual(['Filtered Rows']);
  });

  it('parses each lambdas and comparisons', () => {
    const q = parseM('let a = Table.SelectRows(T, each [Age] > 30 and [City] = "NYC") in a');
    const call = q.steps[0].expr;
    expect(call.kind).toBe('call');
  });

  it('parses #table literals', () => {
    const q = parseM('let t = #table({"a", "b"}, {{1, 2}, {3, 4}}) in t');
    const e = q.steps[0].expr;
    expect(e.kind).toBe('table');
    if (e.kind === 'table') {
      expect(e.columns).toEqual(['a', 'b']);
      expect(e.rows.length).toBe(2);
    }
  });

  it('throws MParseError on bad syntax', () => {
    expect(() => parseM('let a = = in a')).toThrow(MParseError);
  });

  it('parses M string escapes', () => {
    const q = parseM('let a = "x#"y" in a');
    const e = q.steps[0].expr;
    expect(e).toEqual({ kind: 'literal', value: 'x"y' });
  });
});

describe('mLanguage translateM', () => {
  const WEB_QUERY = `let
    Source = Csv.Document(Web.Contents("https://example.com/orders.csv"), [Delimiter=",", Encoding=65001]),
    #"Filtered Rows" = Table.SelectRows(Source, each [Amount] > 100 and [Status] <> "cancelled"),
    #"Renamed Columns" = Table.RenameColumns(#"Filtered Rows", {{"cust_id", "CustomerId"}}),
    #"Sorted Rows" = Table.Sort(#"Renamed Columns", {{"Amount", Order.Descending}})
in
    #"Sorted Rows"`;

  it('translates a realistic web CSV query to a valid recipe', () => {
    const { recipes, warnings } = translateM(WEB_QUERY);
    expect(warnings).toEqual([]);
    expect(recipes.length).toBe(1);
    const [main] = recipes;
    const issues = validateRecipe(main);
    expect(issues).toEqual([]);

    const source = main.nodes.find((n) => n.kind === 'source')!;
    expect(source.kind).toBe('source');
    if (source.kind === 'source') {
      expect(source.source).toEqual({ type: 'url', url: 'https://example.com/orders.csv', format: 'csv' });
    }
    const ops = transformsOf(main.id, { recipes }).map((n) => n.transform.op);
    expect(ops).toEqual(['filter', 'filter', 'rename', 'sort']);
    const transforms = transformsOf(main.id, { recipes });
    expect(transforms[0].transform).toMatchObject({ op: 'filter', column: 'Amount', operator: 'gt', value: 100 });
    expect(transforms[1].transform).toMatchObject({ op: 'filter', column: 'Status', operator: 'neq', value: 'cancelled' });
    expect(transforms[2].transform).toEqual({ op: 'rename', mapping: { cust_id: 'CustomerId' } });
    expect(transforms[3].transform).toMatchObject({ op: 'sort', keys: [{ column: 'Amount', dir: 'desc' }] });
    // Load node present.
    expect(main.nodes.some((n) => n.kind === 'load')).toBe(true);
  });

  it('translates Table.FromRecords to a csv-text source', () => {
    const { recipes } = translateM('let t = Table.FromRecords({[a=1, b="x"], [a=2, b="y"]}) in t');
    const src = recipes[0].nodes.find((n) => n.kind === 'source')!;
    expect(src.kind).toBe('source');
    if (src.kind === 'source') {
      expect(src.source.type).toBe('csv-text');
      if (src.source.type === 'csv-text') {
        expect(src.source.text).toBe('a,b\n1,x\n2,y');
      }
    }
    expect(validateRecipe(recipes[0])).toEqual([]);
  });

  it('translates type conversions and Text.Trim', () => {
    const src = `let
      s = Table.FromRecords({[price="12.5", name="  x  "]}),
      t = Table.TransformColumnTypes(s, {{"price", Currency.Type}, {"name", type text}}),
      u = Table.TransformColumns(t, {{"name", Text.Trim}})
    in u`;
    const { recipes, warnings } = translateM(src);
    expect(warnings).toEqual([]);
    const ops = transformsOf(recipes[0].id, { recipes }).map((n) => n.transform);
    expect(ops[0]).toEqual({ op: 'convert', column: 'price', to: 'number' });
    expect(ops[1]).toEqual({ op: 'convert', column: 'name', to: 'text' });
    expect(ops[2].op).toBe('custom');
    // The generated JS must actually run.
    const custom = ops[2];
    if (custom.op === 'custom') {
      const fn = new Function('input', 'return (' + custom.code + ')');
      const out = fn({ columns: ['price', 'name'], rows: [{ price: 12.5, name: '  x  ' }] });
      expect(out.rows[0].name).toBe('x');
    }
  });

  it('translates Table.Group with List.Sum', () => {
    const src = `let
      s = Table.FromRecords({[k="a", v=1], [k="a", v=2], [k="b", v=3]}),
      g = Table.Group(s, {"k"}, {{"total", each List.Sum([v]), type number}, {"n", each List.Count([v]), type number}})
    in g`;
    const { recipes, warnings } = translateM(src);
    expect(warnings).toEqual([]);
    const ops = transformsOf(recipes[0].id, { recipes }).map((n) => n.transform);
    expect(ops[0]).toEqual({
      op: 'group-by',
      keys: ['k'],
      aggregations: [
        { column: 'v', agg: 'sum', as: 'total' },
        { column: 'v', agg: 'count', as: 'n' },
      ],
    });
  });

  it('translates Table.Combine into main + branch recipes', () => {
    const src = `let
      a = Table.FromRecords({[x=1]}),
      b = Table.FromRecords({[x=2]}),
      c = Table.Combine({a, b})
    in c`;
    const { recipes, warnings } = translateM(src);
    expect(warnings).toEqual([]);
    expect(recipes.length).toBe(2);
    for (const r of recipes) expect(validateRecipe(r)).toEqual([]);
    const main = recipes[0];
    const appends = transformsOf(main.id, { recipes });
    expect(appends.length).toBe(1);
    expect(appends[0].transform.op).toBe('append');
    if (appends[0].transform.op === 'append') {
      expect(appends[0].transform.with).toEqual({ kind: 'recipe', recipeId: recipes[1].id });
    }
  });

  it('translates Table.NestedJoin into a join with a branch recipe', () => {
    const src = `let
      orders = Table.FromRecords({[id=1, total=50]}),
      customers = Table.FromRecords({[id=1, name="Ann"]}),
      j = Table.NestedJoin(orders, {"id"}, customers, {"id"}, "cust", JoinKind.LeftOuter)
    in j`;
    const { recipes, warnings } = translateM(src);
    expect(warnings.some((w) => w.code === 'join-nested')).toBe(true);
    expect(recipes.length).toBe(2);
    const joins = transformsOf(recipes[0].id, { recipes });
    expect(joins[0].transform).toMatchObject({ op: 'join', on: ['id'], how: 'left' });
  });

  it('folds Table.PromoteHeaders into the csv source', () => {
    const src = `let
      s = Csv.Document(File.Contents("/tmp/x.csv")),
      h = Table.PromoteHeaders(s)
    in h`;
    const { recipes, warnings } = translateM(src, { idPrefix: 'ph' });
    expect(warnings.some((w) => w.code === 'source-file-contents')).toBe(true);
    const main = recipes[0];
    // No transform node for the promote step.
    expect(main.nodes.filter((n) => n.kind === 'transform').length).toBe(0);
    const src0 = main.nodes.find((n) => n.kind === 'source')!;
    if (src0.kind === 'source' && src0.source.type === 'csv-text') {
      expect(src0.source.hasHeader).toBe(true);
    }
  });

  it('translates split/merge/unpivot/addcolumn', () => {
    const src = `let
      s = Table.FromRecords({[name="a,b", q=1]}),
      sp = Table.SplitColumn(s, "name", Splitter.SplitTextByDelimiter(","), {"n1", "n2"}),
      mg = Table.CombineColumns(sp, {"n1", "n2"}, Combiner.CombineTextByDelimiter(";"), "n"),
      up = Table.Unpivot(mg, {"q"}, "attr", "val"),
      ad = Table.AddColumn(up, "double", each [val] * 2)
    in ad`;
    const { recipes, warnings } = translateM(src);
    expect(warnings).toEqual([]);
    const ops = transformsOf(recipes[0].id, { recipes }).map((n) => n.transform);
    expect(ops[0]).toEqual({ op: 'split', column: 'name', delimiter: ',', into: ['n1', 'n2'] });
    expect(ops[1]).toEqual({ op: 'merge-columns', columns: ['n1', 'n2'], delimiter: ';', into: 'n' });
    expect(ops[2]).toMatchObject({ op: 'unpivot', idColumns: ['q'], variableColumn: 'attr', valueColumn: 'val' });
    expect(ops[3].op).toBe('custom');
    // The AddColumn JS must run.
    const custom = ops[3];
    if (custom.op === 'custom') {
      const fn = new Function('input', 'return (' + custom.code + ')');
      const out = fn({ columns: ['q', 'attr', 'val'], rows: [{ q: 1, attr: 'n', val: 21 }] });
      expect(out.columns).toContain('double');
      expect(out.rows[0].double).toBe(42);
    }
  });

  it('reports warnings for unsupported transforms and keeps the chain valid', () => {
    const src = `let
      s = Table.FromRecords({[a=1]}),
      f = Table.FirstN(s, 5),
      r = Table.RenameColumns(f, {{"a", "b"}})
    in r`;
    const { recipes, warnings } = translateM(src);
    expect(warnings.some((w) => w.code === 'unsupported-transform')).toBe(true);
    expect(validateRecipe(recipes[0])).toEqual([]);
  });

  it('throws a clear error for Excel.Workbook sources', () => {
    const src = `let s = Excel.Workbook(File.Contents("/tmp/x.xlsx")) in s`;
    expect(() => translateM(src)).toThrow(MTranslateError);
  });

  it('throws a clear error when the in-expression is not a step', () => {
    expect(() => translateM('let a = 1 in 2')).toThrow(MTranslateError);
  });

  it('translates Json.Document over Web.Contents', () => {
    const { recipes } = translateM('let s = Json.Document(Web.Contents("https://example.com/a.json")) in s');
    const src0 = recipes[0].nodes.find((n) => n.kind === 'source')!;
    if (src0.kind === 'source') {
      expect(src0.source).toEqual({ type: 'url', url: 'https://example.com/a.json', format: 'json' });
    }
  });

  it('handles #date literals and null comparisons in filters', () => {
    const src = `let
      s = Table.FromRecords({[d="2024-01-01", x=1]}),
      f = Table.SelectRows(s, each [d] >= #date(2024, 1, 1) and [x] <> null)
    in f`;
    const { recipes, warnings } = translateM(src);
    expect(warnings).toEqual([]);
    const ops = transformsOf(recipes[0].id, { recipes }).map((n) => n.transform);
    expect(ops[0]).toMatchObject({ op: 'filter', column: 'd', operator: 'gte', value: '2024-01-01' });
    expect(ops[1]).toMatchObject({ op: 'filter', column: 'x', operator: 'is-not-null' });
  });

  it('executes a translated recipe end-to-end through the transform library', () => {
    const src = `let
      Source = Table.FromRecords({[name="Ann", amount="120"], [name="Bob", amount="40"], [name="Cat", amount="200"]}),
      #"Changed Type" = Table.TransformColumnTypes(Source, {{"amount", Int64.Type}}),
      #"Filtered Rows" = Table.SelectRows(#"Changed Type", each [amount] > 100),
      #"Sorted Rows" = Table.Sort(#"Filtered Rows", {{"amount", Order.Descending}})
    in #"Sorted Rows"`;
    const { recipes, warnings } = translateM(src);
    expect(warnings).toEqual([]);
    const [main] = recipes;
    expect(validateRecipe(main)).toEqual([]);

    // Execute: source csv-text -> csvTextToTable -> applyTransform per node.
    const srcNode = main.nodes.find((n) => n.kind === 'source')!;
    if (srcNode.kind !== 'source' || srcNode.source.type !== 'csv-text') throw new Error('expected csv-text source');
    let table = csvTextToTable(srcNode.source.text);
    for (const node of main.nodes) {
      if (node.kind !== 'transform') continue;
      const op = (node as TransformNode).transform;
      if (op.op === 'custom') {
        const fn = new Function('input', 'return (' + op.code + ')');
        const out = fn({ columns: table.columns.map((c) => c.name), rows: table.rows }) as {
          columns: string[];
          rows: Record<string, string | number | boolean | null>[];
        };
        table = {
          columns: out.columns.map((c) => ({ name: c, type: 'unknown' as const })),
          rows: out.rows,
        };
        continue;
      }
      const res = applyTransform(table, op);
      table = res.table;
    }
    expect(table.rows.map((r) => [r['name'], r['amount']])).toEqual([
      ['Cat', 200],
      ['Ann', 120],
    ]);
  });
});
