/**
 * App-builder sample template tests (src/appbuilder/templates.ts).
 * Every shipped template must be a valid AppSpec in the same format
 * user-built apps use (no-code-app-builder.md §7).
 */
import { describe, expect, it } from 'vitest';
import {
  APP_TEMPLATES,
  appTemplateIds,
  getAppTemplate,
} from '../src/appbuilder/templates.js';
import { validateAppSpec } from '../src/appbuilder/spec.js';

describe('APP_TEMPLATES', () => {
  it('ships the expected templates', () => {
    expect(appTemplateIds().sort()).toEqual([
      'contact-directory',
      'expense-tracker',
      'inventory-manager',
      'project-dashboard',
    ]);
  });

  it('has unique template and app ids', () => {
    const ids = APP_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const appIds = APP_TEMPLATES.map((t) => t.spec.id);
    expect(new Set(appIds).size).toBe(appIds.length);
  });

  it('every template spec validates', () => {
    for (const t of APP_TEMPLATES) {
      const v = validateAppSpec(t.spec);
      expect(v.ok, `${t.id}: ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it('navigation points at a real initial view and every view is reachable', () => {
    for (const t of APP_TEMPLATES) {
      const viewIds = new Set(t.spec.views.map((v) => v.id));
      expect(viewIds.has(t.spec.navigation.initialViewId)).toBe(true);
      for (const v of t.spec.views) {
        expect(t.spec.navigation.viewOrder ?? []).toContain(v.id);
      }
    }
  });

  it('suggested headers match the bound columns', () => {
    for (const t of APP_TEMPLATES) {
      const cols = t.spec.dataSource.columns ?? [];
      expect(t.suggestedHeaders).toEqual(cols.map((c) => c.name));
      expect(t.suggestedSheet).toBe(t.spec.dataSource.binding.sheet);
    }
  });

  it('getAppTemplate finds by id and misses on unknown', () => {
    expect(getAppTemplate('expense-tracker')?.name).toBe('Expense Tracker');
    expect(getAppTemplate('nope')).toBeUndefined();
  });

  it('delete actions require confirmation', () => {
    for (const t of APP_TEMPLATES) {
      for (const a of t.spec.actions) {
        if (a.kind === 'deleteRow') expect(a.requiresConfirm).toBe(true);
      }
    }
  });
});
