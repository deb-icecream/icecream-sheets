/** Tests for the deterministic chat-diagram spec derivation (#126, no LLM). */
import { describe, expect, it } from 'vitest';
import { deriveDiagramSpec } from '../src/agent/diagramSpec.js';

describe('deriveDiagramSpec', () => {
  it('derives a process diagram from "from lead to close"', () => {
    const spec = deriveDiagramSpec(
      'Create a diagram inside the sheet showing the sales process from lead to close',
    );
    expect(spec.layout).toBe('process');
    expect(spec.items).toEqual(['Lead', 'Close']);
    expect(spec.title).toBe('Process diagram');
  });

  it('derives an arrow chain', () => {
    const spec = deriveDiagramSpec('Create a diagram: Lead -> Prospect -> Close');
    expect(spec.items).toEqual(['Lead', 'Prospect', 'Close']);
  });

  it('derives a hierarchy layout from an org prompt', () => {
    const spec = deriveDiagramSpec('Insert a hierarchy diagram in the sheet for the team structure');
    expect(spec.layout).toBe('hierarchy');
  });

  it('derives a cycle layout', () => {
    const spec = deriveDiagramSpec('Add a cycle diagram to the sheet');
    expect(spec.layout).toBe('cycle');
  });

  it('falls back to the dialog defaults when no steps are stated', () => {
    const spec = deriveDiagramSpec('Create a diagram in the sheet');
    expect(spec.layout).toBe('process');
    expect(spec.items).toEqual(['Step 1', 'Step 2', 'Step 3', 'Step 4']);
  });

  it('caps items at 6', () => {
    const spec = deriveDiagramSpec('Diagram: A -> B -> C -> D -> E -> F -> G -> H');
    expect(spec.items).toHaveLength(6);
  });
});
