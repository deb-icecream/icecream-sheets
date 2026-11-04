// @vitest-environment jsdom
/**
 * Mounted-component proof for the app chart capability (option A):
 * a generated app's <AppChart> element goes through the real Babel
 * transform + narrow-API compile path and must actually render bars
 * into the DOM — proportional to the data, with value labels, title,
 * and a visible empty-data message, never a blank chart.
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

const CHART_APP = `function App() {
  var points = [{ label: 'A', value: 100 }, { label: 'B', value: 200 }, { label: 'C', value: 50 }];
  return <div className="card"><div className="card-body"><AppChart data={points} title="Test Chart" /></div></div>;
}`;

const EMPTY_APP = `function App() {
  return <div className="card"><AppChart data={[]} title="Empty Chart" /></div>;
}`;

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

describe('hostJsx AppChart mounted render', () => {
  it('renders bars proportional to the data, with labels and title', async () => {
    const transformed = await transformSource(CHART_APP);
    const App = compileAppSource(transformed, realApi());
    const el = mount(App);
    expect(el.textContent).toContain('Test Chart');
    const rects = el.querySelectorAll('rect');
    expect(rects.length).toBe(3);
    // Plot height is 222 (280 - 28 top - 30 bottom): 100 -> 111,
    // 200 -> 222, 50 -> 55.5. Order is data order.
    const heights = Array.from(rects).map((r) =>
      parseFloat(r.getAttribute('height') ?? '0'),
    );
    expect(heights[1]).toBeCloseTo(222, 0);
    expect(heights[0]).toBeCloseTo(111, 0);
    expect(heights[2]).toBeCloseTo(55.5, 0);
    expect(el.textContent).toContain('100');
    expect(el.textContent).toContain('200');
    expect(el.textContent).toContain('50');
    expect(el.querySelector('svg')).not.toBeNull();
  });

  it('renders a visible message, never a blank chart, for empty data', async () => {
    const transformed = await transformSource(EMPTY_APP);
    const App = compileAppSource(transformed, realApi());
    const el = mount(App);
    expect(el.querySelectorAll('rect').length).toBe(0);
    expect(el.textContent).toContain('No data to chart');
  });
});
