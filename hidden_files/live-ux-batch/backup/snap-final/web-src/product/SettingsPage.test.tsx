// @vitest-environment jsdom
/**
 * SettingsPage tests (workspace-settings brief + workspace-redesign
 * brief): a dedicated PAGE (back affordance, no panel chrome), two
 * sections, email read-only AND disabled, name save → settings API +
 * presence source, theme radios
 * → API + <html data-theme>, and the delete flow — ONE in-app
 * confirmation dialog (window.confirm/alert are spied and must NEVER
 * fire), cancel = nothing happens, confirm = server delete →
 * Firebase leg → sign-out; a failed Firebase leg shows the honest
 * result state instead of signing out silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { SettingsPage, type FirebaseDeleteOutcome } from './SettingsPage';
import type { ProductApi } from './productApi';
import {
  applyThemeChoice,
  effectiveDisplayName,
  setSessionProfile,
  setSessionSettings,
  type UserSettingsView,
} from './userSettings';

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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitForm(form: HTMLFormElement) {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  applyThemeChoice('system');
  setSessionSettings(null);
  setSessionProfile(null);
  vi.restoreAllMocks();
});

const BASE_VIEW: UserSettingsView = {
  hasRecord: true,
  displayName: 'Ada L.',
  email: 'ada@example.com',
  googleName: 'Ada Lovelace',
  theme: 'system',
};

function makePage(opts: {
  view?: UserSettingsView;
  firebaseOutcome?: FirebaseDeleteOutcome;
  deleteError?: Error;
} = {}) {
  const state = { view: opts.view ?? BASE_VIEW };
  const api = {
    getSettings: vi.fn(async () => state.view),
    updateSettings: vi.fn(
      async (patch: { displayName?: string | null; theme?: UserSettingsView['theme'] }) => {
        state.view = {
          ...state.view,
          hasRecord: true,
          displayName: patch.displayName !== undefined ? patch.displayName : state.view.displayName,
          theme: patch.theme ?? state.view.theme,
        };
        return state.view;
      },
    ),
    deleteAccount: vi.fn(async () => {
      if (opts.deleteError) throw opts.deleteError;
      return { deleted: { files: 2, settings: true } };
    }),
  };
  const onFirebaseDelete = vi.fn(
    async (): Promise<FirebaseDeleteOutcome> => opts.firebaseOutcome ?? 'deleted',
  );
  const onSignedOut = vi.fn();
  const onBack = vi.fn();
  const el = h(SettingsPage, {
    api: api as unknown as ProductApi,
    profileEmail: 'ada@example.com',
    profileName: 'Ada Lovelace',
    onFirebaseDelete,
    onSignedOut,
    onBack,
  });
  return { api, onFirebaseDelete, onSignedOut, onBack, el, state };
}

describe('SettingsPage', () => {
  it('is a page: a Back affordance returns to the workspace', async () => {
    const { el, onBack } = makePage();
    const c = setup(el);
    await flush();
    expect(c.querySelector('.ics-settings') ).toBeNull();
    expect(c.querySelector('.ics-settings-page')).toBeTruthy();
    const back = [...c.querySelectorAll('button')].find(
      (b) => b.textContent?.includes('Back to workspace'),
    ) as HTMLButtonElement;
    expect(back).toBeTruthy();
    click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders both sections; email is read-only AND disabled', async () => {
    const { el } = makePage();
    const c = setup(el);
    await flush();
    expect(c.textContent).toContain('User settings');
    expect(c.textContent).toContain('App settings — Icecream Office');
    expect(c.textContent).toContain('Delete my profile and data');
    const email = c.querySelector('#ics-settings-email') as HTMLInputElement;
    expect(email).toBeTruthy();
    expect(email.readOnly).toBe(true);
    expect(email.disabled).toBe(true);
    expect(email.classList.contains('ics-input-disabled')).toBe(true);
    expect(email.value).toBe('ada@example.com');
    expect(c.textContent).toContain('comes from your Google account');
    // The name field is editable and prefilled with the override.
    const name = c.querySelector('#ics-settings-name') as HTMLInputElement;
    expect(name.readOnly).toBe(false);
    expect(name.value).toBe('Ada L.');
    // Theme radios: System checked per the saved view.
    const radios = [...c.querySelectorAll('input[name="ics-office-theme"]')] as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['light', false],
      ['dark', false],
      ['system', true],
    ]);
  });

  it('saving a name writes through the API and becomes the presence name', async () => {
    const { el, api } = makePage();
    const c = setup(el);
    await flush();
    const name = c.querySelector('#ics-settings-name') as HTMLInputElement;
    setInputValue(name, 'Countess');
    submitForm(name.closest('form') as HTMLFormElement);
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ displayName: 'Countess' });
    expect(effectiveDisplayName()).toBe('Countess');
  });

  it('theme radio applies immediately and saves to the office scope', async () => {
    const { el, api } = makePage();
    const c = setup(el);
    await flush();
    const dark = c.querySelector(
      'input[name="ics-office-theme"][value="dark"]',
    ) as HTMLInputElement;
    click(dark);
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('delete: one in-app dialog, zero native dialogs; cancel deletes nothing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { el, api, onSignedOut } = makePage();
    const c = setup(el);
    await flush();
    const openBtn = [...c.querySelectorAll('button')].find(
      (b) => b.textContent === 'Delete my profile and data',
    ) as HTMLButtonElement;
    click(openBtn);
    await flush();
    const dialog = c.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain('cannot be undone');
    const cancel = [...dialog!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    click(cancel);
    await flush();
    expect(c.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('delete: confirm runs server delete → Firebase leg → sign-out, still zero native dialogs', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { el, api, onFirebaseDelete, onSignedOut } = makePage();
    const c = setup(el);
    await flush();
    click(
      [...c.querySelectorAll('button')].find(
        (b) => b.textContent === 'Delete my profile and data',
      ) as HTMLButtonElement,
    );
    await flush();
    const dialog = c.querySelector('[role="alertdialog"]') as HTMLElement;
    click(
      [...dialog.querySelectorAll('button')].find((b) =>
        b.textContent?.startsWith('Yes, delete'),
      ) as HTMLButtonElement,
    );
    await flush();
    expect(api.deleteAccount).toHaveBeenCalledTimes(1);
    expect(onFirebaseDelete).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('delete: a failed Firebase leg shows the honest result and waits for Continue', async () => {
    const { el, api, onSignedOut } = makePage({ firebaseOutcome: 'failed' });
    const c = setup(el);
    await flush();
    click(
      [...c.querySelectorAll('button')].find(
        (b) => b.textContent === 'Delete my profile and data',
      ) as HTMLButtonElement,
    );
    await flush();
    const dialog = c.querySelector('[role="alertdialog"]') as HTMLElement;
    click(
      [...dialog.querySelectorAll('button')].find((b) =>
        b.textContent?.startsWith('Yes, delete'),
      ) as HTMLButtonElement,
    );
    await flush();
    expect(api.deleteAccount).toHaveBeenCalledTimes(1);
    // Data is deleted, but the user is NOT signed out silently: the
    // result states the sign-in account remains, with one Continue.
    expect(onSignedOut).not.toHaveBeenCalled();
    const alert = [...c.querySelectorAll('[role="alert"]')].find((a) =>
      a.textContent?.includes('sign-in account itself could not be deleted'),
    );
    expect(alert).toBeTruthy();
    click(
      [...alert!.querySelectorAll('button')].find(
        (b) => b.textContent === 'Continue to sign out',
      ) as HTMLButtonElement,
    );
    await flush();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('delete: a server failure aborts the flow and keeps the user signed in', async () => {
    const { el, api, onFirebaseDelete, onSignedOut } = makePage({
      deleteError: new Error('account deletion unavailable'),
    });
    const c = setup(el);
    await flush();
    click(
      [...c.querySelectorAll('button')].find(
        (b) => b.textContent === 'Delete my profile and data',
      ) as HTMLButtonElement,
    );
    await flush();
    const dialog = c.querySelector('[role="alertdialog"]') as HTMLElement;
    click(
      [...dialog.querySelectorAll('button')].find((b) =>
        b.textContent?.startsWith('Yes, delete'),
      ) as HTMLButtonElement,
    );
    await flush();
    expect(api.deleteAccount).toHaveBeenCalledTimes(1);
    expect(onFirebaseDelete).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(c.querySelector('[role="alertdialog"]')).toBeNull();
    expect(c.textContent).toContain('Could not delete your data');
  });
});
