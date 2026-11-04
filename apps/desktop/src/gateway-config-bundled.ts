/**
 * Bundled production gateway URL (issue #85).
 *
 * The gateway base URL is a PUBLIC deployment identifier — it ships
 * inside the hosted web bundle (the hosted build is baked with
 * VITE_GATEWAY_URL set to this exact value) and grants nothing by
 * itself: access is governed by the gateway's own auth checks on
 * every call. Bundling it as the desktop package's DEFAULT is what
 * lets a clean install sign in against the deployed service with
 * zero operator setup (before this, the shipped build's main process
 * fell back to http://localhost:8100 and sign-in could only fail
 * unless ICECREAM_GATEWAY_URL was set by hand — issue #85).
 *
 * This is the LAST resort in loadGatewayUrl's chain: the
 * ICECREAM_GATEWAY_URL env var and a <userData>/gateway.config.json
 * both override it (local stacks, self-hosted deployments). An
 * explicitly-set-but-invalid override still fails closed — the
 * default only applies when NO override was provided at all.
 */

/** The production gateway — same URL the hosted web bundle ships. */
export const BUNDLED_GATEWAY_URL = 'https://icecream-sheet-gateway-7uydfzbt2a-uc.a.run.app';
