// packages/cli/test/unit/ops/operations.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { operationsOp } from '../../../src/ops/operations.js';
import { CALCULATOR_WSDL, removeTempDirs, restItem, restProject, SOAP_ITEM, soapProject } from './helpers.js';

afterEach(removeTempDirs);

describe('op operations', () => {
  it('lists a SOAP operation with its binding, SOAP action and saved request', async () => {
    const fixture = await soapProject();
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result).toEqual({
      operations: [
        {
          kind: 'soap',
          container: 'CalculatorService',
          binding: 'CalculatorSoap',
          operation: 'Add',
          soapAction: 'urn:wirebench:calculator/Add',
          ref: 'CalculatorService/Add',
          items: [SOAP_ITEM],
        },
      ],
      notes: [],
    });
  });

  it('lists REST endpoints from the cached document, with their operationIds and requests', async () => {
    const fixture = await restProject();
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result.operations.map((row) => row.ref)).toEqual([
      'Pets/GET /pets',
      'Pets/POST /pets',
      'Pets/GET /pets/{petId}',
    ]);
    expect(result.operations[0]).toMatchObject({
      kind: 'rest',
      method: 'GET',
      path: '/pets',
      operationId: 'listPets',
      items: [await restItem(fixture.dir, 'GET', '/pets')],
    });
  });

  it('filters by interface or API, and refuses an unknown one', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());

    const soapOnly = await runOp(operationsOp, { container: 'CalculatorService' }, fixture.base());
    expect(soapOnly.operations.map((row) => row.kind)).toEqual(['soap']);
    await expect(runOp(operationsOp, { container: 'Nope' }, fixture.base())).rejects.toMatchObject({
      code: 'container-not-found',
    });
  });
});
