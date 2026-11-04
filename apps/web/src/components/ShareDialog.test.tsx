// @vitest-environment jsdom
/**
 * Share dialog tests (issue #71): the dialog is backed by the server's
 * share contract through services/fileSharing — the gateway registry is
 * the authority, the dialog only renders what it returns. These tests
 * fake that service seam and verify the wiring: the owner sees grant
 * controls keyed off the SERVER-reported role, non-owners see the list
 * with no way to change it, invites/re-roles/revokes post the right
 * principal + role, and failures surface in plain language and resync.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ShareDialog from './ShareDialog';
import { FileShareError, type FileShareState } from '../services/fileSharing';

const FILE_ID = 'file-test-1';

const { mockFetch, mockSet, mockResolve, mockLink, mockTransfer } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockSet: vi.fn(),
  mockResolve: vi.fn(),
  mockLink: vi.fn(),
  mockTransfer: vi.fn(),
}));

vi.mock('../services/fileSharing', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchFileShareState: mockFetch,
    setFileGrant: mockSet,
    resolvePrincipalByEmail: mockResolve,
    setLinkShare: mockLink,
    transferOwnership: mockTransfer,
  };
});

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(ui);
  });
  await act(async () => {});
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

beforeEach(() => {
  mockFetch.mockReset();
  mockSet.mockReset();
  mockSet.mockResolvedValue(undefined);
  mockResolve.mockReset();
  mockLink.mockReset();
  mockLink.mockResolvedValue(undefined);
  mockTransfer.mockReset();
  mockTransfer.mockResolvedValue({ owner: 'user:bob', previousOwner: 'user:alice', catalogTransferred: true });
});

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`button '${text}' not found`);
  return btn as HTMLButtonElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(btn: HTMLButtonElement) {
  await act(async () => {
    btn.click();
  });
  await act(async () => {});
}

function state(over: Partial<FileShareState> = {}): FileShareState {
  return {
    fileId: FILE_ID,
    owner: 'user:alice',
    role: 'owner',
    grants: [{ principal: 'user:bob', role: 'viewer' }],
    linkShare: null,
    ...over,
  };
}

function renderDialog() {
  return h(ShareDialog, {
    fileId: FILE_ID,
    workbookName: 'Budget',
    principal: 'user:alice',
    onClose: () => {},
  });
}

describe('ShareDialog (server-backed, issue #71)', () => {
  it('owner sees the owner row, the grants, and the manage controls', async () => {
    mockFetch.mockResolvedValue(state());
    const el = await setup(renderDialog());
    expect(el.textContent).toContain('alice');
    expect(el.textContent).toContain('(you)');
    expect(el.textContent).toContain('Owner');
    expect(el.textContent).toContain('bob');
    const bobSelect = el.querySelector<HTMLSelectElement>('select[aria-label="Access level for bob"]');
    expect(bobSelect?.value).toBe('viewer');
    expect(buttonByText(el, 'Remove')).toBeTruthy();
    expect(el.querySelector('input[aria-label="Account ID or email address of the person to share with"]')).toBeTruthy();
    expect(buttonByText(el, 'Share')).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledWith(FILE_ID);
  });

  it('invite posts the normalized principal with the chosen role, then refreshes', async () => {
    mockFetch
      .mockResolvedValueOnce(state())
      .mockResolvedValue(
        state({
          grants: [
            { principal: 'user:bob', role: 'viewer' },
            { principal: 'user:carol', role: 'editor' },
          ],
        }),
      );
    const el = await setup(renderDialog());
    const input = el.querySelector<HTMLInputElement>(
      'input[aria-label="Account ID or email address of the person to share with"]',
    )!;
    setInputValue(input, 'carol');
    const level = el.querySelector<HTMLSelectElement>(
      'select[aria-label="Access level for the new share"]',
    )!;
    setSelectValue(level, 'editor');
    await click(buttonByText(el, 'Share'));
    expect(mockSet).toHaveBeenCalledWith(FILE_ID, 'user:carol', 'editor');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('carol');
    expect(el.textContent).toContain('can now edit this file');
  });

  it('changing a grant’s level posts the new role', async () => {
    mockFetch.mockResolvedValue(state());
    const el = await setup(renderDialog());
    const bobSelect = el.querySelector<HTMLSelectElement>('select[aria-label="Access level for bob"]')!;
    setSelectValue(bobSelect, 'editor');
    await act(async () => {});
    expect(mockSet).toHaveBeenCalledWith(FILE_ID, 'user:bob', 'editor');
  });

  it('Remove revokes the grant (role null)', async () => {
    mockFetch.mockResolvedValue(state());
    const el = await setup(renderDialog());
    await click(buttonByText(el, 'Remove'));
    expect(mockSet).toHaveBeenCalledWith(FILE_ID, 'user:bob', null);
  });

  it('an editor sees the list but no way to change it', async () => {
    mockFetch.mockResolvedValue(state({ role: 'editor' }));
    const el = await setup(
      h(ShareDialog, {
        fileId: FILE_ID,
        workbookName: 'Budget',
        principal: 'user:bob',
        onClose: () => {},
      }),
    );
    expect(el.textContent).toContain('bob');
    expect(el.textContent).toContain('(you)');
    expect(el.textContent).toContain('Only the owner can change who has access to this file.');
    expect(el.querySelector('select')).toBeNull();
    expect(el.querySelector('input')).toBeNull();
    // Only the dialog's own close affordances ('×' chrome + Close) —
    // no Share / Remove / any manage button.
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual([
      '×',
      'Close',
    ]);
  });

  it('a viewer likewise gets no manage controls', async () => {
    mockFetch.mockResolvedValue(state({ role: 'viewer' }));
    const el = await setup(
      h(ShareDialog, {
        fileId: FILE_ID,
        workbookName: 'Budget',
        principal: 'user:bob',
        onClose: () => {},
      }),
    );
    expect(el.querySelector('select')).toBeNull();
    expect(el.querySelector('input')).toBeNull();
    expect(el.textContent).toContain('Only the owner can change who has access');
  });

  it('a local-only file explains itself instead of pretending to share', async () => {
    const el = await setup(
      h(ShareDialog, {
        fileId: null,
        workbookName: 'Budget',
        principal: 'user:alice',
        onClose: () => {},
      }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(el.textContent).toContain('only on this device right now');
    expect(el.textContent).toContain('Save it to your workspace');
  });

  it('a load failure shows the plain-language message with a retry', async () => {
    mockFetch.mockRejectedValue(new Error('gateway 404: {"error":"file not found"}'));
    const el = await setup(renderDialog());
    expect(el.textContent).toContain('isn’t saved in the workspace yet');
    expect(buttonByText(el, 'Try again')).toBeTruthy();
  });

  it('a failed change shows the refusal and resyncs from the server', async () => {
    mockFetch.mockResolvedValue(state());
    mockSet.mockRejectedValue(
      new Error('gateway 403: {"error":"only the file owner can share this file"}'),
    );
    const el = await setup(renderDialog());
    const fetchesBefore = mockFetch.mock.calls.length;
    await click(buttonByText(el, 'Remove'));
    expect(el.textContent).toContain('Only the owner of this file can change who has access to it.');
    expect(mockFetch.mock.calls.length).toBeGreaterThan(fetchesBefore);
    // Bob's row is still there — the dialog shows what the server says.
    expect(el.textContent).toContain('bob');
  });

  it('inviting the owner is explained, not posted', async () => {
    mockFetch.mockResolvedValue(state());
    const el = await setup(renderDialog());
    const input = el.querySelector<HTMLInputElement>(
      'input[aria-label="Account ID or email address of the person to share with"]',
    )!;
    setInputValue(input, 'alice');
    await click(buttonByText(el, 'Share'));
    expect(mockSet).not.toHaveBeenCalled();
    expect(el.textContent).toContain('already have full access');
  });
});

describe('ShareDialog (issue #84: email invite, link sharing, transfer)', () => {
  it('owner sees link sharing off and the transfer section', async () => {
    mockFetch.mockResolvedValue(state());
    const el = await setup(renderDialog());
    expect(el.textContent).toContain('Anyone with the link');
    const linkSelect = el.querySelector('select[aria-label="Link sharing role"]') as HTMLSelectElement;
    expect(linkSelect.value).toBe('off');
    expect(el.textContent).toContain('Transfer ownership');
  });

  it('changing link sharing posts the role and reports it', async () => {
    mockFetch.mockResolvedValue(state({ linkShare: null }));
    const el = await setup(renderDialog());
    const linkSelect = el.querySelector('select[aria-label="Link sharing role"]') as HTMLSelectElement;
    setSelectValue(linkSelect, 'viewer');
    await act(async () => {});
    expect(mockLink).toHaveBeenCalledWith(FILE_ID, 'viewer');
    expect(el.textContent).toContain('Anyone with the link can now view this file.');
  });

  it('email invite resolves through the directory, then grants', async () => {
    mockFetch.mockResolvedValue(state({ grants: [] }));
    mockResolve.mockResolvedValue({ principal: 'user:bob', email: 'bob@example.com' });
    const el = await setup(renderDialog());
    const input = el.querySelector(
      'input[aria-label="Account ID or email address of the person to share with"]',
    ) as HTMLInputElement;
    setInputValue(input, 'bob@example.com');
    await click(buttonByText(el, 'Share'));
    expect(mockResolve).toHaveBeenCalledWith(FILE_ID, 'bob@example.com');
    expect(mockSet).toHaveBeenCalledWith(FILE_ID, 'user:bob', 'viewer');
    expect(el.textContent).toContain('bob@example.com can now view this file.');
  });

  it('unknown email shows the sign-in-first message and grants nothing', async () => {
    mockFetch.mockResolvedValue(state());
    mockResolve.mockRejectedValue(
      new FileShareError('no-such-user', 'Nobody has signed in with that email yet.'),
    );
    const el = await setup(renderDialog());
    const input = el.querySelector(
      'input[aria-label="Account ID or email address of the person to share with"]',
    ) as HTMLInputElement;
    setInputValue(input, 'nobody@example.com');
    await click(buttonByText(el, 'Share'));
    expect(mockSet).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Nobody has signed in with that email yet.');
  });

  it('transfer asks for confirmation, then posts and re-renders as non-owner', async () => {
    const ownerState = state();
    const editorState = state({ role: 'editor', owner: 'user:bob', grants: [] });
    mockFetch.mockResolvedValueOnce(ownerState).mockResolvedValue(editorState);
    const el = await setup(renderDialog());
    const input = el.querySelector(
      'input[aria-label="Account ID or email address of the new owner"]',
    ) as HTMLInputElement;
    setInputValue(input, 'bob');
    await click(buttonByText(el, 'Transfer ownership…'));
    expect(el.textContent).toContain('Transfer ownership of this file to bob?');
    await click(buttonByText(el, 'Yes, transfer ownership'));
    expect(mockTransfer).toHaveBeenCalledWith(FILE_ID, 'user:bob');
    expect(el.textContent).toContain('bob is now the owner of this file.');
    expect(el.textContent).toContain('Only the owner can change who has access to this file.');
  });

  it('transfer to someone without access is refused before posting', async () => {
    mockFetch.mockResolvedValue(state());
    const el = await setup(renderDialog());
    const input = el.querySelector(
      'input[aria-label="Account ID or email address of the new owner"]',
    ) as HTMLInputElement;
    setInputValue(input, 'carol');
    await click(buttonByText(el, 'Transfer ownership…'));
    await click(buttonByText(el, 'Yes, transfer ownership'));
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(el.textContent).toContain('share it with them first');
  });

  it('link user sees the link hint and no manage controls', async () => {
    mockFetch.mockResolvedValue(
      state({ role: 'viewer', owner: 'user:alice', grants: [], linkShare: { role: 'viewer' } }),
    );
    const el = await setup(
      h(ShareDialog, { fileId: FILE_ID, workbookName: 'Budget', principal: 'user:stranger', onClose: () => {} }),
    );
    expect(el.textContent).toContain('Link sharing is on: anyone with the link can view this file.');
    expect(el.querySelector('select[aria-label="Link sharing role"]')).toBeNull();
  });
});
