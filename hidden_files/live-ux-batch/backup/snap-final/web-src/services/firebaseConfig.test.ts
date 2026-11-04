/**
 * Firebase config seam tests (Cycle 9, Phase 1 — web login).
 *
 * The Firebase project config is not available yet, so the app must read
 * it from env vars and fail with a clear message when incomplete — never
 * a half-filled config, never hardcoded keys.
 */
import { describe, expect, it } from 'vitest';
import {
  firebaseConfigError,
  getFirebaseConfig,
  FIREBASE_SETUP_INSTRUCTIONS,
} from './firebaseConfig';

const FULL = {
  VITE_FIREBASE_API_KEY: 'AIzaSy-test',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-project',
  VITE_FIREBASE_APP_ID: '1:123:web:abc',
};

describe('firebaseConfig', () => {
  it('returns the full config when every required var is set', () => {
    const cfg = getFirebaseConfig({ ...FULL });
    expect(cfg).toMatchObject({
      apiKey: 'AIzaSy-test',
      authDomain: 'demo.firebaseapp.com',
      projectId: 'demo-project',
      appId: '1:123:web:abc',
    });
    expect(cfg?.measurementId).toBeUndefined();
  });

  it('includes the optional measurement id when present', () => {
    const cfg = getFirebaseConfig({ ...FULL, VITE_FIREBASE_MEASUREMENT_ID: 'G-ABC' });
    expect(cfg?.measurementId).toBe('G-ABC');
  });

  it('returns null when any required var is missing — never a partial config', () => {
    for (const key of Object.keys(FULL)) {
      const env = { ...FULL };
      delete env[key as keyof typeof FULL];
      expect(getFirebaseConfig(env), key).toBeNull();
    }
    expect(getFirebaseConfig({})).toBeNull();
  });

  it('treats blank values as missing', () => {
    expect(getFirebaseConfig({ ...FULL, VITE_FIREBASE_API_KEY: '   ' })).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const cfg = getFirebaseConfig({ ...FULL, VITE_FIREBASE_PROJECT_ID: '  demo-project ' });
    expect(cfg?.projectId).toBe('demo-project');
  });

  it('firebaseConfigError is null when complete, and names the missing vars otherwise', () => {
    expect(firebaseConfigError({ ...FULL })).toBeNull();
    const err = firebaseConfigError({
      VITE_FIREBASE_API_KEY: 'x',
      VITE_FIREBASE_AUTH_DOMAIN: 'x',
    });
    expect(err).toContain('VITE_FIREBASE_PROJECT_ID');
    expect(err).toContain('VITE_FIREBASE_APP_ID');
    expect(err).toContain(FIREBASE_SETUP_INSTRUCTIONS.slice(0, 40));
  });
});
