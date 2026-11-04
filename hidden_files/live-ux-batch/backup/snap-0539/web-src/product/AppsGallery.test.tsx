// @vitest-environment jsdom
/**
 * AppsGallery tests (idea-app-gallery): real-store entries only, live
 * preview mounting, Duplicate rebinding (copy bound to the NEW sheet),
 * the Share dialog (names the sheet + row count, explicit confirm,
 * credentials never mentioned as traveling), "shared by you" + revoke,
 * and the recipient landing (full screen + Restore).
 *
 * Rendering uses the repo's raw react-dom pattern (no testing-library).
 * The store is the REAL MetadataStore over in-memory persistence; the
 * specs are test fixtures in the store — the gallery itself seeds
 * nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  createArtifactStore,
  memoryPersistence,
  type AppSharePackage,
  type ArtifactSpec,
  type MetadataStore,
  type McpCallFn,
} from '@icecream-sheets/service';
import { AppsGallery, SharedAppLanding } from './AppsGallery';
import type { AppShareSummary, SharesApi } from './sharesApi';

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
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function clickByText(scope: ParentNode, text: string): void {
  const btn = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button "${text}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function spec(overrides: Partial<ArtifactSpec> = {}): ArtifactSpec {
  return {
    id: 'artifact_1',
    version: 1,
    kind: 'react-app',
    name: 'Score viewer',
    prompt: 'show me the scores',
    template: 'data-table',
    source: 'function App() { return h("div", null, "scores"); }',
    binding: {
      sheet: 'Scores',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 1,
      hasHeaderRow: true,
      columns: [
        { name: 'Player', type: 'text', index: 0 },
        { name: 'Points', type: 'numeric', index: 1 },
      ],
    },
    principal: 'web-user',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

const CELLS: Record<string, unknown[][]> = {
  Scores: [
    ['Player', 'Points'],
    ['Ada', 30],
    ['Grace', 25],
    ['Linus', 20],
  ],
  Backup: [
    ['Player', 'Points'],
    ['Ada', 30],
  ],
};

const mcpCall: McpCallFn = async (tool, args) => {
  if (tool === 'get_results') {
    const sheet = (args as { sheet: string }).sheet;
    return { cells: CELLS[sheet] ?? [] };
  }
  if (tool === 'read_cells') return { cells: CELLS['Scores'] };
  if (tool === 'subscribe') return { subscriptionId: 's1' };
  if (tool === 'poll_events') return { events: [] };
  if (tool === 'unsubscribe') return { ok: true };
  throw new Error(`unexpected tool ${tool}`);
};

function makeStore(entries: ArtifactSpec[]): MetadataStore<ArtifactSpec> {
  const store = createArtifactStore(memoryPersistence());
  for (const e of entries) store.add(e);
  return store;
}

const SHARE_SUMMARY: AppShareSummary = {
  shareId: 'share-xyz',
  ownerPrincipal: 'user:alice',
  appName: 'Score viewer',
  sourceSheet: 'Scores',
  rowCount: 3,
  colCount: 2,
  createdAt: 5000,
  revokedAt: null,
};

function fakeSharesApi(overrides: Partial<SharesApi> = {}): SharesApi {
  return {
    createShare: vi.fn(async (_pkg: AppSharePackage) => SHARE_SUMMARY),
    listMyShares: vi.fn(async () => [SHARE_SUMMARY]),
    getShare: vi.fn(),
    revokeShare: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SharesApi;
}

describe('AppsGallery', () => {
  it('honest empty state when the store has no generated apps', () => {
    const el = setup(h(AppsGallery, { store: makeStore([]), mcpCall, onOpen: () => undefined }));
    expect(el.textContent).toContain('No apps yet');
  });

  it('lists store entries with their bound sheet and all three actions', () => {
    const el = setup(
      h(AppsGallery, { store: makeStore([spec()]), mcpCall, onOpen: () => undefined }),
    );
    expect(el.textContent).toContain('Score viewer');
    expect(el.textContent).toContain('bound to Scores');
    for (const label of ['Reopen', 'Preview', 'Duplicate', 'Share']) {
      expect(
        [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === label),
      ).toBe(true);
    }
  });

  it('Preview mounts the live app frame for the entry', async () => {
    const el = setup(
      h(AppsGallery, { store: makeStore([spec()]), mcpCall, onOpen: () => undefined }),
    );
    clickByText(el, 'Preview');
    await flush();
    const frame = el.querySelector('[data-gallery-preview="artifact_1"] iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('Duplicate binds the copy to the NEW sheet and keeps the original', async () => {
    const store = makeStore([spec()]);
    const el = setup(
      h(AppsGallery, { store, mcpCall, onOpen: () => undefined, sheets: ['Scores', 'Backup'] }),
    );
    clickByText(el, 'Duplicate');
    const input = el.querySelector('input[aria-label*="bind the copy"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'Backup');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickByText(el, 'Create copy');
    await flush();
    const all = store.all();
    expect(all).toHaveLength(2);
    const copy = all.find((a) => a.id !== 'artifact_1')!;
    expect(copy.name).toBe('Score viewer copy');
    expect(copy.binding.sheet).toBe('Backup');
    expect(all.find((a) => a.id === 'artifact_1')!.binding.sheet).toBe('Scores');
    expect(el.textContent).toContain('bound to Backup');
  });

  it('Share dialog names the sheet and its size, and only creates the link on explicit confirm', async () => {
    const sharesApi = fakeSharesApi();
    const el = setup(
      h(AppsGallery, {
        store: makeStore([spec()]),
        mcpCall,
        onOpen: () => undefined,
        sharesApi,
        shareLinkBase: 'https://sheets.example.test/',
      }),
    );
    clickByText(el, 'Share');
    await flush();
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Scores');
    expect(dialog!.textContent).toContain('3 rows × 2 columns');
    expect(dialog!.textContent).toContain('credentials are never shared');
    // Nothing created before the explicit confirm.
    expect(sharesApi.createShare).not.toHaveBeenCalled();
    clickByText(dialog!, 'Share app + data');
    await flush();
    expect(sharesApi.createShare).toHaveBeenCalledTimes(1);
    const pkg = (sharesApi.createShare as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppSharePackage;
    expect(pkg.snapshot.cells).toEqual(CELLS['Scores']);
    const linkInput = dialog!.querySelector('input[aria-label="Share link"]') as HTMLInputElement;
    expect(linkInput.value).toContain('share=share-xyz');
  });

  it('Share without a signed-in backend explains itself instead of creating anything', async () => {
    const el = setup(
      h(AppsGallery, { store: makeStore([spec()]), mcpCall, onOpen: () => undefined }),
    );
    clickByText(el, 'Share');
    await flush();
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog!.textContent).toContain('signed in');
    expect(
      [...dialog!.querySelectorAll('button')].some((b) => b.textContent?.includes('Share app + data')),
    ).toBe(false);
  });

  it('"Shared by you" lists links and Revoke calls the API', async () => {
    const sharesApi = fakeSharesApi();
    const el = setup(
      h(AppsGallery, {
        store: makeStore([spec()]),
        mcpCall,
        onOpen: () => undefined,
        sharesApi,
      }),
    );
    await flush();
    expect(el.textContent).toContain('Shared by you');
    expect(el.textContent).toContain('data from Scores (3 rows)');
    clickByText(el, 'Revoke');
    await flush();
    expect(sharesApi.revokeShare).toHaveBeenCalledWith('share-xyz');
  });
});

describe('SharedAppLanding', () => {
  it('renders the app full screen with a Restore action', async () => {
    const onRestore = vi.fn();
    const el = setup(h(SharedAppLanding, { spec: spec(), mcpCall, onRestore }));
    const landing = el.querySelector('[data-shared-app-landing="artifact_1"]');
    expect(landing).not.toBeNull();
    expect(landing!.querySelector('iframe')).not.toBeNull();
    expect(el.textContent).toContain('your own copy of the data');
    clickByText(el, '⤢ Restore');
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
