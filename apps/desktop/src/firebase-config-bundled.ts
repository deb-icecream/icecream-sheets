/**
 * Bundled Firebase web config (issue #52).
 *
 * A Firebase WEB config is a set of PUBLIC project identifiers — it
 * ships inside every web app bundle (the hosted web app's bundle
 * carries these exact values) and grants nothing by itself: access is
 * governed by Firebase security rules and the gateway's token checks.
 * Bundling it as the desktop package's DEFAULT is what lets a clean
 * install sign in with zero operator setup (before this, the shipped
 * build carried no config at all and the login window could only show
 * the not-configured error — sign-in was dead on clean installs).
 *
 * This is the LAST resort in loadFirebaseConfig's chain: the
 * ICECREAM_FIREBASE_CONFIG env JSON, a FIREBASE_CONFIG_PATH file, and
 * a <userData>/firebase.config.json all override it (dev/test projects,
 * self-hosted deployments). An explicitly-set-but-invalid override
 * still fails closed — the default only applies when NO override was
 * provided at all.
 */
import type { FirebaseWebConfig } from './firebase-config.js';

/** The production project (icecream-sheets) — same values the web bundle ships. */
export const BUNDLED_FIREBASE_CONFIG: FirebaseWebConfig = {
  apiKey: 'AIzaSyBm_wP3T1yIXC2lyyncWb-X5cMCtoLqxU8',
  authDomain: 'icecream-sheets.firebaseapp.com',
  projectId: 'icecream-sheets',
  appId: '1:340184893273:web:0ba0acea93aa87cd9bae48',
};
