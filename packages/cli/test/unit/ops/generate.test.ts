// packages/cli/test/unit/ops/generate.test.ts
import { loadProject, REDACTED_MARKER } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { generateOp } from '../../../src/ops/generate.js';
import { importOp } from '../../../src/ops/import.js';
import {
  CALCULATOR_WSDL,
  emptyProject,
  exampleOpenApi,
  removeTempDirs,
  restItem,
  restProject,
  SOAP_ITEM,
  SECRET,
  soapProject,
  twoBindingWsdl,
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

  it('resolves a reference by the interface slug, and names the operation as the interface is named', async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({ ...iface, name: 'Calculator (renamed)' })),
    }));
    const bySlug = await runOp(generateOp, { operation: 'CalculatorService/Add' }, fixture.base());
    const byName = await runOp(generateOp, { operation: 'Calculator (renamed)/Add' }, fixture.base());
    expect(bySlug).toEqual(byName);
    expect(bySlug.operation).toBe('Calculator (renamed)/Add');
  });

  it('refuses a request path that names no saved request, or is only a folder', async () => {
    const soap = await soapProject();
    await expect(runOp(generateOp, { operation: 'CalculatorService/Add/garbage' }, soap.base())).rejects.toMatchObject({
      code: 'operation-not-found',
    });

    const rest = await restProject();
    const item = await restItem(rest.dir, 'GET', '/pets');
    await expect(runOp(generateOp, { operation: `${item}/extra` }, rest.base())).rejects.toMatchObject({
      code: 'operation-not-found',
    });
    await expect(runOp(generateOp, { operation: 'Pets/pets' }, rest.base())).rejects.toMatchObject({
      code: 'operation-not-found',
    });
  });

  it('refers to each of two same-named operations by slug, and refuses their shared name', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await twoBindingWsdl() }, fixture.base());
    const { project } = await loadProject(fixture.dir);
    const slugs = project.interfaces.flatMap((iface) => iface.operations.map((operation) => operation.slug));
    expect(slugs).toHaveLength(2);
    expect(new Set(slugs).size).toBe(2);

    const versions: string[] = [];
    for (const slug of slugs) {
      const result = await runOp(generateOp, { operation: `CalculatorService/${slug}` }, fixture.base());
      expect(result.operation).toBe(`CalculatorService/${slug}`);
      if (result.kind !== 'soap') throw new Error('expected SOAP');
      versions.push(result.soapVersion);
    }
    expect([...versions].sort()).toEqual(['1.1', '1.2']);

    // Both operations own `Request 1`, so that item path names two operations.
    await expect(runOp(generateOp, { operation: SOAP_ITEM }, fixture.base())).rejects.toMatchObject({
      code: 'item-ambiguous',
    });
  });

  it('refuses a name that two operations share and no slug spells', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await twoBindingWsdl() }, fixture.base());
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        operations: iface.operations.map((operation, index) => ({ ...operation, slug: `Add-${String(index + 1)}` })),
      })),
    }));
    await expect(runOp(generateOp, { operation: 'CalculatorService/Add' }, fixture.base())).rejects.toMatchObject({
      code: 'item-ambiguous',
      message: expect.stringContaining('CalculatorService/Add-2') as unknown,
    });
    const first = await runOp(generateOp, { operation: 'CalculatorService/Add-1' }, fixture.base());
    expect(first.operation).toBe('CalculatorService/Add-1');
  });

  it('refuses a reference that an interface and an API both resolve, and takes the one that does', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        name: 'Shared',
        operations: iface.operations.map((operation) => ({ ...operation, name: 'listPets', slug: 'listPets' })),
      })),
      apis: project.apis.map((api) => ({ ...api, name: 'Shared' })),
    }));
    await expect(runOp(generateOp, { operation: 'Shared/listPets' }, fixture.base())).rejects.toMatchObject({
      code: 'item-ambiguous',
      message: expect.stringMatching(/interface Shared\/listPets.*API Shared\/GET \/pets/) as unknown,
    });
    // Only the API has this one.
    const result = await runOp(generateOp, { operation: 'Shared/createPet' }, fixture.base());
    expect(result.operation).toBe('Shared/POST /pets');
  });

  it('includes optional properties of a REST body with optional: all', async () => {
    const fixture = await restProject();
    const result = await runOp(generateOp, { operation: 'Pets/createPet', optional: 'all' }, fixture.base());
    if (result.kind !== 'rest' || result.body === undefined) throw new Error('expected a REST body');
    expect(Object.keys(JSON.parse(result.body) as object)).toEqual(['name', 'tag']);
  });

  it('masks a password in an OpenAPI example, keeps ${secret} text as written, and prefers the example', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await exampleOpenApi() }, fixture.base());
    const result = await runOp(generateOp, { operation: 'Login/login', optional: 'required' }, fixture.base());
    if (result.kind !== 'rest' || result.body === undefined) throw new Error('expected a REST body');
    expect(result.body).not.toContain(SECRET);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body).toMatchObject({ user: 'alice', note: '${secret}' });
    expect(body['password']).not.toBe(SECRET);
    expect(body['password']).toBe(REDACTED_MARKER);
  });

  it('leaves the body out when the operation declares neither a schema nor an example', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await exampleOpenApi() }, fixture.base());
    const result = await runOp(generateOp, { operation: 'Login/ping' }, fixture.base());
    expect(result).toMatchObject({ kind: 'rest', method: 'POST', contentType: 'application/json' });
    expect(result).not.toHaveProperty('body');
  });
});
