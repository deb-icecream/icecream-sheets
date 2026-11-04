/**
 * Firebase project config seam (Cycle 9: Firebase Google login — desktop).
 *
 * The config is loaded from, in order:
 *
 *   1. ICECREAM_FIREBASE_CONFIG  — JSON string in the environment
 *      (e.g. {"apiKey":"…","authDomain":"….firebaseapp.com","projectId":"…"}).
 *   2. FIREBASE_CONFIG_PATH      — path to a JSON file with the same shape.
 *   3. <userData>/firebase.config.json — the Electron userData directory
 *      (per-user; never checked into the repo).
 *   4. The BUNDLED default (issue #52, ./firebase-config-bundled) — the
 *      production project's public web config, the same identifiers the
 *      hosted web bundle ships. This is what a clean install uses, so
 *      sign-in works with zero operator setup.
 *
 * Overrides always win over the bundled default, and an override that
 * is SET but invalid fails closed (FirebaseNotConfiguredError): the
 * default applies only when no override was provided at all — which
 * includes a userData file that EXISTS but does not parse/validate (a
 * present file is an override attempt, not an absence).
 *
 * Only the public web-config fields are needed (they are public by design
 * in Firebase — the apiKey is not a secret). Google is the ONLY provider;
 * there is deliberately no username/password anywhere in this flow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUNDLED_FIREBASE_CONFIG } from './firebase-config-bundled.js';

/** Public Firebase web-config fields needed for Google sign-in. */
export interface FirebaseWebConfig {
  /** Firebase web API key (public by design). */
  apiKey: string;
  /** e.g. "my-project.firebaseapp.com". */
  authDomain: string;
  /** e.g. "my-project". */
  projectId: string;
  /** Optional; not required for Auth. */
  appId?: string;
}

/** Thrown when no Firebase config can be found. Carries the fix. */
export class FirebaseNotConfiguredError extends Error {
  readonly checked: string[];
  constructor(checked: string[]) {
    super(
      'Firebase Auth is not configured. Set the ICECREAM_FIREBASE_CONFIG ' +
        'environment variable (JSON), or point FIREBASE_CONFIG_PATH at a JSON ' +
        'file, or place firebase.config.json in the app userData directory. ' +
        `Checked: ${checked.join('; ')}. ` +
        'Expected shape: {"apiKey":"…","authDomain":"….firebaseapp.com","projectId":"…"}. ' +
        'Google is the only sign-in provider — no username/password is supported.',
    );
    this.name = 'FirebaseNotConfiguredError';
    this.checked = checked;
  }
}

function isValidConfig(value: unknown): value is FirebaseWebConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['apiKey'] === 'string' &&
    v['apiKey'].length > 0 &&
    typeof v['authDomain'] === 'string' &&
    v['authDomain'].length > 0 &&
    typeof v['projectId'] === 'string' &&
    v['projectId'].length > 0
  );
}

export interface FirebaseConfigDeps {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to node:fs.readFileSync. */
  readFile?: (p: string) => string;
  /** Defaults to app.getPath('userData') — pass explicitly in tests. */
  userDataPath?: string;
}

/**
 * Load the Firebase web config from the seam. Falls back to the bundled
 * default (issue #52) when no override is provided; throws
 * FirebaseNotConfiguredError (fail closed) when an override IS provided
 * but invalid, or if even the bundled default fails validation.
 */
export function loadFirebaseConfig(deps: FirebaseConfigDeps = {}): FirebaseWebConfig {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const checked: string[] = [];

  // 1. Inline JSON in the environment.
  const inline = env['ICECREAM_FIREBASE_CONFIG'];
  if (inline && inline.trim().length > 0) {
    checked.push('ICECREAM_FIREBASE_CONFIG (env)');
    try {
      const parsed: unknown = JSON.parse(inline);
      if (isValidConfig(parsed)) return parsed;
    } catch {
      // Fall through to the not-configured error below.
    }
    throw new FirebaseNotConfiguredError([
      ...checked,
      'ICECREAM_FIREBASE_CONFIG was set but is not valid JSON with apiKey/authDomain/projectId',
    ]);
  }
  checked.push('ICECREAM_FIREBASE_CONFIG (env, unset)');

  // 2. JSON file pointed at by the environment.
  const configPath = env['FIREBASE_CONFIG_PATH'];
  if (configPath && configPath.trim().length > 0) {
    checked.push(`FIREBASE_CONFIG_PATH=${configPath}`);
    try {
      const parsed: unknown = JSON.parse(readFile(configPath));
      if (isValidConfig(parsed)) return parsed;
    } catch {
      // Fall through.
    }
    throw new FirebaseNotConfiguredError([
      ...checked,
      `FIREBASE_CONFIG_PATH was set but "${configPath}" is unreadable or invalid`,
    ]);
  }
  checked.push('FIREBASE_CONFIG_PATH (env, unset)');

  // 3. Per-user config file in the Electron userData directory.
  const userDataPath = deps.userDataPath;
  const userFile = userDataPath ? path.join(userDataPath, 'firebase.config.json') : null;
  checked.push(userFile ?? '<userData>/firebase.config.json (no userData path available)');
  if (userFile) {
    let raw: string | null = null;
    try {
      raw = readFile(userFile);
    } catch {
      raw = null; // Missing file → not an override; fall through to (4).
    }
    if (raw !== null) {
      // The file EXISTS: it is an override attempt. Invalid content
      // fails closed rather than silently signing into another project.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (isValidConfig(parsed)) return parsed;
      throw new FirebaseNotConfiguredError([
        ...checked,
        `"${userFile}" exists but is not valid JSON with apiKey/authDomain/projectId`,
      ]);
    }
  }

  // 4. Bundled default (issue #52): the production project's public web
  // config, shipped in the package so clean installs can sign in.
  checked.push('bundled default (firebase-config-bundled)');
  if (isValidConfig(BUNDLED_FIREBASE_CONFIG)) return { ...BUNDLED_FIREBASE_CONFIG };

  throw new FirebaseNotConfiguredError(checked);
}
