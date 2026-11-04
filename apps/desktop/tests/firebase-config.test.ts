/**
 * Firebase config seam tests (Cycle 9: desktop login; issue #52).
 *
 * The chain: env JSON → FIREBASE_CONFIG_PATH file →
 * <userData>/firebase.config.json → the BUNDLED production default.
 * Overrides win; a set-but-invalid override fails closed with a clear
 * FirebaseNotConfiguredError; only ABSENCE reaches the default.
 */
import { describe, expect, it } from 'vitest';
import {
  FirebaseNotConfiguredError,
  loadFirebaseConfig,
} from '../src/firebase-config.js';
import { BUNDLED_FIREBASE_CONFIG } from '../src/firebase-config-bundled.js';

const GOOD = {
  apiKey: 'AIza-test-key',
  authDomain: 'demo.firebaseapp.com',
  projectId: 'demo-project',
};

describe('loadFirebaseConfig', () => {
  it('loads from ICECREAM_FIREBASE_CONFIG env JSON', () => {
    const cfg = loadFirebaseConfig({
      env: { ICECREAM_FIREBASE_CONFIG: JSON.stringify(GOOD) },
      readFile: () => {
        throw new Error('must not read files');
      },
    });
    expect(cfg).toEqual(GOOD);
  });

  it('loads from FIREBASE_CONFIG_PATH file', () => {
    const cfg = loadFirebaseConfig({
      env: { FIREBASE_CONFIG_PATH: '/secrets/firebase.json' },
      readFile: (p) => {
        expect(p).toBe('/secrets/firebase.json');
        return JSON.stringify({ ...GOOD, appId: '1:2:3' });
      },
    });
    expect(cfg.projectId).toBe('demo-project');
    expect(cfg.appId).toBe('1:2:3');
  });

  it('loads from <userData>/firebase.config.json', () => {
    const cfg = loadFirebaseConfig({
      env: {},
      userDataPath: '/home/u/.config/app',
      readFile: (p) => {
        expect(p).toBe('/home/u/.config/app/firebase.config.json');
        return JSON.stringify(GOOD);
      },
    });
    expect(cfg.authDomain).toBe('demo.firebaseapp.com');
  });

  it('prefers env JSON over the file paths', () => {
    const cfg = loadFirebaseConfig({
      env: {
        ICECREAM_FIREBASE_CONFIG: JSON.stringify(GOOD),
        FIREBASE_CONFIG_PATH: '/other.json',
      },
      readFile: () => {
        throw new Error('must not read files when env is set');
      },
    });
    expect(cfg).toEqual(GOOD);
  });

  it('falls back to the bundled production default when nothing is set (issue #52)', () => {
    // A clean install: no env, no config files anywhere — sign-in must
    // still work, against the production project the web bundle ships.
    const cfg = loadFirebaseConfig({
      env: {},
      userDataPath: '/home/u/.config/app',
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(cfg).toEqual(BUNDLED_FIREBASE_CONFIG);
    expect(cfg.projectId).toBe('icecream-sheets');
    expect(cfg.authDomain).toBe('icecream-sheets.firebaseapp.com');
    expect(cfg.apiKey.length).toBeGreaterThan(0);
    expect(cfg.appId).toBeTruthy();
  });

  it('a valid userData file overrides the bundled default', () => {
    const cfg = loadFirebaseConfig({
      env: {},
      userDataPath: '/home/u/.config/app',
      readFile: () => JSON.stringify(GOOD),
    });
    expect(cfg.projectId).toBe('demo-project');
    expect(cfg).not.toEqual(BUNDLED_FIREBASE_CONFIG);
  });

  it('throws a clear error when env JSON is present but invalid', () => {
    expect(() =>
      loadFirebaseConfig({
        env: { ICECREAM_FIREBASE_CONFIG: '{"apiKey": "x"}' },
        readFile: () => {
          throw new Error('must not read files');
        },
      }),
    ).toThrow(/not valid JSON with apiKey\/authDomain\/projectId/);
  });

  it('throws a clear error when FIREBASE_CONFIG_PATH is unreadable', () => {
    expect(() =>
      loadFirebaseConfig({
        env: { FIREBASE_CONFIG_PATH: '/missing.json' },
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/unreadable or invalid/);
  });

  it('fails closed when the userData file EXISTS but is invalid', () => {
    // A present file is an override attempt: invalid content must NOT
    // fall through to the bundled default (that would silently sign
    // into a different project than the operator configured).
    expect(() =>
      loadFirebaseConfig({
        env: {},
        userDataPath: '/ud',
        readFile: () => JSON.stringify({ apiKey: 'x' }),
      }),
    ).toThrow(FirebaseNotConfiguredError);
    expect(() =>
      loadFirebaseConfig({
        env: {},
        userDataPath: '/ud',
        readFile: () => 'not json at all',
      }),
    ).toThrow(/exists but is not valid JSON/);
  });
});
