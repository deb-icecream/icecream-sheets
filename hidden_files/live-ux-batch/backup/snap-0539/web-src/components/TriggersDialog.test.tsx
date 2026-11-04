// @vitest-environment jsdom
/**
 * TriggersDialog tests (Extensions > Triggers), mirroring
 * ScriptEditor.test.tsx: list rendering from a stub transport, the
 * grant flow, create submitting the contract payload, the enabled
 * toggle, and the no-transport honesty note.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import TriggersDialog from './TriggersDialog';
import type {
  TriggerListResult,
  TriggerStatus,
  TriggerTransport,
} from '../features/triggers';
import type { TriggerSpecInit } from '@icecream-sheets/service';

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
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

function makeTrigger(overrides: Partial<TriggerStatus> = {}): TriggerStatus {
  return {
    version: 1,
    id: 'trigger-1',
    name: 'Mark edits',
    event: 'onEdit',
    enabled: true,
    language: 'javascript',
    script: 'api.notify("hi");',
    permissions: [{ action: 'cell.write', target: 'Sheet1!10,0', reason: 'marker' }],
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    granted: false,
    lastRun: null,
    ...overrides,
  };
}

interface StubTransport extends TriggerTransport {
  created: TriggerSpecInit[];
  grantedIds: string[];
  enabledCalls: Array<{ id: string; enabled: boolean }>;
  removedIds: string[];
}

function stubTransport(initial: TriggerStatus[]): StubTransport {
  let triggers = [...initial];
  const stub: StubTransport = {
    created: [],
    grantedIds: [],
    enabledCalls: [],
    removedIds: [],
    async list(): Promise<TriggerListResult> {
      return {
        events: ['onOpen', 'onEdit', 'onInterval', 'onAtTime'],
        triggers: triggers.map((t) => ({ ...t })),
      };
    },
    async create(spec: TriggerSpecInit): Promise<TriggerStatus> {
      stub.created.push(spec);
      const t = makeTrigger({
        id: `trigger-${triggers.length + 1}`,
        name: spec.name,
        event: spec.event,
        script: spec.script ?? '',
        permissions: spec.permissions ?? [],
      });
      triggers = [...triggers, t];
      return t;
    },
    async remove(id: string): Promise<void> {
      stub.removedIds.push(id);
      triggers = triggers.filter((t) => t.id !== id);
    },
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      stub.enabledCalls.push({ id, enabled });
      triggers = triggers.map((t) => (t.id === id ? { ...t, enabled } : t));
    },
    async grant(id: string): Promise<void> {
      stub.grantedIds.push(id);
      triggers = triggers.map((t) => (t.id === id ? { ...t, granted: true } : t));
    },
  };
  return stub;
}

describe('TriggersDialog', () => {
  it('renders the list from a stub transport with grant state and last-run outcome', async () => {
    const transport = stubTransport([
      makeTrigger({ lastRun: { ok: false, error: 'Denied by policy: cell.write Sheet1!10,0', durationMs: 3 } }),
    ]);
    const el = setup(h(TriggersDialog, { transport, onClose: () => {} }));
    await flush();
    expect(el.textContent).toContain('Mark edits');
    expect(el.textContent).toContain('When a cell is edited');
    expect(el.textContent).toContain('been granted yet');
    expect(el.textContent).toContain('Last run failed: Denied by policy');
    expect(el.textContent).toContain('Never');
  });

  it('grant button calls grant and refreshes to the granted state', async () => {
    const transport = stubTransport([makeTrigger()]);
    const el = setup(h(TriggersDialog, { transport, onClose: () => {} }));
    await flush();
    const grantBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Grant permissions'),
    ) as HTMLButtonElement;
    expect(grantBtn).toBeTruthy();
    await act(async () => {
      grantBtn.click();
    });
    await flush();
    expect(transport.grantedIds).toEqual(['trigger-1']);
    expect(el.textContent).toContain('Permissions granted');
  });

  it('enable switch calls setEnabled; delete calls remove', async () => {
    const transport = stubTransport([makeTrigger({ granted: true })]);
    const el = setup(h(TriggersDialog, { transport, onClose: () => {} }));
    await flush();
    const toggle = el.querySelector('input[role="switch"]') as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
    await act(async () => {
      toggle.click();
    });
    await flush();
    expect(transport.enabledCalls).toEqual([{ id: 'trigger-1', enabled: false }]);
    await act(async () => {
      buttonByText(el, 'Delete').click();
    });
    await flush();
    expect(transport.removedIds).toEqual(['trigger-1']);
    expect(el.textContent).toContain('No triggers yet');
  });

  it('create submits the contract payload (event from capability list, interval → intervalMs)', async () => {
    const transport = stubTransport([]);
    const el = setup(h(TriggersDialog, { transport, onClose: () => {} }));
    await flush();
    // Event select offers ONLY the capability list's events.
    const eventSelect = el.querySelector('select[id$="-event"]') as HTMLSelectElement;
    expect(eventSelect).toBeTruthy();
    expect([...eventSelect.options].map((o) => o.value)).toEqual([
      'onOpen',
      'onEdit',
      'onInterval',
      'onAtTime',
    ]);
    const nameInput = el.querySelector('input[id$="-name"]') as HTMLInputElement;
    setValue(nameInput, 'Periodic refresh');
    setValue(eventSelect, 'onInterval');
    // Template prefilled in the sandbox shape for the chosen event.
    const scriptArea = el.querySelector('textarea[aria-label="Trigger script"]') as HTMLTextAreaElement;
    expect(scriptArea.value).toContain('api.setCell');
    expect(scriptArea.value).toContain('interval');
    const intervalInput = el.querySelector('input[id$="-interval"]') as HTMLInputElement;
    expect(intervalInput).toBeTruthy();
    setValue(intervalInput, '5');
    await act(async () => {
      buttonByText(el, 'Create trigger').click();
    });
    await flush();
    expect(transport.created).toHaveLength(1);
    const spec = transport.created[0]!;
    expect(spec.name).toBe('Periodic refresh');
    expect(spec.event).toBe('onInterval');
    expect(spec.intervalMs).toBe(5000);
    expect(spec.language).toBe('javascript');
    expect(spec.script).toContain('api.setCell');
    expect(spec.permissions).toContainEqual({
      action: 'cell.write',
      target: 'Sheet1!10,0',
      reason: 'Write the marker cell when the trigger fires',
    });
    // The new trigger shows in the refreshed list.
    expect(el.textContent).toContain('Periodic refresh');
  });

  it('shows the honest hosted-session note when there is no transport', async () => {
    const el = setup(h(TriggersDialog, { transport: null, onClose: () => {} }));
    await flush();
    expect(el.querySelector('[data-testid="triggers-no-transport"]')).toBeTruthy();
    expect(el.textContent).toContain('Triggers need a hosted session');
  });

  it('uses the shared A11yDialog shell: role=dialog, Escape closes', async () => {
    let closed = false;
    const el = setup(
      h(TriggersDialog, { transport: stubTransport([]), onClose: () => void (closed = true) }),
    );
    await flush();
    const dialog = el.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closed).toBe(true);
  });
});
