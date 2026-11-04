/**
 * Host-context app rendering (owner decision 2026-10-25: skip the iframe
 * FOR NOW — generated JSX renders in the host app context itself;
 * iframe sandboxing is a LATER step, not discarded).
 *
 * Pipeline for one artifact source:
 *   1. looksLikeJsx() — plain-JS h() sources skip Babel entirely, so the
 *      Babel chunk is never fetched for old-shape apps.
 *   2. transformSource() — JSX sources are transformed with
 *      @babel/standalone, preset react only, classic runtime (output =
 *      React.createElement calls). TypeScript is NOT accepted: no
 *      typescript preset, per the owner ruling (JSX ONLY).
 *   3. normalizeAppSource() (service) — strips App parameter lists and
 *      narrow-API React destructures, so the #147 crash class (model
 *      writes App(React, h, useState, ...) params AND destructures the
 *      hooks -> duplicate declaration -> mount crash) cannot reach
 *      compile, even for already-stored specs.
 *   4. compileAppSource() — new Function with ONLY the narrow API in
 *      scope: React, h, useState, useEffect, useRef, mcp (scoped data
 *      API), BINDING (the artifact's own sheet binding — part of the
 *      scoped data API, never host internals, never any token), and
 *      AppChart (the SVG bar-chart component — props-only data, no
 *      data access of its own).
 *
 * Trust note, stated plainly: this is NOT a sandbox. Code compiled here
 * runs in the host realm and can reach host globals (window, fetch,
 * localStorage) by construction — the iframe's isolation is exactly what
 * is being deferred. The narrow API limits what is HANDED to the app,
 * not what the app can reach. Host-context rendering is therefore a
 * deliberate interim step for trusted backend-generated code, not a
 * substitute for the later sandboxed frame.
 */
import * as React from 'react';
import {
  ArtifactBridgeHost,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_TAG,
  normalizeAppSource,
  type BridgeHostMessage,
  type McpCallFn,
} from '@icecream-sheets/service';
import { AppChart } from './AppChart';

/* ------------------------------------------------------------------ */
/* JSX detection                                                       */
/* ------------------------------------------------------------------ */

/**
 * True when the source appears to contain JSX markup (an opening,
 * closing, self-closing, or fragment tag). Comments and single/double
 * quoted strings are stripped first so prose or string literals cannot
 * trip it. False positives only cost a Babel load (Babel passes plain
 * JS through); false negatives surface as a visible compile error, not
 * a silent blank frame.
 */
export function looksLikeJsx(source: string): boolean {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '');
  return /<\/?[A-Za-z][\w.]*(\s[^<>]*)?\/?>/.test(stripped) || /<>/.test(stripped);
}

/* ------------------------------------------------------------------ */
/* On-demand Babel                                                     */
/* ------------------------------------------------------------------ */

type BabelApi = {
  transform: (
    code: string,
    options: Record<string, unknown>,
  ) => { code: string };
};

/**
 * The Babel module promise, cached after the first load: the chunk is
 * fetched exactly once per page session, on the first JSX render only.
 * A failed load clears the cache so a later render retries instead of
 * pinning the failure.
 */
let babelPromise: Promise<BabelApi> | null = null;

export function getBabel(): Promise<BabelApi> {
  if (!babelPromise) {
    babelPromise = import('@babel/standalone').then((mod) => {
      const api = ((mod as unknown as { default?: BabelApi }).default ??
        mod) as BabelApi;
      if (!api || typeof api.transform !== 'function') {
        throw new Error('Babel standalone did not provide a transform function');
      }
      return api;
    });
    babelPromise.catch(() => {
      babelPromise = null;
    });
  }
  return babelPromise;
}

/** Test hook: drop the cached module so a test can observe a fresh load. */
export function __resetBabelCacheForTests(): void {
  babelPromise = null;
}

/**
 * Transform JSX to React.createElement calls. Plain-JS sources pass
 * through untouched WITHOUT loading Babel. JSX ONLY: preset react,
 * classic runtime; no typescript preset, no other presets.
 */
export async function transformSource(source: string): Promise<string> {
  if (!looksLikeJsx(source)) return source;
  const babel = await getBabel();
  const out = babel.transform(source, {
    presets: ['react'],
    configFile: false,
    babelrc: false,
    filename: 'app.jsx',
    compact: false,
  });
  return out.code;
}

/**
 * Full pre-compile pipeline for one artifact source, in the order that
 * matters: normalize FIRST (strip App params + narrow-API React
 * destructures — the #147 crash class), THEN transform. Transforming
 * first would let Babel throw on the raw duplicate declaration before
 * normalization could heal it (stored legacy specs must render, not
 * just fail visibly). compileAppSource normalizes again as defense in
 * depth; that second pass is a no-op for already-normalized sources.
 */
export async function prepareAppSource(source: string): Promise<string> {
  return transformSource(normalizeAppSource(source));
}

/* ------------------------------------------------------------------ */
/* Host mcp: the scoped data API, reusing the bridge host              */
/* ------------------------------------------------------------------ */

/**
 * The data API handed to a generated app. Same shape as the iframe
 * frame's window.mcp (bridge.ts / artifactFrame.ts): call() resolves
 * with the tool result, subscribe() registers a handler and returns an
 * unsubscribe function (with .unsubscribe for the cleanup convention
 * LLM apps use). Implemented by driving ArtifactBridgeHost with an
 * in-memory sink instead of postMessage, so the allow-list, principal
 * stamping, subscription refcounting and poll loop are identical to the
 * iframe path — no duplicated logic.
 */
export interface HostMcpApi {
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  subscribe: (
    events: string[],
    sheet: string | undefined | ((events: unknown[]) => void),
    onEvents?: (events: unknown[]) => void,
  ) => (() => void) & { unsubscribe: () => void };
}

export class HostMcp {
  private readonly host: ArtifactBridgeHost;
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly handlers = new Map<string, (events: unknown[]) => void>();

  constructor(mcpCall: McpCallFn) {
    this.host = new ArtifactBridgeHost({
      callTool: mcpCall,
      postToFrame: (msg) => this.onHostMessage(msg),
      principal: 'web-user',
    });
  }

  private onHostMessage(msg: BridgeHostMessage): void {
    if (msg.kind === 'result' && msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error ?? 'bridge call failed'));
      return;
    }
    if (msg.kind === 'event') {
      const h = this.handlers.get(msg.subKey);
      if (h) {
        try {
          h(msg.events);
        } catch {
          /* app handler error: never breaks the bridge */
        }
      }
    }
  }

  /** The mcp object handed to compiled app code. */
  readonly api: HostMcpApi = {
    call: (tool, args) => {
      const id = `c${++this.seq}`;
      return new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.host.handleFrameMessage({
          [BRIDGE_TAG]: BRIDGE_PROTOCOL_VERSION,
          id,
          kind: 'call',
          tool,
          args: args ?? {},
        });
      });
    },
    subscribe: (events, sheet, onEvents) => {
      // Tolerate the 2-arg call shape (events, handler) as well as the
      // canonical (events, sheet, handler) shape.
      let realSheet: string | undefined;
      let realHandler: (events: unknown[]) => void;
      if (typeof sheet === 'function') {
        realSheet = undefined;
        realHandler = sheet as (events: unknown[]) => void;
      } else {
        realSheet = sheet;
        realHandler = onEvents as (events: unknown[]) => void;
      }
      // Canonicalize the event-name alias stored apps commonly guess.
      const normalized = (events || []).map((e) =>
        e === 'cell_changed' ? 'cells_changed' : e,
      );
      const subKey = `s${++this.seq}`;
      this.handlers.set(subKey, realHandler);
      this.host.handleFrameMessage({
        [BRIDGE_TAG]: BRIDGE_PROTOCOL_VERSION,
        kind: 'subscribe',
        subKey,
        events: normalized,
        ...(realSheet ? { sheet: realSheet } : {}),
      });
      const unsub = (): void => {
        this.handlers.delete(subKey);
        this.host.handleFrameMessage({
          [BRIDGE_TAG]: BRIDGE_PROTOCOL_VERSION,
          kind: 'unsubscribe',
          subKey,
        });
      };
      (unsub as (() => void) & { unsubscribe: () => void }).unsubscribe = unsub;
      return unsub as (() => void) & { unsubscribe: () => void };
    },
  };

  dispose(): void {
    this.host.dispose();
    this.pending.clear();
    this.handlers.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Compile                                                             */
/* ------------------------------------------------------------------ */

export interface NarrowApi {
  React: typeof React;
  h: typeof React.createElement;
  useState: typeof React.useState;
  useEffect: typeof React.useEffect;
  useRef: typeof React.useRef;
  mcp: HostMcpApi;
  /** The artifact's own sheet binding (scoped data API, not host state). */
  BINDING: unknown;
  /** SVG bar-chart component: props-only data, no data access. */
  AppChart: typeof AppChart;
}

export type AppComponent = React.ComponentType;

/**
 * Compile app source to a React component. The source is normalized
 * first (App params stripped, narrow-API React destructures stripped),
 * then compiled with new Function receiving ONLY the narrow API.
 * Throws on any failure — the caller renders the message visibly.
 */
export function compileAppSource(source: string, api: NarrowApi): AppComponent {
  const normalized = normalizeAppSource(source);
  const factory = new Function(
    'React',
    'h',
    'useState',
    'useEffect',
    'useRef',
    'mcp',
    'BINDING',
    'AppChart',
    `${normalized}\n;return App;`,
  ) as (
    ...args: [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown]
  ) => unknown;
  const App = factory(
    api.React,
    api.h,
    api.useState,
    api.useEffect,
    api.useRef,
    api.mcp,
    api.BINDING,
    api.AppChart,
  );
  if (typeof App !== 'function') {
    throw new Error('Generated app does not define function App()');
  }
  return App as AppComponent;
}
