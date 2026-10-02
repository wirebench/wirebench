import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiDefinitionDir, createApi, definitionCacheDir, loadProject, saveProject } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import {
  CALCULATOR_WSDL,
  emptyProject,
  PETS_OPENAPI,
  removeTempDirs,
  SECRET,
  startServer,
  tempDir,
  updateProject,
} from './helpers.js';

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

  it('gives an interface another slug than an API, so the next save keeps the API', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({ ...project, apis: [createApi('Shop', { id: 'A1' })] }));

    const result = await runOp(importOp, { source: CALCULATOR_WSDL, name: 'Shop' }, fixture.base());

    expect(result.added[0]).toMatchObject({ kind: 'soap', name: 'Shop', slug: 'Shop-2' });
    const { project, problems } = await loadProject(fixture.dir);
    expect(problems).toEqual([]);
    expect(project.apis.map((api) => api.slug)).toEqual(['Shop']);
    await saveProject(project, fixture.dir);
    await access(join(fixture.dir, 'apis', 'Shop', 'api.yaml'));
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
    // A source that does not exist: the gate answers first, so nothing was read.
    await expect(
      runOp(
        importOp,
        { source: join(fixture.dir, 'missing.wsdl') },
        fixture.base({ gates: { write: false, send: true } }),
      ),
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

  it('imports by URL and redacts the URLs its problems quote', async () => {
    const fixture = await emptyProject();
    const wsdl = (await readFile(CALCULATOR_WSDL, 'utf8')).replace(
      '<wsdl:types>',
      `<wsdl:types><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:import namespace="urn:wirebench:other" schemaLocation="http://127.0.0.1:9/x.xsd?api_key=${SECRET}"/></xs:schema>`,
    );
    const server = await startServer(() => ({ body: wsdl }));
    try {
      const source = `${server.url}/calculator.wsdl`;
      const result = await runOp(importOp, { source }, fixture.base());

      expect(server.received.map((request) => request.url)).toContain('/calculator.wsdl');
      expect(result.added[0]).toMatchObject({ kind: 'soap', name: 'CalculatorService' });
      expect(result.problems.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      const { project } = await loadProject(fixture.dir);
      expect(project.interfaces[0]?.definitionUrl).toBe(source);
    } finally {
      await server.close();
    }
  });

  it('does not read the proxy variables for a file import', async () => {
    const fixture = await emptyProject();
    const result = await runOp(
      importOp,
      { source: CALCULATOR_WSDL },
      fixture.base({ env: { HTTP_PROXY: 'not a url', HTTPS_PROXY: 'not a url' } }),
    );
    expect(result.added).toHaveLength(1);
  });

  it('refuses a URL import under a malformed proxy variable as invalid input, not an internal error', async () => {
    const fixture = await emptyProject();
    const call = runOp(
      importOp,
      { source: 'http://127.0.0.1:9/calculator.wsdl' },
      fixture.base({ env: { HTTP_PROXY: 'not a url' } }),
    );
    await expect(call).rejects.toMatchObject({ code: 'invalid-input', message: 'HTTP_PROXY is not a valid URL' });
  });

  it('reports a definition cache it could not write and keeps the import', async () => {
    const fixture = await emptyProject();
    // A file where the cache folder should be lets the save through and fails the cache write.
    await mkdir(join(fixture.dir, 'interfaces', 'CalculatorService'), { recursive: true });
    await writeFile(join(fixture.dir, 'interfaces', 'CalculatorService', 'definition'), 'in the way');
    const result = await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    const problem = result.problems.find((found) => found.code === 'definition-cache-write-failed');
    expect(problem?.message).toMatch(/; import it again once the folder is writable$/);
    const { project } = await loadProject(fixture.dir);
    expect(project.interfaces).toHaveLength(1);
  });
});
