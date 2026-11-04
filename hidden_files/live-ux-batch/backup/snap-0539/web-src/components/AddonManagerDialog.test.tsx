// @vitest-environment jsdom
/**
 * AddonManagerDialog run-action tests (add-on-model.md §5).
 * The Installed tab offers "Run" for enabled add-ons with an active grant
 * on the open document; clicking it invokes onRun and surfaces the outcome.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import AddonManagerDialog, { type AddonRunOutcome } from './AddonManagerDialog';
import type {
  AddonListing,
  CapabilityGrant,
  StoredAddon,
} from '@icecream-sheets/service';

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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  window.localStorage.clear();
});

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

function buttonsByText(el: HTMLElement, text: string): HTMLButtonElement[] {
  return [...el.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement[];
}

const INSTALLED: StoredAddon[] = [
  {
    manifest: {
      id: 'com.example.sum',
      name: 'Sum',
      version: '1.0.0',
      capabilities: [{ kind: 'read' }],
      entrypoint: 'main',
      manifestVersion: 1,
    } as StoredAddon['manifest'],
    code: 'function main() { return 1; }',
    enabled: true,
    installedAt: '2026-10-19T00:00:00.000Z',
    installedFromCatalog: true,
  },
];

const ACTIVE_GRANT: CapabilityGrant = {
  id: 'grant-1',
  addonId: 'com.example.sum',
  documentId: 'doc-1',
  manifestVersion: '1.0.0',
  capabilities: [{ kind: 'read' }],
  status: 'active',
  requestedBy: 'user:alice',
  requestedAt: '2026-10-19T00:00:00.000Z',
  decidedBy: 'user:alice',
  decidedAt: '2026-10-19T00:01:00.000Z',
};

function props(over: Record<string, unknown> = {}) {
  return {
    documentId: 'doc-1',
    currentUser: 'user:alice',
    catalog: [] as AddonListing[],
    installed: INSTALLED,
    grants: [ACTIVE_GRANT],
    onInstall: () => {},
    onEnable: () => {},
    onDisable: () => {},
    onUninstall: () => {},
    onRequestGrant: () => {},
    onApproveGrant: () => {},
    onDenyGrant: () => {},
    onRevokeGrant: () => {},
    onRun: async (): Promise<AddonRunOutcome> => ({ ok: true, value: { sum: 60 } }),
    onClose: () => {},
    ...over,
  };
}

describe('AddonManagerDialog run action', () => {
  it('offers Run for an enabled add-on with an active grant and shows the result', async () => {
    const onRun = vi.fn(async (): Promise<AddonRunOutcome> => ({ ok: true, value: { sum: 60 } }));
    const el = setup(h(AddonManagerDialog, props({ onRun })));
    act(() => {
      buttonByText(el, 'Installed').click();
    });
    const runBtn = buttonByText(el, 'Run');
    await act(async () => {
      runBtn.click();
    });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith('com.example.sum');
    expect(el.textContent).toContain('Result: {"sum":60}');
  });

  it('surfaces a failed run without throwing', async () => {
    const onRun = vi.fn(
      async (): Promise<AddonRunOutcome> => ({ ok: false, error: 'no active grant' }),
    );
    const el = setup(h(AddonManagerDialog, props({ onRun })));
    act(() => {
      buttonByText(el, 'Installed').click();
    });
    await act(async () => {
      buttonByText(el, 'Run').click();
    });
    expect(el.textContent).toContain('Run failed: no active grant');
  });

  it('hides Run when there is no active grant on this document', () => {
    const el = setup(h(AddonManagerDialog, props({ grants: [] })));
    act(() => {
      buttonByText(el, 'Installed').click();
    });
    expect(buttonsByText(el, 'Run')).toHaveLength(0);
    expect(el.textContent).toContain('Grant access to this document');
  });

  it('hides Run for a disabled add-on', () => {
    const disabled = [{ ...INSTALLED[0], enabled: false }];
    const el = setup(h(AddonManagerDialog, props({ installed: disabled })));
    act(() => {
      buttonByText(el, 'Installed').click();
    });
    expect(buttonsByText(el, 'Run')).toHaveLength(0);
  });
});
