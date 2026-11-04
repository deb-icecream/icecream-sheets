/**
 * Speech-to-text for the voice command palette's built-in dictation.
 *
 * USER RULING (2026-10-21): the palette's dictation uses the CHEAPEST
 * Gemini voice-to-text route on Vertex AI. Gemini models are multimodal
 * — the cheapest Gemini (gemini-2.5-flash-lite, the same model as
 * VERTEX_DEFAULT_MODEL) accepts audio input directly through
 * generateContent, so dictation needs no separate speech API and no
 * pricier model. If 2.5-flash-lite is ever shut down, bump
 * VERTEX_STT_MODEL (3.1-flash-lite is the successor pick) exactly like
 * VERTEX_DEFAULT_MODEL.
 *
 * This module is browser-safe (fetch only, no node builtins), mirroring
 * llm.ts: credentials arrive through the injected getAccessToken
 * callback — the service boundary wires it to the credential vault /
 * service-account token source; nothing is hardcoded here.
 */

import { VERTEX_DEFAULT_LOCATION, vertexAiHost } from './llm.js';

/**
 * Cheapest Gemini on Vertex AI — the dictation model. Config seam:
 * override per deployment via VertexTranscriberOptions.model (or the
 * VERTEX_STT_MODEL environment variable where the host wires one).
 */
export const VERTEX_STT_MODEL = 'gemini-3.1-flash-lite'; // 2026-10-22: 2.5-flash-lite retired; successor pick per module comment

export interface AudioClip {
  /** Base64-encoded audio bytes (no data: prefix). */
  dataBase64: string;
  /** IANA mime type, e.g. 'audio/webm', 'audio/wav', 'audio/mp3'. */
  mimeType: string;
}

export interface Transcriber {
  readonly name: string;
  readonly modelId: string;
  /** Transcribe one clip; resolves to the raw transcript text. */
  transcribe(clip: AudioClip): Promise<string>;
}

export interface VertexTranscriberOptions {
  /** GCP project id. */
  project: string;
  /** Vertex AI location. Defaults to VERTEX_DEFAULT_LOCATION ('global'). */
  location?: string;
  /** Model id. Defaults to VERTEX_STT_MODEL (cheapest Gemini). */
  model?: string;
  /** Resolve a GCP OAuth2 access token (vault-wired by the host). */
  getAccessToken: () => Promise<string | null>;
  /** fetch implementation (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

const TRANSCRIBE_INSTRUCTION =
  'Transcribe this audio exactly as spoken. Return only the transcript ' +
  'text — no commentary, no quotes, no punctuation repairs beyond what ' +
  'was said. The speaker is dictating spreadsheet commands and function ' +
  'names, so keep words like "sum if" or "vee look up" exactly as heard.';

/** Production dictation backend: Vertex AI generateContent with audio input. */
export class VertexTranscriber implements Transcriber {
  readonly name = 'vertex-ai-stt';
  private readonly project: string;
  private readonly location: string;
  private readonly model: string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VertexTranscriberOptions) {
    if (!opts.project || opts.project.trim() === '') {
      throw new Error('VertexTranscriber requires a GCP project id.');
    }
    this.project = opts.project;
    this.location = opts.location ?? VERTEX_DEFAULT_LOCATION;
    this.model = opts.model ?? VERTEX_STT_MODEL;
    this.getAccessToken = opts.getAccessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get modelId(): string {
    return this.model;
  }

  async transcribe(clip: AudioClip): Promise<string> {
    if (!clip.dataBase64 || clip.dataBase64.length === 0) {
      throw new Error('transcribe: empty audio clip');
    }
    if (!clip.mimeType || !clip.mimeType.startsWith('audio/')) {
      throw new Error(`transcribe: unsupported mime type "${clip.mimeType}" (expected audio/*)`);
    }
    const token = await this.getAccessToken().catch(() => null);
    if (!token) {
      throw new Error(
        'Vertex AI credentials are not configured: no GCP access token is available. ' +
          'Wire getAccessToken to the service credential source (locally: ' +
          'GOOGLE_APPLICATION_CREDENTIALS + GCP_PROJECT_ID). Dictation is ' +
          'unavailable until then.',
      );
    }
    const url =
      `https://${vertexAiHost(this.location)}/v1/` +
      `projects/${this.project}/locations/${this.location}/` +
      `publishers/google/models/${this.model}:generateContent`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: clip.mimeType, data: clip.dataBase64 } },
                { text: TRANSCRIBE_INSTRUCTION },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 1024 },
        }),
      });
    } catch (e) {
      throw new Error(`Vertex AI request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Vertex AI error ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text =
      json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return text.trim();
  }
}

/**
 * Test-mode transcriber: returns a canned transcript and records clips.
 * No network, no credentials — structurally incapable of calling Vertex,
 * mirroring TestCodeGenBackend in llm.ts.
 */
export class TestTranscriber implements Transcriber {
  readonly name = 'test';
  readonly modelId = 'test';
  readonly clips: AudioClip[] = [];

  constructor(private readonly canned: string = 'some if b2 to b20 greater than 10') {}

  async transcribe(clip: AudioClip): Promise<string> {
    this.clips.push(clip);
    return this.canned;
  }
}
