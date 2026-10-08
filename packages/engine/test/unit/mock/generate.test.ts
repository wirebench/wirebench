/**
 * The headless path a CLI takes (#61): generate a mock from a cached contract, save it with the
 * project, load it back, start it, and get the generated stub over HTTP — for SOAP and for REST.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateMock, startMock } from '../../../src/index.js';
import type { RunningMock } from '../../../src/index.js';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { listTree, tempProjectDir } from '../project/fixture.js';
import { mockProject, wsdlFixture } from './fixture.js';

const running: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
});

describe('generateMock', () => {
  it('generates, saves, reloads and serves a SOAP mock', async () => {
    const { dir, project } = await mockProject({ wsdl: wsdlFixture('public/calculator/service.wsdl') });
    const mock = await generateMock(project, dir, 'I1', { name: 'Calculator mock' });
    expect(mock.source.binding).toBe('{http://tempuri.org/}CalculatorSoap');
    expect(mock.operations.map((o) => o.name)).toEqual(['Add', 'Subtract', 'Multiply', 'Divide']);
    await saveProject({ ...project, mocks: [mock] }, dir);
    expect(await listTree(dir)).toContain('mocks/Calculator mock/operations/Add/Default.response.yaml');

    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    const m = await startMock({ project: loaded, root: dir, mockId: mock.id });
    running.push(m);
    const reply = await fetch(m.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', SOAPAction: '"http://tempuri.org/Add"' },
      body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Add xmlns="http://tempuri.org/"><intA>1</intA><intB>2</intB></Add></s:Body></s:Envelope>',
    });
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain('AddResponse');
  });

  it('generates, saves, reloads and serves a REST mock', async () => {
    const spec = join(await tempProjectDir(), 'openapi.yaml');
    await writeFile(
      spec,
      "openapi: 3.0.3\ninfo: { title: T, version: '1' }\npaths:\n  /ping:\n    get:\n      operationId: ping\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              example: { pong: true }\n",
    );
    const { dir, project } = await mockProject({ openapi: pathToFileURL(spec).href });
    const mock = await generateMock(project, dir, 'A1', { name: 'Ping mock' });
    await saveProject({ ...project, mocks: [mock] }, dir);
    const { project: loaded } = await loadProject(dir);
    const m = await startMock({ project: loaded, root: dir, mockId: mock.id });
    running.push(m);
    const reply = await fetch(`${m.url}ping`);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ pong: true });
  });

  it('picks a slug no other mock has, and orders after them', async () => {
    const { dir, project } = await mockProject({ wsdl: wsdlFixture('public/calculator/service.wsdl') });
    const first = await generateMock(project, dir, 'I1', { name: 'Calc' });
    const second = await generateMock({ ...project, mocks: [first] }, dir, 'I1', { name: 'Calc' });
    expect(second.slug).not.toBe(first.slug);
    expect(second.order).toBe(first.order + 1);
  });

  it('refuses a container that is not there', async () => {
    const { dir, project } = await mockProject({});
    await expect(generateMock(project, dir, 'nope', { name: 'x' })).rejects.toMatchObject({
      code: 'mock-container-missing',
    });
  });
});
