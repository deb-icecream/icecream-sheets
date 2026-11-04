/**
 * Headless tests for the artifact sandbox document builder.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { BRIDGE_PRELUDE, buildArtifactSrcDoc } from './artifactFrame';
import { BRIDGE_TAG, type ArtifactBinding } from '@icecream-sheets/service';

const RUNTIME = { reactUmd: '/*react*/', reactDomUmd: '/*react-dom*/' };
const SOURCE = 'var BINDING = {};\nfunction App() { return null; }';

describe('buildArtifactSrcDoc', () => {
  it('embeds the bridge prelude, runtime, and app source', () => {
    const doc = buildArtifactSrcDoc(SOURCE, RUNTIME, 'My App');
    expect(doc).toContain('<title>My App</title>');
    // React runtime inlined (offline-capable).
    expect(doc).toContain('/*react*/');
    expect(doc).toContain('/*react-dom*/');
    // Bridge protocol pieces.
    expect(doc).toContain(BRIDGE_TAG);
    expect(doc).toContain('window.mcp');
    expect(doc).toContain("kind: 'call'");
    expect(doc).toContain("kind: 'subscribe'");
    // The app source is embedded (JSON-encoded into the prelude).
    expect(doc).toContain('function App()');
    // The prelude renders App into #root via ReactDOM.
    expect(doc).toContain('createRoot');
    expect(BRIDGE_PRELUDE).toContain('__APP_SOURCE__');
  });

  it('rejects sources that would break out of the script block', () => {
    expect(() =>
      buildArtifactSrcDoc('function App() {}</scr' + 'ipt><script>alert(1)', RUNTIME),
    ).toThrow('</script');
  });

  it('requires the runtime scripts', () => {
    expect(() => buildArtifactSrcDoc(SOURCE, { reactUmd: '', reactDomUmd: '' })).toThrow(
      'React UMD',
    );
  });

  it('escapes the title', () => {
    const doc = buildArtifactSrcDoc(SOURCE, RUNTIME, '<b>App</b>');
    expect(doc).toContain('&lt;b&gt;App&lt;/b&gt;');
    expect(doc).not.toContain('<b>App</b>');
  });
});

const BINDING: ArtifactBinding = {
  sheet: 'Sales',
  startRow: 0,
  startCol: 0,
  endRow: 12,
  endCol: 2,
  hasHeaderRow: true,
  columns: [
    { name: 'Month', type: 'text', index: 0 },
    { name: 'Region', type: 'text', index: 1 },
    { name: 'Revenue', type: 'numeric', index: 2 },
  ],
};

describe('buildArtifactSrcDoc BINDING injection (wave-c W2 / case 3b)', () => {
  it('defines the BINDING global from the spec binding when provided', () => {
    const doc = buildArtifactSrcDoc('function App() { return null; }', RUNTIME, 'App', BINDING);
    expect(doc).toContain('var BINDING = {"sheet":"Sales","startRow":0,"startCol":0,"endRow":12,"endCol":2,');
    expect(doc).toContain('"name":"Revenue"');
    expect(doc).not.toContain('__BINDING_PRELUDE__');
    expect(doc).not.toContain('__APP_SOURCE__');
  });

  it('leaves no placeholder behind when no binding is provided', () => {
    const doc = buildArtifactSrcDoc('function App() { return null; }', RUNTIME, 'App');
    expect(doc).not.toContain('__BINDING_PRELUDE__');
    expect(doc).not.toContain('var BINDING');
  });
});

/**
 * Functional pin for the case-3b mechanism: execute the built document's
 * prelude script in a vm with stub React/ReactDOM and a stub host, using
 * an LLM-shaped app source (uses the pre-defined BINDING global, the
 * 'cell_changed' alias, and subscription.unsubscribe() cleanup — and
 * defines NONE of that itself). Before the W2 fix this posted no bridge
 * call at all (ReferenceError: BINDING is not defined) and rendered no
 * rows.
 */
describe('artifact frame execution (case-3b shape)', () => {
  const LLM_SOURCE = `
function App() {
  const [data, setData] = React.useState([]);
  React.useEffect(() => {
    const fetchData = async () => {
      const result = await mcp.call('read_cells', {
        sheet: BINDING.sheet, startRow: BINDING.startRow, startCol: BINDING.startCol,
        endRow: BINDING.endRow, endCol: BINDING.endCol,
      });
      setData(result.cells);
    };
    fetchData();
    const subscription = mcp.subscribe(['cell_changed'], BINDING.sheet, () => { fetchData(); });
    return () => { subscription.unsubscribe(); };
  }, []);
  return React.createElement('div', null, data.map((row, i) =>
    React.createElement('span', { key: i }, String(row[0]) + '|' + String(row[1]) + '|' + String(row[2]))));
}`;

  const FIXTURE = [
    ['Month', 'Region', 'Revenue'],
    ['Jan', 'North', 12000],
    ['Feb', 'South', 11200],
  ];

  function runFrame(source: string, binding?: ArtifactBinding) {
    const doc = buildArtifactSrcDoc(source, RUNTIME, 'App', binding);
    const script = doc.split('<script>').pop()!.replace(/<\/script><\/body><\/html>$/, '');
    const posted: Record<string, unknown>[] = [];
    let listener: ((ev: { data: unknown }) => void) | null = null;
    let hookState: unknown[] = [];
    let hookIdx = 0;
    const effectsRan = new Set<number>();
    let cleanup: (() => void) | null = null;
    let tree: unknown = null;
    let AppFn: (() => unknown) | null = null;
    const render = () => { hookIdx = 0; tree = AppFn!(); };
    const ReactStub = {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useState: (init: unknown) => {
        const i = hookIdx++;
        if (!(i in hookState)) hookState[i] = init;
        return [hookState[i], (v: unknown) => { hookState[i] = v; render(); }];
      },
      useEffect: (fn: () => unknown) => {
        const i = hookIdx++;
        if (effectsRan.has(i)) return;
        effectsRan.add(i);
        const c = fn();
        if (typeof c === 'function') cleanup = c as () => void;
      },
      useRef: (init: unknown) => ({ current: init }),
    };
    const sandbox: Record<string, unknown> = {
      console,
      setTimeout,
      clearTimeout,
      React: ReactStub,
      ReactDOM: { createRoot: () => ({ render: (el: { type: () => unknown }) => { AppFn = () => el.type(); render(); } }) },
      document: { getElementById: () => ({ innerHTML: '' }) },
      parent: {
        postMessage: (msg: Record<string, unknown>) => {
          posted.push(msg);
          if (msg['kind'] === 'call' && msg['tool'] === 'read_cells') {
            listener?.({
              data: { [BRIDGE_TAG]: 1, id: msg['id'], kind: 'result', ok: true, data: { cells: FIXTURE } },
            });
          }
        },
      },
      addEventListener: (_n: string, fn: (ev: { data: unknown }) => void) => { listener = fn; },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox as vm.Context);
    vm.runInContext(script, sandbox as vm.Context);
    const flatten = (n: unknown, out: string[] = []): string[] => {
      if (n === null || n === undefined) return out;
      if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
      if (Array.isArray(n)) { for (const c of n) flatten(c, out); return out; }
      if (typeof n === 'object') for (const c of (n as { children?: unknown[] }).children ?? []) flatten(c, out);
      return out;
    };
    return { posted, text: () => flatten(tree).join(' '), runCleanup: () => cleanup?.() };
  }

  it('LLM-shaped app reads through the host-defined BINDING and renders rows', async () => {
    const { posted, text } = runFrame(LLM_SOURCE, BINDING);
    await new Promise((r) => setTimeout(r, 20));
    const call = posted.find((p) => p['kind'] === 'call');
    expect(call?.['tool']).toBe('read_cells');
    expect(call?.['args']).toEqual({ sheet: 'Sales', startRow: 0, startCol: 0, endRow: 12, endCol: 2 });
    expect(text()).toContain('Jan|North|12000');
    expect(text()).toContain('Feb|South|11200');
  });

  it("normalizes the 'cell_changed' alias so the MCP subscribe enum accepts it", async () => {
    const { posted } = runFrame(LLM_SOURCE, BINDING);
    await new Promise((r) => setTimeout(r, 20));
    const sub = posted.find((p) => p['kind'] === 'subscribe');
    expect(sub?.['events']).toEqual(['cells_changed']);
    expect(sub?.['sheet']).toBe('Sales');
  });

  it('subscription.unsubscribe() cleanup works and posts unsubscribe', async () => {
    const { posted, runCleanup } = runFrame(LLM_SOURCE, BINDING);
    await new Promise((r) => setTimeout(r, 20));
    expect(() => runCleanup()).not.toThrow();
    expect(posted.some((p) => p['kind'] === 'unsubscribe')).toBe(true);
  });

  it('#144: a spec destructuring `h` from React still renders (prelude aliases React.h)', async () => {
    // Exact crashing shape from the validation probe: the model emitted
    // `const { useState, useEffect, useRef, h } = React`, but React has
    // no `h` export, so the local `h` shadowed the prelude's `h`
    // argument with undefined and mount threw "h is not a function".
    const OLD_SHAPE = `
function App() {
  const { useState, h } = React;
  const [v] = useState('hello-h144');
  return h('div', null, v);
}`;
    const { text } = runFrame(OLD_SHAPE, BINDING);
    expect(text()).toContain('hello-h144');
  });

  it('#144: the prelude aliases React.h to createElement', () => {
    expect(BRIDGE_PRELUDE).toContain('React.h = React.createElement');
  });
});
