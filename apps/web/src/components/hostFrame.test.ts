// @vitest-environment jsdom
/**
 * HostArtifactFrame tests (owner decision 2026-10-25: host-context
 * rendering, no iframe for now). Proves the frame mounts the app into
 * a shadow root, sets data-theme on the INNER mount div (the theme
 * variables live only under [data-theme=...] selectors), and injects
 * the ungated Tailwind --tw-* defaults (the properties layer's
 * @supports block is false in Chrome and @property does not register
 * inside a shadow tree, so .border would otherwise compute to none/0).
 * Visual styling itself is proven by browser computed styles.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { HostArtifactFrame } from './HostArtifactFrame';
import type { ArtifactSpec, McpCallFn } from '@icecream-sheets/service';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function spec(): ArtifactSpec {
  return {
    id: 'frame_1',
    version: 1,
    kind: 'react-app',
    name: 'Frame test',
    prompt: 'test',
    template: 'custom',
    source: 'function App() { return h("div", { className: "border" }, "frame-marker"); }',
    binding: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1, hasHeaderRow: true, columns: [] },
    principal: 'web-user',
    createdAt: 0,
    updatedAt: 0,
  };
}

const mcpCall: McpCallFn = async () => ({ cells: [] });

describe('HostArtifactFrame', () => {
  it('mounts the app in a shadow root with themed mount + tw defaults, no iframe', async () => {
    const el = setup(h(HostArtifactFrame, { spec: spec(), mcpCall }));
    await flush();
    expect(el.querySelector('iframe')).toBeNull();
    const host = el.querySelector('.host-app-root') as HTMLElement | null;
    expect(host).not.toBeNull();
    const shadow = host!.shadowRoot;
    expect(shadow).not.toBeNull();
    const styles = [...shadow!.querySelectorAll('style')].map((s) => s.textContent || '');
    expect(styles.length).toBeGreaterThanOrEqual(2);
    expect(styles.some((t) => t.includes('--tw-border-style:solid'))).toBe(true);
    const mount = shadow!.querySelector('div[data-theme]') as HTMLElement | null;
    expect(mount).not.toBeNull();
    expect(mount!.getAttribute('data-theme')).toBe('icecream-light');
    expect((mount!.textContent || '')).toContain('frame-marker');
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });
});
