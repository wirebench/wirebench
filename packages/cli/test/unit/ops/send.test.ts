import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGrpcApi, createWsApi, loadProject, REDACTED_MARKER } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { MAX_STORED_CHARS } from '../../../src/ops/history-entry.js';
import { sendOp } from '../../../src/ops/send.js';
import {
  addEnvironment,
  removeTempDirs,
  restItem,
  restProject,
  SECRET,
  SOAP_ITEM,
  soapProject,
  startServer,
  updateProject,
  updateRestRequest,
} from './helpers.js';
import type { TestServer } from './helpers.js';

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

async function server(...args: Parameters<typeof startServer>): Promise<TestServer> {
  const started = await startServer(...args);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await removeTempDirs();
});

async function historyText(historyDir: string): Promise<string> {
  return readFile(join(historyDir, 'mcp-fixture.jsonl'), 'utf8');
}

describe('updateRestRequest', () => {
  it('changes a request inside a folder, and throws when none matched', async () => {
    const fixture = await restProject();
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({ ...request, name: 'Renamed' }));
    const item = await restItem(fixture.dir, 'GET', '/pets');
    expect(item).toBe('Pets/pets/Renamed');
    await expect(updateRestRequest(fixture.dir, 'GET', '/nowhere', (request) => request)).rejects.toThrow(
      'no request for GET /nowhere',
    );
  });
});

describe('op send', () => {
  it('sends a SOAP request under an environment, and writes a tagged History entry', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: `${calculator.url}/calculator` });

    const result = await runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base());

    expect(result).toMatchObject({
      item: SOAP_ITEM,
      kind: 'soap',
      outcome: 'passed',
      unasserted: true,
      method: 'POST',
      url: `${calculator.url}/calculator`,
      status: 200,
      assertions: [],
    });
    expect(result.body).toContain('<c:result>5</c:result>');
    expect(calculator.received[0]?.headers['soapaction']).toContain('urn:wirebench:calculator/Add');

    const [line] = (await historyText(fixture.historyDir)).trim().split('\n');
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      id: result.historyId,
      kind: 'soap',
      projectId: 'mcp-fixture',
      requestName: 'Request 1',
      interfaceName: 'CalculatorService',
      operationName: 'Add',
      status: 200,
      ok: true,
      tags: ['mcp'],
    });
  });

  it('sends a REST request with a secret header, and masks it in the result and in History', async () => {
    const fixture = await restProject();
    const pets = await server((request) => ({
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': `session=${SECRET}` },
      body: JSON.stringify([{ id: 1, name: 'Rex', key: request.headers['x-api-key'] }]),
    }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      headers: [...request.headers, { name: 'X-Api-Key', value: '${secret:petsKey}', enabled: true }],
    }));
    const item = await restItem(fixture.dir, 'GET', '/pets');

    const result = await runOp(
      sendOp,
      { item, environment: 'local' },
      fixture.base({ env: { WIREBENCH_SECRET_PETSKEY: SECRET }, origin: 'cli' }),
    );

    expect(pets.received[0]?.headers['x-api-key']).toBe(SECRET);
    expect(result).toMatchObject({ kind: 'rest', method: 'GET', status: 200, outcome: 'passed' });
    expect(result.headers['set-cookie']).toBe(REDACTED_MARKER);
    expect(result.body).toContain('Rex');
    // The server echoed the header back in its body: the masker hides it there too.
    expect(result.body).toContain(REDACTED_MARKER);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const history = await historyText(fixture.historyDir);
    expect(history).not.toContain(SECRET);
    expect(history).toContain('"tags":["cli"]');
  });

  it('reports a failing assertion as failed, and takes a body without saving it', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
      body: ADD_RESPONSE,
    }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        operations: iface.operations.map((operation) => ({
          ...operation,
          requests: operation.requests.map((request) => ({
            ...request,
            assertions: [{ type: 'status', equals: 200 }],
          })),
        })),
      })),
    }));
    const body =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
      '<c:Add xmlns:c="urn:wirebench:calculator"><c:a>2</c:a><c:b>3</c:b></c:Add></soapenv:Body></soapenv:Envelope>';

    const result = await runOp(sendOp, { item: SOAP_ITEM, environment: 'local', body }, fixture.base());

    expect(result.outcome).toBe('failed');
    expect(result.assertions[0]).toMatchObject({ type: 'status', outcome: 'failed' });
    expect(calculator.received[0]?.body).toBe(body);
    const { project } = await loadProject(fixture.dir);
    expect(project.interfaces[0]?.operations[0]?.requests[0]?.envelopeXml).not.toBe(body);
  });

  it('fails with the engine code when no response came, and writes no History', async () => {
    const fixture = await soapProject();
    const closed = await server(() => ({ body: '' }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: closed.url });
    await closed.close();
    servers.splice(servers.indexOf(closed), 1);

    await expect(runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base())).rejects.toMatchObject({
      code: 'connection-refused',
    });
    await expect(historyText(fixture.historyDir)).rejects.toThrow();
  });

  it('still returns the result, without a historyId, when History is busy, and warns', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });
    // A fresh lock file is a live writer's: the append waits for it, then gives up.
    await writeFile(join(fixture.historyDir, 'mcp-fixture.jsonl.lock'), 'held-by-a-test');

    const result = await runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base());

    expect(result).toMatchObject({ status: 200, outcome: 'passed' });
    expect(result).not.toHaveProperty('historyId');
    expect(fixture.warnings).toEqual([expect.stringContaining('history-busy') as unknown]);
  }, 15_000);

  it('masks a secret across the 256 KiB cut, so no prefix of it survives', async () => {
    const fixture = await restProject();
    const pets = await server((request) => ({
      headers: { 'Content-Type': 'text/plain' },
      body: `${'x'.repeat(MAX_STORED_CHARS - 10)}${String(request.headers['x-api-key'])}tail`,
    }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      headers: [...request.headers, { name: 'X-Api-Key', value: '${secret:petsKey}', enabled: true }],
    }));
    const item = await restItem(fixture.dir, 'GET', '/pets');

    const result = await runOp(
      sendOp,
      { item, environment: 'local' },
      fixture.base({ env: { WIREBENCH_SECRET_PETSKEY: SECRET } }),
    );

    expect(result.bodyTruncated).toBe(true);
    expect(result.body).not.toContain(SECRET.slice(0, 8));
    expect(await historyText(fixture.historyDir)).not.toContain(SECRET.slice(0, 8));
  });

  it('names the variable to set when a secret is missing', async () => {
    const fixture = await restProject();
    const pets = await server(() => ({ body: '[]' }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      headers: [...request.headers, { name: 'X-Api-Key', value: '${secret:petsKey}', enabled: true }],
    }));
    const item = await restItem(fixture.dir, 'GET', '/pets');

    await expect(runOp(sendOp, { item, environment: 'local' }, fixture.base())).rejects.toMatchObject({
      code: 'secret-missing',
      message: expect.stringContaining('WIREBENCH_SECRET_PETSKEY') as unknown,
    });
    expect(pets.received).toEqual([]);
  });

  it('refuses a body override with any placeholder, and sends nothing', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });
    const base = fixture.base({ env: { WIREBENCH_SECRET_OTHER: SECRET } });
    const saved = process.env['WIREBENCH_SECRET_OTHER'];
    process.env['WIREBENCH_SECRET_OTHER'] = SECRET;
    try {
      for (const body of [
        '<a>${#System#WIREBENCH_SECRET_OTHER}</a>',
        '<a>${secret:other}</a>',
        '<a>${#Project#x}</a>',
        '<a>${x}</a>',
      ]) {
        await expect(runOp(sendOp, { item: SOAP_ITEM, environment: 'local', body }, base)).rejects.toMatchObject({
          code: 'invalid-input',
          message: expect.stringContaining('may not contain ${…} placeholders') as unknown,
        });
      }
    } finally {
      if (saved === undefined) {
        delete process.env['WIREBENCH_SECRET_OTHER'];
      } else {
        process.env['WIREBENCH_SECRET_OTHER'] = saved;
      }
    }
    expect(calculator.received).toEqual([]);
  });

  it('sends a REST body override as given, and refuses one over a form body', async () => {
    const fixture = await restProject();
    const pets = await server(() => ({ status: 201, headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    const item = await restItem(fixture.dir, 'POST', '/pets');

    const sent = await runOp(sendOp, { item, environment: 'local', body: '{"name":"Rex"}' }, fixture.base());
    expect(sent).toMatchObject({ kind: 'rest', method: 'POST', status: 201 });
    expect(pets.received[0]?.body).toBe('{"name":"Rex"}');

    await updateRestRequest(fixture.dir, 'POST', '/pets', (request) => ({
      ...request,
      body: { kind: 'form', fields: [] },
    }));
    await expect(
      runOp(sendOp, { item, environment: 'local', body: '{"name":"Rex"}' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'invalid-input', message: expect.stringContaining('form body') as unknown });
    expect(pets.received).toHaveLength(1);

    // Without the override the form body goes, and History keeps '' for a body with no text form.
    const plain = await runOp(sendOp, { item, environment: 'local' }, fixture.base());
    const lines = (await historyText(fixture.historyDir)).trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1] ?? '{}') as { id: string; request: { envelopeXml: string } };
    expect(entry.id).toBe(plain.historyId);
    expect(entry.request.envelopeXml).toBe('');
  });

  it('refuses without the send gate, outside the allowed environments, and without an environment', async () => {
    const fixture = await soapProject();
    await addEnvironment(fixture.dir, 'local', { CalculatorService: 'http://127.0.0.1:9' });
    await addEnvironment(fixture.dir, 'prod', { CalculatorService: 'http://127.0.0.1:9' });

    await expect(
      runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base({ gates: { write: true, send: false } })),
    ).rejects.toMatchObject({ code: 'send-not-allowed', message: expect.stringContaining('--allow-send') as unknown });
    await expect(
      runOp(
        sendOp,
        { item: SOAP_ITEM, environment: 'prod' },
        fixture.base({ gates: { write: true, send: true, environments: ['local'] } }),
      ),
    ).rejects.toMatchObject({ code: 'environment-not-allowed' });
    await expect(runOp(sendOp, { item: SOAP_ITEM }, fixture.base())).rejects.toMatchObject({
      code: 'environment-required',
    });
  });

  it('refuses a send under no environment when --env narrows it', async () => {
    const fixture = await soapProject();
    const narrowed = fixture.base({ gates: { write: true, send: true, environments: ['local'] } });

    await expect(runOp(sendOp, { item: SOAP_ITEM }, narrowed)).rejects.toMatchObject({
      code: 'environment-not-allowed',
    });
  });

  it('refuses an unknown item, and WebSocket and gRPC requests', async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      wsApis: [createWsApi('Chat', { id: 'ws-chat' })],
      grpcApis: [createGrpcApi('Greeter', { id: 'grpc-greeter' })],
    }));

    await expect(runOp(sendOp, { item: 'CalculatorService/Add/Nope' }, fixture.base())).rejects.toMatchObject({
      code: 'item-not-found',
    });
    await expect(runOp(sendOp, { item: 'Chat/Hello' }, fixture.base())).rejects.toMatchObject({
      code: 'unsupported-kind',
    });
    await expect(runOp(sendOp, { item: 'Greeter/SayHello' }, fixture.base())).rejects.toMatchObject({
      code: 'unsupported-kind',
    });
  });
});
