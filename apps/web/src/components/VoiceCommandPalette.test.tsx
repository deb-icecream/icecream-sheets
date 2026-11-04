// @vitest-environment jsdom
/**
 * Voice command palette component tests (Pro-tier feature).
 *
 * The CONFIRM GATE is the hard rule under test: typing, matching,
 * previewing, and picking alternates must NEVER call an MCP tool —
 * exactly one call happens, with the shown arguments, only when the
 * user clicks Run. Also pinned: the Default-tier gate renders a
 * labeled Pro-only state (no input at all), the hosted-session (v1)
 * execution boundary disables Run, and read results render in-dialog.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { McpCallFn } from '@icecream-sheets/service';
import VoiceCommandPalette from './VoiceCommandPalette';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(props: Partial<Parameters<typeof VoiceCommandPalette>[0]>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const full = {
    sheet: 'Sheet1',
    selection: { row: 4, col: 2 },
    tier: 'pro' as const,
    mcpCall: null,
    ready: true,
    onClose: () => undefined,
    ...props,
  };
  act(() => {
    root?.render(h(VoiceCommandPalette, full));
  });
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

const byTestId = (id: string) => container!.querySelector(`[data-testid="${id}"]`);

describe('VoiceCommandPalette — confirm gate', () => {
  it('never calls a tool while typing/previewing; Run executes exactly the shown match once', async () => {
    const mcpCall = vi.fn(async () => ({ written: 1, errors: [] })) as unknown as McpCallFn;
    render({ mcpCall });
    const input = byTestId('voice-input') as HTMLInputElement;
    expect(input).not.toBeNull();

    setInputValue(input, 'some if b2 to b20 greater than 10');
    // Preview shows the interpreted match...
    expect(byTestId('voice-match-name')?.textContent).toBe('SUMIF');
    expect(byTestId('voice-action')?.textContent).toContain('Sheet1!C5');
    const formulaEdit = byTestId('voice-formula-edit') as HTMLInputElement;
    expect(formulaEdit.value).toBe('=SUMIF(B2:B20, ">10")');
    // ...and NO tool call has happened.
    expect(mcpCall).not.toHaveBeenCalled();

    const runBtn = byTestId('voice-run') as HTMLButtonElement;
    expect(runBtn.disabled).toBe(false);
    await act(async () => {
      runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(mcpCall).toHaveBeenCalledTimes(1);
    expect(mcpCall).toHaveBeenCalledWith('set_formulas', {
      formulas: [{ sheet: 'Sheet1', row: 4, col: 2, formula: '=SUMIF(B2:B20, ">10")' }],
      principal: 'web-user',
    });
    expect(byTestId('voice-result')?.textContent).toContain('Done');
  });

  it('read commands render the returned values in the palette', async () => {
    const mcpCall = vi.fn(async () => ({
      cells: [
        [{ kind: 'number', value: 7 }],
        [{ kind: 'number', value: 8 }],
      ],
    })) as unknown as McpCallFn;
    render({ mcpCall });
    const input = byTestId('voice-input') as HTMLInputElement;
    setInputValue(input, 'read b2 to b3');
    expect(mcpCall).not.toHaveBeenCalled();
    const runBtn = byTestId('voice-run') as HTMLButtonElement;
    await act(async () => {
      runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(mcpCall).toHaveBeenCalledWith(
      'read_cells',
      expect.objectContaining({ startRow: 1, endRow: 2 }),
    );
    const table = byTestId('voice-read-result');
    expect(table?.textContent).toContain('7');
    expect(table?.textContent).toContain('8');
  });
});

/** Minimal MediaRecorder stand-in: start() emits a chunk, stop() ends. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) });
    }, 5);
  }
  stop() {
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['tail'], { type: 'audio/webm' }) });
      this.onstop?.();
    }, 5);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('VoiceCommandPalette — live transcript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  function stubMedia() {
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }),
      },
    });
  }

  async function startMic() {
    const mic = byTestId('voice-mic') as HTMLButtonElement;
    expect(mic).not.toBeNull();
    await act(async () => {
      mic.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await sleep(30);
    });
  }

  async function letPollsRun(ms: number) {
    await act(async () => {
      await sleep(ms);
    });
  }

  it('words appear live while dictating (panel + input mirror), and dictation alone never executes', async () => {
    stubMedia();
    const heard = ['vee', 'vee look up', 'vee look up in the table'];
    let calls = 0;
    let firstMime: string | null = null;
    const transcribe = vi.fn(async (clip: { dataBase64: string; mimeType: string }) => {
      if (firstMime === null) firstMime = clip.mimeType;
      return heard[Math.min(calls++, heard.length - 1)];
    });
    const mcpCall = vi.fn(async () => ({ written: 1, errors: [] })) as unknown as McpCallFn;
    render({ mcpCall, transcribe, livePollMs: 25 });

    await startMic();
    await letPollsRun(220);
    // The interim transcript is visible in the live panel AND mirrored
    // into the command input as it arrives.
    expect(byTestId('voice-live')).not.toBeNull();
    expect(byTestId('voice-live-text')?.textContent).toBe('vee look up in the table');
    expect((byTestId('voice-input') as HTMLInputElement).value).toBe('vee look up in the table');
    // The codec parameter was stripped before hitting the STT route.
    expect(firstMime).toBe('audio/webm');
    // Hearing a command is not confirming it: no tool call.
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('a mid-dictation correction wins over later transcripts; the corrected text is what Run executes', async () => {
    stubMedia();
    // The recognizer keeps hearing the WRONG function.
    const transcribe = vi.fn(async () => 'some product b two to b twenty');
    const mcpCall = vi.fn(async () => ({ written: 1, errors: [] })) as unknown as McpCallFn;
    render({ mcpCall, transcribe, livePollMs: 25 });

    await startMic();
    await letPollsRun(160);
    const input = byTestId('voice-input') as HTMLInputElement;
    expect(input.value).toBe('some product b two to b twenty');
    expect(byTestId('voice-match-name')?.textContent).toBe('SUMPRODUCT');

    // "No, that's not what I said" — the user corrects the text.
    setInputValue(input, 'some if b two to b twenty greater than ten');
    await letPollsRun(160);
    // Later polls still show what was HEARD in the live panel, but the
    // corrected input is never overwritten, and the match follows it.
    expect(byTestId('voice-live-text')?.textContent).toBe('some product b two to b twenty');
    expect(input.value).toBe('some if b two to b twenty greater than ten');
    expect(byTestId('voice-match-name')?.textContent).toBe('SUMIF');
    expect(mcpCall).not.toHaveBeenCalled();

    // Stop dictation: the final pass (still hearing it wrong) must not
    // clobber the correction either.
    await act(async () => {
      (byTestId('voice-mic') as HTMLButtonElement).dispatchEvent(
        new window.MouseEvent('click', { bubbles: true }),
      );
    });
    await letPollsRun(120);
    expect(input.value).toBe('some if b two to b twenty greater than ten');

    const runBtn = byTestId('voice-run') as HTMLButtonElement;
    await act(async () => {
      runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(mcpCall).toHaveBeenCalledTimes(1);
    expect(mcpCall).toHaveBeenCalledWith('set_formulas', {
      formulas: [{ sheet: 'Sheet1', row: 4, col: 2, formula: '=SUMIF(B2:B20, ">10")' }],
      principal: 'web-user',
    });
  });
});

describe('VoiceCommandPalette — tier gate and boundaries', () => {
  it('Default tier renders the labeled Pro-only gate with no input and no execution path', () => {
    const mcpCall = vi.fn(async () => ({})) as unknown as McpCallFn;
    render({ tier: 'default', mcpCall });
    expect(byTestId('voice-gate')).not.toBeNull();
    expect(byTestId('voice-gate')?.textContent).toContain('Pro feature');
    expect(byTestId('voice-gate')?.textContent).toContain('Default tier');
    expect(byTestId('voice-input')).toBeNull();
    expect(byTestId('voice-run')).toBeNull();
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('standalone tier (no gateway session) is not gated', () => {
    render({ tier: 'standalone', mcpCall: vi.fn(async () => ({})) as unknown as McpCallFn });
    expect(byTestId('voice-gate')).toBeNull();
    expect(byTestId('voice-input')).not.toBeNull();
  });

  it('hosted-session boundary (no MCP caller) disables Run and says why', () => {
    render({ mcpCall: null });
    const input = byTestId('voice-input') as HTMLInputElement;
    setInputValue(input, 'sum of column b');
    expect(byTestId('voice-match-name')?.textContent).toBe('SUM');
    expect(byTestId('voice-boundary')?.textContent).toContain('hosted sessions');
    expect((byTestId('voice-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('gibberish shows the no-match state and Run stays disabled', () => {
    const mcpCall = vi.fn(async () => ({})) as unknown as McpCallFn;
    render({ mcpCall });
    const input = byTestId('voice-input') as HTMLInputElement;
    setInputValue(input, 'flurbo zanz quix');
    expect(byTestId('voice-nomatch')).not.toBeNull();
    expect((byTestId('voice-run') as HTMLButtonElement).disabled).toBe(true);
    click(byTestId('voice-run')!);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('#41 handoff: no match offers "Ask the agent instead" with the words', () => {
    const onAskAgent = vi.fn();
    render({ mcpCall: vi.fn(async () => ({})) as unknown as McpCallFn, onAskAgent });
    const input = byTestId('voice-input') as HTMLInputElement;
    setInputValue(input, 'highlight the top three rows');
    expect(byTestId('voice-nomatch')).not.toBeNull();
    const btn = byTestId('voice-ask-agent');
    expect(btn).not.toBeNull();
    click(btn!);
    expect(onAskAgent).toHaveBeenCalledWith('highlight the top three rows');
  });

  it('#41 handoff: a low-confidence match offers the agent alongside', () => {
    const onAskAgent = vi.fn();
    render({ mcpCall: vi.fn(async () => ({})) as unknown as McpCallFn, onAskAgent });
    const input = byTestId('voice-input') as HTMLInputElement;
    // A real but weak fuzzy match (MAX at 0.80, below the 0.85 bar).
    setInputValue(input, 'maxx of column b');
    expect(byTestId('voice-preview')).not.toBeNull();
    expect(byTestId('voice-ask-agent')).not.toBeNull();
  });

  it('#41: a confident match does NOT offer the handoff', () => {
    const onAskAgent = vi.fn();
    render({ mcpCall: vi.fn(async () => ({})) as unknown as McpCallFn, onAskAgent });
    const input = byTestId('voice-input') as HTMLInputElement;
    setInputValue(input, 'sum of column b');
    expect(byTestId('voice-match-name')?.textContent).toBe('SUM');
    expect(byTestId('voice-ask-agent')).toBeNull();
  });
});
