import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiDefinitionDir, definitionCacheDir, loadProject } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { CALCULATOR_WSDL, emptyProject, PETS_OPENAPI, removeTempDirs, tempDir, updateProject } from './helpers.js';

afterEach(removeTempDirs);

describe('op import', () => {
  it('adds a WSDL as an interface with its definition cached and a request per operation', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());

    expect(result).toEqual({
      format: 'wsdl',
      added: [{ kind: 'soap', name: 'CalculatorService', slug: 'CalculatorService', operations: 1, requests: 1 }],
      problems: [],
    });
    const { project } = await loadProject(fixture.dir);
    const iface = project.interfaces[0];
    expect(iface?.endpoints.map((endpoint) => endpoint.url)).toEqual(['http://127.0.0.1:9/calculator']);
    expect(iface?.operations[0]?.requests[0]?.name).toBe('Request 1');
    expect(iface?.operations[0]?.requests[0]?.soapAction).toBe('urn:wirebench:calculator/Add');
    expect(iface?.operations[0]?.requests[0]?.endpointId).toBe(iface?.endpoints[0]?.id);
    await access(definitionCacheDir(fixture.dir, 'CalculatorService'));
  });

  it('adds an OpenAPI document as an API with its documents cached', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: PETS_OPENAPI }, fixture.base());

    expect(result).toMatchObject({
      format: 'openapi',
      added: [{ kind: 'rest', name: 'Pets', slug: 'Pets', operations: 3, requests: 3 }],
    });
    const { project } = await loadProject(fixture.dir);
    expect(project.apis[0]?.definition).toMatchObject({ source: PETS_OPENAPI, cache: true, version: '3.0.3' });
    await access(apiDefinitionDir(fixture.dir, 'Pets'));
  });

  it('takes a name, and gives a second import of the same definition its own slug', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    const second = await runOp(importOp, { source: CALCULATOR_WSDL, name: 'Calc v2' }, fixture.base());
    expect(second.added[0]).toMatchObject({ name: 'Calc v2', slug: 'Calc v2' });
  });

  it('does not cache a definition when the project does not', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    await expect(access(definitionCacheDir(fixture.dir, 'CalculatorService'))).rejects.toThrow();
  });

  it('refuses without the write gate and leaves the project alone', async () => {
    const fixture = await emptyProject();
    await expect(
      runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base({ gates: { write: false, send: true } })),
    ).rejects.toMatchObject({
      code: 'write-not-allowed',
      message: expect.stringContaining('--allow-write') as unknown,
    });
    const { project } = await loadProject(fixture.dir);
    expect(project.interfaces).toEqual([]);
  });

  it('refuses a format it does not import, and a file it cannot read', async () => {
    const fixture = await emptyProject();
    const proto = join(await tempDir(), 'greeter.proto');
    await writeFile(proto, 'syntax = "proto3";\nservice Greeter {}\n');

    await expect(runOp(importOp, { source: proto }, fixture.base())).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    await expect(runOp(importOp, { source: join(fixture.dir, 'missing.wsdl') }, fixture.base())).rejects.toMatchObject({
      code: 'file-not-found',
    });
  });
});
