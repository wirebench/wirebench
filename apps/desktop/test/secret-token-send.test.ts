// @vitest-environment node
/**
 * `${secret:name}` tokens on the desktop send paths, which build their input in main rather than
 * through the engine's `prepare`: the name resolves to the store entry labelled for the request's
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
  createProject,
  createRestRequest,
  createWsApi,
  createWsRequest,
  entry,
} from '@wirebench/engine';
import type { GetSecret, Project, PropertyScopes } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { resolveGrpcSend } from '../src/main/grpc-send.js';
import { buildRestHistoryEntry } from '../src/main/history-service.js';
import { sendRestRequest, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { recordSecretValue, redactHeaders, redactRawHttp, redactUrl, redactXml } from '../src/main/redact.js';
import { resolveRestSend } from '../src/main/rest-send.js';
import { projectSecretGetter, resolveWithStoredValues, secretStoreLabel } from '../src/main/secret-resolver.js';
import { SecretStore, type CryptoBackend } from '../src/main/secrets.js';
import { sendAndRecordHistory } from '../src/main/send-with-history.js';
import { resolveWsSend } from '../src/main/ws-send.js';

const SCOPES: PropertyScopes = { project: {}, global: {}, system: {} };

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

  it('does not record an auth value, which its header, password and body-key rules already mask', async () => {
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

function restDeps(project: Project): RequestChannelDeps {
  return {
    project: {
      scopesFor: () => SCOPES,
      projectId: () => 'p1',
      restSend: (requestId: string) =>
        resolveRestSend({
          project,
          requestId,
          scopes: SCOPES,
          resolveBaseUrl: (api) => ({ url: api.baseUrl, source: 'api' }),
        }),
    } as unknown as RequestChannelDeps['project'],
    secretsFor: getterFor,
  };
}

describe('a desktop REST send', () => {
  it('resolves a token through the store, sends the value and masks it on the way back', async () => {
    await store.set('fake-billing-key-0001', { label: secretStoreLabel('p1', 'billing_key') });
    const before = server.requests.length;

    const summary = await sendRestRequest(new EngineService(), restDeps(restProject('Key ${secret:billing_key}')), {
      sendId: 'rest-1',
      requestId: 'r1',
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
      sendRestRequest(new EngineService(), restDeps(restProject('${secret:not_stored}')), {
        sendId: 'rest-2',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'secret-missing', details: { ref: 'secret:not_stored' } });
    expect(server.requests.length).toBe(before);
  });
});

describe('a desktop SOAP send', () => {
  it('resolves a token in the envelope and masks it in the exchange', async () => {
    await store.set('fake-soap-password-01', { label: secretStoreLabel('p1', 'soap_pw') });
    const before = server.requests.length;

    const summary = await sendAndRecordHistory(
      new EngineService(),
      {
        project: {
          scopesFor: () => SCOPES,
          authFor: () => undefined,
          requestMeta: () => undefined,
          projectId: () => 'p1',
        },
        secretsFor: getterFor,
      },
      {
        sendId: 'soap-1',
        requestId: 'req-1',
        input: {
          endpoint: server.url,
          envelopeXml: '<Envelope><Pw>${secret:soap_pw}</Pw></Envelope>',
          soapVersion: '1.1',
          timeoutMs: 5_000,
        },
      },
    );

    expect(server.requests.slice(before)[0]?.body).toContain('<Pw>fake-soap-password-01</Pw>');
    expect(Buffer.from(summary.http.rawRequestBase64, 'base64').toString('utf8')).not.toContain(
      'fake-soap-password-01',
    );
  });
});

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

    const resolved = await resolveWithStoredValues(
      () =>
        resolveGrpcSend({
          project,
          requestId: 'q-1',
          scopes: SCOPES,
          resolveTarget: (api) => ({ url: api.target, source: 'api' }),
        }),
      getterFor('p1'),
    );

    expect(resolved?.unresolved).toEqual([]);
    expect(resolved?.input.metadata).toContainEqual(entry('x-token', 'fake-grpc-token-0001'));
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
    const resolve = (header: string) => () =>
      resolveWsSend({
        project: project(header),
        requestId: 'q-1',
        scopes: SCOPES,
        resolveTarget: (api) => ({ url: api.url, source: 'api' }),
      });

    const resolved = await resolveWithStoredValues(resolve('${secret:ws_token}'), getterFor('p1'));
    expect(resolved?.input.request.headers).toEqual([entry('x-token', 'fake-ws-token-000001')]);

    await expect(resolveWithStoredValues(resolve('${secret:gone}'), getterFor('p1'))).rejects.toMatchObject({
      code: 'secret-missing',
    });
  });
});
