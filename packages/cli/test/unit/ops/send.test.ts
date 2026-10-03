import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createGrpcApi,
  createWsApi,
  createWsRequest,
  createWsSavedMessage,
  loadProject,
  REDACTED_MARKER,
} from '@wirebench/engine';
import { startTestWsServer } from '@wirebench/engine/test-helpers';
import type { TestWsServer } from '@wirebench/engine/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { MAX_STORED_CHARS } from '../../../src/ops/history-entry.js';
import { sendOp } from '../../../src/ops/send.js';
import {
  addEnvironment,
  emptyProject,
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

  it("shows a failed match on a secret key's value as the marker, not the value", async () => {
    const fixture = await restProject();
    const pets = await server(() => ({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SECRET, name: 'Rex' }),
    }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      assertions: [
        { type: 'match', language: 'jsonpath', expression: '$.token', equals: 'something-else' },
        { type: 'match', language: 'jsonpath', expression: '$.name', equals: 'Fido' },
      ],
    }));
    const item = await restItem(fixture.dir, 'GET', '/pets');

    const result = await runOp(sendOp, { item, environment: 'local' }, fixture.base({ origin: 'cli' }));

    expect(result.outcome).toBe('failed');
    expect(result.assertions).toEqual([
      expect.objectContaining({
        type: 'match',
        outcome: 'failed',
        expected: 'something-else',
        actual: REDACTED_MARKER,
      }),
      expect.objectContaining({ type: 'match', outcome: 'failed', expected: 'Fido', actual: 'Rex' }),
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('masks a credential inside the object a failed JSONPath match read', async () => {
    const fixture = await restProject();
    const pets = await server(() => ({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth: { token: SECRET, user: 'ann' } }),
    }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      assertions: [{ type: 'match', language: 'jsonpath', expression: '$.auth', equals: 'x' }],
    }));
    const item = await restItem(fixture.dir, 'GET', '/pets');

    const result = await runOp(sendOp, { item, environment: 'local' }, fixture.base({ origin: 'cli' }));

    expect(result.assertions[0]).toMatchObject({ outcome: 'failed' });
    expect(JSON.parse(result.assertions[0]?.actual ?? '')).toEqual({ token: REDACTED_MARKER, user: 'ann' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('masks a WS-Security password inside the node a failed XPath match read', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({
      headers: { 'Content-Type': 'text/xml' },
      body: ADD_RESPONSE.replace(
        '<soapenv:Body>',
        '<soapenv:Header><wsse:Security xmlns:wsse="urn:wsse"><wsse:UsernameToken><wsse:Username>ann</wsse:Username>' +
          `<wsse:Password>${SECRET}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body>`,
      ),
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
            assertions: [
              { type: 'match', language: 'xpath', expression: '//*:Header', equals: 'x' },
              { type: 'match', language: 'xpath', expression: '//*:Security', equals: 'x' },
            ],
          })),
        })),
      })),
    }));

    const result = await runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base({ origin: 'cli' }));

    // The Header serialised is cut at 200 characters inside the Password: nothing of it can show.
    expect(result.assertions[0]).toMatchObject({ outcome: 'failed', actual: REDACTED_MARKER });
    // The Security element fits whole: only the Password's text is masked.
    expect(result.assertions[1]?.actual).toContain('<wsse:Username>ann</wsse:Username>');
    expect(result.assertions[1]?.actual).toContain(`<wsse:Password>${REDACTED_MARKER}</wsse:Password>`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
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

  it("masks a resolved secret in a fault's code and reason in History", async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        auth: { type: 'basic', username: 'calc', passwordRef: 'calcPass', preemptive: true },
      })),
    }));
    const calculator = await server(() => ({
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
      body:
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>' +
        `<faultcode>soapenv:Server.${SECRET}</faultcode><faultstring>bad ${SECRET}</faultstring>` +
        '</soapenv:Fault></soapenv:Body></soapenv:Envelope>',
    }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });

    await runOp(
      sendOp,
      { item: SOAP_ITEM, environment: 'local' },
      fixture.base({ env: { WIREBENCH_SECRET_CALCPASS: SECRET } }),
    );

    const history = await historyText(fixture.historyDir);
    const entry = JSON.parse(history.trim()) as { fault?: { code: string; reason: string } };
    expect(entry.fault?.reason).toMatch(/^bad /);
    expect(history).not.toContain(SECRET);
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

  it('keeps every History entry already held, even past the default cap of 1000', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });
    // The desktop's cap preference can exceed 1000; these 1500 are entries the user kept.
    const kept = Array.from({ length: 1500 }, (_, index) =>
      JSON.stringify({
        id: `kept-${String(index).padStart(4, '0')}`,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        projectId: 'mcp-fixture',
        requestName: 'Kept',
        interfaceName: 'CalculatorService',
        operationName: 'Add',
        endpoint: calculator.url,
        soapVersion: '1.1',
        durationMs: 1,
        ok: true,
        status: 200,
        request: { envelopeXml: '<Envelope/>', headers: [] },
        response: { envelopeXml: '<Envelope/>', rawHeaders: [], status: 200, statusText: 'OK' },
        sizeBytes: 11,
      }),
    );
    await writeFile(join(fixture.historyDir, 'mcp-fixture.jsonl'), `${kept.join('\n')}\n`);

    const result = await runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base());

    const lines = (await historyText(fixture.historyDir)).trim().split('\n');
    expect(lines).toHaveLength(1501);
    expect(lines[0]).toContain('"kept-0000"');
    expect(lines[1500]).toContain(`"${String(result.historyId)}"`);
  });

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

  it('refuses an unknown item, and gRPC requests', async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      wsApis: [createWsApi('Chat', { id: 'ws-chat' })],
      grpcApis: [createGrpcApi('Greeter', { id: 'grpc-greeter' })],
    }));

    await expect(runOp(sendOp, { item: 'CalculatorService/Add/Nope' }, fixture.base())).rejects.toMatchObject({
      code: 'item-not-found',
    });
    // send takes WebSocket requests: a reference into a WebSocket API that matches none is not found.
    await expect(runOp(sendOp, { item: 'Chat/Hello' }, fixture.base())).rejects.toMatchObject({
      code: 'item-not-found',
    });
    await expect(runOp(sendOp, { item: 'Greeter/SayHello' }, fixture.base())).rejects.toMatchObject({
      code: 'unsupported-kind',
    });
  });
});

describe('op send on a WebSocket request', () => {
  const sockets: TestWsServer[] = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => socket.close()));
  });

  /** An empty project with one WebSocket request on `url`: a secret header and two saved messages. */
  async function wsProject(url: string): Promise<Awaited<ReturnType<typeof emptyProject>>> {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      wsApis: [
        createWsApi('Chat', {
          id: 'ws-chat',
          slug: 'chat',
          url,
          requests: [
            createWsRequest('Echo', {
              id: 'ws-echo',
              url: '/echo',
              headers: [{ name: 'X-Key', value: '${secret:wsKey}', enabled: true }],
              messages: [
                createWsSavedMessage('Hello', { id: 'm1', content: 'hello' }),
                createWsSavedMessage('Key', { id: 'm2', content: 'key ${secret:wsKey}' }),
              ],
            }),
          ],
        }),
      ],
    }));
    return fixture;
  }

  it('sends the saved messages, returns the frames as a run collects them, and writes a tagged History entry', async () => {
    const echo = await startTestWsServer();
    sockets.push(echo);
    const fixture = await wsProject(echo.url);

    const result = await runOp(
      sendOp,
      { item: 'Chat/Echo' },
      fixture.base({ env: { WIREBENCH_SECRET_WSKEY: SECRET } }),
    );

    expect(echo.handshakes[0]?.headers['x-key']).toBe(SECRET);
    expect(echo.received.map((frame) => frame.payload.toString('utf8'))).toContain(`key ${SECRET}`);
    expect(result).toMatchObject({
      item: 'Chat/Echo',
      kind: 'websocket',
      outcome: 'passed',
      unasserted: true,
      method: 'GET',
      status: 101,
      assertions: [],
    });
    const texts = (result.frames ?? [])
      .filter((frame) => frame.opcode === 'text')
      .map((frame) => [frame.direction, frame.text]);
    // The run closes once a reply has come after the last saved message; the echo of it may or may not beat the close.
    expect(texts.slice(0, 3)).toEqual([
      ['sent', 'hello'],
      ['sent', `key ${REDACTED_MARKER}`],
      ['received', 'hello'],
    ]);
    expect((JSON.parse(result.body) as string[])[0]).toBe('hello');
    expect(JSON.stringify(result)).not.toContain(SECRET);

    const [line] = (await historyText(fixture.historyDir)).trim().split('\n');
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      id: result.historyId,
      kind: 'websocket',
      projectId: 'mcp-fixture',
      requestId: 'ws-echo',
      requestName: 'Echo',
      interfaceName: 'Chat',
      operationName: '',
      method: 'GET',
      status: 101,
      ok: true,
      tags: ['mcp'],
    });
    expect(line).not.toContain(SECRET);
  });

  it('errors with timeout, with no frames and no History, when no reply comes before the timeout', async () => {
    const deaf = await startTestWsServer({ onText: () => undefined, ignoreClose: true });
    sockets.push(deaf);
    const fixture = await wsProject(deaf.url);
    await updateProject(fixture.dir, (project) => ({
      ...project,
      wsApis: project.wsApis.map((api) => ({
        ...api,
        requests: api.requests.map((request) => ({ ...request, settings: { handshakeTimeoutMs: 300 } })),
      })),
    }));

    await expect(
      runOp(sendOp, { item: 'Chat/Echo' }, fixture.base({ env: { WIREBENCH_SECRET_WSKEY: SECRET } })),
    ).rejects.toMatchObject({ code: 'timeout' });
    await expect(historyText(fixture.historyDir)).rejects.toThrow();
  });

  it('masks a secret inside a binary frame, in the result and in History', async () => {
    // Answers the last saved message only, with a binary frame that carries it between two non-text
    // bytes. A run closes after the first reply that follows its last message, so an answer to
    // `hello` arriving after `key …` was sent would end the run before the frame under test.
    const binary = await startTestWsServer({
      onText: (text, peer) => {
        if (text.startsWith('key ')) {
          peer.sendBinary(Buffer.concat([Buffer.from([0x01]), Buffer.from(text), Buffer.from([0xff])]));
        }
      },
    });
    sockets.push(binary);
    const fixture = await wsProject(binary.url);

    const result = await runOp(
      sendOp,
      { item: 'Chat/Echo' },
      fixture.base({ env: { WIREBENCH_SECRET_WSKEY: SECRET } }),
    );

    const decoded = (result.frames ?? [])
      .filter((frame) => frame.opcode === 'binary')
      .map((frame) => Buffer.from(frame.base64 ?? '', 'base64').toString('latin1'));
    expect(decoded).toEqual([`\u0001key ${REDACTED_MARKER}\u00ff`]);
    for (const frame of result.frames ?? []) {
      expect(Buffer.from(frame.base64 ?? '', 'base64').toString('latin1')).not.toContain(SECRET);
    }
    const [line] = (await historyText(fixture.historyDir)).trim().split('\n');
    const entry = JSON.parse(line ?? '{}') as { ws: { frames: { opcode: string; base64?: string }[] } };
    const stored = entry.ws.frames
      .filter((frame) => frame.opcode === 'binary')
      .map((frame) => Buffer.from(frame.base64 ?? '', 'base64').toString('latin1'));
    expect(stored).toContain(`\u0001key ${REDACTED_MARKER}\u00ff`);
    expect(stored.join('')).not.toContain(SECRET);
  });

  it('errors with ws-handshake-refused when nothing listens at the endpoint', async () => {
    const fixture = await wsProject('ws://127.0.0.1:1');

    await expect(
      runOp(sendOp, { item: 'Chat/Echo' }, fixture.base({ env: { WIREBENCH_SECRET_WSKEY: SECRET } })),
    ).rejects.toMatchObject({ code: 'ws-handshake-refused' });
  });

  it('refuses the body override, which replaces an envelope or a body only', async () => {
    const fixture = await wsProject('ws://127.0.0.1:1');

    await expect(runOp(sendOp, { item: 'Chat/Echo', body: 'hi' }, fixture.base())).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });
});
