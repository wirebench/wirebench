/**
 * The checker: diagnostics, completion, hover and signature help for a script against its
 * declarations — in-process (the service) and through the worker (the host).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { OpenApiOperation } from '../../../src/rest/openapi/model.js';
import { createScriptChecker } from '../../../src/script/check/host.js';
import {
  MAX_MODELS,
  checkOnce,
  completionsAt,
  diagnosticsOf,
  quickInfoAt,
  removeModel,
  signatureHelpAt,
  updateModel,
} from '../../../src/script/check/service.js';
import { scriptDeclarations } from '../../../src/script/types/api.js';
import { restScriptTypes } from '../../../src/script/types/rest.js';

const pet = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' }, name: { type: 'string', description: 'Its name' } },
};
const OPERATION: OpenApiOperation = {
  method: 'get',
  path: '/pets/{id}',
  parameters: [],
  responses: { '200': { content: { 'application/json': { schema: pet } } } },
};
const DECLARATIONS = scriptDeclarations('rest', 'post', ['signing-key'], restScriptTypes(OPERATION));

describe('the checker service', () => {
  it('reports a wrong path with its position', () => {
    const source = 'if (response.status === 200) {\n  log(response.json().pett);\n}\n';
    expect(checkOnce({ source, declarations: DECLARATIONS, api: 'wirebench' })).toEqual([
      expect.objectContaining({ line: 2, column: 23, endLine: 2, endColumn: 27, severity: 'error', code: 2339 }),
    ]);
    expect(checkOnce({ source: source.replace('pett', 'name'), declarations: DECLARATIONS, api: 'wirebench' })).toEqual(
      [],
    );
  });

  it('refuses syntax that cannot be erased', () => {
    const errors = checkOnce({
      source: 'enum Color { Red }\nlog(Color.Red);',
      declarations: DECLARATIONS,
      api: 'wirebench',
    });
    expect(errors.map((e) => e.code)).toContain(1294);
  });

  it('checks only the syntax of a Postman script', () => {
    expect(
      checkOnce({ source: 'pm.test("x", () => { pm.expect(1).to.equal(1); });', declarations: '', api: 'postman' }),
    ).toEqual([]);
    expect(checkOnce({ source: 'pm.test("x", () => {', declarations: '', api: 'postman' })).toHaveLength(1);
  });

  it('completes, describes and helps with a signature', () => {
    const source = 'if (response.status === 200) {\n  response.json().\n}\ncrypto.hmac(';
    updateModel('m1', { source, declarations: DECLARATIONS, api: 'wirebench' });
    const names = completionsAt('m1', 2, 19).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'name']));
    expect(names.some((n) => n.startsWith('Wb'))).toBe(false);
    expect(quickInfoAt('m1', 1, 5)).toMatchObject({ text: expect.stringContaining('response') as unknown });
    expect(signatureHelpAt('m1', 4, 13)).toMatchObject({
      parameters: expect.arrayContaining([expect.stringContaining('algorithm')]) as unknown,
      activeParameter: 0,
    });
    expect(diagnosticsOf('m1').length).toBeGreaterThan(0);
    removeModel('m1');
    expect(() => diagnosticsOf('m1')).toThrow(/No script model/);
  });

  it('keeps at most MAX_MODELS models, dropping the least recently used', () => {
    for (let i = 0; i <= MAX_MODELS; i++) {
      updateModel(`lru-${String(i)}`, { source: 'log(1);', declarations: DECLARATIONS, api: 'wirebench' });
    }
    expect(() => diagnosticsOf('lru-0')).toThrow(/No script model/);
    expect(diagnosticsOf(`lru-${String(MAX_MODELS)}`)).toEqual([]);
    for (let i = 0; i <= MAX_MODELS; i++) removeModel(`lru-${String(i)}`);
  });
});

describe('createScriptChecker', () => {
  const checker = createScriptChecker();
  afterAll(async () => {
    await checker.dispose();
  });

  it('checks and completes on the worker', { timeout: 30_000 }, async () => {
    const model = {
      source: 'if (response.status === 200) {\n  log(response.json().pett);\n}\n',
      declarations: DECLARATIONS,
      api: 'wirebench' as const,
    };
    expect(await checker.check(model)).toHaveLength(1);
    expect(await checker.diagnostics('w1', model)).toHaveLength(1);
    const completions = await checker.completions(
      'w1',
      { ...model, source: 'if (response.status === 200) {\n  response.json().\n}\n' },
      2,
      19,
    );
    expect(completions.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'name']));
    expect(await checker.quickInfo('w1', model, 1, 5)).toMatchObject({
      text: expect.stringContaining('response') as unknown,
    });
    expect(await checker.signatureHelp('w1', { ...model, source: 'crypto.hmac(' }, 1, 13)).toBeDefined();
    await checker.remove('w1');
  });

  it('fails a request past its deadline, and rejects after dispose', { timeout: 30_000 }, async () => {
    const slow = createScriptChecker({ deadlineMs: 1 });
    await expect(slow.check({ source: 'log(1);', declarations: DECLARATIONS, api: 'wirebench' })).rejects.toThrow(
      /longer than 1 ms/,
    );
    await slow.dispose();
    await expect(slow.check({ source: '', declarations: '', api: 'wirebench' })).rejects.toThrow(/stopped/);
  });
});
