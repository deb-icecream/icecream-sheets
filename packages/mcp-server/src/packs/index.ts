/**
 * Skill-pack registry: the bundled packs and the selection logic.
 *
 * `createServer` installs the packs named by ServerOptions.packs;
 * when no selection is given, EVERY bundled pack is installed. The
 * runners select packs with the MCP_PACKS environment variable
 * (comma-separated pack ids; unset/empty = all bundled packs).
 * Unknown ids fail closed — a typo must never silently start a
 * server with fewer tools than the operator asked for.
 */
import { dataCleaningPack } from './data-cleaning.js';
import { financialModelingPack } from './financial-modeling.js';
import { surveyAnalysisPack } from './survey-analysis.js';
import type { SkillPack } from './types.js';

export { manifestOf, type SkillPack, type SkillPackManifest, type SkillPackPrompt } from './types.js';

/** Every skill pack bundled with this build, in install order. */
export const SKILL_PACKS: SkillPack[] = [dataCleaningPack, financialModelingPack, surveyAnalysisPack];

/**
 * Resolve a pack selection to pack objects. `ids` undefined → all
 * bundled packs. Throws on an unknown id (fail closed).
 */
export function resolveSkillPacks(ids?: string[]): SkillPack[] {
  if (ids === undefined) return [...SKILL_PACKS];
  const wanted = ids.map((id) => id.trim()).filter((id) => id !== '');
  const byId = new Map(SKILL_PACKS.map((p) => [p.id, p]));
  const resolved: SkillPack[] = [];
  for (const id of wanted) {
    const pack = byId.get(id);
    if (!pack) {
      throw new Error(
        `unknown skill pack "${id}" — bundled packs: ${SKILL_PACKS.map((p) => p.id).join(', ')}`,
      );
    }
    if (!resolved.includes(pack)) resolved.push(pack);
  }
  return resolved;
}

/**
 * Parse the MCP_PACKS environment value: comma-separated pack ids.
 * Unset/empty → undefined (meaning: all bundled packs).
 */
export function packsFromEnv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return ids.length > 0 ? ids : undefined;
}
