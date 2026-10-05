import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapOpenCollection } from '../../../../src/import/opencollection/map.js';
import { parseOpenCollection } from '../../../../src/import/opencollection/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../../../../fixtures');

function readFixture(rel: string): string {
  return readFileSync(resolve(fixtureDir, rel), 'utf8');
}

function collection(items: string, request = ''): string {
  return `opencollection: "1.0.0"\ninfo:\n  name: Crafted\n${request}items:\n${items}`;
}

function mapText(text: string) {
  return mapOpenCollection(parseOpenCollection(text));
}

const grpcItem = (extra: string, name = 'Call'): string =>
  `  - info: { name: ${name}, type: grpc }\n    grpc:\n      url: "grpc://localhost:50051"\n      method: /pets.v1.Pets/Get\n${extra}`;
const wsItem = (extra: string, name = 'Sock'): string =>
  `  - info: { name: ${name}, type: websocket }\n    websocket:\n      url: "wss://x.example.com/ws"\n${extra}`;

describe('mapOpenCollection: gRPC, WebSocket and unsupported items', () => {
  const mapped = mapOpenCollection(parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml')));

  it('maps gRPC items to a gRPC API that still needs a definition', () => {
    expect(mapped.grpc).toMatchObject({ name: 'Pets (gRPC)', target: 'localhost:50051', tls: false });
    expect(mapped.grpc?.definition).toBeUndefined();
    expect(mapped.grpc?.requests[0]).toMatchObject({
      service: 'pets.v1.Pets',
      method: 'Get',
      methodKind: 'unary',
      message: '{"id":1}',
    });
    expect(mapped.protoFiles).toEqual(['protos/pets.proto']);
    expect(mapped.report.notes.join('\n')).not.toContain('needs a definition');
  });

  it('maps WebSocket items with one saved message', () => {
    expect(mapped.websocket?.name).toBe('Pets (WebSocket)');
    expect(mapped.websocket?.requests[0]?.messages.map((m) => m.content)).toEqual(['{"hi":true}']);
  });

  it('orders the APIs rest, gRPC, WebSocket from firstOrder', () => {
    const again = mapOpenCollection(parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml')), {
      firstOrder: 4,
    });
    expect([again.rest?.order, again.grpc?.order, again.websocket?.order]).toEqual([4, 5, 6]);
  });

  it('skips App items with a warning', () => {
    expect(mapped.report.warnings).toEqual(
      expect.arrayContaining(['Dashboard: app items are not supported and were skipped.']),
    );
  });

  it('keeps the plain name when only one protocol is present, and notes the missing definition', () => {
    const m = mapText(collection(grpcItem('')));
    expect(m.grpc?.name).toBe('Crafted');
    expect(m.grpc?.order).toBe(0);
    expect(m.report.notes).toContain('Crafted: needs a definition: import its .proto or use server reflection.');
  });

  it('reads the target, TLS and default ports', () => {
    const tls = (url: string) => mapText(collection(grpcItem('').replace('grpc://localhost:50051', url))).grpc;
    expect(tls('grpcs://api.example.com')).toMatchObject({ target: 'api.example.com:443', tls: true });
    expect(tls('https://api.example.com:8443/x')).toMatchObject({ target: 'api.example.com:8443', tls: true });
    expect(tls('grpc://api.example.com')).toMatchObject({ target: 'api.example.com:80', tls: false });
    expect(tls('localhost:50051')).toMatchObject({ target: 'localhost:50051', tls: false });
  });

  it('maps every spelling of a streaming kind and notes an unknown one', () => {
    const kind = (value: string) => mapText(collection(grpcItem(`      methodType: ${value}\n`)));
    expect(kind('server_streaming').grpc?.requests[0]?.methodKind).toBe('server-streaming');
    expect(kind('clientStreaming').grpc?.requests[0]?.methodKind).toBe('client-streaming');
    expect(kind('bidirectional').grpc?.requests[0]?.methodKind).toBe('bidi-streaming');
    const odd = kind('weird');
    expect(odd.grpc?.requests[0]?.methodKind).toBe('unary');
    expect(odd.report.notes.join('\n')).toContain('"weird" is unknown');
  });

  it('skips a gRPC item whose method is not service/method', () => {
    const m = mapText(collection(grpcItem('').replace('/pets.v1.Pets/Get', 'nonsense')));
    expect(m.grpc).toBeUndefined();
    expect(m.report.warnings.join('\n')).toContain('Call: the gRPC method is not service/method');
  });

  it('notes a later item with another target and keeps the first', () => {
    const second = grpcItem('', 'Other').replace('localhost:50051', 'other.example.com:1');
    const m = mapText(collection(grpcItem('') + second));
    expect(m.grpc?.target).toBe('localhost:50051');
    expect(m.report.notes.join('\n')).toContain('differs from the API');
  });

  it('indents an object message and rebuilds folders only where gRPC items live', () => {
    const items = [
      '  - info: { name: Empty }',
      '    items:',
      '      - info: { name: Rest, type: http }',
      '        http: { method: GET, url: "https://x.example.com" }',
      '  - info: { name: Pets }',
      '    items:',
      '      - info: { name: Call, type: grpc }',
      '        grpc:',
      '          url: "grpc://localhost:50051"',
      '          method: pets.v1.Pets/Get',
      '          message: { id: 1 }',
      '',
    ].join('\n');
    const m = mapText(collection(items));
    expect(m.grpc?.folders.map((f) => f.name)).toEqual(['Pets']);
    expect(m.grpc?.folders[0]?.requests[0]?.message).toBe('{\n  "id": 1\n}');
    expect(m.rest?.folders.map((f) => f.name)).toEqual(['Empty']);
  });

  it('drops literal credentials from metadata and messages, keeps references', () => {
    const m = mapText(
      collection(
        grpcItem(
          [
            '      metadata:',
            '        - { name: x-api-key, value: s3cret }',
            '        - { name: x-token, value: "{{token}}" }',
            '        - { name: x-trace, value: abc }',
            '      message: \'{"password":"hunter2","id":1}\'',
            '',
          ].join('\n'),
        ),
      ),
    );
    const request = m.grpc?.requests[0];
    expect(request?.metadata.map((r) => [r.name, r.value])).toEqual([
      ['x-token', '${token}'],
      ['x-trace', 'abc'],
    ]);
    expect(request?.message).not.toContain('hunter2');
    expect(JSON.stringify(m.grpc)).not.toContain('s3cret');
    expect(m.report.warnings.join('\n')).toContain('x-api-key');
  });

  it('maps WebSocket headers, query, settings and the saved message safely', () => {
    const m = mapText(
      collection(
        wsItem(
          [
            '      headers:',
            '        - { name: Authorization, value: Bearer abc }',
            '        - { name: X-Id, value: 7 }',
            '      message: { type: text, data: \'{"token":"abc","n":1}\' }',
            '    settings: { timeout: 3000, keepAliveInterval: 10 }',
            '',
          ].join('\n'),
        ).replace('/ws"', '/ws?apikey=zzz&a=1"'),
      ),
    );
    const request = m.websocket?.requests[0];
    expect(request?.headers.map((h) => h.name)).toEqual(['X-Id']);
    expect(request?.auth).toEqual({ type: 'bearer' });
    expect(request?.query.map((q) => [q.name, q.value])).toEqual([
      ['apikey', ''],
      ['a', '1'],
    ]);
    expect(request?.messages[0]?.content).not.toContain('abc');
    expect(request?.settings).toEqual({ handshakeTimeoutMs: 3000 });
    expect(m.report.notes.join('\n')).toContain('keepAliveInterval');
    expect(JSON.stringify(m)).not.toContain('zzz');
  });

  it('strips URL credentials from gRPC and WebSocket items', () => {
    const m = mapText(
      collection(
        grpcItem('').replace('grpc://localhost', 'grpc://u:p@localhost') + wsItem('').replace('wss://x', 'wss://u:p@x'),
      ),
    );
    expect(m.grpc?.target).toBe('localhost:50051');
    expect(m.websocket?.requests[0]?.url).toBe('wss://x.example.com/ws');
    expect(JSON.stringify(m)).not.toContain('u:p@');
  });

  it('reports a dynamic variable once across protocols', () => {
    const m = mapText(
      collection(
        grpcItem('      message: \'{"a":"{{$guid}}"}\'\n') +
          wsItem('      message: { type: text, data: "{{$guid}}" }\n'),
      ),
    );
    expect(m.report.warnings.filter((w) => w.startsWith('Dynamic variables'))).toHaveLength(1);
  });

  it('counts gRPC and WebSocket requests', () => {
    expect(mapped.counts.requests).toBe(5);
  });
});
