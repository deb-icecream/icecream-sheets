/**
 * #64 — generateAndSaveArtifact distinguishes a MISSING sheet from a
 * generation failure.
 *
 * A sheet that does not exist is a user-caused bad reference: the flow
 * throws the typed SheetNotFoundError (HTTP layers map it to a clean
 * 4xx) instead of travelling downstream as a generic failure that the
 * gateway used to surface as a 502. The existence check goes through
 * the existing list_sheets MCP tool and is FAIL-OPEN: when the tool
 * surface cannot list sheets, the legacy flow runs exactly as before.
 */
import { describe, expect, it } from 'vitest';
import {
  SheetNotFoundError,
  generateAndSaveArtifact,
  type ArtifactSink,
  type McpCallFn,
} from '../src/artifacts/index.js';

const store: ArtifactSink & { specs: unknown[] } = {
  specs: [],
  add(spec) {
    this.specs.push(spec);
  },
};

const CELLS = [
  ['Item', 'Qty'],
  ['Pens', 5],
];

describe('#64 generateAndSaveArtifact sheet existence', () => {
  it('throws SheetNotFoundError for a missing sheet, before reading it', async () => {
    const calls: string[] = [];
    const callTool: McpCallFn = async (tool) => {
      calls.push(tool);
      if (tool === 'list_sheets') return { sheets: ['Sheet1'] };
      throw new Error(`should not be called for a missing sheet: ${tool}`);
    };
    await expect(
      generateAndSaveArtifact(
        { prompt: 'build a data table app', sheet: 'Nope' },
        { callTool, store, template: 'data-table' },
      ),
    ).rejects.toBeInstanceOf(SheetNotFoundError);
    await expect(
      generateAndSaveArtifact(
        { prompt: 'build a data table app', sheet: 'Nope' },
        { callTool, store, template: 'data-table' },
      ),
    ).rejects.toThrow('Sheet "Nope" does not exist in this workbook.');
    expect(calls).toEqual(['list_sheets', 'list_sheets']);
  });

  it('generates as before when the sheet exists', async () => {
    const callTool: McpCallFn = async (tool) => {
      if (tool === 'list_sheets') return { sheets: ['Sheet1'] };
      if (tool === 'get_results') return { cells: CELLS };
      throw new Error(`unexpected tool ${tool}`);
    };
    const result = await generateAndSaveArtifact(
      { prompt: 'build a data table app', sheet: 'Sheet1' },
      { callTool, store, template: 'data-table' },
    );
    expect(result.routed).toBe('app');
  });

  it('fails open when list_sheets is unavailable (legacy flow unchanged)', async () => {
    const callTool: McpCallFn = async (tool) => {
      if (tool === 'list_sheets') throw new Error('mock: unexpected tool list_sheets');
      if (tool === 'get_results') return { cells: CELLS };
      throw new Error(`unexpected tool ${tool}`);
    };
    const result = await generateAndSaveArtifact(
      { prompt: 'build a data table app', sheet: 'Sheet1' },
      { callTool, store, template: 'data-table' },
    );
    expect(result.routed).toBe('app');
  });
});
