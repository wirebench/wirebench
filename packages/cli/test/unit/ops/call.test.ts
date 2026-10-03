import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callOp } from '../../../src/ops/call.js';
import { runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { historyFileFor } from '../../../src/ops/paths.js';
import {
  addEnvironment,
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  SECRET,
  soapProject,
  startServer,
  tempDir,
  updateProject,
} from './helpers.js';
import type { Fixture, Reply, TestServer } from './helpers.js';

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const fault = (reason: string): string =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>' +
  `<faultcode>soapenv:Server</faultcode><faultstring>${reason}</faultstring>` +
  '<detail><x:why xmlns:x="urn:x">disk</x:why></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

async function serving(fixture: Fixture, reply: Reply): Promise<TestServer> {
  const server = await startServer(() => reply);
  servers.push(server);
  await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
  return server;
}

function call(fixture: Fixture, args: Record<string, unknown>, overrides: Partial<OpsBase> = {}) {
  return runOp(callOp, { tool: 'calculator_service_add', ref: 'CalculatorService/Add', args }, fixture.base(overrides));
}

async function historyLines(fixture: Fixture): Promise<Record<string, unknown>[]> {
  const text = await readFile(historyFileFor(fixture.historyDir, 'mcp-fixture'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The calculator, its `note` restricted by an XSD-only pattern the argument check cannot run. */
async function patternProject(): Promise<Fixture> {
  const original = await readFile(CALCULATOR_WSDL, 'utf8');
  const file = join(await tempDir(), 'calculator-pattern.wsdl');
  await writeFile(
    file,
    original.replace(
      '<xs:element name="note" type="xs:string" minOccurs="0"/>',
      '<xs:element name="note" minOccurs="0"><xs:simpleType><xs:restriction base="xs:string">' +
        '<xs:pattern value="\\c+"/></xs:restriction></xs:simpleType></xs:element>',
    ),
  );
  const fixture = await emptyProject();
  await runOp(importOp, { source: file }, fixture.base());
  return fixture;
}

describe('op call, SOAP', () => {
  it('refuses without --allow-send, and sends nothing', async () => {
    const fixture = await soapProject();
    const server = await serving(fixture, { body: ADD_RESPONSE });
    await expect(
      call(fixture, { environment: 'local', a: 1, b: 2 }, { gates: { write: false, send: false } }),
    ).rejects.toMatchObject({ code: 'send-not-allowed' });
    expect(server.received).toEqual([]);
  });

  it('refuses an operation that is gone, arguments the schema refuses, and ${', async () => {
    const fixture = await soapProject();
    await expect(
      runOp(callOp, { tool: 'x', ref: 'CalculatorService/Subtract', args: {} }, fixture.base()),
    ).rejects.toMatchObject({ code: 'operation-gone' });
    await expect(call(fixture, { a: 'two', b: 2 })).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('/a') as unknown,
    });
    await expect(call(fixture, { a: 1, b: 2, note: '${#System#HOME}' })).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });

  it('refuses arguments the XSD refuses, listing the path and message, and sends nothing', async () => {
    const fixture = await patternProject();
    const server = await serving(fixture, { body: ADD_RESPONSE });
    const refused = call(fixture, { environment: 'local', a: 1, b: 2, note: 'not a name' });
    await expect(refused).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringMatching(/not make a valid Add message: .*note/) as unknown,
    });
    expect(server.received).toEqual([]);
    // The same pattern, met, sends.
    await expect(call(fixture, { environment: 'local', a: 1, b: 2, note: 'a-name' })).resolves.toMatchObject({
      ok: true,
    });
    expect(server.received).toHaveLength(1);
  });

  it("follows send's environment rules", async () => {
    const fixture = await soapProject();
    await serving(fixture, { body: ADD_RESPONSE });
    await expect(call(fixture, { a: 1, b: 2 })).rejects.toMatchObject({ code: 'environment-required' });
    await expect(
      call(
        fixture,
        { environment: 'local', a: 1, b: 2 },
        { gates: { write: false, send: true, environments: ['prod'] } },
      ),
    ).rejects.toMatchObject({ code: 'environment-not-allowed' });
  });

  it('refuses with no-endpoint when the interface has none, naming it', async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      // The default endpoint id is left pointing at nothing, as a hand-edited project might.
      interfaces: project.interfaces.map((iface) => ({ ...iface, endpoints: [] })),
    }));
    await expect(call(fixture, { a: 1, b: 2 })).rejects.toMatchObject({
      code: 'no-endpoint',
      message: expect.stringContaining('CalculatorService') as unknown,
    });
  });

  it('sends the envelope, returns the response as JSON, and records an ad-hoc History entry', async () => {
    const fixture = await soapProject();
    const server = await serving(fixture, { headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE });

    const result = await call(fixture, { environment: 'local', a: 2, b: 3, note: 'line one\n  line two' });

    expect(result).toMatchObject({
      tool: 'calculator_service_add',
      operation: 'CalculatorService/Add',
      kind: 'soap',
      status: 200,
      ok: true,
      result: { result: 5 },
      notes: [],
    });
    expect(result.historyId).toMatch(/^[0-9A-Z]{26}$/);
    const sent = server.received[0];
    expect(sent?.body).toMatch(/<(\w+):a>2<\/\1:a>/);
    expect(sent?.body).toContain('line one\n  line two');
    expect(String(sent?.headers['soapaction'])).toContain('urn:wirebench:calculator/Add');
    const [entry] = await historyLines(fixture);
    expect(entry).toMatchObject({
      id: result.historyId,
      kind: 'soap',
      requestName: 'Add (MCP)',
      interfaceName: 'CalculatorService',
      operationName: 'Add',
      tags: ['mcp'],
    });
    expect(entry).not.toHaveProperty('requestId');
  });

  it('returns a body element the operation does not describe as its XML, with a note', async () => {
    const fixture = await soapProject();
    await serving(fixture, {
      headers: { 'Content-Type': 'text/xml' },
      body: ADD_RESPONSE.replace(/AddResponse/g, 'Other'),
    });
    const result = await call(fixture, { environment: 'local', a: 1, b: 2 });
    expect(result).toMatchObject({ ok: true, result: expect.stringContaining('<c:Other') as unknown });
    expect(result.notes).toEqual([expect.stringContaining('kept as its XML') as unknown]);
  });

  it('returns a fault as a normal result, its undeclared detail as XML', async () => {
    const fixture = await soapProject();
    await serving(fixture, { status: 500, headers: { 'Content-Type': 'text/xml' }, body: fault('boom') });
    const result = await call(fixture, { environment: 'local', a: 1, b: 2 });
    expect(result).toMatchObject({
      status: 500,
      ok: false,
      fault: { code: 'soapenv:Server', reason: 'boom', detail: expect.stringContaining('disk') as unknown },
    });
    expect(result).not.toHaveProperty('result');
  });

  it("applies the interface's auth, and masks the secret it resolved", async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        auth: { type: 'basic', username: 'calc', passwordRef: 'calcPass', preemptive: true },
      })),
    }));
    const server = await serving(fixture, {
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
      body: fault(`bad ${SECRET}`),
    });

    const result = await call(
      fixture,
      { environment: 'local', a: 1, b: 2 },
      { env: { WIREBENCH_SECRET_CALCPASS: SECRET } },
    );

    expect(server.received[0]?.headers.authorization).toBe(`Basic ${Buffer.from(`calc:${SECRET}`).toString('base64')}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(await historyLines(fixture))).not.toContain(SECRET);
  });
});
