// @vitest-environment jsdom
/**
 * Mounted-component proof for host-context JSX rendering: a static,
 * hardcoded JSX source goes through the real Babel transform + compile
 * path and must actually render into the DOM — not just transform or
 * compile. The same assertion runs in a real browser in probe leg (a);
 * this pins it at unit level too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  compileAppSource,
  transformSource,
  type NarrowApi,
} from './hostJsx';
import { AppChart } from './AppChart';

const JSX_APP = `function App() {
  const [n] = useState(3);
  return <div className="card"><h2 className="card-title">Host JSX Probe</h2><span className="badge badge-primary">JSX-OK {n}</span></div>;
}`;

const H_APP =
  'function App() {\n  var st = useState({ n: 1 });\n  var data = st[0];\n  return h("div", { className: "card" }, "n=" + data.n);\n}';

function realApi(): NarrowApi {
  const subscribe = () =>
    Object.assign(() => undefined, { unsubscribe: () => undefined });
  return {
    React,
    h: React.createElement,
    useState: React.useState,
    useEffect: React.useEffect,
    useRef: React.useRef,
    mcp: {
      call: async () => ({}),
      subscribe,
    } as unknown as NarrowApi['mcp'],
    BINDING: {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 1,
      columns: [],
    },
    AppChart,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function mount(App: React.ComponentType): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<App />);
  });
  return container;
}

describe('hostJsx mounted render', () => {
  it('renders a hardcoded JSX app through Babel to the DOM', async () => {
    const transformed = await transformSource(JSX_APP);
    expect(transformed).toContain('React.createElement');
    expect(transformed).not.toContain('<div');
    const App = compileAppSource(transformed, realApi());
    const el = mount(App);
    expect(el.textContent).toContain('Host JSX Probe');
    expect(el.textContent).toContain('JSX-OK 3');
    expect(el.querySelector('.card-title')).not.toBeNull();
  });

  it('renders a plain h() old-shape app through the same path', async () => {
    const transformed = await transformSource(H_APP);
    const App = compileAppSource(transformed, realApi());
    const el = mount(App);
    expect(el.textContent).toContain('n=1');
  });
});
