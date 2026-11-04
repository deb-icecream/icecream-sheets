/**
 * Service-layer host wiring for the Google-connector formula functions
 * (design-docs/connector-vs-component.md: "GOOGLEFINANCE, GOOGLETRANSLATE,
 * DETECTLANGUAGE and IMPORTRANGE use Google connectors"; auth: "OAuth2 /
 * API key via vault credentialRef").
 *
 * Cycle-3 GAP-1: the engine exposes pluggable seams
 * (setTranslatorProvider, setLanguageDetectorProvider, setGoogleApiCredential
 * from @icecream-sheets/engine) but no host code called them — TRANSLATE
 * silently fell back to the bundled phrasebook, DETECTLANGUAGE to the
 * heuristic, IMPORTRANGE to #N/A. This module is the host: it resolves the
 * Google credential from the vault (via an injected resolver — the secret
 * value never touches workbook bytes, the spec, or logs) and wires it into
 * the engine seams.
 *
 * - Credential present  → TRANSLATE/DETECTLANGUAGE use the Google Cloud
 *   Translation v2 API; IMPORTRANGE uses the Sheets API v4 credential.
 * - Credential absent    → the engine's built-in fallbacks stay active
 *   (phrasebook / heuristic / honest #N/A). The returned
 *   GoogleFormulaSeamStatus documents which mode each function is in, so the
 *   fallback is never silent.
 *
 * The providers are synchronous because the engine's interpreter is
 * synchronous: the default fetch delegates to the engine's own
 * fetchUrlText (curl under Node, host-injectable elsewhere). OAuth2 tokens
 * travel as the `access_token` query parameter — the same pattern the
 * engine's IMPORTRANGE fetch uses (google-functions.ts) — so one code path
 * serves both auth modes with no Node-only imports (this module stays
 * browser-safe like the rest of the service entrypoint).
 *
 * GOOGLEFINANCE is intentionally untouched: its Stooq default is
 * design-sanctioned.
 */
import {
  fetchUrlText,
  setGoogleApiCredential,
  setLanguageDetectorProvider,
  setTranslatorProvider,
  type GoogleApiCredential,
  type LanguageDetectorProvider,
  type TranslatorProvider,
} from '@icecream-sheets/engine';

/** Vault credentialRef naming the shared Google connector credential. */
export const DEFAULT_GOOGLE_CREDENTIAL_REF = 'google';

/** How the vault secret authenticates against Google APIs. */
export type GoogleAuthMode = 'apikey' | 'oauth2';

/** Synchronous text fetch (the engine calls providers synchronously). */
export type GoogleSyncFetch = (url: string) => string;

/** Cap on Google API response text per call (network data is untrusted). */
export const GOOGLE_API_MAX_TEXT = 1_000_000;

const TRANSLATE_V2_BASE = 'https://translation.googleapis.com/language/translate/v2';

function authParams(cred: GoogleApiCredential): Record<string, string> {
  if (cred.apiKey) return { key: cred.apiKey };
  if (cred.accessToken) return { access_token: cred.accessToken };
  return {};
}

function buildUrl(path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params);
  return `${TRANSLATE_V2_BASE}${path}?${qs.toString()}`;
}

/** Google Cloud Translation HTML-escapes translatedText; decode entities. */
export function decodeTranslateEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/**
 * Google Cloud Translation v2 as an engine TranslatorProvider.
 * Returns the translated text, or null when unavailable — the engine then
 * surfaces an honest #N/A ("No translation available for this phrase.")
 * instead of a fabricated translation. Never throws.
 */
export function makeGoogleCloudTranslator(
  cred: GoogleApiCredential,
  fetchText: GoogleSyncFetch = fetchUrlText,
): TranslatorProvider {
  return {
    translate(text: string, source: string | null, target: string): string | null {
      try {
        if (!text.trim()) return null;
        const params: Record<string, string> = {
          q: text,
          target: (target || 'en').toLowerCase(),
          ...authParams(cred),
        };
        if (source) params.source = source.toLowerCase();
        const doc = parseJson(fetchText(buildUrl('', params))) as {
          data?: { translations?: Array<{ translatedText?: unknown }> };
          error?: { message?: unknown };
        };
        if (doc?.error) return null;
        const t = doc?.data?.translations?.[0]?.translatedText;
        return typeof t === 'string' ? decodeTranslateEntities(t) : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Google Cloud Translation v2 language detection as an engine
 * LanguageDetectorProvider. Returns the ISO 639-1 code, or null when
 * unknown — the engine then reports 'und'. Never throws.
 */
export function makeGoogleCloudLanguageDetector(
  cred: GoogleApiCredential,
  fetchText: GoogleSyncFetch = fetchUrlText,
): LanguageDetectorProvider {
  return {
    detect(text: string): string | null {
      try {
        if (!text.trim()) return null;
        const params: Record<string, string> = { q: text, ...authParams(cred) };
        const doc = parseJson(fetchText(buildUrl('/detect', params))) as {
          data?: { detections?: Array<Array<{ language?: unknown }>> };
          error?: { message?: unknown };
        };
        if (doc?.error) return null;
        const lang = doc?.data?.detections?.[0]?.[0]?.language;
        return typeof lang === 'string' && lang !== '' ? lang.toLowerCase() : null;
      } catch {
        return null;
      }
    },
  };
}

export interface GoogleFormulaSeamsOptions {
  /**
   * Vault credentialRef for the Google connector credential.
   * Default: 'google' (DEFAULT_GOOGLE_CREDENTIAL_REF).
   */
  credentialRef?: string;
  /** 'apikey' (default) → key= param; 'oauth2' → access_token= param. */
  auth?: GoogleAuthMode;
  /**
   * Resolve the vault secret for `credentialRef`. Return the secret string,
   * or null when the vault holds no Google credential. A throwing resolver
   * fails closed: the seams are left on their honest fallbacks.
   * When omitted, no credential is resolved (fallbacks stay active).
   */
  resolveCredential?: (ref: string) => Promise<string | null>;
  /** Synchronous fetch for the Translation API (injectable for tests). */
  fetchText?: GoogleSyncFetch;
  /** Optional log sink for the wiring summary (never receives the secret). */
  logger?: (message: string) => void;
}

/** Which backend each Google-connector function is currently using. */
export interface GoogleFormulaSeamStatus {
  credentialRef: string;
  auth: GoogleAuthMode;
  /** True when a vault credential was found and the seams were wired. */
  credentialFound: boolean;
  translate: 'google-cloud-translate' | 'bundled-phrasebook';
  detectLanguage: 'google-cloud-translate' | 'heuristic';
  importRange: 'google-sheets-api' | 'prefeed-cache-only';
}

/**
 * Wire the vault-resolved Google credential into the engine's
 * TRANSLATE/DETECTLANGUAGE/IMPORTRANGE seams. Idempotent: safe to call on
 * every EngineHost bootstrap (the seams are process-global engine state).
 *
 * The returned status documents the active mode per function — callers
 * should log it so the fallback modes are visible, never silent.
 */
export async function wireGoogleFormulaSeams(
  opts: GoogleFormulaSeamsOptions = {},
): Promise<GoogleFormulaSeamStatus> {
  const credentialRef = (opts.credentialRef ?? DEFAULT_GOOGLE_CREDENTIAL_REF).trim() || DEFAULT_GOOGLE_CREDENTIAL_REF;
  const auth: GoogleAuthMode = opts.auth ?? 'apikey';
  const fetchText = opts.fetchText ?? ((url: string) => fetchUrlText(url, GOOGLE_API_MAX_TEXT));

  let secret: string | null = null;
  if (opts.resolveCredential) {
    try {
      const resolved = await opts.resolveCredential(credentialRef);
      secret = typeof resolved === 'string' && resolved.trim() !== '' ? resolved : null;
    } catch (e) {
      // Fail closed: a broken resolver must not half-wire the seams.
      opts.logger?.(
        `google seams: credential resolver failed (${e instanceof Error ? e.message : String(e)}); ` +
          'keeping honest fallbacks',
      );
    }
  }

  const status: GoogleFormulaSeamStatus = secret
    ? {
        credentialRef,
        auth,
        credentialFound: true,
        translate: 'google-cloud-translate',
        detectLanguage: 'google-cloud-translate',
        importRange: 'google-sheets-api',
      }
    : {
        credentialRef,
        auth,
        credentialFound: false,
        translate: 'bundled-phrasebook',
        detectLanguage: 'heuristic',
        importRange: 'prefeed-cache-only',
      };

  if (secret) {
    const cred: GoogleApiCredential = auth === 'oauth2' ? { accessToken: secret } : { apiKey: secret };
    // IMPORTRANGE: the engine's Sheets v4 fetch reads this credential.
    setGoogleApiCredential(cred);
    setTranslatorProvider(makeGoogleCloudTranslator(cred, fetchText));
    setLanguageDetectorProvider(makeGoogleCloudLanguageDetector(cred, fetchText));
  }

  opts.logger?.(
    `google seams [${credentialRef}]: ` +
      (secret
        ? 'vault credential found — TRANSLATE/DETECTLANGUAGE → Google Cloud Translation, IMPORTRANGE → Sheets API v4'
        : 'no vault credential — TRANSLATE → bundled phrasebook, DETECTLANGUAGE → heuristic, IMPORTRANGE → pre-fed cache only'),
  );
  return status;
}
