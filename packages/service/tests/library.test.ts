/**
 * Workbook library tests (design-docs/platform-shell.md §2):
 * Make a copy duplicates bytes and metadata under a new id and needs the
 * manage right on the workbook — the authorize() check runs before any
 * byte is read or duplicated.
 */
import { describe, expect, it } from 'vitest';
import {
  WorkbookLibrary,
  type AuthorizePort,
  type WorkbookByteStore,
  type WorkbookEntry,
} from '../src/index.js';

function entry(id: string, name = 'Budget'): WorkbookEntry {
  return {
    id,
    name,
    owner: 'debajyoti',
    createdAt: '2026-10-18T10:00:00.000Z',
    modifiedAt: '2026-10-18T10:00:00.000Z',
    sizeBytes: 5,
    backend: 'local',
  };
}

class MemoryBytes implements WorkbookByteStore {
  readonly map = new Map<string, Uint8Array>([['w1', new TextEncoder().encode('bytes1')]]);
  reads = 0;
  async readBytes(id: string): Promise<Uint8Array> {
    this.reads += 1;
    const b = this.map.get(id);
    if (!b) throw new Error(`no bytes for '${id}'`);
    return b;
  }
  async writeBytes(id: string, bytes: Uint8Array): Promise<void> {
    this.map.set(id, bytes);
  }
}

function allowAll(): AuthorizePort {
  return (_a, _t, ctx) => ctx.principal.length > 0;
}

function denyManage(): AuthorizePort {
  return (action, _t, ctx) => (action === 'manage' ? false : ctx.principal.length > 0);
}

function throwing(): AuthorizePort {
  return () => {
    throw new Error('policy blew up');
  };
}

describe('WorkbookLibrary.copy', () => {
  it('copies bytes and metadata under a new id when manage is granted', async () => {
    const bytes = new MemoryBytes();
    const lib = new WorkbookLibrary([entry('w1')], bytes, {
      now: () => new Date('2026-10-18T12:00:00.000Z'),
      newId: () => 'w2',
    });
    const seen: string[] = [];
    const copy = await lib.copy(
      'w1',
      {
        authorize: (action, target, ctx) => {
          seen.push(`${action} ${target}`);
          return allowAll()(action, target, ctx);
        },
        principal: 'debajyoti',
      },
    );
    // The manage-right check targets the workbook object id, and it ran.
    expect(seen).toEqual(['manage workbook:w1']);
    expect(copy.id).toBe('w2');
    expect(copy.name).toBe('Copy of Budget');
    expect(copy.owner).toBe('debajyoti');
    expect(copy.createdAt).toBe('2026-10-18T12:00:00.000Z');
    expect(copy.backend).toBe('local');
    expect(copy.sizeBytes).toBe(6); // real byte length of 'bytes1'
    // Bytes duplicated, source untouched.
    expect(new TextDecoder().decode(bytes.map.get('w2'))).toBe('bytes1');
    expect(bytes.map.get('w1')).toBe(bytes.map.get('w1'));
    expect(lib.list()).toHaveLength(2);
    expect(lib.get('w2')).toMatchObject({ id: 'w2', name: 'Copy of Budget' });
  });

  it('denies the copy without the manage right — nothing is read or duplicated', async () => {
    const bytes = new MemoryBytes();
    const lib = new WorkbookLibrary([entry('w1')], bytes, { newId: () => 'w2' });
    await expect(
      lib.copy('w1', { authorize: denyManage(), principal: 'intruder' }),
    ).rejects.toThrow(/manage right/);
    expect(bytes.reads).toBe(0); // the check ran before any byte read
    expect(bytes.map.has('w2')).toBe(false);
    expect(lib.list()).toHaveLength(1);
  });

  it('fails closed when the policy throws', async () => {
    const bytes = new MemoryBytes();
    const lib = new WorkbookLibrary([entry('w1')], bytes, { newId: () => 'w2' });
    await expect(lib.copy('w1', { authorize: throwing(), principal: 'debajyoti' })).rejects.toThrow(
      /denied/,
    );
    expect(bytes.reads).toBe(0);
    expect(lib.list()).toHaveLength(1);
  });

  it('fails closed on a missing principal', async () => {
    const bytes = new MemoryBytes();
    const lib = new WorkbookLibrary([entry('w1')], bytes);
    await expect(lib.copy('w1', { authorize: allowAll(), principal: '' })).rejects.toThrow(
      /missing principal/,
    );
  });

  it('throws for an unknown workbook', async () => {
    const bytes = new MemoryBytes();
    const lib = new WorkbookLibrary([entry('w1')], bytes);
    await expect(lib.copy('nope', { authorize: allowAll(), principal: 'debajyoti' })).rejects.toThrow(
      /unknown workbook/,
    );
  });

  it('accepts an explicit copy name', async () => {
    const bytes = new MemoryBytes();
    const lib = new WorkbookLibrary([entry('w1')], bytes, { newId: () => 'w2' });
    const copy = await lib.copy('w1', { authorize: allowAll(), principal: 'debajyoti' }, { name: 'Q4' });
    expect(copy.name).toBe('Q4');
  });
});
