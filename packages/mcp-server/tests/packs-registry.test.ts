/**
 * Skill-pack registry + manifest tests: the bundled set is exactly
 * the three packs, selection fails closed on unknown ids, the
 * manifests on disk (packs/<id>/pack.json) mirror the registered
 * manifests, and a server built with a selection exposes only that
 * pack's tools (plus list_skill_packs) over the real MCP protocol.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerOptions } from '../src/server.js';
import {
  SKILL_PACKS,
  manifestOf,
  packsFromEnv,
  resolveSkillPacks,
} from '../src/packs/index.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  return JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function makeClient(options?: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(undefined, options);
  await server.connect(serverTransport);
  const client = new Client({ name: 'pack-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((t) => t.name).sort();
}

describe('skill pack registry', () => {
  it('bundles exactly the three packs', () => {
    expect(SKILL_PACKS.map((p) => p.id)).toEqual([
      'data-cleaning',
      'financial-modeling',
      'survey-analysis',
    ]);
    for (const pack of SKILL_PACKS) {
      expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pack.tools.length).toBeGreaterThan(0);
      expect(pack.prompts.length).toBeGreaterThan(0);
    }
  });

  it('resolveSkillPacks defaults to all and fails closed on unknown ids', () => {
    expect(resolveSkillPacks().map((p) => p.id)).toEqual([
      'data-cleaning',
      'financial-modeling',
      'survey-analysis',
    ]);
    expect(resolveSkillPacks(['survey-analysis']).map((p) => p.id)).toEqual(['survey-analysis']);
    expect(() => resolveSkillPacks(['nope'])).toThrow(/unknown skill pack "nope"/);
    expect(() => createServer(undefined, { packs: ['nope'] })).toThrow(/unknown skill pack/);
  });

  it('packsFromEnv parses MCP_PACKS', () => {
    expect(packsFromEnv(undefined)).toBeUndefined();
    expect(packsFromEnv('')).toBeUndefined();
    expect(packsFromEnv('  ')).toBeUndefined();
    expect(packsFromEnv('data-cleaning, survey-analysis')).toEqual([
      'data-cleaning',
      'survey-analysis',
    ]);
  });

  it('pack.json on disk mirrors each registered manifest', () => {
    for (const pack of SKILL_PACKS) {
      const url = new URL(`../packs/${pack.id}/pack.json`, import.meta.url);
      const onDisk = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
      expect(onDisk).toEqual(JSON.parse(JSON.stringify(manifestOf(pack))));
    }
  });
});

describe('skill packs over the MCP protocol', () => {
  it('default server installs every pack plus list_skill_packs', async () => {
    const client = await makeClient();
    const names = await toolNames(client);
    for (const pack of SKILL_PACKS) {
      for (const tool of pack.tools) expect(names).toContain(tool);
    }
    expect(names).toContain('list_skill_packs');
    // Core count is derived (not hardcoded) so adding a core tool
    // (e.g. search_web/fetch_web_page) does not break this test.
    const core = await toolNames(await makeClient({ packs: [] }));
    const allPackTools = SKILL_PACKS.flatMap((p) => p.tools);
    expect(names).toEqual([...new Set([...core, ...allPackTools])].sort());

    const listed = payloadOf(
      await client.callTool({ name: 'list_skill_packs', arguments: {} }),
    );
    expect(listed.ok).toBe(true);
    const packs = listed.packs as { id: string; tools: string[] }[];
    expect(packs.map((p) => p.id)).toEqual([
      'data-cleaning',
      'financial-modeling',
      'survey-analysis',
    ]);
  });

  it('a selection installs only that pack', async () => {
    const client = await makeClient({ packs: ['data-cleaning'] });
    const names = await toolNames(client);
    expect(names).toContain('clean_dedupe_rows');
    expect(names).toContain('list_skill_packs');
    expect(names.some((n) => n.startsWith('fin_'))).toBe(false);
    expect(names.some((n) => n.startsWith('survey_'))).toBe(false);
    // Core tools are unaffected by pack selection.
    expect(names).toContain('read_cells');
    // Derived counts: core tools plus only the selected pack's tools.
    const core = await toolNames(await makeClient({ packs: [] }));
    const selected = SKILL_PACKS.find((p) => p.id === 'data-cleaning')?.tools ?? [];
    expect(names).toEqual([...new Set([...core, ...selected])].sort());
  });

  it('pack example prompts are real MCP prompts', async () => {
    const client = await makeClient();
    const listed = await client.listPrompts();
    const names = listed.prompts.map((p) => p.name);
    expect(names).toContain('data-cleaning.dedupe-and-tidy-orders');
    expect(names).toContain('financial-modeling.value-this-project');
    expect(names).toContain('survey-analysis.code-open-text');
    const got = await client.getPrompt({
      name: 'data-cleaning.dedupe-and-tidy-orders',
      arguments: {},
    });
    const first = got.messages[0]?.content;
    expect(first?.type).toBe('text');
    expect((first as { text: string }).text).toContain('clean_dedupe_rows');
  });
});
