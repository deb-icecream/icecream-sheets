// @vitest-environment jsdom
/**
 * Issue #112: one click from speaking to sent in the AI chat composer.
 * Renders the REAL AgentChat in jsdom with a mocked MediaRecorder +
 * getUserMedia and a fake transcribe fn. The transcript is slow by
 * construction (a deferred promise), so the test proves the click
 * arms a send that fires only when the final transcript lands.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import AgentChat from './AgentChat';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

/** Controllable MediaRecorder stand-in. */
class MockRecorder {
  static instances: MockRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    MockRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    // A chunk must exist or the final pass skips transcription.
    this.ondataavailable?.({ data: new Blob(['audio']) });
    queueMicrotask(() => this.onstop?.());
  }
}

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

function renderChat(transcribe: (arg: unknown) => Promise<string>) {
  const runtime = {
    chat: async (_thread: string, _prompt: string) => ({ message: 'reply ok' }),
  };
  act(() => {
    root!.render(
      h(AgentChat, {
        runtime: runtime as never,
        sheet: 'Sheet1',
        onClose: () => {},
        transcribe: transcribe as never,
        voiceCommand: null,
      }),
    );
  });
}

const mic = () => container!.querySelector('button[aria-label="Dictate a message"], button[aria-label="Stop dictation and send"]') as HTMLButtonElement;
const sendBtn = () =>
  Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLButtonElement;
const userMsgs = () => Array.from(container!.querySelectorAll('.ds-msg-user')).map((el) => el.textContent ?? '');
const draft = () => container!.querySelector('textarea[aria-label="Message the AI Agent"]') as HTMLTextAreaElement;

beforeEach(() => {
  if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function () {};
  }
  MockRecorder.instances = [];
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = MockRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    configurable: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe('#112 one-click dictation send', () => {
  it('SEND while recording stops and sends once the transcript lands', async () => {
    renderChat(async () => 'hello agent');
    act(() => mic().click());
    await flush();
    expect(mic().getAttribute('aria-label')).toBe('Stop dictation and send');
    expect(container!.textContent).toContain('Listening…');
    // Send is clickable mid-dictation even with an empty draft.
    expect(sendBtn().disabled).toBe(false);
    act(() => sendBtn().click());
    await flush();
    // Still recording-stopped/transcribing: nothing sent yet.
    expect(userMsgs()).toEqual([]);
    await flush();
    await flush();
    expect(userMsgs()).toContain('hello agent');
  });

  it('mic re-click while recording stops and sends', async () => {
    renderChat(async () => 'mic send works');
    act(() => mic().click());
    await flush();
    expect(mic().getAttribute('aria-label')).toBe('Stop dictation and send');
    act(() => mic().click());
    await flush();
    await flush();
    expect(userMsgs()).toContain('mic send works');
  });

  it('SEND while transcribing sends the transcript when it lands', async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((res) => {
      release = res;
    });
    renderChat(() => gate);
    act(() => mic().click());
    await flush();
    // Stop the recorder directly (no send armed): now transcribing.
    act(() => MockRecorder.instances[0]!.stop());
    await flush();
    expect(container!.textContent).toContain('Transcribing…');
    expect(sendBtn().disabled).toBe(false);
    act(() => sendBtn().click());
    await flush();
    expect(userMsgs()).toEqual([]);
    act(() => release('transcribed late'));
    await flush();
    await flush();
    expect(userMsgs()).toContain('transcribed late');
  });

  it('typed send is unchanged (no dictation)', async () => {
    renderChat(async () => 'unused');
    const ta = draft();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(ta, 'typed hello');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    act(() => sendBtn().click());
    await flush();
    expect(userMsgs()).toContain('typed hello');
  });

  it('plain stop-free path: dictation with no send still lands in the draft for review', async () => {
    renderChat(async () => 'just dictation');
    act(() => mic().click());
    await flush();
    act(() => MockRecorder.instances[0]!.stop());
    await flush();
    await flush();
    expect(draft().value).toBe('just dictation');
    expect(userMsgs()).toEqual([]);
  });
});
