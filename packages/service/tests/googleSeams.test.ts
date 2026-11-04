/**
 * Google-connector formula host wiring (Cycle-3 GAP-1,
 * design-docs/connector-vs-component.md: GOOGLETRANSLATE, DETECTLANGUAGE and
 * IMPORTRANGE use Google connectors, "OAuth2 / API key via vault
 * credentialRef").
 *
 * The engine exposes the seams (setTranslatorProvider,
 * setLanguageDetectorProvider, setGoogleApiCredential) but no host called
 * them. These tests prove wireGoogleFormulaSeams() — the service-layer host
 * (packages/service/src/connectors/googleSeams.ts) — puts the
 * vault-resolved credential into the seams: the IMPORTRANGE credential
 * equals the vault secret, and TRANSLATE/DETECTLANGUAGE drive the real
 * Google Cloud Translation endpoints with that secret. All network and
 * credential resolution are faked — no live HTTP, no real secrets.
 *
 * The seams are process-global engine state; every test resets them in
 * afterEach so other suites keep the honest defaults.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  EngineHost,
  getGoogleApiCredential,
  resetLanguageDetectorProvider,
  resetTranslatorProvider,
  setGoogleApiCredential,
} from '@icecream-sheets/engine';
import {
  decodeTranslateEntities,
  DEFAULT_GOOGLE_CREDENTIAL_REF,
  makeGoogleCloudLanguageDetector,
  makeGoogleCloudTranslator,
  wireGoogleFormulaSeams,
} from '../src/connectors/index.js';

afterEach(() => {
  setGoogleApiCredential(null);
  resetTranslatorProvider();
  resetLanguageDetectorProvider();
});

const TRANSLATE_BODY = JSON.stringify({
  data: { translations: [{ translatedText: 'hola', detectedSourceLanguage: 'en' }] },
});
const DETECT_BODY = JSON.stringify({
  data: { detections: [[{ language: 'es', isUndetermined: false, confidence: 0.99 }]] },
});

/** Sync fetch double: records URLs, answers translate vs detect endpoints. */
function mockFetch(opts: { translateBody?: string; detectBody?: string; throws?: boolean } = {}) {
  const urls: string[] = [];
  const fetchText = (url: string): string => {
    urls.push(url);
    if (opts.throws) throw new Error('network down');
    return url.includes('/detect') ? (opts.detectBody ?? DETECT_BODY) : (opts.translateBody ?? TRANSLATE_BODY);
  };
  return { fetchText, urls };
}

function vaultResolver(secret: string | null, seen: { ref?: string }) {
  return async (ref: string): Promise<string | null> => {
    seen.ref = ref;
    return secret;
  };
}

/** Evaluate one formula through a real EngineHost and read the cell back. */
function evalFormula(formula: string): { kind: string; value?: unknown; code?: string } {
  const host = new EngineHost();
  const res = host.execute({
    cmd: 'setCell',
    ref: { sheet: 'Sheet1', row: 0, col: 0 },
    value: formula,
  });
  expect(res.ok).toBe(true);
  const tv = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 });
  return tv as { kind: string; value?: unknown; code?: string };
}

describe('wireGoogleFormulaSeams', () => {
  it('wires the vault credential (apikey) into all three seams', async () => {
    const { fetchText, urls } = mockFetch();
    const seen: { ref?: string } = {};
    const status = await wireGoogleFormulaSeams({
      resolveCredential: vaultResolver('VAULT-SECRET-1', seen),
      fetchText,
    });

    // The host asked the vault for the Google connector credentialRef.
    expect(seen.ref).toBe(DEFAULT_GOOGLE_CREDENTIAL_REF);
    expect(seen.ref).toBe('google');
    // Status documents the live mode (not silent).
    expect(status).toMatchObject({
      credentialRef: 'google',
      auth: 'apikey',
      credentialFound: true,
      translate: 'google-cloud-translate',
      detectLanguage: 'google-cloud-translate',
      importRange: 'google-sheets-api',
    });
    // IMPORTRANGE seam: the credential IS the vault secret.
    expect(getGoogleApiCredential()).toEqual({ apiKey: 'VAULT-SECRET-1' });

    // TRANSLATE seam: the engine function now drives the Google endpoint
    // with the vault secret (proves the seam received the credential).
    const t = evalFormula('=TRANSLATE("hello","en","es")');
    expect(t).toMatchObject({ kind: 'string', value: 'hola' });
    const translateCall = urls.find((u) => u.includes('translation.googleapis.com') && !u.includes('/detect'));
    expect(translateCall).toBeTruthy();
    expect(translateCall!).toContain('key=VAULT-SECRET-1');
    expect(translateCall!).toContain('target=es');

    // DETECTLANGUAGE seam: same, through the detect endpoint.
    const d = evalFormula('=DETECTLANGUAGE("hola mundo")');
    expect(d).toMatchObject({ kind: 'string', value: 'es' });
    const detectCall = urls.find((u) => u.includes('/detect'));
    expect(detectCall).toBeTruthy();
    expect(detectCall!).toContain('key=VAULT-SECRET-1');
  });

  it('oauth2 mode sets the access token and sends it to the API', async () => {
    const { fetchText, urls } = mockFetch();
    const status = await wireGoogleFormulaSeams({
      auth: 'oauth2',
      resolveCredential: vaultResolver('OAUTH-TOKEN-9', {}),
      fetchText,
    });
    expect(status).toMatchObject({ credentialFound: true, auth: 'oauth2' });
    expect(getGoogleApiCredential()).toEqual({ accessToken: 'OAUTH-TOKEN-9' });

    const t = evalFormula('=TRANSLATE("hello","en","es")');
    expect(t).toMatchObject({ kind: 'string', value: 'hola' });
    const call = urls.find((u) => u.includes('translation.googleapis.com') && !u.includes('/detect'));
    expect(call).toContain('access_token=OAUTH-TOKEN-9');
    expect(call).not.toContain('key=');
  });

  it('absent credential keeps the honest fallbacks and documents them', async () => {
    const { fetchText, urls } = mockFetch();
    const status = await wireGoogleFormulaSeams({
      resolveCredential: vaultResolver(null, {}),
      fetchText,
    });
    expect(status).toMatchObject({
      credentialFound: false,
      translate: 'bundled-phrasebook',
      detectLanguage: 'heuristic',
      importRange: 'prefeed-cache-only',
    });
    // Seams untouched: no credential, no Google providers.
    expect(getGoogleApiCredential()).toBeNull();
    expect(urls.length).toBe(0);
    // The documented fallbacks still work.
    expect(evalFormula('=TRANSLATE("hello","en","es")')).toMatchObject({
      kind: 'string',
      value: 'hola',
    });
    expect(evalFormula('=DETECTLANGUAGE("hello world")')).toMatchObject({
      kind: 'string',
      value: 'en',
    });
  });

  it('a throwing resolver fails closed to the honest fallbacks', async () => {
    const logged: string[] = [];
    const status = await wireGoogleFormulaSeams({
      resolveCredential: async () => {
        throw new Error('vault unreachable');
      },
      logger: (m) => void logged.push(m),
    });
    expect(status.credentialFound).toBe(false);
    expect(status.translate).toBe('bundled-phrasebook');
    expect(getGoogleApiCredential()).toBeNull();
    expect(logged.some((m) => m.includes('vault unreachable'))).toBe(true);
  });

  it('empty/whitespace secrets are treated as absent', async () => {
    const status = await wireGoogleFormulaSeams({
      resolveCredential: vaultResolver('   ', {}),
    });
    expect(status.credentialFound).toBe(false);
    expect(getGoogleApiCredential()).toBeNull();
  });

  it('API errors surface as honest #N/A, never as thrown exceptions', async () => {
    const { fetchText } = mockFetch({
      translateBody: JSON.stringify({ error: { message: 'API key not valid' } }),
    });
    await wireGoogleFormulaSeams({
      resolveCredential: vaultResolver('BAD-KEY', {}),
      fetchText,
    });
    const t = evalFormula('=TRANSLATE("hello","en","es")');
    expect(t.kind).toBe('error');
    expect(t.code).toBe('#N/A');
  });

  it('network failure in detect degrades to und, not a crash', async () => {
    const { fetchText } = mockFetch({ throws: true });
    await wireGoogleFormulaSeams({
      resolveCredential: vaultResolver('VAULT-SECRET-1', {}),
      fetchText,
    });
    expect(evalFormula('=DETECTLANGUAGE("hola mundo")')).toMatchObject({
      kind: 'string',
      value: 'und',
    });
  });
});

describe('google cloud providers (unit)', () => {
  it('translator decodes HTML entities in translatedText', () => {
    const { fetchText } = mockFetch({
      translateBody: JSON.stringify({
        data: { translations: [{ translatedText: 'l&#39;homme &amp; la femme' }] },
      }),
    });
    const p = makeGoogleCloudTranslator({ apiKey: 'k' }, fetchText);
    expect(p.translate('the man and the woman', 'en', 'fr')).toBe("l'homme & la femme");
  });

  it('translator returns null (→ #N/A) on garbage responses', () => {
    const p = makeGoogleCloudTranslator({ apiKey: 'k' }, () => 'not json');
    expect(p.translate('hello', 'en', 'es')).toBeNull();
  });

  it('detector lowercases the language code', () => {
    const { fetchText } = mockFetch({
      detectBody: JSON.stringify({ data: { detections: [[{ language: 'EN' }]] } }),
    });
    const p = makeGoogleCloudLanguageDetector({ apiKey: 'k' }, fetchText);
    expect(p.detect('hello')).toBe('en');
  });

  it('detector returns null when the payload has no detection', () => {
    const p = makeGoogleCloudLanguageDetector({ apiKey: 'k' }, () => JSON.stringify({ data: {} }));
    expect(p.detect('hello')).toBeNull();
  });

  it('decodeTranslateEntities handles named, decimal and hex entities', () => {
    expect(decodeTranslateEntities('a &lt;b&gt; &quot;q&quot; &#39;s&#39; &#65; &#x42;')).toBe(
      'a <b> "q" \'s\' A B',
    );
  });
});
