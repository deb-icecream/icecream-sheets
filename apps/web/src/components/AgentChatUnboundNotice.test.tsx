// @vitest-environment jsdom
/**
 * Agent-panel binding: when a workbook is open in the grid but the
 * runtime would send a turn with no bound file, the panel says so
 * truthfully instead of letting the service refuse as "no active
 * workbook connection" while the user looks at an open workbook.
 * The turn is not sent. Genuine no-file chats (workbookOpen false)
 * and bound turns are unaffected.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import AgentChat from './AgentChat';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

// jsdom has no Element.scrollTo (AgentChat autoscrolls on new messages).
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {};
}

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

function mockRuntime(boundFileId: string | null, chatStream: ReturnType<typeof vi.fn>) {
  return {
    chat: async () => ({ message: 'reply ok' }),
    answer: async () => ({ message: 'reply ok' }),
    chatStream,
    getAuditLog: () => [],
    watch: async () => 'sub',
    unwatch: async () => {},
    pollWatch: async () => [],
    close: async () => {},
    getBoundFileId: () => boundFileId,
  };
}

function renderChat(workbookOpen: boolean, runtime: ReturnType<typeof mockRuntime>) {
  act(() => {
    root!.render(
      h(AgentChat, {
        runtime: runtime as never,
        sheet: 'Sheet1',
        onClose: () => {},
        workbookOpen,
        transcribe: null,
        voiceCommand: null,
      }),
    );
  });
}

async function sendText(text: string) {
  const ta = container!.querySelector(
    'textarea[aria-label="Message the AI Agent"]',
  ) as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
  const btn = Array.from(container!.querySelectorAll('button')).find(
    (b) => b.textContent === 'Send',
  ) as HTMLButtonElement;
  act(() => btn.click());
  await flush();
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  container = null;
  root = null;
});

describe('unbound-workbook notice', () => {
  it('shows the notice and does not send when open but unbound', async () => {
    const chatStream = vi.fn(async () => ({ message: 'should not happen' }));
    renderChat(true, mockRuntime(null, chatStream));
    await sendText('put 10 in A1');
    expect(chatStream).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("isn't connected to a server session");
  });

  it('sends normally when no workbook is open (genuine no-file)', async () => {
    const chatStream = vi.fn(async () => ({ message: 'reply ok' }));
    renderChat(false, mockRuntime(null, chatStream));
    await sendText('put 10 in A1');
    expect(chatStream).toHaveBeenCalled();
    expect(container!.textContent).not.toContain("isn't connected to a server session");
  });

  it('sends normally when bound, even with a workbook open', async () => {
    const chatStream = vi.fn(async () => ({ message: 'reply ok' }));
    renderChat(true, mockRuntime('file-abc', chatStream));
    await sendText('put 10 in A1');
    expect(chatStream).toHaveBeenCalled();
    expect(container!.textContent).not.toContain("isn't connected to a server session");
  });
});
