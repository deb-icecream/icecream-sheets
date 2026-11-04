/**
 * Dictation client for the voice command palette: sends one recorded
 * audio clip to the agent service's POST /api/agent/transcribe (through
 * the API gateway, like every agent call) and returns the transcript.
 *
 * Speech-to-text runs server-side on the cheapest Gemini on Vertex AI
 * (VERTEX_STT_MODEL — user ruling 2026-10-21); the browser never holds
 * GCP credentials. Available only in gateway sessions — local/desktop
 * modes have no service route, and the palette offers typed input and
 * OS dictation there instead of a mic button.
 */
import type { GatewayClient } from './gatewayClient';
import type { VoiceTranscribeFn } from '../components/VoiceCommandPalette';

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
