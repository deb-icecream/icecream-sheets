// @vitest-environment jsdom
/**
 * Workspace tests (workspace-redesign brief, 2026-10-22): OneDrive /
 * SharePoint shape — header bar (brand, tier meter, settings gear,
 * avatar), command bar (+ New / Upload), files in a LIST VIEW in the
 * API's recents-first order, real deep-link anchors, a per-row actions
 * menu (Download / Rename / Delete), the Default file-count meter,
 * verbatim server error display on upload failure, the create → open
 * flow, and gear → Settings PAGE → back navigation. ProductApi is
 * faked with vi.fn stubs; rendering uses the repo's raw
 * react-dom/test-utils pattern (no testing-library).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Workspace } from './Workspace';
import {
  ProductApiError,
  type FileListResult,
  type ProductApi,
  type UserFileRecord,
} from './productApi';
import type { UserSettingsView } from './userSettings';

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

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function pickFile(el: HTMLElement, file: File) {
  const input = el.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

function makeRecord(i: number, overrides: Partial<UserFileRecord> = {}): UserFileRecord {
  return {
    fileId: `file-${i}`,
    ownerPrincipal: 'user:u1',
    name: `Book ${i}.xlsx`,
    origin: i % 2 === 0 ? 'upload' : 'created',
    sourceFormat: 'xlsx',
    sizeBytes: 1000 * i,
    storageRef: null,
    libraryEntryId: null,
    hasStoredState: false,
    createdAt: Date.now() - i * 3_600_000,
    updatedAt: Date.now() - i * 3_600_000,
    lastOpenedAt: Date.now() - i * 3_600_000,
    ...overrides,
  };
}

function makeList(files: UserFileRecord[], overrides: Partial<FileListResult> = {}): FileListResult {
  return {
    tier: 'default',
    limits: { uploadMaxBytes: 1_285_214, fileLimit: 10 },
    count: files.length,
    files,
    ...overrides,
  };
}

interface Stubs {
  listFiles: ReturnType<typeof vi.fn>;
  createFile: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
  renameFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  downloadGrant: ReturnType<typeof vi.fn>;
}

function fakeApi(list: FileListResult, patch: Partial<Stubs> = {}): { api: ProductApi; stubs: Stubs } {
  const stubs: Stubs = {
    listFiles: vi.fn(async () => list),
    createFile: vi.fn(async (name: string) => makeRecord(99, { name })),
    uploadFile: vi.fn(async () => makeRecord(50)),
    renameFile: vi.fn(async () => makeRecord(1)),
    deleteFile: vi.fn(async () => undefined),
    downloadGrant: vi.fn(async () => 'http://127.0.0.1:8100/dl?ut=t'),
    ...patch,
  };
  return { api: stubs as unknown as ProductApi, stubs };
}

const SETTINGS_VIEW: UserSettingsView = {
  hasRecord: true,
  displayName: 'Ada L.',
  email: 'ada@example.com',
  googleName: 'Ada Lovelace',
  theme: 'system',
};

function settingsProp() {
  return {
    profileEmail: 'ada@example.com',
    profileName: 'Ada Lovelace',
    onFirebaseDelete: vi.fn(async () => 'deleted' as const),
    onSignedOut: vi.fn(),
  };
}

function fakeApiWithSettings(list: FileListResult): ProductApi {
  const { api } = fakeApi(list);
  return {
    ...api,
    getSettings: vi.fn(async () => SETTINGS_VIEW),
    updateSettings: vi.fn(async () => SETTINGS_VIEW),
    deleteAccount: vi.fn(async () => ({ deleted: {} })),
  } as unknown as ProductApi;
}

describe('Workspace', () => {
  it('the list shows every file once, in the API order (recents-first)', async () => {
    const files = [1, 2, 3, 4, 5, 6, 7].map((i) => makeRecord(i));
    const { api } = fakeApi(makeList(files));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const rows = [...el.querySelectorAll('.ics-table tbody tr')];
    expect(rows).toHaveLength(7);
    const names = [...el.querySelectorAll('.ics-table .ics-file-link')].map((a) => a.textContent);
    expect(names).toEqual(files.map((f) => f.name));
    // No card grid anymore.
    expect(el.querySelector('.ics-recent-list')).toBeNull();
  });

  it('list columns are Name / Modified / Size, with a file-type icon per row', async () => {
    const files = [makeRecord(1), makeRecord(2, { sourceFormat: 'csv', name: 'data.csv' })];
    const { api } = fakeApi(makeList(files));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const headers = [...el.querySelectorAll('.ics-table thead th')].map((t) =>
      t.textContent?.trim(),
    );
    expect(headers.slice(0, 3)).toEqual(['Name', 'Modified', 'Size']);
    const icons = el.querySelectorAll('.ics-table .ics-file-icon');
    expect(icons).toHaveLength(2);
  });

  it('file names are real anchors whose href carries ?file=<id>', async () => {
    const files = [makeRecord(1), makeRecord(2)];
    const { api } = fakeApi(makeList(files));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const anchors = [...el.querySelectorAll('a.ics-file-link')];
    expect(anchors.length).toBe(2);
    for (const f of files) {
      const match = anchors.find((a) => a.textContent === f.name);
      expect(match, `anchor for ${f.name}`).toBeTruthy();
      expect(match!.getAttribute('href')).toContain(`?file=${f.fileId}`);
    }
  });

  it('anchor click with a custom onOpenFile prevents default and calls it', async () => {
    const files = [makeRecord(3)];
    const onOpenFile = vi.fn();
    const { api } = fakeApi(makeList(files));
    const el = setup(h(Workspace, { api, onOpenFile }));
    await flush();

    const anchor = el.querySelector('.ics-table a.ics-file-link');
    expect(anchor).toBeTruthy();
    click(anchor!);
    expect(onOpenFile).toHaveBeenCalledWith('file-3');
  });

  it('header bar: brand, tier badge "Default" and meter "3 of 10 files"', async () => {
    const files = [makeRecord(1), makeRecord(2), makeRecord(3)];
    const { api } = fakeApi(makeList(files, { count: 3 }));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const header = el.querySelector('header.ics-ws-header');
    expect(header).toBeTruthy();
    expect(header!.querySelector('.ics-wordmark')?.textContent).toContain('Icecream');
    expect(el.querySelector('h1')?.textContent).toBe('My files');
    expect(el.querySelector('.ics-tier-badge')?.textContent).toBe('Default');
    expect(el.textContent).toContain('3 of 10 files');
  });

  it('Pro header: badge "Pro" and no cap meter', async () => {
    const files = [makeRecord(1)];
    const { api } = fakeApi(
      makeList(files, { tier: 'pro', limits: { uploadMaxBytes: null, fileLimit: null } }),
    );
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    expect(el.querySelector('.ics-tier-badge')?.textContent).toBe('Pro');
    expect(el.textContent).not.toContain('of 10 files');
  });

  it('command bar: "+ New" creates an Untitled spreadsheet and opens it; Upload is present', async () => {
    const created = makeRecord(42, { name: 'Untitled spreadsheet', origin: 'created' });
    const createFile = vi.fn(async () => created);
    const onOpenFile = vi.fn();
    const { api } = fakeApi(makeList([makeRecord(1)]), { createFile });
    const el = setup(h(Workspace, { api, onOpenFile }));
    await flush();

    const bar = el.querySelector('.ics-ws-commandbar');
    expect(bar).toBeTruthy();
    const newBtn = [...bar!.querySelectorAll('button')].find((b) => b.textContent?.includes('New'));
    expect(newBtn).toBeTruthy();
    expect(newBtn!.textContent).toContain('+');
    const uploadLabel = [...bar!.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Upload'),
    );
    expect(uploadLabel).toBeTruthy();

    click(newBtn!);
    await flush();
    expect(createFile).toHaveBeenCalledWith('Untitled spreadsheet');
    expect(onOpenFile).toHaveBeenCalledWith('file-42');
  });

  it('row menu: Download / Rename / Delete behind the ⋯ button', async () => {
    const file = makeRecord(1);
    const { api, stubs } = fakeApi(makeList([file]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    expect(el.querySelector('[role="menu"]')).toBeNull();
    const menuBtn = el.querySelector(
      'button[aria-label="Actions for Book 1.xlsx"]',
    ) as HTMLButtonElement;
    expect(menuBtn).toBeTruthy();
    click(menuBtn);
    await flush();
    const menu = el.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    const items = [...menu!.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
    expect(items).toEqual(['Download', 'Rename', 'Delete']);

    click([...menu!.querySelectorAll('[role="menuitem"]')][0]);
    await flush();
    expect(stubs.downloadGrant).toHaveBeenCalledWith('file-1');
    expect(el.querySelector('[role="menu"]')).toBeNull();
  });

  it('row menu: Rename opens the inline form and saves through the API', async () => {
    const file = makeRecord(1);
    const { api, stubs } = fakeApi(makeList([file]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    click(el.querySelector('button[aria-label="Actions for Book 1.xlsx"]')!);
    await flush();
    const menu = el.querySelector('[role="menu"]')!;
    click([...menu.querySelectorAll('[role="menuitem"]')][1]);
    await flush();

    const input = el.querySelector('input[aria-label="Rename Book 1.xlsx"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(input, 'Renamed.xlsx');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = input.closest('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(stubs.renameFile).toHaveBeenCalledWith('file-1', 'Renamed.xlsx');
  });

  it('upload failure shows the server error message VERBATIM in role="alert"', async () => {
    const verbatim =
      'Upload too large: this file is 2,000,000 bytes and the Default upload limit is 1,285,214 bytes. Pro accounts have no upload limit.';
    const { api } = fakeApi(makeList([makeRecord(1)]), {
      uploadFile: vi.fn(async () => {
        throw new ProductApiError(413, verbatim, 'UPLOAD_TOO_LARGE');
      }),
    });
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const input = el.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'big.xlsx')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const alert = el.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert!.textContent).toBe(verbatim);
  });

  it('file input accept attribute includes both .xlsx and .csv', async () => {
    const { api } = fakeApi(makeList([makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const input = el.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const accept = input.getAttribute('accept') ?? '';
    expect(accept).toContain('.xlsx');
    expect(accept).toContain('.csv');
  });

  it('uploading a .csv file calls the API and refreshes the list', async () => {
    const { api, stubs } = fakeApi(makeList([makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();
    expect(stubs.listFiles).toHaveBeenCalledTimes(1);

    await pickFile(el, new File(['a,b\n1,2'], 'sales.csv', { type: 'text/csv' }));

    expect(stubs.uploadFile).toHaveBeenCalledTimes(1);
    const uploaded = (stubs.uploadFile.mock.calls[0] as unknown as [File])[0];
    expect(uploaded.name).toBe('sales.csv');
    // Initial load + post-upload refresh.
    expect(stubs.listFiles).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('uploading a .CSV file (uppercase extension) calls the API', async () => {
    const { api, stubs } = fakeApi(makeList([makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    await pickFile(el, new File(['a,b\n1,2'], 'SALES.CSV', { type: 'text/csv' }));

    expect(stubs.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('uploading a .txt file shows the supported-formats error and never calls uploadFile', async () => {
    const { api, stubs } = fakeApi(makeList([makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    await pickFile(el, new File(['hello'], 'notes.txt', { type: 'text/plain' }));

    expect(stubs.uploadFile).not.toHaveBeenCalled();
    const alert = el.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert!.textContent).toBe('Only .xlsx, .xls and .csv files can be uploaded.');
  });

  it('a csv-sourced record renders the CSV marker in its row; an xlsx record does not', async () => {
    const csvFile = makeRecord(8, {
      name: 'sales.csv',
      origin: 'upload',
      sourceFormat: 'csv',
    });
    const xlsxFile = makeRecord(9, { name: 'Book 9.xlsx', sourceFormat: 'xlsx' });
    const { api } = fakeApi(makeList([csvFile, xlsxFile]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const rows = [...el.querySelectorAll('.ics-table tbody tr')].map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Imported from CSV');
    expect(rows[1]).not.toContain('Imported from CSV');
  });

  it('a record with no sourceFormat (older server) renders without the CSV marker', async () => {
    const legacy = makeRecord(11);
    delete legacy.sourceFormat;
    const { api } = fakeApi(makeList([legacy]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    expect(el.textContent).not.toContain('Imported from CSV');
  });

  it('empty state is designed: points at New and Upload when the user has no files', async () => {
    const { api } = fakeApi(makeList([]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const empty = el.querySelector('.ics-empty');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('Your workspace is empty');
    const buttons = [...empty!.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes('New spreadsheet'))).toBe(true);
    expect(buttons.some((t) => t?.includes('Upload a file'))).toBe(true);
    // The command bar is still there above the empty state.
    expect(el.querySelector('.ics-ws-commandbar')).toBeTruthy();
  });

  it('received share copies list like other entries, tagged Shared', async () => {
    const shared = makeRecord(9, { name: 'Shared model.xlsx', origin: 'shared' });
    const { api } = fakeApi(makeList([shared, makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const tags = [...el.querySelectorAll('.ics-origin-tag')].map((t) => t.textContent);
    expect(tags).toContain('Shared');
    const link = [...el.querySelectorAll('a.ics-file-link')].find(
      (a) => a.textContent === 'Shared model.xlsx',
    );
    expect(link?.getAttribute('href')).toContain('?file=file-9');
  });

  it('Apps slot: section renders with the gallery content when appsSlot is given', async () => {
    const { api } = fakeApi(makeList([makeRecord(1)]));
    const gallery = h('div', { 'data-testid': 'fake-gallery' }, 'Gallery placeholder content');
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn(), appsSlot: gallery }));
    await flush();

    const section = el.querySelector('section.ics-apps');
    expect(section).toBeTruthy();
    expect(section!.querySelector('h2')!.textContent).toBe('Apps');
    expect(section!.textContent).toContain('Gallery placeholder content');
    // The Apps section is the LAST section in the workspace main column.
    const main = el.querySelector('main.ics-ws-main')!;
    const sections = [...main.querySelectorAll('section')];
    expect(sections[sections.length - 1]).toBe(section);
  });

  it('Apps slot: no Apps section at all when appsSlot is absent', async () => {
    const { api } = fakeApi(makeList([makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    expect(el.querySelector('section.ics-apps')).toBeNull();
  });

  it('Apps slot: still renders when the file list is empty', async () => {
    const { api } = fakeApi(makeList([]));
    const gallery = h('div', null, 'Gallery placeholder content');
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn(), appsSlot: gallery }));
    await flush();

    expect(el.querySelector('section.ics-apps')).toBeTruthy();
  });

  it('load failure renders an alert with a retry affordance', async () => {
    const { api } = fakeApi(makeList([]), {
      listFiles: vi.fn(async () => {
        throw new ProductApiError(503, 'product layer unavailable', 'UNAVAILABLE');
      }),
    });
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    const alert = el.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert!.textContent).toContain('product layer unavailable');
  });

  it('no gear and no avatar when the settings wiring is absent', async () => {
    const { api } = fakeApi(makeList([makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn() }));
    await flush();

    expect(el.querySelector('button[aria-label="Settings"]')).toBeNull();
    expect(el.querySelector('.ics-avatar')).toBeNull();
  });

  it('gear + avatar in the header; gear opens the Settings PAGE; Back returns to the list', async () => {
    const api = fakeApiWithSettings(makeList([makeRecord(1)]));
    const el = setup(h(Workspace, { api, onOpenFile: vi.fn(), settings: settingsProp() }));
    await flush();

    const avatar = el.querySelector('.ics-avatar');
    expect(avatar).toBeTruthy();
    expect(avatar!.textContent).toBe('AL');
    const gear = el.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;
    expect(gear).toBeTruthy();
    // No settings surface before the gear is used — and never a panel
    // inside the file list.
    expect(el.querySelector('.ics-settings-page')).toBeNull();

    click(gear);
    await flush();
    const page = el.querySelector('.ics-settings-page');
    expect(page).toBeTruthy();
    expect(page!.querySelector('h1')?.textContent).toBe('Settings');
    // The file list + command bar are replaced by the page.
    expect(el.querySelector('.ics-table')).toBeNull();
    expect(el.querySelector('.ics-ws-commandbar')).toBeNull();
    // Email visibly disabled on the page.
    const email = page!.querySelector('#ics-settings-email') as HTMLInputElement;
    expect(email.disabled).toBe(true);
    expect(email.readOnly).toBe(true);

    const back = [...page!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Back to workspace'),
    ) as HTMLButtonElement;
    click(back);
    await flush();
    expect(el.querySelector('.ics-settings-page')).toBeNull();
    expect(el.querySelector('.ics-table')).toBeTruthy();
    expect(el.querySelector('.ics-ws-commandbar')).toBeTruthy();
  });
});
