/**
 * A `${…}` in a contract's own text reaches the wire as written, through `send` (a request the
 * import generated) and through a contract tool's call alike: it never reads the sending process's
 * environment (#223).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProject, soapInterfacesOf } from '@wirebench/engine';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { callOp } from '../../../src/ops/call.js';
import { runOp } from '../../../src/ops/context.js';
import { generateOp } from '../../../src/ops/generate.js';
import { importOp } from '../../../src/ops/import.js';
import { sendOp } from '../../../src/ops/send.js';
import {
  addEnvironment,
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  restItem,
  SOAP_ITEM,
  startServer,
  tempDir,
  updateProject,
} from './helpers.js';
import type { Fixture, TestServer } from './helpers.js';

const PROBE = '${#System#WB_PROBE_223}';
const LEAK = 'leaked-from-the-environment';

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

beforeAll(() => {
  process.env['WB_PROBE_223'] = LEAK;
});

afterAll(() => {
  delete process.env['WB_PROBE_223'];
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

/**
 * The calculator with a `fixed` element, a required `fixed` attribute and a SOAP action that each hold
 * a `${…}`; the element optional or required.
 */
async function craftedSoap(homeOccurs: 'optional' | 'required'): Promise<{ fixture: Fixture; server: TestServer }> {
  const min = homeOccurs === 'optional' ? ' minOccurs="0"' : '';
  const original = await readFile(CALCULATOR_WSDL, 'utf8');
  const file = join(await tempDir(), 'calculator-crafted.wsdl');
  await writeFile(
    file,
    original
      .replace(
        '<xs:element name="note" type="xs:string" minOccurs="0"/>',
        `<xs:element name="note" type="xs:string" minOccurs="0"/><xs:element name="home" type="xs:string"${min} fixed="${PROBE}"/>`,
      )
      // A required fixed attribute: the argument check never asks for it, so the call writes it in.
      .replace(
        '</xs:sequence>',
        `</xs:sequence><xs:attribute name="origin" type="xs:string" use="required" fixed="${PROBE}"/>`,
      )
      .replace('soapAction="urn:wirebench:calculator/Add"', `soapAction="urn:wirebench:calculator/${PROBE}"`),
  );
  const fixture = await emptyProject();
  await runOp(importOp, { source: file }, fixture.base());
  const server = await startServer(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
  servers.push(server);
  await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
  return { fixture, server };
}

const OPENAPI = `openapi: 3.0.3
info:
  title: Files
  version: 1.0.0
servers:
  - url: http://127.0.0.1:9
paths:
  /files/\${home}:
    get:
      operationId: listFiles
      parameters:
        # OpenAPI reads the {home} of the path as this parameter: the path is "$" and then its value.
        - name: home
          in: path
          required: true
          schema:
            type: string
          example: p1
        - name: q
          in: query
          required: true
          schema:
            type: string
            default: '${PROBE}'
      responses:
        '200':
          description: ok
`;

async function craftedRest(): Promise<{ fixture: Fixture; server: TestServer }> {
  const file = join(await tempDir(), 'files.openapi.yaml');
  await writeFile(file, OPENAPI);
  const fixture = await emptyProject();
  await runOp(importOp, { source: file }, fixture.base());
  const server = await startServer(() => ({ headers: { 'Content-Type': 'application/json' }, body: '[]' }));
  servers.push(server);
  await addEnvironment(fixture.dir, 'local', { Files: server.url });
  // A project property of the same name, which the path's `${home}` must not read.
  await updateProject(fixture.dir, (project) => ({ ...project, properties: { ...project.properties, home: LEAK } }));
  return { fixture, server };
}

describe('a ${ from the contract', () => {
  it('generate: shows the contract text as written, for SOAP as for REST', async () => {
    const { fixture } = await craftedSoap('required');
    const soap = await runOp(generateOp, { operation: 'CalculatorService/Add' }, fixture.base());
    expect(soap).toMatchObject({ kind: 'soap', soapAction: `urn:wirebench:calculator/${PROBE}` });
    if (soap.kind === 'soap') {
      expect(soap.body).toContain(`>${PROBE}</`);
      expect(soap.body).toContain(`origin="${PROBE}"`);
      expect(soap.body).not.toContain(`$${PROBE}`);
      expect(soap.headers['SOAPAction']).toBe(`"urn:wirebench:calculator/${PROBE}"`);
    }
    const rest = await runOp(
      generateOp,
      { operation: 'Files/GET /files/${home}' },
      (await craftedRest()).fixture.base(),
    );
    expect(rest).toMatchObject({ kind: 'rest', path: '/files/${home}' });
  });

  it('send: an XSD fixed value, a fixed attribute and the SOAP action go out literally', async () => {
    const { fixture, server } = await craftedSoap('required');
    await runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base());

    const [received] = server.received;
    expect(received?.body).toContain(`>${PROBE}</`);
    expect(received?.body).toContain(`origin="${PROBE}"`);
    expect(received?.headers['soapaction']).toBe(`"urn:wirebench:calculator/${PROBE}"`);
    expect(JSON.stringify(received)).not.toContain(LEAK);
  });

  it("a contract tool's call: a fixed attribute and the SOAP action go out literally; a ${ argument is refused", async () => {
    const { fixture, server } = await craftedSoap('optional');
    const call = (args: Record<string, unknown>) =>
      runOp(
        callOp,
        { tool: 'calculator_service_add', ref: 'CalculatorService/Add', args: { environment: 'local', ...args } },
        fixture.base(),
      );
    // The fixed value is a required argument, and an argument holding `${` is refused before anything is built.
    await expect(call({ a: 1, b: 2, home: PROBE })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(server.received).toEqual([]);

    await call({ a: 1, b: 2 });
    const [received] = server.received;
    expect(received?.body).toContain(`origin="${PROBE}"`);
    expect(received?.headers['soapaction']).toBe(`"urn:wirebench:calculator/${PROBE}"`);
    expect(JSON.stringify(received)).not.toContain(LEAK);
  });

  it('send: an OpenAPI path and a default go out literally', async () => {
    const { fixture, server } = await craftedRest();
    const item = await restItem(fixture.dir, 'GET', '/files/${home}');
    await runOp(sendOp, { item, environment: 'local' }, fixture.base());

    const [received] = server.received;
    expect(decodeURIComponent(received?.url ?? '')).toBe(`/files/$p1?q=${PROBE}`);
    expect(JSON.stringify(received)).not.toContain(LEAK);
  });

  it("a contract tool's call: an OpenAPI path goes out literally", async () => {
    const { fixture, server } = await craftedRest();
    await runOp(
      callOp,
      {
        tool: 'files_list_files',
        ref: 'Files/GET /files/${home}',
        args: { environment: 'local', path: { home: 'p2' }, query: { q: 'x' } },
      },
      fixture.base(),
    );

    const [received] = server.received;
    expect(decodeURIComponent(received?.url ?? '')).toBe('/files/$p2?q=x');
    expect(JSON.stringify(received)).not.toContain(LEAK);
  });

  it('import and send: a soap:address goes out literally, held escaped on the endpoint', async () => {
    const server = await startServer(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    servers.push(server);
    const original = await readFile(CALCULATOR_WSDL, 'utf8');
    const file = join(await tempDir(), 'calculator-address.wsdl');
    await writeFile(file, original.replace('http://127.0.0.1:9/calculator', `${server.url}/calc/\${home}`));
    const fixture = await emptyProject();
    await runOp(importOp, { source: file }, fixture.base());
    // A project property of the same name, which the address's `${home}` must not read.
    await updateProject(fixture.dir, (project) => ({ ...project, properties: { ...project.properties, home: LEAK } }));

    const { project } = await loadProject(fixture.dir);
    expect(soapInterfacesOf(project)[0]?.endpoints.map((endpoint) => endpoint.url)).toEqual([
      `${server.url}/calc/$\${home}`,
    ]);

    await runOp(sendOp, { item: SOAP_ITEM }, fixture.base());
    const [received] = server.received;
    expect(decodeURIComponent(received?.url ?? '')).toBe('/calc/${home}');
    expect(JSON.stringify(received)).not.toContain(LEAK);
  });
});
