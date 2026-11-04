// @vitest-environment jsdom
/**
 * Request-access flow UI tests (GAP-11).
 *
 * The request/approve/deny logic itself runs against the real AccessTable +
 * SharingService (packages/service/tests/{access,sharing}.test.ts). These
 * tests render ShareDialog / RequestAccessDialog with a behavioral fake of
 * SharingService and verify the wiring: the request entry point for
 * non-managers, the pending queue with Approve/Deny for owners, and the
 * request form + withdraw for the requester.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type {
  AccessLevel,
  AccessRequestRow,
  GrantRow,
  ShareLevel,
  SharingService,
} from '@icecream-sheets/service';
import ShareDialog from './ShareDialog';
import RequestAccessDialog from './RequestAccessDialog';

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
  vi.restoreAllMocks();
});

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`button '${text}' not found`);
  return btn as HTMLButtonElement;
}

/** Behavioral stand-in for SharingService (no WebCrypto under jsdom). */
class FakeSharing {
  levels: Record<string, AccessLevel> = { 'user:owner': 'owner', 'user:viewer': 'viewer' };
  grantsRows: GrantRow[] = [
    {
      principal: 'user:owner',
      level: 'owner',
      objectId: 'workbook:wb',
      scope: 'Workbook',
      grantedBy: 'user:owner',
      grantedAt: '2026-10-18T00:00:00.000Z',
      isOwner: true,
    },
  ];
  requests: AccessRequestRow[] = [];

  grants(): GrantRow[] {
    return [...this.grantsRows];
  }
  pendingRequests(): AccessRequestRow[] {
    return [...this.requests];
  }
  canManage(p: string): boolean {
    const l = this.levels[p];
    return l === 'owner' || l === 'manager';
  }
  effectiveLevel(p: string): AccessLevel | null {
    return this.levels[p] ?? null;
  }
  async grant(user: string, level: ShareLevel, by: string): Promise<void> {
    if (!this.canManage(by)) throw new Error('lacks the manage right');
    this.levels[user] = level;
    this.grantsRows.push({
      principal: user,
      level,
      objectId: 'workbook:wb',
      scope: 'Workbook',
      grantedBy: by,
      grantedAt: new Date().toISOString(),
      isOwner: false,
    });
  }
  async revoke(user: string, by: string): Promise<void> {
    if (!this.canManage(by)) throw new Error('lacks the manage right');
    delete this.levels[user];
    this.grantsRows = this.grantsRows.filter((g) => g.principal !== user);
  }
  async transferOwnership(from: string, to: string): Promise<void> {
    if (this.levels[from] !== 'owner') throw new Error('owner-only');
    this.levels[from] = 'manager';
    this.levels[to] = 'owner';
  }
  async requestAccess(
    requester: string,
    opts?: { level?: ShareLevel; message?: string },
  ): Promise<string> {
    const id = `req-${this.requests.length + 1}`;
    this.requests.push({
      id,
      principal: requester,
      requestedLevel: opts?.level ?? 'viewer',
      message: opts?.message ?? '',
      scope: 'Workbook',
      requestedAt: new Date().toISOString(),
    });
    return id;
  }
  async approveRequest(id: string, by: string, level?: ShareLevel): Promise<void> {
    if (!this.canManage(by)) throw new Error('lacks the manage right');
    const i = this.requests.findIndex((r) => r.id === id);
    if (i < 0) throw new Error('unknown request');
    const [r] = this.requests.splice(i, 1);
    this.levels[r.principal] = level ?? r.requestedLevel;
  }
  async denyRequest(id: string, by: string): Promise<void> {
    if (!this.canManage(by)) throw new Error('lacks the manage right');
    const i = this.requests.findIndex((r) => r.id === id);
    if (i < 0) throw new Error('unknown request');
    this.requests.splice(i, 1);
  }
  async cancelRequest(id: string, p: string): Promise<void> {
    const r = this.requests.find((x) => x.id === id);
    if (!r) throw new Error('unknown request');
    if (r.principal !== p) throw new Error('not the requester');
    this.requests = this.requests.filter((x) => x.id !== id);
  }
}

function seedRequest(fake: FakeSharing, principal = 'user:applicant', level: ShareLevel = 'viewer') {
  fake.requests.push({
    id: `req-seed-${fake.requests.length + 1}`,
    principal,
    requestedLevel: level,
    message: 'need it for the close',
    scope: 'Workbook',
    requestedAt: '2026-10-18T10:00:00.000Z',
  });
}

describe('ShareDialog access-request flow', () => {
  it('owner sees the pending queue and can approve', async () => {
    const fake = new FakeSharing();
    seedRequest(fake);
    const el = setup(
      h(ShareDialog, {
        sharing: fake as unknown as SharingService,
        workbookName: 'Budget',
        principal: 'user:owner',
        onClose: () => {},
      }),
    );
    expect(el.textContent).toContain('Access requests (1 pending)');
    expect(el.textContent).toContain('user:applicant');
    expect(el.textContent).toContain('need it for the close');

    await act(async () => {
      buttonByText(el, 'Approve').click();
    });
    expect(el.textContent).not.toContain('Access requests');
    expect(fake.effectiveLevel('user:applicant')).toBe('viewer');
  });

  it('owner can deny a pending request', async () => {
    const fake = new FakeSharing();
    seedRequest(fake);
    const el = setup(
      h(ShareDialog, {
        sharing: fake as unknown as SharingService,
        workbookName: 'Budget',
        principal: 'user:owner',
        onClose: () => {},
      }),
    );
    await act(async () => {
      buttonByText(el, 'Deny').click();
    });
    expect(el.textContent).not.toContain('Access requests');
    expect(fake.effectiveLevel('user:applicant')).toBeNull();
  });

  it('non-manager gets the request-access entry point, not grant controls', async () => {
    const fake = new FakeSharing();
    const el = setup(
      h(ShareDialog, {
        sharing: fake as unknown as SharingService,
        workbookName: 'Budget',
        principal: 'user:viewer',
        onClose: () => {},
      }),
    );
    expect(el.textContent).not.toContain('Grant access');
    expect(el.textContent).toContain('Request access…');

    // Opening the request dialog renders the request form.
    act(() => {
      buttonByText(el, 'Request access…').click();
    });
    expect(el.textContent).toContain('Send request');

    await act(async () => {
      buttonByText(el, 'Send request').click();
    });
    expect(el.textContent).toContain('Request sent');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      principal: 'user:viewer',
      requestedLevel: 'viewer',
    });
  });
});

describe('RequestAccessDialog', () => {
  it('requester sees and can withdraw their pending request', async () => {
    const fake = new FakeSharing();
    seedRequest(fake, 'user:viewer', 'editor');
    const el = setup(
      h(RequestAccessDialog, {
        sharing: fake as unknown as SharingService,
        workbookName: 'Budget',
        principal: 'user:viewer',
        onClose: () => {},
      }),
    );
    expect(el.textContent).toContain('Your pending requests');
    expect(el.textContent).toContain('Withdraw');

    await act(async () => {
      buttonByText(el, 'Withdraw').click();
    });
    expect(fake.requests).toHaveLength(0);
    expect(el.textContent).not.toContain('Your pending requests');
  });
});
