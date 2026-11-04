// @vitest-environment jsdom
/**
 * FirebaseLoginButton UI wiring tests (Cycle 9, Phase 1 — web login).
 *
 * Drives a real FirebaseAuthService backed by a fake FirebasePort and
 * asserts the header button renders the right thing per auth state and
 * wires clicks to the service's signInWithGoogle/signOut.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { FirebaseLoginButton } from './FirebaseLoginButton';
import { FirebaseAuthService } from '../services/firebaseAuth';
import type { FirebasePort, PortUser } from '../services/firebasePort';

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

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function fakeUser(): PortUser {
  return {
    uid: 'uid-9',
    email: 'deb@example.com',
    displayName: 'Deb',
    photoURL: null,
    getIdToken: () => Promise.resolve('id-token'),
  };
}

class FakePort implements FirebasePort {
  popup: PortUser | { code: string; message: string } = fakeUser();
  signInCalls = 0;
  signOutCalls = 0;
  isConfigured() {
    return true;
  }
  configError() {
    return null;
  }
  async signInWithGooglePopup(): Promise<PortUser> {
    this.signInCalls++;
    if ('code' in this.popup) {
      const e = new Error(this.popup.message) as Error & { code: string };
      e.code = this.popup.code;
      throw e;
    }
    return this.popup;
  }
  async signOut(): Promise<void> {
    this.signOutCalls++;
  }
  async deleteCurrentUser(): Promise<void> {}
  async reauthenticateCurrentUserWithGoogle(): Promise<void> {}
  getCurrentUser(): PortUser | null {
    return null;
  }
  onAuthStateChanged(): () => void {
    return () => {};
  }
}

function makeService(port: FakePort) {
  const exchange = {
    loginWithFirebaseIdToken: vi.fn((): Promise<void> => Promise.resolve()),
    logout: vi.fn(),
  };
  const svc = new FirebaseAuthService(port, exchange);
  return { svc, port, exchange };
}

describe('FirebaseLoginButton', () => {
  it('logged-out → shows "Sign in with Google"; click starts the service sign-in', async () => {
    const { svc, port } = makeService(new FakePort());
    const el = setup(h(FirebaseLoginButton, { auth: svc }));
    const btn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Sign in with Google'),
    );
    expect(btn).toBeTruthy();
    click(btn!);
    await act(async () => {
      await svc.signInWithGoogle();
    });
    expect(port.signInCalls).toBeGreaterThan(0);
  });

  it('logged-in → shows avatar/name and a Sign out button; click signs out', async () => {
    const { svc, port, exchange } = makeService(new FakePort());
    const el = setup(h(FirebaseLoginButton, { auth: svc }));
    await act(async () => {
      await svc.signInWithGoogle();
    });
    expect(svc.current.status).toBe('logged-in');
    // Name shown, sign-in button gone.
    expect(el.textContent).toContain('Deb');
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Sign in with Google')),
    ).toBe(false);
    const signOutBtn = [...el.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label') === 'Sign out',
    );
    expect(signOutBtn).toBeTruthy();
    click(signOutBtn!);
    await act(async () => {
      await svc.signOut();
    });
    expect(port.signOutCalls).toBeGreaterThan(0);
    expect(exchange.logout).toHaveBeenCalled();
    expect(svc.current.status).toBe('logged-out');
    // Back to the sign-in button.
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Sign in with Google')),
    ).toBe(true);
  });

  it('renders the photo avatar when the user has a photoURL', async () => {
    const port = new FakePort();
    port.popup = { ...fakeUser(), photoURL: 'https://example.com/me.png' };
    const { svc } = makeService(port);
    const el = setup(h(FirebaseLoginButton, { auth: svc }));
    await act(async () => {
      await svc.signInWithGoogle();
    });
    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/me.png');
  });

  it('error state → shows the message and a Try again button that retries', async () => {
    const port = new FakePort();
    port.popup = { code: 'auth/popup-blocked', message: 'blocked' };
    const { svc } = makeService(port);
    const el = setup(h(FirebaseLoginButton, { auth: svc }));
    await act(async () => {
      await svc.signInWithGoogle();
    });
    expect(svc.current.status).toBe('error');
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/popup/i);
    const retry = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Try again'),
    );
    expect(retry).toBeTruthy();
    // Fix the popup and retry through the UI.
    port.popup = fakeUser();
    click(retry!);
    // Wait for the service to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(svc.current.status).toBe('logged-in');
    expect(el.textContent).toContain('Deb');
  });
});
