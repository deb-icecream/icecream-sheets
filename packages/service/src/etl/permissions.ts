/**
 * ETL permission enforcement (design-docs/etl-pipeline.md §6).
 *
 * "Permissions follow the permission model: the recipe is an object in the
 * permission tree, the manage right is required to edit it and running it
 * requires read on the credential and write on the target."
 *
 * This module is the authorize() wiring the runner's old optional
 * `checkPermission` hook never had: it turns a structural authorize() port
 * into the §6 checks, and the runner calls it whenever the host supplies
 * an authorize port (no host hook required anymore).
 *
 * Object ids:
 * - recipe:            `etl:recipe:<recipeId>`
 * - credential (vault): `etl:credential:<credentialRef>`
 * - load target:        workbook-table loads reuse the permission model's
 *                       workbook object id `workbook:<workbookId>` so
 *                       workbook grants apply; adapter loads use
 *                       `etl:adapter:<adapterId>`.
 *
 * Actions:
 * - `etl.manage`          — edit a recipe (manage right on the recipe object)
 * - `etl.credential.read` — read a credential the recipe's source uses
 * - `etl.target.write`    — write the recipe's load target
 *
 * Hosts provide the policy behind the authorize() port (e.g.
 * accessPolicy() composed with the protection policy); this module only
 * decides WHICH action/target pairs §6 requires. Denials throw — the
 * runner treats a thrown permission error as a hard failure, never as a
 * failed run record.
 */

import type { EtlRecipe, LoadTarget } from './recipe.js';

/** Structural authorize() port — mirrors the engine's Policy signature. */
export interface AuthorizePort {
  (action: string, target: string, ctx: { principal: string }): boolean;
}

/** Action: edit a recipe — needs the manage right on the recipe object. */
export const ETL_MANAGE_ACTION = 'etl.manage';
/** Action: run a recipe — needs read on each credential it uses. */
export const ETL_CREDENTIAL_READ_ACTION = 'etl.credential.read';
/** Action: run a recipe — needs write on the load target. */
export const ETL_TARGET_WRITE_ACTION = 'etl.target.write';

/** `etl:recipe:<recipeId>` — the recipe as an object in the permission tree. */
export function etlRecipeObjectId(recipeId: string): string {
  assertNonEmpty(recipeId, 'recipeId');
  return `etl:recipe:${recipeId}`;
}

/** `etl:credential:<credentialRef>` — a vault credential the recipe reads. */
export function etlCredentialObjectId(credentialRef: string): string {
  assertNonEmpty(credentialRef, 'credentialRef');
  return `etl:credential:${credentialRef}`;
}

/**
 * The load target as a permission-tree object. Workbook-table loads reuse
 * the permission model's `workbook:<id>` object id so ordinary workbook
 * grants decide write access; adapter loads are namespaced under ETL.
 */
export function etlLoadTargetObjectId(target: LoadTarget): string {
  if (target.kind === 'workbook-table') {
    assertNonEmpty(target.workbookId, 'target.workbookId');
    return `workbook:${target.workbookId}`;
  }
  assertNonEmpty(target.adapterId, 'target.adapterId');
  return `etl:adapter:${target.adapterId}`;
}

/** Every credential reference a recipe's connector sources read. */
export function credentialRefsOfRecipe(recipe: EtlRecipe): string[] {
  const refs = new Set<string>();
  for (const node of recipe.nodes) {
    if (node.kind === 'source' && node.source.type === 'connector') {
      refs.add(node.source.credentialRef);
    }
  }
  return [...refs];
}

/** The recipe's load node target. Throws when the recipe has no load node. */
export function loadTargetOfRecipe(recipe: EtlRecipe): LoadTarget {
  const load = recipe.nodes.find((n) => n.kind === 'load');
  if (!load || load.kind !== 'load') {
    throw new Error(`etl: recipe '${recipe.id}' has no load node`);
  }
  return load.target;
}

function assertNonEmpty(v: string, name: string): void {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`etl permissions: ${name} must be a non-empty string`);
  }
}

function assertPrincipal(principal: string): void {
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new Error('etl permissions: missing principal (fail closed)');
  }
}

/**
 * Enforce the manage right before editing a recipe
 * (design-docs/etl-pipeline.md §6: "the manage right is required to edit
 * it"). Throws on denial; a throwing policy also denies (fail closed).
 */
export function checkRecipeEdit(
  authorize: AuthorizePort,
  recipeId: string,
  principal: string,
): void {
  assertPrincipal(principal);
  const objectId = etlRecipeObjectId(recipeId);
  let allowed = false;
  try {
    allowed = authorize(ETL_MANAGE_ACTION, objectId, { principal }) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new Error(
      `etl: denied — principal '${principal}' lacks the manage right on recipe '${recipeId}'`,
    );
  }
}

/**
 * Build the run permission check for a recipe
 * (design-docs/etl-pipeline.md §6: "running it requires read on the
 * credential and write on the target"). The returned function throws on the
 * first denied check; it is the default `checkPermission` the runner uses
 * when the host supplies an authorize port.
 */
export function makeRecipeRunCheck(
  authorize: AuthorizePort,
  principal: string,
): (recipe: EtlRecipe) => Promise<void> {
  assertPrincipal(principal);
  return async (recipe: EtlRecipe): Promise<void> => {
    const deny = (what: string): never => {
      throw new Error(`etl: denied — principal '${principal}' may not run recipe '${recipe.id}' (${what})`);
    };
    for (const ref of credentialRefsOfRecipe(recipe)) {
      let allowed = false;
      try {
        allowed = authorize(ETL_CREDENTIAL_READ_ACTION, etlCredentialObjectId(ref), { principal }) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) deny(`no read on credential '${ref}'`);
    }
    const target = etlLoadTargetObjectId(loadTargetOfRecipe(recipe));
    let allowed = false;
    try {
      allowed = authorize(ETL_TARGET_WRITE_ACTION, target, { principal }) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) deny(`no write on load target '${target}'`);
  };
}
