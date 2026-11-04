/**
 * Dictation client for the voice command palette: sends one recorded
 * audio clip to the agent service's POST /api/agent/transcribe (through
 * the API gateway, like every agent call) and returns the transcript.
 *
 * Speech-to-text runs server-side on the cheapest Gemini on Vertex AI
 * (VERTEX_STT_MODEL — user ruling 2026-10-21); the browser never holds
 * GCP credentials. Offered wherever the transcribe route is reachable
 * for the current session (see dictationSupported); where it is not,
 * the palette offers typed input and OS dictation instead of a mic.
 */
import type { GatewayClient } from './gatewayClient';
import type { VoiceTranscribeFn } from '../components/VoiceCommandPalette';

/** The session-shape facts dictation availability depends on. */
export interface DictationSupportState {
  /** A gateway client exists (build carries VITE_GATEWAY_URL). */
  gatewayConfigured: boolean;
  /** The active engine host is the remote (gateway) host. */
  gatewayMode: boolean;
  /** Running inside the desktop shell. */
  desktop: boolean;
  /** The desktop shell is signed in (main holds a gateway JWT). */
  desktopSignedIn: boolean;
}

/**
 * Whether dictation can be offered for the CURRENT session state
 * (issue #54). The /transcribe route is reachable when the gateway is
 * configured AND the call will authenticate:
 * - gateway mode: the gateway client holds the session token (web), or
 *   the session runs through the desktop shell's bridge (signed-in
 *   desktop with a service file open);
 * - desktop with the LOCAL host active but the shell signed in: the
 *   renderer is tokenless, yet GatewayClient routes tokenless calls
 *   through the main-process bridge (callViaDesktopBridge), which
 *   attaches main's JWT — dictation works with a local file open too.
 * Signed-out desktop and gateway-less builds have no route: no mic.
 * This must be evaluated against live state (it changes on host swaps
 * and sign-in/out), never frozen at mount.
 */
export function dictationSupported(state: DictationSupportState): boolean {
  if (!state.gatewayConfigured) return false;
  if (state.gatewayMode) return true;
  return state.desktop && state.desktopSignedIn;
}

export function createGatewayTranscribe(client: GatewayClient): VoiceTranscribeFn {
  return async ({ dataBase64, mimeType }) => {
    const res = await client.call<{ text?: string }>(
      '/api/agent/transcribe',
      { method: 'POST' },
      { audioBase64: dataBase64, mimeType },
    );
    return res.text ?? '';
  };
}
