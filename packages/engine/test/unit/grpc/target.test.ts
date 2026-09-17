import { describe, expect, it } from 'vitest';
import { GrpcError } from '../../../src/errors.js';
import { entry } from '../../../src/rest/model.js';
import { buildGrpcHeaders, parseGrpcTarget } from '../../../src/grpc/send.js';

describe('parseGrpcTarget', () => {
  it('reads host:port, IPv6 literals and scheme-bearing URLs', () => {
    expect(parseGrpcTarget('localhost:50051', false)).toEqual({
      host: 'localhost',
      port: 50051,
      authority: 'localhost:50051',
      tls: false,
    });
    expect(parseGrpcTarget('[::1]:50051', false)).toMatchObject({ host: '::1', authority: '[::1]:50051' });
    expect(parseGrpcTarget('grpcs://api.example.com', false)).toEqual({
      host: 'api.example.com',
      port: 443,
      authority: 'api.example.com:443',
      tls: true,
    });
    expect(parseGrpcTarget('grpc://api.example.com:9090/ignored', true)).toMatchObject({ port: 9090, tls: false });
    expect(parseGrpcTarget('https://api.example.com:8443', false).tls).toBe(true);
    expect(parseGrpcTarget('dns:///api.example.com:5000', true)).toMatchObject({
      host: 'api.example.com',
      port: 5000,
      tls: true,
    });
    expect(parseGrpcTarget('api.example.com', true).port).toBe(443);
    expect(parseGrpcTarget('api.example.com', false).port).toBe(80);
  });

  it('refuses an empty target, credentials, or a scheme gRPC cannot use', () => {
    for (const target of ['', '   ', 'ftp://x:1', 'user:pw@host:1', 'http://']) {
      try {
        parseGrpcTarget(target, false);
        expect.unreachable(target);
      } catch (error) {
        expect(error).toBeInstanceOf(GrpcError);
        expect((error as GrpcError).code).toBe('grpc-target-invalid');
      }
    }
  });
});

describe('buildGrpcHeaders', () => {
  const target = parseGrpcTarget('localhost:1', false);
  const base = {
    target: 'localhost:1',
    tls: false,
    service: 'a.B',
    method: 'C',
    messages: [],
    metadata: [],
    timeoutMs: 5000,
  };

  it('sets the protocol headers, lets a typed row override a default but never a reserved header', () => {
    const headers = buildGrpcHeaders(
      {
        ...base,
        defaultMetadata: { 'user-agent': 'wirebench', 'x-default': 'd' },
        metadata: [
          entry('X-Default', 'typed'),
          entry('te', 'nope'),
          entry(':path', '/hack'),
          entry('x-off', 'x', { enabled: false }),
          entry('', 'blank'),
        ],
      },
      target,
    );
    expect(headers).toEqual({
      ':method': 'POST',
      ':scheme': 'http',
      ':authority': 'localhost:1',
      ':path': '/a.B/C',
      'content-type': 'application/grpc+proto',
      te: 'trailers',
      'grpc-accept-encoding': 'identity,gzip,deflate',
      'grpc-timeout': '5000m',
      'user-agent': 'wirebench',
      'x-default': 'typed',
    });
  });

  it('turns credentials into the header they travel in', () => {
    expect(buildGrpcHeaders({ ...base, auth: { type: 'bearer', token: 't' } }, target)['authorization']).toBe(
      'Bearer t',
    );
    expect(
      buildGrpcHeaders({ ...base, auth: { type: 'bearer', token: 't', scheme: 'Token' } }, target)['authorization'],
    ).toBe('Token t');
    expect(buildGrpcHeaders({ ...base, auth: { type: 'oauth2', accessToken: 'a' } }, target)['authorization']).toBe(
      'Bearer a',
    );
    expect(
      buildGrpcHeaders({ ...base, auth: { type: 'api-key', name: 'X-Api-Key', value: 'k', in: 'header' } }, target)[
        'x-api-key'
      ],
    ).toBe('k');
    expect(
      buildGrpcHeaders({ ...base, auth: { type: 'basic', username: 'u', password: 'p', preemptive: true } }, target)[
        'authorization'
      ],
    ).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    try {
      buildGrpcHeaders({ ...base, auth: { type: 'ntlm', username: 'u', password: 'p' } }, target);
      expect.unreachable();
    } catch (error) {
      expect((error as GrpcError).code).toBe('grpc-auth-unsupported');
    }
  });
});
