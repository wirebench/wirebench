import { describe, expect, it } from 'vitest';
import {
  clientStreams,
  createGrpcApi,
  createGrpcFolder,
  createGrpcRequest,
  defaultTlsFor,
  grpcApiFolders,
  grpcApiRequests,
  grpcMethodPath,
  serverStreams,
} from '../../../src/grpc/model.js';

describe('gRPC model', () => {
  it('creates an API whose TLS default follows the target spelling', () => {
    expect(createGrpcApi('Local', { target: 'localhost:50051', id: 'a' }).tls).toBe(false);
    expect(createGrpcApi('Prod', { target: 'api.example.com:443', id: 'b' }).tls).toBe(true);
    expect(createGrpcApi('Url', { target: 'grpcs://api.example.com', id: 'c' }).tls).toBe(true);
    expect(createGrpcApi('Plain', { target: 'grpc://api.example.com:8443', id: 'd' }).tls).toBe(false);
    expect(defaultTlsFor('')).toBe(false);
    const api = createGrpcApi('Greeter API', { id: 'e' });
    expect(api).toMatchObject({
      kind: 'grpc',
      slug: 'Greeter API',
      target: '',
      metadata: [],
      folders: [],
      requests: [],
    });
  });

  it('creates a unary request with an empty message and inherited credentials', () => {
    const request = createGrpcRequest('Say hello', { id: 'r', service: 'x.Greeter', method: 'SayHello' });
    expect(request).toMatchObject({
      kind: 'grpc',
      methodKind: 'unary',
      message: '{}',
      auth: { type: 'inherit' },
      settings: {},
    });
    expect(grpcMethodPath(request.service, request.method)).toBe('/x.Greeter/SayHello');
  });

  it('walks folders and requests depth-first', () => {
    const leaf = createGrpcRequest('Leaf', { id: 'l' });
    const rootRequest = createGrpcRequest('Root', { id: 'r' });
    const inner = createGrpcFolder('Inner', { id: 'i', requests: [leaf] });
    const outer = createGrpcFolder('Outer', { id: 'o', folders: [inner] });
    const api = createGrpcApi('A', { id: 'a', folders: [outer], requests: [rootRequest] });
    expect(grpcApiRequests(api).map((r) => r.id)).toEqual(['r', 'l']);
    expect(grpcApiFolders(api).map((f) => f.id)).toEqual(['o', 'i']);
  });

  it('knows which side of each method kind streams', () => {
    expect(clientStreams('unary')).toBe(false);
    expect(clientStreams('client-streaming')).toBe(true);
    expect(clientStreams('bidi-streaming')).toBe(true);
    expect(serverStreams('server-streaming')).toBe(true);
    expect(serverStreams('client-streaming')).toBe(false);
  });
});
