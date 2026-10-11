import { describe, expect, it } from 'vitest';
import { PostmanError } from '../../../../src/errors.js';
import type { MappedCollectionV3 } from '../../../../src/import/collection-v3/map.js';
import { mapCollectionV3 } from '../../../../src/import/collection-v3/map.js';
import { readCollectionV3 } from '../../../../src/import/collection-v3/parse.js';
import { REDACTED_MARKER } from '../../../../src/redact/index.js';
import type { RestFolder, RestRequestDef } from '../../../../src/rest/model.js';
import { folderRequests } from '../../../../src/rest/model.js';
import { fixtureFiles } from './fixture-files.js';

function counter(): () => string {
  let n = 0;
  return () => `id-${String((n += 1))}`;
}

function mapFolder(folder: string, rootName: string, files = fixtureFiles(folder)): MappedCollectionV3 {
  return mapCollectionV3(readCollectionV3(files, rootName), { newId: counter() });
}

const workspace = mapFolder('workspace', 'postman');
const bookstore = workspace.collections[0]!;
const realtime = workspace.collections[1]!;
const rest = bookstore.rest!;
const requestNamed = (name: string): RestRequestDef => folderRequests(rest).find((r) => r.name === name)!;
const folderNamed = (name: string): RestFolder => rest.folders.find((f) => f.name === name)!;
const warnings = workspace.report.warnings;

describe('mapCollectionV3: a workspace folder', () => {
  it('maps each collection to its APIs, named after the collection, suffixed when it has several kinds', () => {
    expect(workspace.collections.map((c) => c.name)).toEqual(['Bookstore API', 'Realtime']);
    expect(bookstore.grpc).toBeUndefined();
    expect(realtime.rest).toBeUndefined();
    expect(realtime.grpc?.name).toBe('Realtime (gRPC)');
    expect(realtime.websocket?.name).toBe('Realtime (WebSocket)');
    expect([rest.order, realtime.grpc?.order, realtime.websocket?.order]).toEqual([0, 1, 2]);
  });

  it('counts what it brought across', () => {
    expect(workspace.counts).toEqual({ collections: 2, requests: 16, folders: 2, examples: 2 });
  });

  it('turns environments into workspace environments and globals into Globals, secrets apart', () => {
    const [local] = workspace.variables.environments;
    expect(local?.name).toBe('Local');
    expect(local?.variables.find((v) => v.name === 'accessToken')).toMatchObject({
      secret: true,
      value: '',
      secretValue: 'local-token-value',
    });
    expect(local?.variables.find((v) => v.name === 'debug')?.enabled).toBe(false);
    expect(workspace.variables.globals?.variables.map((v) => v.name)).toEqual(['traceId']);
    // A known dynamic variable maps onto the Dynamic scope, so nothing is reported as kept (#333).
    expect(workspace.variables.globals?.variables.find((v) => v.name === 'traceId')?.value).toBe('${$guid}');
    expect(workspace.variables.report.warnings.join('\n')).not.toContain('Dynamic variables');
  });

  it("gathers the collections' variables as project properties, base URLs aside", () => {
    const names = workspace.variables.projectProperties?.variables.map((v) => v.name);
    expect(names).toEqual(['pageSize', 'legacyFlag', 'adminUser', 'grpcHost', 'wsUrl']);
    expect(workspace.variables.projectProperties?.variables.find((v) => v.name === 'legacyFlag')?.enabled).toBe(false);
  });
});

describe('mapCollectionV3: HTTP requests through the v2.1 mapping', () => {
  it('keeps the order of the files and the base URL of the collection', () => {
    expect(rest.baseUrl).toBe('https://api.bookstore.example/v1');
    expect(rest.requests.map((r) => r.name)).toEqual(['Get all books', 'Get book by :id', 'Add book']);
    expect(rest.folders.map((f) => f.name)).toEqual(['Admin', 'Legacy']);
    expect(folderNamed('Legacy').requests.map((r) => r.name)).toEqual(['Ping', 'Health']);
    expect(rest.description).toBe('Books, authors and the admin area.');
  });

  it('maps URL, query, path variables and headers in both list and map form', () => {
    const all = requestNamed('Get all books');
    expect(all.url).toBe('/books');
    expect(all.query.map((q) => [q.name, q.value, q.enabled])).toEqual([
      ['page', '1', true],
      ['limit', '${pageSize}', true],
      ['draft', 'true', false],
    ]);
    const byId = requestNamed('Get book by :id');
    expect(byId.url).toBe('/books/{id}');
    expect(byId.pathParams).toEqual([
      expect.objectContaining({ name: 'id', value: '1', description: "The book's id" }),
    ]);
    expect(requestNamed('Add book').headers.map((h) => [h.name, h.value])).toEqual([
      ['Content-Type', 'application/json'],
      ['X-Request-Id', '${$guid}'],
    ]);
  });

  it('maps every body type', () => {
    expect(requestNamed('Add book').body).toMatchObject({ kind: 'raw', language: 'json' });
    expect(requestNamed('Export xml').body).toMatchObject({ kind: 'raw', language: 'xml' });
    expect(requestNamed('Note').body).toMatchObject({
      kind: 'raw',
      language: 'text',
      text: 'first line\r\nsecond line',
    });
    expect(requestNamed('Page').body).toMatchObject({ kind: 'raw', language: 'html' });
    expect(requestNamed('Snippet').body).toMatchObject({ kind: 'raw', language: 'javascript' });
    expect(requestNamed('Login form').body).toEqual({
      kind: 'form',
      fields: [
        expect.objectContaining({ name: 'user', value: '${adminUser}' }),
        expect.objectContaining({ name: 'remember', value: 'yes', description: 'Keep the session' }),
      ],
    });
    expect(requestNamed('Upload cover').body).toMatchObject({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'caption', value: 'Front cover' },
        { kind: 'file', name: 'image', source: { kind: 'path', path: './covers/front.png' }, contentType: 'image/png' },
      ],
    });
    expect(requestNamed('Restore').body).toMatchObject({
      kind: 'binary',
      source: { kind: 'path', path: './backups/books.tar.gz' },
      contentType: 'application/gzip',
    });
    expect(requestNamed('Purge').body).toEqual({ kind: 'none' });
  });

  it('maps auth at every level and never copies a secret', () => {
    expect(rest.auth).toEqual({ type: 'bearer' });
    expect(folderNamed('Admin').auth).toEqual({ type: 'basic', username: '${adminUser}' });
    expect(requestNamed('Get all books').auth).toEqual({ type: 'inherit' });
    expect(requestNamed('Audit').auth).toEqual({ type: 'none' });
    expect(requestNamed('Purge').auth).toEqual({ type: 'none' });
    expect(warnings).toContain('Bookstore API: Authentication type "digest" is not supported; set to "none"');
    expect(JSON.stringify(rest)).not.toContain('hunter2');
  });

  it('imports scripts switched off at their level, read from a file when named (#334)', () => {
    // The collection's script goes on the API, not into each request.
    expect(rest.scripts?.enabled).toBe(false);
    expect(rest.scripts?.pre?.text).toContain("pm.request.headers.add({ key: 'X-Trace'");
    const add = requestNamed('Add book').scripts;
    expect(add?.enabled).toBe(false);
    expect(add?.pre?.text ?? '').not.toContain('X-Trace');
    expect(add?.post?.text).toContain('pm.test("created"');
    expect(requestNamed('Audit').scripts?.pre?.text).toContain("value: 'yes'");
    expect(warnings).toContain(
      'collections/Bookstore API/.resources/definition.yaml: its grpc:beforeInvoke script runs where Wirebench has no scripts, so it was left out.',
    );
  });

  it('imports examples masked, in order, and takes the redirect settings', () => {
    const examples = requestNamed('Get all books').examples ?? [];
    expect(examples.map((e) => [e.name, e.status])).toEqual([
      ['200 OK', 200],
      ['500', 500],
    ]);
    expect(examples[0]?.headers.map((h) => h.name)).toEqual(['Content-Type']);
    expect(examples[1]?.headers.find((h) => h.name === 'authorization')?.value).toBe(REDACTED_MARKER);
    expect(examples[1]?.contentType).toBe('text/plain');
    expect(requestNamed('Ping').settings).toEqual({ followRedirects: false });
  });

  it('lists the fields it does not read', () => {
    expect(warnings).toContain(
      'collections/Bookstore API/Legacy/Ping.request.yaml: Wirebench does not read x-owner, so it was left out.',
    );
  });
});

describe('mapCollectionV3: gRPC, WebSocket and the kinds it does not map', () => {
  it('maps a gRPC request with its method, streaming kind, target, metadata and message', () => {
    const grpc = realtime.grpc!;
    expect(grpc.target).toBe('${grpcHost}');
    expect(grpc.tls).toBe(true);
    expect(grpc.auth).toEqual({ type: 'api-key', name: 'X-Api-Key', in: 'header' });
    expect(grpc.requests[0]).toMatchObject({
      name: 'Say hello',
      service: 'helloworld.Greeter',
      method: 'SayHello',
      methodKind: 'server-streaming',
      message: '{ "name": "${userName}" }',
      metadata: [expect.objectContaining({ name: 'x-tenant', value: 'acme' })],
      auth: { type: 'inherit' },
    });
    const path = 'collections/Realtime/Greeter.request.yaml';
    expect(warnings).toContain(`${path}: Wirebench does not read settings.includeDefaultFields, so it was left out.`);
    expect(warnings).toContain(`${path}: gRPC requests have no scripts in Wirebench, so its scripts were left out.`);
    expect(workspace.report.notes).toContain(
      'Realtime (gRPC): needs a definition: import its .proto or use server reflection.',
    );
  });

  it('maps a WebSocket request with its query, headers, settings and saved messages', () => {
    const ws = realtime.websocket!;
    expect(ws.url).toBe('${wsUrl}/chat');
    expect(ws.requests[0]).toMatchObject({
      name: 'Chat',
      url: '${wsUrl}/chat',
      query: [expect.objectContaining({ name: 'room', value: 'general' })],
      headers: [expect.objectContaining({ name: 'Authorization', value: 'Bearer ${userToken}' })],
      settings: { handshakeTimeoutMs: 5000 },
    });
    expect(ws.requests[0]?.messages.map((m) => [m.name, m.content])).toEqual([
      ['Message 1', '{ "type": "hello", "user": "${userName}" }'],
      ['Bye', 'bye'],
    ]);
    expect(warnings).toContain(
      'collections/Realtime/Chat.request.yaml: Wirebench does not read settings.retryCount, so it was left out.',
    );
  });

  it('reports each kind it does not map, and the first of several auths', () => {
    for (const [file, label] of [
      ['Query', 'GraphQL'],
      ['Broker', 'MQTT'],
      ['Events', 'Socket.IO'],
      ['Tools', 'MCP'],
      ['Assistant', 'LLM'],
    ]) {
      expect(warnings).toContain(
        `collections/Realtime/${file}.request.yaml: ${label} requests have no Wirebench equivalent, so it was not imported.`,
      );
    }
    expect(warnings).toContain(
      'collections/Realtime/Mystery.request.yaml: the request kind "carrier-pigeon-request" is unknown, so it was not imported.',
    );
    expect(workspace.report.notes).toContain(
      'collections/Realtime/.resources/definition.yaml: it holds 2 auths; the first ("Partner key") was imported and the others were left out.',
    );
  });
});

describe('mapCollectionV3: a single collection and refusals', () => {
  it('maps a collection with no definition, named by the picked folder or the given name', () => {
    const single = mapFolder('single', 'status');
    expect(single.collections[0]?.rest?.name).toBe('status');
    expect(single.collections[0]?.rest?.requests.map((r) => r.name)).toEqual(['Create', 'Health']);
    expect(single.report.warnings.join('\n')).not.toContain('Dynamic variables');
    const renamed = mapCollectionV3(readCollectionV3(fixtureFiles('single'), 'status'), { name: 'Health checks' });
    expect(renamed.collections[0]?.rest?.name).toBe('Health checks');
  });

  it('refuses a folder with no collection, and one with nothing to import', () => {
    const code = (files: Map<string, string>): string | undefined => {
      try {
        mapCollectionV3(readCollectionV3(files, 'x'));
        return undefined;
      } catch (error) {
        return error instanceof PostmanError ? error.code : String(error);
      }
    };
    expect(code(new Map([['readme.yaml', 'a: 1']]))).toBe('postman-v3-no-collection');
    expect(code(new Map([['q.request.yaml', '$kind: graphql-request']]))).toBe('postman-v3-nothing-to-import');
  });
});
