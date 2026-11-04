/**
 * Tests for the TypeScript type-stripper
 * (packages/service/src/automation/tsStrip.ts).
 *
 * The strongest tests feed REAL translator output (VBA + Apps Script) and
 * syntax-check the stripped result with node:vm — proving the in-browser
 * runner can execute migrated macros.
 */
import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { stripTypeAnnotations, TypeStripError } from '../src/automation/tsStrip.js';
import { translateAppsScript, translateVba } from '../src/automation/translator.js';

/** Assert the stripped code parses as a script (compiles, never runs). */
function expectCompiles(ts: string): string {
  const js = stripTypeAnnotations(ts);
  expect(() => new Script(js, { filename: 'stripped.js' })).not.toThrow();
  return js;
}

describe('stripTypeAnnotations basics', () => {
  it('erases variable annotations', () => {
    expect(stripTypeAnnotations('let x: number = 5;')).toBe('let x = 5;');
    expect(stripTypeAnnotations('const s: string = "a";')).toBe('const s = "a";');
    expect(stripTypeAnnotations('let u: unknown;')).toBe('let u;');
  });

  it('erases function params, optional markers and return types', () => {
    expect(stripTypeAnnotations('function f(a: string, b?: number): boolean { return true; }')).toBe(
      'function f(a, b) { return true; }',
    );
  });

  it('erases arrow-function annotations', () => {
    const js = expectCompiles('const f = (a: string, b: number = 2): string => a + b;');
    expect(js).toBe('const f = (a, b = 2) => a + b;');
  });

  it('erases as-casts, satisfies and non-null assertions', () => {
    expect(stripTypeAnnotations('const x = y as string;')).toBe('const x = y;');
    expect(stripTypeAnnotations('const z = w!;')).toBe('const z = w;');
    expect(stripTypeAnnotations('const q = r satisfies string;')).toBe('const q = r;');
  });

  it('drops import type and export keywords', () => {
    const js = expectCompiles(
      "import type { AutomationApi } from '@icecream-sheets/service';\nexport function main(api: AutomationApi): void {}",
    );
    expect(js).toBe('\nfunction main(api) {}');
  });

  it('drops interfaces and type aliases', () => {
    const js = expectCompiles(
      'interface Point { x: number; y: number }\ntype Name = string;\nconst p = { x: 1 };',
    );
    expect(js).not.toContain('interface');
    expect(js).not.toContain('type Name');
    expect(js).toContain('const p = { x: 1 };');
  });

  it('drops generic parameter lists and generic call args', () => {
    const js = expectCompiles('function id<T>(x: T): T { return x; }\nconst y = id<string>("s");');
    expect(js).toBe('function id(x) { return x; }\nconst y = id("s");');
  });

  it('keeps comparisons that look like generics', () => {
    expect(stripTypeAnnotations('if (a < b) { c(); }')).toBe('if (a < b) { c(); }');
  });

  it('keeps ternary and object-literal colons', () => {
    expect(stripTypeAnnotations('const t = a ? b : c;')).toBe('const t = a ? b : c;');
    expect(stripTypeAnnotations('const o = { a: 1, b: x ? 1 : 2 };')).toBe('const o = { a: 1, b: x ? 1 : 2 };');
  });

  it('drops class field types, modifiers and implements', () => {
    const js = expectCompiles(
      'class C implements I { private x!: number; readonly y: string = "s"; get(): string { return this.y; } }',
    );
    expect(js).not.toContain('implements');
    expect(js).not.toContain('private');
    expect(js).not.toContain(': string');
    expect(js).toContain('get()');
  });

  it('handles union/intersection/object types and typeof', () => {
    const js = expectCompiles(
      'let v: string | number | null = null;\nlet m: Map<string, number[]> = new Map();\nlet f: (x: number) => string;',
    );
    expect(js).toBe('let v = null;\nlet m = new Map();\nlet f;');
  });

  it('keeps regex literals and template literals intact', () => {
    const js = expectCompiles('const re = /a\\d+/g;\nconst t = `x${1 + 2}y`;');
    expect(js).toContain('/a\\d+/g');
    expect(js).toContain('`x${1 + 2}y`');
  });

  it('keeps optional chaining and nullish coalescing', () => {
    expect(stripTypeAnnotations('const v = a?.b ?? c;')).toBe('const v = a?.b ?? c;');
  });

  it('fails loudly on value imports', () => {
    expect(() => stripTypeAnnotations("import { x } from './m';")).toThrow(TypeStripError);
  });

  it('fails loudly on enums', () => {
    expect(() => stripTypeAnnotations('enum E { A, B }')).toThrow(TypeStripError);
  });

  it('error carries the line number', () => {
    try {
      stripTypeAnnotations('const a = 1;\nimport { x } from "./m";\n');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TypeStripError);
      expect((e as TypeStripError).line).toBe(2);
    }
  });

  it('handles destructured params and rest params', () => {
    const js = expectCompiles('function f({a, b}: Opts, ...rest: string[]): void {}');
    expect(js).toBe('function f({a, b}, ...rest) {}');
  });
});

describe('translator output round-trip', () => {
  const VBA = `Sub FillTotals()
    Dim total As Double
    total = 0
    For i = 1 To 10
        total = total + Cells(i, 2).Value
    Next
    Range("B11").Value = total
    MsgBox "done"
End Sub`;

  const APPS_SCRIPT = `function main() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Data");
  const v = sheet.getRange("A1").getValue();
  sheet.getRange("B1").setValue(v * 2);
  SpreadsheetApp.getUi().alert("done");
}`;

  it('strips real VBA-translator output and it compiles', () => {
    const t = translateVba(VBA);
    expect(t.untranslated).toEqual([]);
    const js = expectCompiles(t.code);
    expect(js).toContain('function main(api)');
    expect(js).toContain('api.setCell');
    expect(js).toContain('api.notify');
    expect(js).not.toContain(': AutomationApi');
    expect(js).not.toContain('import type');
  });

  it('strips real Apps-Script-translator output and it compiles', () => {
    const t = translateAppsScript(APPS_SCRIPT);
    const js = expectCompiles(t.code);
    expect(js).toContain('function main(api)');
    expect(js).not.toContain(': AutomationApi');
  });

  it('stripped translator output actually RUNS against a fake api', async () => {
    const t = translateVba(VBA);
    const js = stripTypeAnnotations(t.code);
    const calls: string[] = [];
    const api = new Proxy(
      {},
      {
        get(_t, m) {
          return (...args: unknown[]) => {
            calls.push(String(m));
            if (m === 'getCell') return { kind: 'number', value: 5 };
            if (m === 'getRange') return [[{ kind: 'number', value: 5 }]];
            return null;
          };
        },
      },
    );
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...runArgs: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction(`${js}\n;return (typeof main === 'function') ? main : null;`);
    const main = (await fn()) as (api: unknown) => unknown;
    expect(typeof main).toBe('function');
    await main(api);
    expect(calls).toContain('setCell');
    expect(calls).toContain('notify');
  });
});
