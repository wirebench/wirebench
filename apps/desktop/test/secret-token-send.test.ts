// @vitest-environment node
/**
 * `${secret:name}` tokens on the desktop's sends through the engine: the name resolves to the store entry labelled for the request's
 * own project, a missing one refuses the send as `secret-missing`, and every value the getter
 * handed out is masked wherever the HTTP log and History show a request.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApi,
  createGrpcApi,
  createGrpcRequest,
  createInterface,
  createProject,
  createRequest,
  createRunScope,
  grpcItemFor,
  resolveExchange,
  createRestRequest,
  createWsApi,
  createWsRequest,
  entry,
  wsItemFor,
} from '@wirebench/engine';
import type { GetSecret, Project, SelectedRequest } from '@wirebench/engine';
import { buildRestHistoryEntry } from '../src/main/history-service.js';
import {
  recordSecretValue,
  redactHeaders,
  redactRawHttp,
  redactSecretBytes,
  redactUrl,
  redactXml,
} from '../src/main/redact.js';
import { projectSecretGetter, secretStoreLabel } from '../src/main/secret-resolver.js';
import { newSecretRef, SecretStore, type CryptoBackend } from '../src/main/secrets.js';
import { sendThroughEngine, type SendThroughEngineDeps } from '../src/main/send/exchange.js';
import { sendDepsFor } from './helpers/send-deps.js';
import { desktopSendHost } from '../src/main/send/host.js';

let dir: string;
let store: SecretStore;

function fakeCrypto(): CryptoBackend {
  return {
    available: true,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-secret-send-'));
  store = new SecretStore(dir, fakeCrypto());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The getter main wires for project `p1`, recording what it hands out into the log masking. */
function getterFor(projectId: string | undefined): GetSecret {
  return projectSecretGetter(store, projectId, recordSecretValue);
}

interface CaptureServer {
  readonly url: string;
  readonly requests: { headers: IncomingMessage['headers']; body: string }[];
  close(): Promise<void>;
}

/** Answers every request with its own body, and keeps what arrived for the test to read. */
async function startCaptureServer(): Promise<CaptureServer> {
  const requests: CaptureServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/plain' });
      res.end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let server: CaptureServer;

beforeAll(async () => {
  server = await startCaptureServer();
});

afterAll(async () => {
  await server.close();
});

describe('projectSecretGetter', () => {
  it('reads a secret: pseudo-ref from the entry labelled for its project, other refs directly', async () => {
    await store.set('fake-token-not-real-0000', { label: secretStoreLabel('p1', 'api_token') });
    const ref = await store.set('fake-password-not-real');

    expect(secretStoreLabel('p1', 'api_token')).toBe('wirebench-secret:p1:api_token');
    expect(await getterFor('p1')('secret:api_token')).toBe('fake-token-not-real-0000');
    expect(await getterFor('p2')('secret:api_token')).toBeUndefined();
    expect(await getterFor(undefined)('secret:api_token')).toBeUndefined();
    expect(await getterFor('p1')(ref)).toBe('fake-password-not-real');
  });

  it('never resolves a team secrets machine key, even named directly', async () => {
    const key = newSecretRef();
    await store.putMachineOnly(key, '{"private":"k"}', { label: 'wirebench-team-key:ws-1' });
    expect(await getterFor('p1')(key)).toBeUndefined();
  });

  it('records every token value it hands out, so the log shows it redacted', async () => {
    await store.set('fake-recorded-not-real-1', { label: secretStoreLabel('p1', 'recorded') });
    await store.set('fake-recorded-not-real-2', { label: secretStoreLabel('p1', 'recorded_2') });
    await getterFor('p1')('secret:recorded');
    await getterFor('p1')('secret:recorded_2');

    for (const value of ['fake-recorded-not-real-1', 'fake-recorded-not-real-2']) {
      expect(redactHeaders({ 'X-Plain': `k ${value}` })).toEqual({ 'X-Plain': 'k <redacted>' });
      expect(redactUrl(`https://h.test/p?k=${value}`)).not.toContain(value);
      expect(redactXml(`<a>${value}</a>`)).toBe('<a><redacted></a>');
      const raw = Buffer.from(`GET / HTTP/1.1\r\nX-Plain: ${value}\r\n\r\n`).toString('base64');
      expect(Buffer.from(redactRawHttp(raw, { encoding: 'base64' }), 'base64').toString('utf8')).not.toContain(value);
      // Shown as-is while the session's show-secrets toggle is on.
      expect(redactHeaders({ 'X-Plain': value }, { show: true })).toEqual({ 'X-Plain': value });
    }
    const history = buildRestHistoryEntry('p1', {
      requestId: 'r1',
      requestName: 'R',
      apiName: 'A',
      folderPath: '',
      url: 'https://h.test/',
      method: 'GET',
      requestHeaders: { 'X-Plain': 'fake-recorded-not-real-1' },
      requestBody: '{"key":"fake-recorded-not-real-2"}',
      durationMs: 1,
    });
    expect(JSON.stringify(history)).not.toContain('fake-recorded-not-real');
    expect(history.request.envelopeXml).toBe('{"key":"<redacted>"}');
  });

  it('masks recorded values in raw bytes whether or not they are UTF-8', () => {
    recordSecretValue('fake-bytes-not-real-001');
    const raw = Buffer.concat([
      Buffer.from([0x0a, 0x97, 0xff]),
      Buffer.from('fake-bytes-not-real-001', 'utf8'),
      Buffer.from([0x80]),
    ]);

    const masked = Buffer.from(redactSecretBytes(raw.toString('base64')), 'base64');
    expect(masked).toEqual(
      Buffer.concat([Buffer.from([0x0a, 0x97, 0xff]), Buffer.from('<redacted>'), Buffer.from([0x80])]),
    );
    expect(redactSecretBytes(raw.toString('base64'), { show: true })).toBe(raw.toString('base64'));
    const other = Buffer.from([0x00, 0xff, 0x10]).toString('base64');
    expect(redactSecretBytes(other)).toBe(other);
    expect(redactSecretBytes('')).toBe('');

    // UTF-8 text is bytes too: the characters around the value come back as they were.
    const text = Buffer.from('{"k":"fake-bytes-not-real-001","é":"ü"}', 'utf8').toString('base64');
    expect(Buffer.from(redactSecretBytes(text), 'base64').toString('utf8')).toBe('{"k":"<redacted>","é":"ü"}');
  });

  it('does not record a password the getter hands out, which is often ordinary text', async () => {
    // A short auth password is ordinary text elsewhere: recording it would rewrite every History
    // body and URL that happens to contain it.
    const ref = await store.set('admin');
    await store.set('fake-token-value-not-real', { label: secretStoreLabel('p1', 'x') });
    expect(await getterFor('p1')(ref)).toBe('admin');
    await getterFor('p1')('secret:x');

    const history = buildRestHistoryEntry('p1', {
      requestId: 'r1',
      requestName: 'R',
      apiName: 'A',
      folderPath: '',
      url: 'https://h.test/admin/users',
      method: 'POST',
      requestHeaders: {},
      requestBody: '{"role":"admin","note":"fake-token-value-not-real"}',
      durationMs: 1,
    });
    expect(history.request.envelopeXml).toBe('{"role":"admin","note":"<redacted>"}');
    expect(redactUrl('https://h.test/admin/users')).toBe('https://h.test/admin/users');
  });
});

function restProject(header: string): Project {
  return {
    ...createProject('Billing', { id: 'p1' }),
    apis: [
      createApi('Billing API', {
        id: 'api-1',
        baseUrl: server.url,
        requests: [
          createRestRequest('Invoices', {
            id: 'r1',
            method: 'GET',
            url: '/echo',
            headers: [entry('X-Billing', header)],
          }),
        ],
      }),
    ],
  };
}

function restDeps(project: Project): SendThroughEngineDeps {
  return sendDepsFor(project, { secretsFor: getterFor });
}

describe('a desktop REST send', () => {
  it('resolves a token through the store, sends the value and masks it on the way back', async () => {
    await store.set('fake-billing-key-0001', { label: secretStoreLabel('p1', 'billing_key') });
    const before = server.requests.length;

    const summary = await sendThroughEngine(restDeps(restProject('Key ${secret:billing_key}')), 'rest-1', 'r1', {
      draft: { kind: 'rest' },
    });

    expect(server.requests.slice(before)[0]?.headers['x-billing']).toBe('Key fake-billing-key-0001');
    expect(summary.http.request.headers['X-Billing'] ?? summary.http.request.headers['x-billing']).toBe(
      'Key <redacted>',
    );
    expect(Buffer.from(summary.http.rawRequestBase64, 'base64').toString('utf8')).not.toContain(
      'fake-billing-key-0001',
    );
  });

  it('refuses a token with no stored value as secret-missing, sending nothing', async () => {
    const before = server.requests.length;

    await expect(
      sendThroughEngine(restDeps(restProject('${secret:not_stored}')), 'rest-2', 'r1', { draft: { kind: 'rest' } }),
    ).rejects.toMatchObject({ code: 'secret-missing', details: { ref: 'secret:not_stored' } });
    expect(server.requests.length).toBe(before);
  });
});

describe('a desktop SOAP send', () => {
  it('resolves a token in the envelope and masks it in the exchange', async () => {
    await store.set('fake-soap-password-01', { label: secretStoreLabel('p1', 'soap_pw') });
    const before = server.requests.length;
    const request = {
      ...createRequest('Add', {
        id: 'req-1',
        envelopeXml: '<Envelope><Pw>${secret:soap_pw}</Pw></Envelope>',
        soapVersion: '1.1',
      }),
      endpointUrl: server.url,
    };
    const iface = createInterface('Calculator', {
      id: 'iface-1',
      definitionUrl: `${server.url}?wsdl`,
      cacheDefinition: false,
      operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
    });
    const project: Project = { ...createProject('Billing', { id: 'p1' }), interfaces: [iface] };

    const summary = await sendThroughEngine(sendDepsFor(project, { secretsFor: getterFor }), 'soap-1', 'req-1', {
      draft: { kind: 'soap' },
    });

    expect(server.requests.slice(before)[0]?.body).toContain('<Pw>fake-soap-password-01</Pw>');
    expect(Buffer.from(summary.http.rawRequestBase64, 'base64').toString('utf8')).not.toContain(
      'fake-soap-password-01',
    );
  });
});

/** `item` of `project` resolved as its send resolves it, its tokens read through the project's getter. */
async function resolvedThroughEngine(project: Project, item: SelectedRequest | undefined): Promise<unknown> {
  if (item === undefined) throw new Error('no such request');
  const host = await desktopSendHost(sendDepsFor(project, { secretsFor: getterFor }), {
    sendId: '',
    requestId: item.request.id,
    projectId: project.id,
  });
  return await resolveExchange(item, host, createRunScope({ project, projectDir: '/tmp/none', overrides: {}, host }));
}

describe('gRPC and WebSocket resolution', () => {
  it('fills the secrets scope for a gRPC call', async () => {
    await store.set('fake-grpc-token-0001', { label: secretStoreLabel('p1', 'grpc_token') });
    const project: Project = {
      ...createProject('Demo', { id: 'p1' }),
      grpcApis: [
        createGrpcApi('Greeter', {
          id: 'g-1',
          target: 'localhost:1',
          requests: [
            createGrpcRequest('SayHello', {
              id: 'q-1',
              service: 's',
              method: 'm',
              metadata: [entry('x-token', '${secret:grpc_token}')],
            }),
          ],
        }),
      ],
    };

    const resolved = (await resolvedThroughEngine(project, grpcItemFor(project, 'q-1'))) as {
      unresolved: unknown[];
      input: { metadata: unknown[] };
    };

    expect(resolved.unresolved).toEqual([]);
    expect(resolved.input.metadata).toContainEqual(entry('x-token', 'fake-grpc-token-0001'));
  });

  it('fills the secrets scope for a WebSocket call, and refuses a missing one', async () => {
    await store.set('fake-ws-token-000001', { label: secretStoreLabel('p1', 'ws_token') });
    const project = (header: string): Project => ({
      ...createProject('Demo', { id: 'p1' }),
      wsApis: [
        createWsApi('Chat', {
          id: 'w-1',
          url: 'ws://localhost:1',
          requests: [createWsRequest('Echo', { id: 'q-1', url: '/echo', headers: [entry('x-token', header)] })],
        }),
      ],
    });
    const resolve = (header: string) => resolvedThroughEngine(project(header), wsItemFor(project(header), 'q-1'));

    const resolved = (await resolve('${secret:ws_token}')) as { input: { request: { headers: unknown[] } } };
    expect(resolved.input.request.headers).toEqual([entry('x-token', 'fake-ws-token-000001')]);

    await expect(resolve('${secret:gone}')).rejects.toMatchObject({ code: 'secret-missing' });
  });
});
