/**
 * Reconciling a gRPC API against a schema it has been given again: what the user edited survives, a
 * method that vanished is flagged rather than deleted, and one that came back is un-flagged.
 */
import { describe, expect, it } from 'vitest';
import { grpcApiRequests } from '../../../src/grpc/model.js';
import type { GrpcApi } from '../../../src/grpc/model.js';
import { importProto } from '../../../src/grpc/import.js';
import { loadProtoSet } from '../../../src/grpc/proto/load.js';
import { reconcileGrpcApi } from '../../../src/grpc/reconcile.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const FULL = `syntax = "proto3";
package p;
message Req { string a = 1; }
message Res { string b = 1; }
service S {
  rpc One(Req) returns (Res);
  rpc Two(Req) returns (stream Res);
}
`;

const SHRUNK = `syntax = "proto3";
package p;
message Req { string a = 1; }
message Res { string b = 1; }
service S {
  rpc One(Req) returns (Res);
}
`;

const RETYPED = `syntax = "proto3";
package p;
message Req { string a = 1; }
message Res { string b = 1; }
service S {
  rpc One(stream Req) returns (Res);
  rpc Two(Req) returns (stream Res);
}
`;

function setOf(source: string) {
  return loadProtoSet(new Map([['s.proto', source]]), { roots: ['s.proto'] });
}

function apiOf(source: string): GrpcApi {
  let next = 0;
  return importProto(new Map([['s.proto', source]]), { roots: ['s.proto'], newId: () => `id-${String(++next)}` }).api;
}

function ids(api: GrpcApi): (readonly [string, boolean])[] {
  return grpcApiRequests(api).map((request) => [`${request.service}/${request.method}`, request.orphaned === true]);
}

describe('reconcileGrpcApi', () => {
  it('leaves an unchanged API untouched', () => {
    const api = apiOf(FULL);
    const result = reconcileGrpcApi(api, setOf(FULL));
    expect(result).toMatchObject({
      requestsAdded: [],
      requestsOrphaned: [],
      requestsRestored: [],
      requestsRetyped: [],
      foldersAdded: [],
    });
    expect(ids(result.api)).toEqual(ids(api));
  });

  it('flags a method the schema no longer declares rather than deleting it', () => {
    const api = apiOf(FULL);
    const result = reconcileGrpcApi(api, setOf(SHRUNK));
    expect(result.requestsOrphaned).toHaveLength(1);
    expect(ids(result.api)).toEqual([
      ['p.S/One', false],
      ['p.S/Two', true],
    ]);
  });

  it('clears the flag when the method comes back, and does not add a second request for it', () => {
    const shrunk = reconcileGrpcApi(apiOf(FULL), setOf(SHRUNK));
    const restored = reconcileGrpcApi(shrunk.api, setOf(FULL));
    expect(restored.requestsRestored).toEqual(shrunk.requestsOrphaned);
    expect(restored.requestsAdded).toEqual([]);
    expect(ids(restored.api)).toEqual([
      ['p.S/One', false],
      ['p.S/Two', false],
    ]);
  });

  it('is idempotent once the flag is set', () => {
    const once = reconcileGrpcApi(apiOf(FULL), setOf(SHRUNK));
    const twice = reconcileGrpcApi(once.api, setOf(SHRUNK));
    expect(twice.requestsOrphaned).toEqual([]);
    expect(ids(twice.api)).toEqual(ids(once.api));
  });

  it('adds a request for a method the API does not have, into the folder its service owns', () => {
    const api = apiOf(SHRUNK);
    const result = reconcileGrpcApi(api, setOf(FULL), { newId: () => 'new-1' });
    expect(result.requestsAdded).toEqual(['new-1']);
    expect(result.foldersAdded).toEqual([]);
    expect(result.api.folders).toHaveLength(1);
    expect(result.api.folders[0]?.requests.map((request) => [request.method, request.order])).toEqual([
      ['One', 0],
      ['Two', 1],
    ]);
  });

  it('adds a folder for a service the API does not have', () => {
    const api = apiOf(SHRUNK);
    const withSecond = setOf(`${FULL}
service T { rpc Only(Req) returns (Res); }
`);
    let next = 0;
    const result = reconcileGrpcApi(api, withSecond, { newId: () => `new-${String(++next)}` });
    expect(result.foldersAdded).toHaveLength(1);
    expect(result.api.folders.map((folder) => folder.name)).toEqual(['S', 'T']);
    expect(result.api.folders[1]?.requests.map((request) => request.method)).toEqual(['Only']);
  });

  it('corrects a method whose streaming shape changed', () => {
    const api = apiOf(FULL);
    const result = reconcileGrpcApi(api, setOf(RETYPED));
    expect(result.requestsRetyped).toHaveLength(1);
    const one = grpcApiRequests(result.api).find((request) => request.method === 'One');
    expect(one?.methodKind).toBe('client-streaming');
  });

  it('keeps the message and metadata the user edited', () => {
    const api = apiOf(SHRUNK);
    const edited: GrpcApi = {
      ...api,
      folders: api.folders.map((folder) => ({
        ...folder,
        requests: folder.requests.map((request) => ({
          ...request,
          message: '{"a":"mine"}',
          metadata: [{ name: 'x-mine', value: '1', enabled: true }],
        })),
      })),
    };
    const result = reconcileGrpcApi(edited, setOf(FULL));
    const one = grpcApiRequests(result.api).find((request) => request.method === 'One');
    expect(one?.message).toBe('{"a":"mine"}');
    expect(one?.metadata).toEqual([{ name: 'x-mine', value: '1', enabled: true }]);
  });

  it('reconciles the greeter fixture against itself without change', () => {
    const sources = readProtoFixture('greeter');
    const api = importProto(sources, { roots: ['greeter.proto'] }).api;
    const result = reconcileGrpcApi(api, loadProtoSet(sources, { roots: ['greeter.proto'] }));
    expect(result.requestsAdded).toEqual([]);
    expect(result.requestsOrphaned).toEqual([]);
  });
});
