// @vitest-environment node
/**
 * The gRPC send path in main: the target, chain and expansion a send resolves (`previewGrpc`); a send through the engine
 * against a real gRPC server with credentials from the store, redacted on the way back; and the
 * history line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGrpcServer, type TestGrpcServer } from '@wirebench/engine/test-helpers';
import { createGrpcApi, createGrpcFolder, createGrpcRequest, createProject, entry } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { buildGrpcHistoryEntry } from '../src/main/history-service.js';
import { previewGrpc, sendThroughEngine } from '../src/main/send/exchange.js';
import type { GrpcRequestPatchWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

let server: TestGrpcServer;

beforeAll(async () => {
  server = await startTestGrpcServer();
});

afterAll(async () => {
  await server.close();
});

function project(): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    properties: { who: 'Ada', tenant: 'acme' },
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'g-1',
        target: '${host}',
        tls: false,
        metadata: [entry('x-tenant', '${tenant}')],
        auth: { type: 'bearer', tokenRef: 'sec_tok' },
        folders: [
          createGrpcFolder('Greeter', {
            id: 'f-1',
            requests: [
              createGrpcRequest('SayHello', {
                id: 'q-1',
                service: 'wirebench.greet.Greeter',
                method: 'SayHello',
                message: '{"name": "${who}"}',
                metadata: [entry('x-trace', 'abc')],
              }),
            ],
          }),
        ],
      }),
    ],
  };
}

/** `requestId` resolved as its send would resolve it, the server's target in `${host}`. */
function resolve(overrides: { readonly draft?: GrpcRequestPatchWire; readonly requestId?: string } = {}) {
  const model = project();
  const withHost: Project = { ...model, properties: { ...model.properties, host: server.target } };
  return previewGrpc(sendDepsFor(withHost), overrides.requestId ?? 'q-1', overrides.draft);
}

/**
 * `q-1` sent through the engine as the editor sends it, the server's target in `${host}`, with
 * `getSecret` as the keychain and `show` as the session's flag.
 */
function send(
  sendId: string,
  getSecret: (ref: string) => Promise<string | undefined>,
  options: { readonly draft?: GrpcRequestPatchWire; readonly show?: boolean } = {},
) {
  const model = project();
  const withHost: Project = { ...model, properties: { ...model.properties, host: server.target } };
  const deps = sendDepsFor(withHost, {
    getSecret,
    project: { grpcProtoSetFor: () => Promise.resolve(server.set), grpcMeta: () => undefined },
    ...(options.show === true ? { showSecrets: { get: () => true } } : {}),
  });
  return sendThroughEngine(deps, sendId, 'q-1', {
    draft: { kind: 'grpc', ...(options.draft !== undefined ? { draft: options.draft } : {}) },
  });
}

describe('resolving a gRPC call (previewGrpc)', () => {
  it('applies the draft, expands target, metadata and message, and resolves the chain', async () => {
    const resolved = (await resolve())!;
    expect(resolved.input.target).toBe(server.target);
    expect(resolved.input.metadata).toEqual([entry('x-tenant', 'acme'), entry('x-trace', 'abc')]);
    expect(resolved.messageText).toBe('{"name": "Ada"}');
    expect(resolved.auth).toEqual({ type: 'bearer', tokenRef: 'sec_tok' });
    expect(resolved.unresolved).toEqual([]);
    const drafted = (await resolve({ draft: { message: '{"name": "${nope}"}' } }))!;
    expect(drafted.unresolved.map((ref) => ref.name)).toEqual(['nope']);
    expect(await resolve({ requestId: 'zz' })).toBeUndefined();
  });
});

describe('a gRPC send through the engine', () => {
  it('calls the server, decodes the reply, and redacts the token on the way back', async () => {
    const getSecret = (ref: string) => Promise.resolve(ref === 'sec_tok' ? 'good-token' : undefined);
    const summary = await send('s1', getSecret);
    expect(summary).toMatchObject({
      status: 0,
      statusName: 'OK',
      methodKind: 'unary',
      service: 'wirebench.greet.Greeter',
      method: 'SayHello',
    });
    expect(summary.http.status).toBe(200);
    expect(summary.http.httpVersion).toBe('2');
    expect(JSON.parse(summary.responseMessages[0]!.json!)).toMatchObject({
      message: 'Hello, Ada',
      metadata: { 'x-tenant': 'acme', 'x-trace': 'abc' },
    });
    expect(summary.http.request.headers['authorization']).toBe('<redacted>');
    expect(Buffer.from(summary.http.rawRequestBase64, 'base64').toString('latin1')).not.toContain('good-token');
    expect(server.calls.at(-1)?.headers['authorization']).toBe('Bearer good-token');

    const shown = await send('s2', getSecret, { show: true });
    expect(shown.http.request.headers['authorization']).toBe('Bearer good-token');
  });

  it('reports a non-OK status as a result and a missing secret as an error', async () => {
    const failing = await send('s3', () => Promise.resolve('t'), {
      draft: { method: 'Fail', message: '{"code": 7, "message": "nope"}' },
    });
    expect(failing).toMatchObject({ status: 7, statusName: 'PERMISSION_DENIED', statusMessage: 'nope' });
    await expect(
      send('s4', () => Promise.resolve(undefined), {
        draft: { message: '{}', auth: { type: 'bearer', tokenRef: 'gone' } },
      }),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });
});

describe('a gRPC server stream sent from the editor', () => {
  it('keeps a stream its deadline cut as a result, with the messages and DEADLINE_EXCEEDED', async () => {
    const summary = await send('s6', () => Promise.resolve('t'), {
      draft: {
        method: 'LotsOfReplies',
        methodKind: 'server-streaming',
        message: '{"count": 1000, "delay_ms": 20}',
        settings: { timeoutMs: 200 },
      },
    });
    expect(summary).toMatchObject({ status: 4, statusName: 'DEADLINE_EXCEEDED', methodKind: 'server-streaming' });
    expect(summary.responseMessages.length).toBeGreaterThan(0);
  });
});

describe('buildGrpcHistoryEntry', () => {
  it('records the call with its messages, redacting the metadata', async () => {
    const resolved = (await resolve())!;
    const summary = await send('s5', () => Promise.resolve('good-token'));
    const entry = buildGrpcHistoryEntry('p1', {
      requestId: 'q-1',
      requestName: 'SayHello',
      apiName: 'Greeter',
      folderPath: 'Greeter',
      target: server.target,
      service: 'wirebench.greet.Greeter',
      method: 'SayHello',
      methodKind: 'unary',
      requestMetadata: { authorization: 'Bearer good-token', 'x-trace': 'abc' },
      requestMessage: resolved.messageText,
      exchange: summary,
      durationMs: 3,
    });
    expect(entry).toMatchObject({
      kind: 'grpc',
      ok: true,
      status: 200,
      interfaceName: 'Greeter',
      operationName: 'Greeter',
      endpoint: server.target,
      soapVersion: 'none',
    });
    expect(entry.grpc).toMatchObject({
      service: 'wirebench.greet.Greeter',
      method: 'SayHello',
      status: 0,
      statusName: 'OK',
    });
    expect(entry.grpc?.responseMessages[0]).toContain('Hello, Ada');
    expect(entry.request.headers).toContainEqual({ name: 'authorization', value: '<redacted>' });
    expect(entry.grpc?.trailers).toContainEqual({ name: 'grpc-status', value: '0' });
  });
});
