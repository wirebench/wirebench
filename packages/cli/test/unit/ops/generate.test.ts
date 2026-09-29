// packages/cli/test/unit/ops/generate.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { generateOp } from '../../../src/ops/generate.js';
import { importOp } from '../../../src/ops/import.js';
import {
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  restItem,
  restProject,
  SOAP_ITEM,
  soapProject,
  updateProject,
} from './helpers.js';

afterEach(removeTempDirs);

describe('op generate', () => {
  it('builds a SOAP envelope from the XSD, required elements by default', async () => {
    const fixture = await soapProject();
    const result = await runOp(generateOp, { operation: 'CalculatorService/Add' }, fixture.base());

    expect(result).toMatchObject({
      kind: 'soap',
      operation: 'CalculatorService/Add',
      soapVersion: '1.1',
      soapAction: 'urn:wirebench:calculator/Add',
      problems: [],
    });
    if (result.kind !== 'soap') throw new Error('expected SOAP');
    expect(result.body).toMatch(/<(\w+:)?a>/);
    expect(result.body).not.toMatch(/<(\w+:)?note>/);

    const all = await runOp(generateOp, { operation: 'CalculatorService/Add', optional: 'all' }, fixture.base());
    if (all.kind !== 'soap') throw new Error('expected SOAP');
    expect(all.body).toMatch(/<(\w+:)?note>/);
  });

  it('takes a saved request path as the operation reference', async () => {
    const fixture = await soapProject();
    const result = await runOp(generateOp, { operation: SOAP_ITEM }, fixture.base());
    expect(result.operation).toBe('CalculatorService/Add');
  });

  it('takes a saved REST request path as the operation reference', async () => {
    const fixture = await restProject();
    const result = await runOp(generateOp, { operation: await restItem(fixture.dir, 'POST', '/pets') }, fixture.base());
    expect(result.operation).toBe('Pets/POST /pets');
  });

  it('builds a JSON body from the schema, by METHOD path or by operationId', async () => {
    const fixture = await restProject();
    const byPath = await runOp(generateOp, { operation: 'Pets/post /pets' }, fixture.base());
    const byId = await runOp(generateOp, { operation: 'Pets/createPet' }, fixture.base());

    expect(byPath).toEqual(byId);
    expect(byPath).toMatchObject({
      kind: 'rest',
      operation: 'Pets/POST /pets',
      method: 'POST',
      path: '/pets',
      contentType: 'application/json',
      headers: { 'Content-Type': 'application/json' },
    });
    if (byPath.kind !== 'rest' || byPath.body === undefined) throw new Error('expected a REST body');
    expect(Object.keys(JSON.parse(byPath.body) as object)).toEqual(['name']);

    const list = await runOp(generateOp, { operation: 'Pets/GET /pets' }, fixture.base());
    expect(list).toMatchObject({ kind: 'rest', method: 'GET', headers: {} });
    expect(list).not.toHaveProperty('body');
  });

  it('refuses an unknown operation, and one whose definition is not cached', async () => {
    const fixture = await soapProject();
    await expect(runOp(generateOp, { operation: 'CalculatorService/Subtract' }, fixture.base())).rejects.toMatchObject({
      code: 'operation-not-found',
    });

    const uncached = await emptyProject();
    await updateProject(uncached.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: CALCULATOR_WSDL }, uncached.base());
    await expect(runOp(generateOp, { operation: 'CalculatorService/Add' }, uncached.base())).rejects.toMatchObject({
      code: 'definition-cache-missing',
    });
  });
});
