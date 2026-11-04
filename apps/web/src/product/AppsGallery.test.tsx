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

  it('#145: card header row wraps so the title cannot collapse in a narrow panel', () => {
    const el = setup(
      h(AppsGallery, { store: makeStore([spec()]), mcpCall, onOpen: () => undefined }),
    );
    const title = [...el.querySelectorAll('div')].find((d) => d.textContent === 'Score viewer');
    expect(title).not.toBeUndefined();
    const titleBlock = title!.parentElement!;
    expect(titleBlock.style.flex).toContain('220px');
    const row = titleBlock.parentElement!;
    expect(row.style.flexWrap).toBe('wrap');
  });

  it('Preview mounts the live app frame for the entry', async () => {
    const el = setup(
      h(AppsGallery, { store: makeStore([spec()]), mcpCall, onOpen: () => undefined }),
    );
    clickByText(el, 'Preview');
    await flush();
    // No-iframe rule: the preview mounts the host-context frame, not an
    // iframe. The app renders into a shadow root under .host-app-root.
    const preview = el.querySelector('[data-gallery-preview="artifact_1"]');
    expect(preview).not.toBeNull();
    expect(preview!.querySelector('iframe')).toBeNull();
    const host = preview!.querySelector('.host-app-root') as HTMLElement | null;
    expect(host).not.toBeNull();
    expect(host!.shadowRoot).not.toBeNull();
    expect(host!.shadowRoot!.textContent).toContain('scores');
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

describe('AppsGallery panel variant (#145 redesign)', () => {
  function panelEl(
    store: MetadataStore<ArtifactSpec>,
    opts: { onOpen?: (id: string) => void; sharesApi?: SharesApi | null } = {},
  ) {
    return setup(
      h(AppsGallery, {
        store,
        mcpCall,
        onOpen: opts.onOpen ?? (() => undefined),
        sharesApi: opts.sharesApi ?? null,
        variant: 'panel',
      }),
    );
  }

  function openMenu(el: ParentNode): void {
    const menuBtn = el.querySelector('button[aria-label="Options for Score viewer"]');
    if (!menuBtn) throw new Error('⋯ menu button not found');
    act(() => {
      menuBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('shows the name + ⋯ only — no action buttons below the app name', () => {
    const el = panelEl(makeStore([spec()]));
    expect(el.textContent).toContain('Score viewer');
    expect(el.querySelector('button[aria-label="Options for Score viewer"]')).not.toBeNull();
    for (const label of ['Reopen', 'Preview', 'Duplicate', 'Share', '✕']) {
      expect(
        [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === label),
      ).toBe(false);
    }
  });

  it('tapping the item opens the app; tapping ⋯ does not', () => {
    const onOpen = vi.fn();
    const el = panelEl(makeStore([spec()]), { onOpen });
    openMenu(el);
    expect(onOpen).not.toHaveBeenCalled();
    const item = el.querySelector('[data-panel-app-item="artifact_1"]');
    expect(item).not.toBeNull();
    act(() => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledWith('artifact_1');
  });

  it('⋯ menu holds Share, Duplicate, Preview, Delete', () => {
    const el = panelEl(makeStore([spec()]));
    openMenu(el);
    const menu = el.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    for (const label of ['Share', 'Duplicate', 'Preview', 'Delete']) {
      expect(
        [...menu!.querySelectorAll('button')].some((b) => b.textContent?.trim() === label),
      ).toBe(true);
    }
  });

  it('menu Preview mounts the live app frame', async () => {
    const el = panelEl(makeStore([spec()]));
    openMenu(el);
    clickByText(el, 'Preview');
    await flush();
    const preview = el.querySelector('[data-gallery-preview="artifact_1"]');
    expect(preview).not.toBeNull();
    expect(preview!.querySelector('iframe')).toBeNull();
    const host = preview!.querySelector('.host-app-root') as HTMLElement | null;
    expect(host).not.toBeNull();
    expect(host!.shadowRoot).not.toBeNull();
  });

  it('menu Share opens the share dialog and creates the link on confirm', async () => {
    const sharesApi = fakeSharesApi();
    const el = panelEl(makeStore([spec()]), { sharesApi, onOpen: () => undefined });
    openMenu(el);
    clickByText(el, 'Share');
    await flush();
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Scores');
    expect(dialog!.textContent).toContain('3 rows × 2 columns');
    expect(sharesApi.createShare).not.toHaveBeenCalled();
    clickByText(dialog!, 'Share app + data');
    await flush();
    expect(sharesApi.createShare).toHaveBeenCalledTimes(1);
  });

  it('menu Delete removes the entry after confirm', () => {
    const store = makeStore([spec()]);
    const el = panelEl(store);
    const prevConfirm = window.confirm;
    (window as unknown as { confirm: (msg: string) => boolean }).confirm = () => true;
    try {
      openMenu(el);
      clickByText(el, 'Delete');
    } finally {
      (window as unknown as { confirm: (msg: string) => boolean }).confirm = prevConfirm;
    }
    expect(store.all()).toHaveLength(0);
    expect(el.textContent).toContain('No apps yet');
  });

  it('#145 revoke: item ⋯ menu offers "Revoke share" for a shared app', async () => {
    const sharesApi = fakeSharesApi();
    const el = panelEl(makeStore([spec()]), { sharesApi });
    await flush();
    openMenu(el);
    const menu = el.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(
      [...menu!.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Revoke share'),
    ).toBe(true);
    clickByText(el, 'Revoke share');
    await flush();
    expect(sharesApi.revokeShare).toHaveBeenCalledWith('share-xyz');
  });

  it('#145 revoke: "Shared by you" entry has its own ⋯ menu, no standalone Revoke button', async () => {
    const sharesApi = fakeSharesApi();
    const el = panelEl(makeStore([spec()]), { sharesApi });
    await flush();
    expect(el.textContent).toContain('Shared by you');
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Revoke'),
    ).toBe(false);
    const shareMenuBtn = el.querySelector('button[aria-label="Options for shared app Score viewer"]');
    expect(shareMenuBtn).not.toBeNull();
    act(() => {
      shareMenuBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const menu = el.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(
      [...menu!.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Revoke share'),
    ).toBe(true);
    clickByText(el, 'Revoke share');
    await flush();
    expect(sharesApi.revokeShare).toHaveBeenCalledWith('share-xyz');
  });

  it('#145 revoke: a revoked share offers no "Revoke share" anywhere', async () => {
    const sharesApi = fakeSharesApi({
      listMyShares: vi.fn(async () => [{ ...SHARE_SUMMARY, revokedAt: 9000 }]),
    });
    const el = panelEl(makeStore([spec()]), { sharesApi });
    await flush();
    expect(el.textContent).toContain('revoked');
    expect(el.querySelector('button[aria-label="Options for shared app Score viewer"]')).toBeNull();
    openMenu(el);
    const menu = el.querySelector('[role="menu"]');
    expect(
      [...menu!.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Revoke share'),
    ).toBe(false);
  });

  it('#145 revoke: Escape closes an open ⋯ menu even when focus sits on the ⋯ button', () => {
    const el = panelEl(makeStore([spec()]));
    openMenu(el);
    expect(el.querySelector('[role="menu"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(el.querySelector('[role="menu"]')).toBeNull();
  });

  it('#145 revoke: panel menus render fixed-positioned so no scroll region can clip them', () => {
    const sharesApi = fakeSharesApi();
    const el = panelEl(makeStore([spec()]), { sharesApi });
    openMenu(el);
    const menu = el.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.position).toBe('fixed');
  });
});

describe('SharedAppLanding', () => {
  it('renders the app full screen with a Restore action', async () => {
    const onRestore = vi.fn();
    const el = setup(h(SharedAppLanding, { spec: spec(), mcpCall, onRestore }));
    const landing = el.querySelector('[data-shared-app-landing="artifact_1"]');
    expect(landing).not.toBeNull();
    await flush();
    expect(landing!.querySelector('iframe')).toBeNull();
    const host = landing!.querySelector('.host-app-root') as HTMLElement | null;
    expect(host).not.toBeNull();
    expect(host!.shadowRoot).not.toBeNull();
    expect(el.textContent).toContain('your own copy of the data');
    clickByText(el, '⤢ Restore');
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
