/**
 * Tests for NamedFunctionRegistry (design-docs/named-ranges-and-named-functions.md
 * §§6–7): typed signatures, definition-time checks, versioning/rollback,
 * permissions, LAMBDA compilation, and the JS→formula transpiler.
 */
import { describe, expect, it } from 'vitest';
import {
  NamedFunctionRegistry,
  NameError,
  KeyManager,
  memoryPersistence,
  validateSignature,
  stripTypeScript,
  compileToLambda,
  transpileJsExpressionToFormula,
  parseLambdaRef,
  isExpressionSyntax,
  type CreateNamedFunctionRegistryOptions,
  type NamedFunctionSignature,
} from '../src/index.js';
import { makeInvokeFn } from '../src/names/node.js';

const PRINCIPAL = 'user:alice';
const WB = 'wb-fn-test';
const MGR = 'user:mgr';

const allowAll = () => true;
const denyManage = (action: string) => action !== 'manage';

function keys() {
  return new KeyManager(memoryPersistence());
}

async function registry(
  opts: Partial<CreateNamedFunctionRegistryOptions> = {},
): Promise<NamedFunctionRegistry> {
  return NamedFunctionRegistry.create({
    persistence: memoryPersistence(),
    workbookId: WB,
    invoke: makeInvokeFn(),
    keys: keys(),
    ...opts,
  });
}

const sig = (params: [string, 'number' | 'string' | 'boolean' | 'null' | 'array' | 'any'][], returns: 'number' | 'string' | 'boolean' | 'null' | 'array' | 'any'): NamedFunctionSignature => ({
  params: params.map(([name, type]) => ({ name, type })),
  returns,
});

describe('signature validation (§6)', () => {
  it('accepts a well-formed signature', async () => {
    expect(validateSignature(sig([['x', 'number']], 'number')).params).toHaveLength(1);
  });

  it('rejects unknown types, bad identifiers, duplicates', async () => {
    expect(() => validateSignature({ params: [{ name: 'x', type: 'date' }], returns: 'number' } as never)).toThrowError(NameError);
    expect(() => validateSignature(sig([['9x', 'number']], 'number'))).toThrowError(NameError);
    expect(() =>
      validateSignature(sig([['x', 'number'], ['X', 'number']], 'number')),
    ).toThrowError(/Duplicate/);
    expect(() => validateSignature({ params: [], returns: 'void' } as never)).toThrowError(NameError);
  });
});

describe('define (§6: typed signature checked at definition time)', () => {
  it('defines a JS function and compiles to LAMBDA', async () => {
    const r = await registry();
    const d = await r.define({
      name: 'Double',
      language: 'javascript',
      source: 'x * 2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    expect(d.id).toMatch(/^nf:/);
    expect(d.version).toBe(1);
    expect(d.lambda).toBe('LAMBDA(x,(x*2))');
  });

  it('smoke-checks the return type against the real result', async () => {
    const r = await registry();
    // Declares number but returns a string → rejected at definition time.
    await expect(      r.define({
        name: 'Bad',
        language: 'javascript',
        source: 'String(x)',
        signature: sig([['x', 'number']], 'number'),
        principal: PRINCIPAL,
      })).rejects.toThrowError(/declared return/);
  });

  it('rejects a body that throws on sample args', async () => {
    const r = await registry();
    await expect(      r.define({
        name: 'Boom',
        language: 'javascript',
        source: 'nope.nothing',
        signature: sig([['x', 'number']], 'number'),
        principal: PRINCIPAL,
      })).rejects.toThrowError(/failed on sample/);
  });

  it('defines a Python function (no LAMBDA compile — best effort)', async () => {
    const r = await registry();
    const d = await r.define({
      name: 'PyDouble',
      language: 'python',
      source: 'result = params["x"] * 2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    expect(d.lambda).toBeNull();
  });

  it('rejects Python bodies with imports', async () => {
    const r = await registry();
    await expect(      r.define({
        name: 'PyBad',
        language: 'python',
        source: 'import os\nresult = 1',
        signature: sig([['x', 'number']], 'number'),
        principal: PRINCIPAL,
      })).rejects.toThrowError(/may not import/);
  });

  it('rejects name collisions and function-name shadowing', async () => {
    const r = await registry();
    await r.define({
      name: 'Double',
      language: 'javascript',
      source: 'x*2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    await expect(      r.define({
        name: 'DOUBLE',
        language: 'javascript',
        source: 'x*2',
        signature: sig([['x', 'number']], 'number'),
        principal: PRINCIPAL,
      })).rejects.toThrowError(/already exists/);
    await expect(
      r.define({
        name: 'SUM',
        language: 'javascript',
        source: 'x',
        signature: sig([['x', 'number']], 'number'),
        principal: PRINCIPAL,
      }),
    ).resolves.not.toThrow(); // no reserved set injected → host decides shadowing policy
  });

  it('reservedNames blocks built-in shadowing', async () => {
    const r = await registry({ reservedNames: new Set(['SUM']) });
    await expect(
      r.define({
        name: 'sum',
        language: 'javascript',
        source: 'x',
        signature: sig([['x', 'number']], 'number'),
        principal: PRINCIPAL,
      }),
    ).rejects.toThrowError(/function name/);
  });
});

describe('versioning (§7)', () => {
  it('update bumps the version and retains history', async () => {
    const r = await registry();
    const d = await r.define({
      name: 'Double',
      language: 'javascript',
      source: 'x * 2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    const v2 = await r.update(d.id, { source: 'x * 3', principal: PRINCIPAL, note: 'triple it' });
    expect(v2.version).toBe(2);
    expect(v2.source).toBe('x * 3');
    expect(v2.versions).toHaveLength(1);
    expect(v2.versions[0]).toMatchObject({ version: 1, source: 'x * 2', note: 'triple it' });
  });

  it('rollback restores as a new version (history append-only)', async () => {
    const r = await registry();
    const d = await r.define({
      name: 'Double',
      language: 'javascript',
      source: 'x * 2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    await r.update(d.id, { source: 'x * 3', principal: PRINCIPAL });
    const rb = await r.rollback(d.id, 1, PRINCIPAL);
    expect(rb.version).toBe(3);
    expect(rb.source).toBe('x * 2');
    expect(rb.versions).toHaveLength(2);
    await expect(r.rollback(d.id, 99, PRINCIPAL)).rejects.toThrowError(/No version 99/);
  });

  it('persists versions across instances', async () => {
    const persistence = memoryPersistence();
    const k = keys();
    const r1 = await NamedFunctionRegistry.create({ persistence, workbookId: WB, invoke: makeInvokeFn(), keys: k });
    const d = await r1.define({
      name: 'Double',
      language: 'javascript',
      source: 'x*2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    await r1.update(d.id, { source: 'x*3', principal: PRINCIPAL });
    const r2 = await NamedFunctionRegistry.create({ persistence, workbookId: WB, keys: k });
    const back = r2.get(d.id)!;
    expect(back.version).toBe(2);
    expect(back.versions).toHaveLength(1);
  });

  it('stored bytes are ciphertext, not plaintext (per-workbook key)', async () => {
    const persistence = memoryPersistence();
    const r = await NamedFunctionRegistry.create({
      persistence,
      workbookId: WB,
      invoke: makeInvokeFn(),
      keys: keys(),
    });
    await r.define({
      name: 'SecretDouble',
      language: 'javascript',
      source: 'x*2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    const raw = persistence.load(`icecream-sheets.secure.v1/${WB}/icecream-sheets.named-functions.v1`);
    expect(raw).not.toBeNull();
    for (const secret of ['SecretDouble', 'x*2', PRINCIPAL]) {
      expect(raw as string).not.toContain(secret);
    }
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.ciphertext).toBe('string');
  });
});

describe('permissions (§7)', () => {
  it('editing needs the manage right', async () => {
    const r = await registry({ authorize: denyManage });
    await expect(      r.define({
        name: 'Double',
        language: 'javascript',
        source: 'x*2',
        signature: sig([['x', 'number']], 'number'),
        principal: MGR,
      })).rejects.toThrowError(/manage right/);
  });

  it('using needs read on the workbook', async () => {
    const r = await registry({ authorize: allowAll });
    await r.define({
      name: 'Double',
      language: 'javascript',
      source: 'x*2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    expect(r.checkUseAllowed(PRINCIPAL)).toBe(true);
    const r2 = await registry({ authorize: (a) => a !== 'cell.read' });
    expect(r2.checkUseAllowed('user:nobody')).toBe(false);
  });
});

describe('LAMBDA compilation (best effort)', () => {
  const params = new Set(['x', 'y']);

  it('transpiles the strict subset', async () => {
    expect(transpileJsExpressionToFormula('x * 2', params)).toBe('(x*2)');
    expect(transpileJsExpressionToFormula('x + y * 3', params)).toBe('(x+(y*3))');
    expect(transpileJsExpressionToFormula('x > 1 ? "big" : "small"', params)).toBe(
      'IF((x>1),"big","small")',
    );
    expect(transpileJsExpressionToFormula('x && y', params)).toBe('AND(x,y)');
    expect(transpileJsExpressionToFormula('!x', params)).toBe('NOT(x)');
    expect(transpileJsExpressionToFormula('Math.max(x, y)', params)).toBe('MAX(x,y)');
    expect(transpileJsExpressionToFormula('x ** 2', params)).toBe('(x^2)');
    expect(transpileJsExpressionToFormula('-x', params)).toBe('(-x)');
  });

  it('returns null outside the subset (no globals, no statements)', async () => {
    expect(transpileJsExpressionToFormula('fetch(x)', params)).toBeNull();
    expect(transpileJsExpressionToFormula('unknown + 1', params)).toBeNull();
    expect(transpileJsExpressionToFormula('x % 2', params)).toBeNull();
    expect(transpileJsExpressionToFormula('null', params)).toBeNull();
  });

  it('compileToLambda: expression → LAMBDA, statements → null', async () => {
    const s = sig([['x', 'number']], 'number');
    expect(compileToLambda('javascript', 'x * 2', s)).toBe('LAMBDA(x,(x*2))');
    expect(compileToLambda('javascript', 'const y = x * 2; y + 1;', s)).toBeNull();
    expect(compileToLambda('python', 'result = 1', s)).toBeNull();
  });

  it('parseLambdaRef handles Excel _xlpm. prefixes', async () => {
    expect(parseLambdaRef('LAMBDA(_xlpm.x,_xlpm.x*2)')).toEqual({
      params: ['x'],
      body: '_xlpm.x*2',
    });
    expect(parseLambdaRef('=LAMBDA(a,b,a+b)')).toEqual({ params: ['a', 'b'], body: 'a+b' });
    expect(parseLambdaRef('SUM(A1:A2)')).toBeNull();
  });
});

describe('TypeScript stripping', () => {
  it('strips erasable annotations', async () => {
    expect(stripTypeScript('(x: number, y?: string): number => x * 2')).toBe(
      '(x,y)=> x * 2',
    );
    expect(stripTypeScript('const v: number = x * 2;')).toBe('const v = x * 2;');
  });

  it('rejects non-erasable constructs with clear errors', async () => {
    expect(() => stripTypeScript('interface I { x: number }')).toThrowError(/interfaces/);
    expect(() => stripTypeScript('const x = y as number;')).toThrowError(/`as` casts/);
    expect(() => stripTypeScript('enum E { A }')).toThrowError(/enums/);
  });

  it('stripped output is valid JS (syntax probe)', async () => {
    expect(isExpressionSyntax(stripTypeScript('(x: number): number => x * 2'))).toBe(true);
  });
});

describe('XLSX mapping (§7: LAMBDA defined names, best effort)', () => {
  it('toDefinedNames exports LAMBDA-compilable functions; skips the rest', async () => {
    const r = await registry();
    await r.define({
      name: 'Double',
      language: 'javascript',
      source: 'x*2',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    await r.define({
      name: 'PyFn',
      language: 'python',
      source: 'result = 1',
      signature: sig([['x', 'number']], 'number'),
      principal: PRINCIPAL,
    });
    const { names, skipped } = r.toDefinedNames();
    expect(names).toEqual([{ name: 'Double', ref: 'LAMBDA(x,(x*2))' }]);
    expect(skipped).toEqual(['PyFn']);
  });

  it('importDefinedNames reads LAMBDA names back (best effort)', async () => {
    const r = await registry();
    const { imported, skipped } = await r.importDefinedNames(
      [
        { name: 'Double', ref: 'LAMBDA(x,x*2)' },
        { name: 'NotLambda', ref: 'Sheet1!$A$1' },
      ],
      PRINCIPAL,
    );
    expect(imported).toHaveLength(1);
    expect(skipped.map((s) => s.name)).toEqual(['NotLambda']);
    const d = r.getByName('double')!;
    expect(d.language).toBe('javascript');
    expect(d.signature.params).toEqual([{ name: 'x', type: 'any' }]);
    expect(d.lambda).toBe('LAMBDA(x,x*2)');
  });
});
