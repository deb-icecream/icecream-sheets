/**
 * Issue #54: dictation availability follows the CURRENT session state.
 * The composer mic was gated on a mount-once isGatewayMode() check, so
 * it never appeared on desktop (which always boots on the local IPC
 * host) even after sign-in. These tests pin the availability matrix
 * the App wiring evaluates live on host swaps and auth transitions.
 */
import { describe, expect, it } from 'vitest';
import { createGatewayTranscribe, dictationSupported } from './voiceTranscribe';
import type { GatewayClient } from './gatewayClient';

describe('dictationSupported (issue #54)', () => {
  it('web gateway session: supported', () => {
    expect(
      dictationSupported({
        gatewayConfigured: true,
        gatewayMode: true,
        desktop: false,
        desktopSignedIn: false,
      }),
    ).toBe(true);
  });

  it('web local session (no gateway host): not supported', () => {
    expect(
      dictationSupported({
        gatewayConfigured: true,
        gatewayMode: false,
        desktop: false,
        desktopSignedIn: false,
      }),
    ).toBe(false);
  });

  it('desktop signed in with a LOCAL file open (IPC host): supported via the shell bridge', () => {
    expect(
      dictationSupported({
        gatewayConfigured: true,
        gatewayMode: false,
        desktop: true,
        desktopSignedIn: true,
      }),
    ).toBe(true);
  });

  it('desktop signed in with a service file open (gateway host): supported', () => {
    expect(
      dictationSupported({
        gatewayConfigured: true,
        gatewayMode: true,
        desktop: true,
        desktopSignedIn: true,
      }),
    ).toBe(true);
  });

  it('desktop signed OUT: not supported (no route — the bridge fails closed)', () => {
    expect(
      dictationSupported({
        gatewayConfigured: true,
        gatewayMode: false,
        desktop: true,
        desktopSignedIn: false,
      }),
    ).toBe(false);
  });

  it('gateway not configured in the build: never supported', () => {
    expect(
      dictationSupported({
        gatewayConfigured: false,
        gatewayMode: true,
        desktop: true,
        desktopSignedIn: true,
      }),
    ).toBe(false);
    expect(
      dictationSupported({
        gatewayConfigured: false,
        gatewayMode: false,
        desktop: false,
        desktopSignedIn: false,
      }),
    ).toBe(false);
  });
});

describe('createGatewayTranscribe', () => {
  it('posts the clip to /api/agent/transcribe and returns the text', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const stub = {
      call: async (path: string, _init: unknown, body: unknown) => {
        calls.push({ path, body });
        return { text: 'hello sheet' };
      },
    } as unknown as GatewayClient;
    const transcribe = createGatewayTranscribe(stub);
    const text = await transcribe({ dataBase64: 'AAAA', mimeType: 'audio/webm' });
    expect(text).toBe('hello sheet');
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/agent/transcribe');
    expect(calls[0].body).toEqual({ audioBase64: 'AAAA', mimeType: 'audio/webm' });
  });
});
