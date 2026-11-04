// @vitest-environment node
/**
 * Auto-open regression guard (demo fix, owner 2026-10-25).
 *
 * A loop-generated app must OPEN AUTOMATICALLY in the side panel on
 * completion — no Apps-tab navigation, no row click. The loop path
 * (gateway mode) previously only set the message artifact footprint
 * (pill) and persisted the spec, leaving the app closed until the
 * user clicked. runChatTurn must call openArtifactById for the loop
 * artifact right after persisting it, so the lane opens at once.
 * (Runtime behavior is proven by the browser proof; this guards the
 * call against silent removal.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function runChatTurnArtifactBlock(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'AgentChat.tsx'), 'utf8');
  const marker = 'persist the full spec BEFORE the message renders its';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('artifact persist block not found in AgentChat.tsx');
  return src.slice(at, at + 900);
}

describe('loop app auto-open (demo fix)', () => {
  it('runChatTurn opens the loop artifact after persisting it', () => {
    const block = runChatTurnArtifactBlock();
    expect(block).toContain('artifactStore.add(reply.artifact)');
    expect(block).toContain('openArtifactById(reply.artifact.id)');
    // The open must come AFTER the persist, so the store resolves it.
    expect(block.indexOf('openArtifactById(reply.artifact.id)')).toBeGreaterThan(
      block.indexOf('artifactStore.add(reply.artifact)'),
    );
  });
});
