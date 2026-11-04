/**
 * Gateway URL seam tests (issue #85).
 *
 * The chain: ICECREAM_GATEWAY_URL env → <userData>/gateway.config.json
 * → the BUNDLED production default. Overrides win; a set-but-invalid
 * override fails closed with a GatewayConfigError (no fallthrough to
 * localhost, no fallthrough to production either); only ABSENCE
 * reaches the default. Before #85 the main process fell back to
 * http://localhost:8100, which made sign-in impossible on a clean
 * packaged install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GatewayConfigError,
  loadGatewayUrl,
  normalizeGatewayUrl,
} from '../src/gateway-config.js';
import { BUNDLED_GATEWAY_URL } from '../src/gateway-config-bundled.js';

const PROD = 'https://icecream-sheet-gateway-7uydfzbt2a-uc.a.run.app';
const MISSING = () => {
  throw new Error('ENOENT: no such file');
};

describe('loadGatewayUrl', () => {
  it('falls back to the bundled PRODUCTION default when nothing is set', () => {
    const url = loadGatewayUrl({ env: {}, userDataPath: '/home/u/.config/app', readFile: MISSING });
    expect(url).toBe(PROD);
    expect(url).toBe(BUNDLED_GATEWAY_URL);
    expect(url).not.toContain('localhost');
  });

  it('reaches the default with no userData path at all', () => {
    expect(loadGatewayUrl({ env: {}, readFile: MISSING })).toBe(PROD);
  });

  it('env override wins — and the config file is never consulted', () => {
    const url = loadGatewayUrl({
      env: { ICECREAM_GATEWAY_URL: 'http://localhost:8100' },
      userDataPath: '/home/u/.config/app',
      readFile: () => {
        throw new Error('must not read files');
      },
    });
    expect(url).toBe('http://localhost:8100');
  });

  it('normalizes the env override (whitespace + trailing slashes)', () => {
    const url = loadGatewayUrl({
      env: { ICECREAM_GATEWAY_URL: '  https://gw.example.com/// ' },
      readFile: MISSING,
    });
    expect(url).toBe('https://gw.example.com');
  });

  it('userData gateway.config.json wins over the bundled default', () => {
    const url = loadGatewayUrl({
      env: {},
      userDataPath: '/home/u/.config/app',
      readFile: (p) => {
        expect(p).toBe(path.join('/home/u/.config/app', 'gateway.config.json'));
        return JSON.stringify({ gatewayUrl: 'https://self-hosted.example.com/' });
      },
    });
    expect(url).toBe('https://self-hosted.example.com');
  });

  it('an invalid env override fails closed — no fallthrough to file or default', () => {
    for (const bad of ['not a url', 'ftp://gw.example.com', 'localhost:8100', '://']) {
      expect(() =>
        loadGatewayUrl({
          env: { ICECREAM_GATEWAY_URL: bad },
          userDataPath: '/home/u/.config/app',
          readFile: () => JSON.stringify({ gatewayUrl: 'https://self-hosted.example.com' }),
        }),
      ).toThrow(GatewayConfigError);
    }
  });

  it('an existing-but-invalid userData file fails closed', () => {
    const cases = [
      '{not json',
      JSON.stringify({}),
      JSON.stringify({ gatewayUrl: 42 }),
      JSON.stringify({ gatewayUrl: 'not a url' }),
      JSON.stringify({ gatewayUrl: 'ftp://gw.example.com' }),
    ];
    for (const raw of cases) {
      expect(() =>
        loadGatewayUrl({
          env: {},
          userDataPath: '/home/u/.config/app',
          readFile: () => raw,
        }),
      ).toThrow(GatewayConfigError);
    }
  });

  it('a blank env value counts as unset, not as an invalid override', () => {
    const url = loadGatewayUrl({
      env: { ICECREAM_GATEWAY_URL: '   ' },
      userDataPath: '/home/u/.config/app',
      readFile: MISSING,
    });
    expect(url).toBe(PROD);
  });
});

describe('normalizeGatewayUrl', () => {
  it('accepts http(s) URLs and rejects everything else', () => {
    expect(normalizeGatewayUrl('https://gw.example.com')).toBe('https://gw.example.com');
    expect(normalizeGatewayUrl('http://localhost:8100')).toBe('http://localhost:8100');
    expect(normalizeGatewayUrl('')).toBeNull();
    expect(normalizeGatewayUrl('   ')).toBeNull();
    expect(normalizeGatewayUrl(null)).toBeNull();
    expect(normalizeGatewayUrl(undefined)).toBeNull();
    expect(normalizeGatewayUrl('gw.example.com')).toBeNull();
    expect(normalizeGatewayUrl('mailto:a@b.c')).toBeNull();
  });
});

/**
 * services.gatewayUrl() wiring: the main process's single entry point
 * must resolve through the seam with the real userData path.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'icecream-gw-config-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Uint8Array) => Buffer.from(b).toString('utf8'),
  },
}));

const { gatewayUrl } = await import('../src/services.js');

describe('services.gatewayUrl() (#85 wiring)', () => {
  beforeEach(() => {
    delete process.env.ICECREAM_GATEWAY_URL;
    try {
      fs.unlinkSync(path.join(userData, 'gateway.config.json'));
    } catch {
      // Absent is the common case.
    }
  });

  afterEach(() => {
    delete process.env.ICECREAM_GATEWAY_URL;
  });

  it('defaults to the production gateway — never localhost', () => {
    expect(gatewayUrl()).toBe(PROD);
  });

  it('honors the env override', () => {
    process.env.ICECREAM_GATEWAY_URL = 'http://gw.test:8100/';
    expect(gatewayUrl()).toBe('http://gw.test:8100');
  });

  it('honors a userData gateway.config.json override', () => {
    fs.writeFileSync(
      path.join(userData, 'gateway.config.json'),
      JSON.stringify({ gatewayUrl: 'https://self-hosted.example.com' }),
    );
    expect(gatewayUrl()).toBe('https://self-hosted.example.com');
  });

  it('fails closed on an invalid env override', () => {
    process.env.ICECREAM_GATEWAY_URL = 'not a url';
    expect(() => gatewayUrl()).toThrow(GatewayConfigError);
  });
});
