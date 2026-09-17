// @vitest-environment node
/**
 * The gRPC send path in main: the resolver's target, chain and expansion; the engine service against
 * a real gRPC server with credentials from the store, redacted on the way back; and the history line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGrpcServer, type TestGrpcServer } from '@wirebench/engine/test-helpers';
import { createGrpcApi, createGrpcFolder, createGrpcRequest, createProject, entry } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { resolveGrpcSend } from '../src/main/grpc-send.js';
import { buildGrpcHistoryEntry } from '../src/main/history-service.js';

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

function resolve(overrides: { readonly draft?: { message?: string } } = {}) {
  return resolveGrpcSend({
    project: project(),
    requestId: 'q-1',
    ...(overrides.draft !== undefined ? { draft: overrides.draft } : {}),
    scopes: { project: { who: 'Ada', tenant: 'acme', host: server.target }, global: {}, system: {} },
    resolveTarget: (api) => ({ url: api.target, source: 'api' }),
  });
}

describe('resolveGrpcSend', () => {
  it('applies the draft, expands target, metadata and message, and resolves the chain', () => {
    const resolved = resolve()!;
    expect(resolved.input.target).toBe(server.target);
    expect(resolved.input.metadata).toEqual([entry('x-tenant', 'acme'), entry('x-trace', 'abc')]);
    expect(resolved.messageText).toBe('{"name": "Ada"}');
    expect(resolved.auth).toEqual({ type: 'bearer', tokenRef: 'sec_tok' });
    expect(resolved.unresolved).toEqual([]);
    const drafted = resolve({ draft: { message: '{"name": "${nope}"}' } })!;
    expect(drafted.unresolved.map((ref) => ref.name)).toEqual(['nope']);
    expect(
      resolveGrpcSend({
        project: project(),
        requestId: 'zz',
        scopes: { project: {}, global: {}, system: {} },
        resolveTarget: () => ({ url: '', source: 'api' }),
      }),
    ).toBeUndefined();
  });
});

describe('EngineService.sendGrpcRequest', () => {
  it('calls the server, decodes the reply, and redacts the token on the way back', async () => {
    const resolved = resolve()!;
    const engine = new EngineService((ref) => Promise.resolve(ref === 'sec_tok' ? 'good-token' : undefined));
    const summary = await engine.sendGrpcRequest(
      { sendId: 's1', requestId: 'q-1', set: server.set, input: resolved.input, messageText: resolved.messageText },
      { auth: resolved.auth },
    );
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

    const shown = await engine.sendGrpcRequest(
      { sendId: 's2', requestId: 'q-1', set: server.set, input: resolved.input, messageText: resolved.messageText },
      { auth: resolved.auth, showSecrets: true },
    );
    expect(shown.http.request.headers['authorization']).toBe('Bearer good-token');
  });

  it('reports a non-OK status as a result and a missing secret as an error', async () => {
    const resolved = resolve()!;
    const engine = new EngineService(() => Promise.resolve('t'));
    const failing = await engine.sendGrpcRequest({
      sendId: 's3',
      requestId: 'q-1',
      set: server.set,
      input: { ...resolved.input, method: 'Fail' },
      messageText: '{"code": 7, "message": "nope"}',
    });
    expect(failing).toMatchObject({ status: 7, statusName: 'PERMISSION_DENIED', statusMessage: 'nope' });
    await expect(
      new EngineService(() => Promise.resolve(undefined)).sendGrpcRequest(
        { sendId: 's4', requestId: 'q-1', set: server.set, input: resolved.input, messageText: '{}' },
        { auth: { type: 'bearer', tokenRef: 'gone' } },
      ),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });
});

describe('buildGrpcHistoryEntry', () => {
  it('records the call with its messages, redacting the metadata', async () => {
    const resolved = resolve()!;
    const engine = new EngineService(() => Promise.resolve('good-token'));
    const summary = await engine.sendGrpcRequest(
      { sendId: 's5', requestId: 'q-1', set: server.set, input: resolved.input, messageText: resolved.messageText },
      { auth: resolved.auth },
    );
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
