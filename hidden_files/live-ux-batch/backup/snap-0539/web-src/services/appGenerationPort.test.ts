/**
 * AppGenerationPort lanes (FIX-E):
 * - local lane: generateAndSaveArtifact runs in-process over the
 *   injected MCP call (unchanged behavior);
 * - gateway lane: generation is delegated to the agent service via
 *   deps.gatewayGenerate, the returned spec is upserted into the SAME
 *   web artifact store, and the local MCP call is never touched.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createArtifactStore,
  generateAndSaveArtifact,
  memoryPersistence,
  type ArtifactSpec,
  type GenerateArtifactResult,
  type MetadataStore,
} from '@icecream-sheets/service';
import { createAppGenerationPort } from './appGenerationPort';

const SHEET_CELLS = [
  ['Name', 'Hours'],
  ['Alice', 8],
  ['Bob', 6],
];

const stubCallTool = async (tool: string) => {
  if (tool === 'get_results') return { cells: SHEET_CELLS };
  throw new Error(`unexpected tool ${tool}`);
};

function freshStore(): MetadataStore<ArtifactSpec> {
  return createArtifactStore(memoryPersistence());
}

/** Mint a genuine artifact spec through the real local flow. */
async function mintSpec(): Promise<ArtifactSpec> {
  const store = freshStore();
  const result = await generateAndSaveArtifact(
    { prompt: 'build a data table app', sheet: 'Sheet1' },
    { callTool: stubCallTool, store, principal: 'test-user', template: 'data-table' },
  );
  if (result.routed !== 'app') throw new Error('mint failed');
  return result.spec;
}

describe('createAppGenerationPort', () => {
  it('local lane: generates through the injected MCP call and saves to the store', async () => {
    const store = freshStore();
    const port = createAppGenerationPort({
      getMcpCall: async () => stubCallTool,
      getStore: () => store,
      getSheet: () => 'Sheet1',
    });
    const out = await port.generateApp({ prompt: 'build a data table app' });
    expect(out.reactSource).toContain('function App(');
    expect(out.artifactMeta.artifactId).toBeTruthy();
    expect(store.all()).toHaveLength(1);
  });

  it('gateway lane: delegates, upserts the returned spec, never touches local MCP', async () => {
    const spec = await mintSpec();
    const store = freshStore();
    const getMcpCall = vi.fn(async () => {
      throw new Error('local MCP must not be used in the gateway lane');
    });
    const gatewayGenerate = vi.fn(
      async (): Promise<GenerateArtifactResult> => ({ routed: 'app', spec }),
    );
    const port = createAppGenerationPort({
      getMcpCall,
      getStore: () => store,
      getSheet: () => 'Sheet1',
      gatewayGenerate,
    });
    const out = await port.generateApp({ prompt: 'build a data table app' });
    expect(gatewayGenerate).toHaveBeenCalledWith('build a data table app', 'Sheet1');
    expect(getMcpCall).not.toHaveBeenCalled();
    expect(out.reactSource).toBe(spec.source);
    expect(out.artifactMeta.artifactId).toBe(spec.id);
    expect(store.all().map((a) => a.id)).toEqual([spec.id]);
  });

  it('gateway lane: a non-app result surfaces its reason', async () => {
    const port = createAppGenerationPort({
      getMcpCall: async () => stubCallTool,
      getStore: () => freshStore(),
      getSheet: () => 'Sheet1',
      gatewayGenerate: async (): Promise<GenerateArtifactResult> => ({
        routed: 'not-artifact',
        reason: 'not an app request',
      }),
    });
    await expect(port.generateApp({ prompt: 'hello' })).rejects.toThrow('not an app request');
  });
});
