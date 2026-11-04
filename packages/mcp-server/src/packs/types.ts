/**
 * Skill packs for the Icecream Sheets MCP server.
 *
 * A skill pack is an installable bundle of related MCP tools (plus
 * example prompts) that ships inside this package and registers into
 * the server through the SAME `server.tool` path the core tools use.
 * Pack tools run against the shared EngineHost and every read/write
 * goes through authorize() with the caller's principal — there is no
 * side channel and no privileged pack path.
 *
 * A pack module exports one `SkillPack`: a manifest (id, name,
 * version, tool names, example prompts) and a `register(ctx)` that
 * installs its tools on the server. The registry (./index.js) holds
 * the bundled set; `createServer` installs the packs selected via
 * ServerOptions.packs (default: every bundled pack). Third parties
 * add a pack by adding a module here and one entry in the registry —
 * see packs/README.md (the install guide) for the full walkthrough.
 */
import type { EngineHost, TypedValue } from '@icecream-sheets/engine';
import type { ChartSpec } from '@icecream-sheets/service';
import type { z } from 'zod';

/** Tool result envelope, identical to the core tools' shape. */
export interface PackToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Structural mirror of the server's ChartSink seam (server.ts). */
export interface PackChartSink {
  addChart(
    spec: ChartSpec,
    principal: string,
  ): Promise<{ id: number | string; revision: number }>;
}

/**
 * Everything a pack may touch while registering and handling calls.
 * Built inside createServer from the same closures the core tools use,
 * so pack tools are indistinguishable from core tools on the wire.
 */
export interface PackContext {
  /** Register an MCP tool (same semantics as McpServer.tool). */
  tool<Args>(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Args) => Promise<PackToolResult>,
  ): void;
  /** Register an example prompt as a real MCP prompt. */
  prompt(name: string, description: string, text: string): void;
  /** The shared engine host (the workbook). All access is authorized. */
  engine: EngineHost;
  /** Resolve the acting principal for a tool call (F-10: a bound session identity is authoritative — a mismatching arg throws; unbound servers honor the arg, else the fallback). */
  authOf(args: { principal?: string }): { principal: string };
  /** The optional per-tool principal argument schema (spread into tool schemas). */
  principalSchema: z.ZodTypeAny;
  /** Success envelope: { protocolVersion, ok: true, ...payload }. */
  ok(payload: Record<string, unknown>): PackToolResult;
  /** Failure envelope: { protocolVersion, ok: false, error } with isError. */
  error(message: string): PackToolResult;
  /** Convert a TypedValue matrix to plain JSON values. */
  toJson(values: TypedValue[][]): unknown[][];
  /**
   * Native-chart sink, when the host wired one (FIX-G seam). Absent →
   * chart-creating pack tools fail closed, exactly like create_chart.
   */
  charts?: PackChartSink;
}

/** One example prompt shipped with a pack (also registered as an MCP prompt). */
export interface SkillPackPrompt {
  /** Slug unique within the pack; the MCP prompt name is `<packId>.<name>`. */
  name: string;
  /** Short human title shown in docs and prompt listings. */
  title: string;
  /** The prompt text a user can paste into an MCP client. */
  text: string;
}

/** An installable skill pack: manifest + registration. */
export interface SkillPack {
  /** Stable pack id (kebab-case). Selection surfaces (MCP_PACKS, ServerOptions.packs) use this. */
  id: string;
  /** Human-readable pack name. */
  name: string;
  /** Pack version (semver), versioned independently of the server. */
  version: string;
  /** What the pack does, in one or two sentences. */
  description: string;
  /** Names of the MCP tools this pack registers, in registration order. */
  tools: string[];
  /** Example prompts shipped with the pack. */
  prompts: SkillPackPrompt[];
  /** Install the pack's tools and prompts on the server. */
  register(ctx: PackContext): void;
}

/** The manifest portion of a pack (what pack.json on disk mirrors). */
export interface SkillPackManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  tools: string[];
  prompts: SkillPackPrompt[];
}

/** Extract the serializable manifest from a pack. */
export function manifestOf(pack: SkillPack): SkillPackManifest {
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    description: pack.description,
    tools: [...pack.tools],
    prompts: pack.prompts.map((p) => ({ ...p })),
  };
}
