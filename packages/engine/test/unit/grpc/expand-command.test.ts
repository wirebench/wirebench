import { describe, expect, it } from 'vitest';
import { grpcToCommand, GRPC_COMMAND_REDACTED } from '../../../src/grpc/command.js';
import { expandGrpcInput } from '../../../src/grpc/expand.js';
import { entry } from '../../../src/rest/model.js';
import { toGrpcSendInput } from '../../../src/send-options.js';
import { DEFAULT_PREFERENCES } from '../../../src/project/preferences.js';

describe('expandGrpcInput', () => {
  const scopes = { project: { host: 'api.test', tenant: 'acme', quote: 'say "hi"' }, global: {}, system: {} };

  it('expands the target, metadata names and values, and the message text', () => {
    const { input, unresolved } = expandGrpcInput(
      { target: '${host}:443', metadata: [entry('x-${tenant}', '${tenant}')], messageText: '{"name": "${tenant}"}' },
      scopes,
    );
    expect(input).toEqual({
      target: 'api.test:443',
      metadata: [entry('x-acme', 'acme')],
      messageText: '{"name": "acme"}',
    });
    expect(unresolved).toEqual([]);
  });

  it('reports an unresolved reference and escapes only the message when asked', () => {
    const { input, unresolved } = expandGrpcInput(
      { target: '${nope}', metadata: [entry('x-q', '${quote}')], messageText: '{"q": "${quote}"}' },
      scopes,
      { escape: true },
    );
    expect(unresolved.map((ref) => ref.name)).toEqual(['nope']);
    expect(input.metadata[0]?.value).toBe('say "hi"');
    expect(input.messageText).toBe('{"q": "say \\"hi\\""}');
  });
});

describe('toGrpcSendInput', () => {
  it('climbs request → API → project → preference and puts the API metadata first', () => {
    const input = toGrpcSendInput({
      request: { service: 'a.B', method: 'C', methodKind: 'unary', metadata: [entry('x-k', 'request')], settings: {} },
      target: 'h:1',
      tls: true,
      apiMetadata: [entry('x-k', 'api')],
      apiSettings: { timeoutMs: 7 },
      projectSettings: { defaultTimeoutMs: 9 },
      preferences: DEFAULT_PREFERENCES,
      auth: { type: 'bearer', token: 't' },
    });
    expect(input).toMatchObject({
      target: 'h:1',
      tls: true,
      service: 'a.B',
      method: 'C',
      timeoutMs: 7,
      auth: { type: 'bearer', token: 't' },
    });
    expect(input.metadata).toEqual([entry('x-k', 'api'), entry('x-k', 'request')]);
    expect(input.defaultMetadata?.['user-agent']).toBe(DEFAULT_PREFERENCES.http.userAgent);
    expect(input.tlsOptions?.minVersion).toBe(DEFAULT_PREFERENCES.ssl.minVersion);
    const fallback = toGrpcSendInput({
      request: {
        service: 'a.B',
        method: 'C',
        methodKind: 'unary',
        metadata: [],
        settings: { timeoutMs: 3, bindAddress: '10.0.0.1', maxSizeBytes: 5 },
      },
      target: 'h:1',
      tls: false,
    });
    expect(fallback).toMatchObject({ timeoutMs: 3, localAddress: '10.0.0.1', maxSizeBytes: 5 });
    expect(
      toGrpcSendInput({
        request: { service: 'a.B', method: 'C', methodKind: 'unary', metadata: [], settings: {} },
        target: 'h:1',
        tls: false,
      }).timeoutMs,
    ).toBe(DEFAULT_PREFERENCES.http.socketTimeoutMs);
  });
});

describe('grpcToCommand', () => {
  const input = {
    target: 'localhost:50051',
    tls: false,
    service: 'a.Greeter',
    method: 'SayHello',
    metadata: [entry('x-trace', "it's"), entry('authorization', 'Bearer typed')],
    auth: { type: 'bearer' as const, token: 'secret' },
    defaultMetadata: { 'user-agent': 'wirebench' },
    timeoutMs: 30_000,
  };

  it('renders a plaintext call with headers, data and redacted credentials', () => {
    const command = grpcToCommand(input, '{"name": "Ada"}', { protoFiles: ['greeter.proto'], importPath: '/protos' });
    expect(command).toBe(
      [
        'grpcurl',
        '-plaintext',
        "-import-path '/protos'",
        "-proto 'greeter.proto'",
        '-max-time 30',
        "-H 'user-agent: wirebench'",
        `-H 'authorization: Bearer ${GRPC_COMMAND_REDACTED}'`,
        `-H 'x-trace: it'\\''s'`,
        `-H 'authorization: ${GRPC_COMMAND_REDACTED}'`,
        `-d '{"name": "Ada"}'`,
        "'localhost:50051' 'a.Greeter/SayHello'",
      ].join(' \\\n  '),
    );
  });

  it('keeps secrets when told to, omits -plaintext over TLS, and quotes for PowerShell', () => {
    const command = grpcToCommand({ ...input, tls: true }, '', { redactSecrets: false, shell: 'powershell' });
    expect(command).not.toContain('-plaintext');
    expect(command).toContain("'authorization: Bearer secret'");
    expect(command).toContain("'x-trace: it''s'");
    expect(command).toContain("-d '{}'");
  });
});
