/**
 * Host-context JSX rendering (owner decision 2026-10-25): JSX detection,
 * on-demand Babel transform (react preset only), narrow-API compile, and
 * the #147 crash class elimination. Pure-module tests; the mounted
 * component is proven in the browser legs.
 */
import { describe, expect, it } from 'vitest';
import {
  HostMcp,
  compileAppSource,
  getBabel,
  looksLikeJsx,
  prepareAppSource,
  transformSource,
  type NarrowApi,
} from './hostJsx';
import { AppChart } from './AppChart';

const H_APP =
  'function App() {\n  var st = useState({ n: 1 });\n  return h("div", { className: "card" }, "n=" + st.n);\n}';

function stubApi(): NarrowApi {
  const createElement = (type: unknown, props: unknown, ...children: unknown[]): unknown => ({
    type,
    props,
    children,
  });
  return {
    React: { createElement } as unknown as NarrowApi['React'],
    h: createElement as unknown as NarrowApi['h'],
    useState: ((init: unknown) => [init, () => undefined]) as unknown as NarrowApi['useState'],
    useEffect: (() => undefined) as unknown as NarrowApi['useEffect'],
    useRef: ((init: unknown) => ({ current: init })) as unknown as NarrowApi['useRef'],
    mcp: { call: async () => ({}), subscribe: () => Object.assign(() => undefined, { unsubscribe: () => undefined }) } as unknown as NarrowApi['mcp'],
    BINDING: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 1, columns: [] },
    AppChart: AppChart as unknown as NarrowApi['AppChart'],
  };
}

describe('looksLikeJsx', () => {
  it('detects elements, closing tags, and fragments', () => {
    expect(looksLikeJsx('function App() { return <div className="card">hi</div>; }')).toBe(true);
    expect(looksLikeJsx('function App() { return </div>; }')).toBe(true);
    expect(looksLikeJsx('function App() { return <></>; }')).toBe(true);
    expect(looksLikeJsx('function App() { return <Foo.Bar x={1} />; }')).toBe(true);
  });

  it('does not fire on plain h() code, strings, or comparisons', () => {
    expect(looksLikeJsx(H_APP)).toBe(false);
    expect(looksLikeJsx('var s = "<div>not jsx</div>";\nvar t = "a < b";')).toBe(false);
    expect(looksLikeJsx('function f(a, b) { return a < b ? 1 : 0; }')).toBe(false);
    expect(looksLikeJsx('// <div> in a comment\nfunction App() { return h("div"); }')).toBe(false);
  });
});

describe('transformSource', () => {
  it('passes plain-JS sources through unchanged', async () => {
    await expect(transformSource(H_APP)).resolves.toBe(H_APP);
  });

  it('transforms JSX to React.createElement calls (react preset, classic runtime)', async () => {
    const src =
      'function App() {\n  const [n] = useState(0);\n  return <div className="card"><h2>Hi {n}</h2></div>;\n}';
    const out = await transformSource(src);
    expect(out).toContain('React.createElement');
    expect(out).not.toContain('<div');
    expect(out).toContain('function App()');
  });

  it('loads a real Babel transform function on demand', async () => {
    const babel = await getBabel();
    expect(typeof babel.transform).toBe('function');
  });
});

describe('compileAppSource', () => {
  it('compiles a contract-shaped h() app', () => {
    const App = compileAppSource(H_APP, stubApi());
    const el = (App as unknown as () => unknown)();
    expect(el).toMatchObject({ type: 'div' });
  });

  it('compiles the #147 shape (App params + hook destructure) without crashing', () => {
    const bad =
      'function App(React, h, useState, useEffect, useRef, mcp) {\n  const { useState, useEffect } = React;\n  var st = useState({ n: 2 });\n  return h("div", null, "n=" + st.n);\n}';
    const App = compileAppSource(bad, stubApi());
    const el = (App as unknown as () => unknown)();
    expect(el).toMatchObject({ type: 'div' });
  });

  it('throws visibly when App is missing', () => {
    // The `return App` line throws ReferenceError; the renderer shows it
    // in place instead of a blank frame.
    expect(() => compileAppSource('var x = 1;', stubApi())).toThrow('App is not defined');
  });
});

describe('HostMcp (scoped data API)', () => {
  it('resolves allowed calls and rejects forbidden tools', async () => {
    const seen: Array<{ tool: string }> = [];
    const mcp = new HostMcp(async (tool: string) => {
      seen.push({ tool });
      if (tool === 'read_cells') return { cells: [['A'], [1]] };
      throw new Error(`unexpected tool ${tool}`);
    });
    await expect(mcp.api.call('read_cells', { sheet: 'Sheet1' })).resolves.toEqual({
      cells: [['A'], [1]],
    });
    await expect(mcp.api.call('execute_code', {})).rejects.toThrow();
    expect(seen.map((s) => s.tool)).toEqual(['read_cells']);
    mcp.dispose();
  });
});

describe('prepareAppSource (normalize BEFORE transform)', () => {
  it('heals the JSX #147 shape: Babel must never see the duplicate declaration', async () => {
    // This is the exact stored legacy shape that errored visibly in the
    // frame before the fix: Babel parsed the RAW source (params +
    // destructure) and threw before compile's normalize could strip it.
    const legacy =
      'function App(React, h, useState, useEffect, useRef, mcp) {\n  const { useState, useEffect } = React;\n  const [n] = useState(7);\n  return <div className="badge badge-primary">LEGACY-147-OK {n}</div>;\n}';
    const prepared = await prepareAppSource(legacy);
    expect(prepared).not.toContain('function App(React');
    expect(prepared).not.toContain('} = React');
    const App = compileAppSource(prepared, stubApi());
    const el = (App as unknown as () => unknown)();
    expect(el).toMatchObject({ type: 'div' });
  });

  it('still transforms contract-clean JSX to createElement calls', async () => {
    const src =
      'function App() {\n  const [n] = useState(0);\n  return <div className="card"><h2>Hi {n}</h2></div>;\n}';
    const out = await prepareAppSource(src);
    expect(out).toContain('React.createElement');
    expect(out).not.toContain('<div');
  });

  it('passes contract-clean h() sources through unchanged', async () => {
    await expect(prepareAppSource(H_APP)).resolves.toBe(H_APP);
  });
});
