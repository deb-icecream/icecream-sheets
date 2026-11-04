// @vitest-environment node
/**
 * Hooks-order invariant for the App shell (#92/#94 regression pin).
 *
 * App renders three shell surfaces by early return — the login gate,
 * the share-accept interstitial, and the Workspace — before the final
 * grid return. Any React hook defined AFTER one of those returns is
 * skipped on the short-circuit renders, so an in-place transition to
 * the grid (e.g. sign-in returning to a file) calls MORE hooks than
 * the previous render and React unmounts the whole app (blank page,
 * "Rendered more hooks than during the previous render").
 *
 * This test pins the structural rule: every hook the grid path needs
 * is defined ABOVE the first shell-routing early return, and no hook
 * definition appears after the Workspace return at all.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

const GATE = 'if (gwClient && !gwAuthed && !isDesktop()) {';
const WORKSPACE = 'if (gwClient && gwAuthed && !collabFileId && productApi';

const GRID_HOOKS = [
  'const gridIsCellLocked = useCallback(',
  'const gridIsCellHiddenVisible = useCallback(',
  'const toggleDataTypeCard = useCallback(',
  'const toggleSmartChipCard = useCallback(',
  'const statusCollaborators = useMemo(',
  'const agentVoiceCommand = useMemo(',
];

describe('App shell hooks order', () => {
  it('defines the grid-path hooks above the login-gate early return', () => {
    const gateIdx = src.indexOf(GATE);
    expect(gateIdx).toBeGreaterThan(-1);
    for (const hook of GRID_HOOKS) {
      const idx = src.indexOf(hook);
      expect(idx, `${hook} must exist`).toBeGreaterThan(-1);
      expect(idx, `${hook} must be defined before the gate return`).toBeLessThan(gateIdx);
    }
  });

  it('has no hook definitions after the Workspace early return', () => {
    const wsIdx = src.indexOf(WORKSPACE);
    expect(wsIdx).toBeGreaterThan(-1);
    const after = src.slice(wsIdx);
    const hookDefs = after.match(/=\s*use(State|Effect|Ref|Memo|Callback|Reducer|Context)\(/g) ?? [];
    expect(hookDefs).toEqual([]);
  });

  it('has no hook calls of ANY form after the login-gate return (bare + custom hooks)', () => {
    // The blanket rule below matches only assignment-style definitions
    // (`const x = useEffect(`). A bare `useEffect(() => ...)` statement
    // or a custom hook call (`useSessionSync(...)`) after a shell return
    // breaks the same invariant — it runs on the fall-through (grid)
    // renders and is skipped on the early-return renders — while
    // passing the defs-only regex. The cycle-2 desktop blank window
    // (React #300, "Rendered fewer hooks than expected") was the
    // mirror image of #92/#94's #310: desktop boot renders the grid
    // first (gwAuthed still false), then the async auth snapshot takes
    // the Workspace early return and the six grid hooks that used to
    // live below it were skipped. Scan for every hook-call token, not
    // just definitions.
    const gateIdx = src.indexOf(GATE);
    expect(gateIdx).toBeGreaterThan(-1);
    const after = src.slice(gateIdx);
    const hookCalls = after.match(/\buse[A-Z][A-Za-z0-9]*\s*\(/g) ?? [];
    expect(hookCalls).toEqual([]);
  });

  it('has no hook definitions after the login-gate return at all (blanket rule)', () => {
    // Stronger form of the rule: the gate is the FIRST shell-routing
    // return, so "no hooks below it" covers the share-accept zone and
    // the Workspace return too. Any hook landing below ANY shell return
    // is a latent "rendered more/fewer hooks" crash on the in-place
    // transition that crosses that return (web sign-in; desktop auth
    // snapshot flips take sibling branches of the same shell).
    const gateIdx = src.indexOf(GATE);
    expect(gateIdx).toBeGreaterThan(-1);
    const after = src.slice(gateIdx);
    const hookDefs = after.match(/=\s*use(State|Effect|Ref|Memo|Callback|Reducer|Context)\(/g) ?? [];
    expect(hookDefs).toEqual([]);
  });
});
