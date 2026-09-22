import { describe, expect, it } from 'vitest';
import { mapAsyncApi } from '../../../src/asyncapi/map.js';
import { importAsyncApi } from '../../../src/asyncapi/import.js';
import { parseAsyncApi } from '../../../src/asyncapi/parse.js';
import type { AsyncApiDocument } from '../../../src/asyncapi/model.js';
import { fileFetch } from '../../helpers/file-fetch.js';

const fixture = (name: string) => new URL(`../../fixtures/asyncapi/${name}`, import.meta.url);
const parse = (name: string) => parseAsyncApi({ kind: 'file', path: fixture(name).href }, { fetchDocument: fileFetch });
const seqIds = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}-${String((n += 1)).padStart(4, '0')}`;
};

describe('mapAsyncApi', () => {
  it('one request per ws channel with path, query, headers and subprotocol', async () => {
    const { api, summary } = mapAsyncApi((await parse('chat-2.6.yaml')).document, { newId: seqIds() });
    expect(api.url).toBe('wss://eu.chat.example.test/ws');
    expect(api.requests).toHaveLength(1);
    const req = api.requests.find((r) => r.contract?.channel === '/chat/{roomId}')!;
    expect(req.url).toBe('/chat/lobby'); // parameter default
    expect(req.query.map((q) => q.name)).toEqual(['token']);
    expect(req.subprotocols).toEqual(['chat.v1']);
    expect(req.headers.some((h) => h.name.toLowerCase() === 'sec-websocket-protocol')).toBe(false);
    expect(summary.skipped).toContainEqual({
      where: 'channel audit',
      reason: 'kafka binding: only WebSocket is imported',
    });
    expect(summary.skipped).toContainEqual({
      where: 'server broker',
      reason: 'kafka server: only WebSocket is imported',
    });
  });

  it('outgoing messages get samples, examples win, Avro is reported', async () => {
    const { api, summary } = mapAsyncApi((await parse('chat-2.6.yaml')).document, { newId: seqIds() });
    const req = api.requests.find((r) => r.contract?.channel === '/chat/{roomId}')!;
    expect(req.messages.map((m) => m.name)).toEqual(['sendMessage']);
    expect(JSON.parse(req.messages[0]!.content)).toEqual({ type: 'message', text: 'Hello' }); // examples[0].payload
    expect(req.messages[0]!.content).toBe('{\n  "type": "message",\n  "text": "Hello"\n}');
    expect(req.messages[0]!.contract).toEqual({ message: 'sendMessage', generated: req.messages[0]!.content });
    expect(summary.skipped.some((s) => s.reason.includes('avro'))).toBe(true);
    expect(summary).toMatchObject({
      declaredVersion: '2.6.0',
      title: 'Chat service',
      server: 'public',
      requests: 1,
      messages: 1,
    });
  });

  it('3.0 bearer security becomes the API auth; mqtt server is skipped; tags make folders', async () => {
    const { api, summary } = mapAsyncApi((await parse('chat-3.0.yaml')).document, { newId: seqIds() });
    expect(api.auth).toMatchObject({ type: 'bearer' });
    expect(summary.skipped.some((s) => s.where === 'server telemetry' && s.reason.includes('mqtt'))).toBe(true);
    expect(api.folders.map((f) => f.name)).toEqual(['chat']);
    const req = api.folders[0]!.requests[0]!;
    expect(req.contract).toEqual({ channel: 'userChat' });
    expect(req.url).toBe('/chat/lobby');
    expect(req.auth).toEqual({ type: 'inherit' });
    // sendChat is outgoing; its reply (ack) and onChat are incoming, so they get no sample.
    expect(req.messages.map((m) => m.name)).toEqual(['sendChat']);
  });

  it('a sample is generated when there is no example; a string payload is saved raw', () => {
    const doc: AsyncApiDocument = {
      version: '3',
      declaredVersion: '3.0.0',
      title: 'Gen',
      servers: [{ key: 's', url: 'ws://h.test', protocol: 'ws', security: [], unresolvedVariables: [] }],
      channels: [{ key: 'c', address: '/{id}', servers: 'all', parameters: { id: {} }, bindings: {}, tags: [] }],
      operations: [
        {
          key: 'o',
          channel: 'c',
          direction: 'sent',
          messages: [
            {
              key: 'a',
              name: 'a',
              contentType: 'application/json',
              payload: {
                type: 'object',
                required: ['n'],
                properties: { n: { type: 'integer' }, x: { type: 'string' } },
              },
            },
            { key: 'b', name: 'a', contentType: 'text/plain', payload: { type: 'string', examples: ['ping'] } },
            { key: 'c', name: 'c', contentType: 'application/json', payload: { type: 'object', if: {} } },
          ],
        },
      ],
      notes: [],
    };
    const { api, summary } = mapAsyncApi(doc, { newId: seqIds() });
    const req = api.requests[0]!;
    expect(req.url).toBe('/${id}');
    expect(summary.unresolved).toEqual(['id']);
    expect(JSON.parse(req.messages[0]!.content)).toEqual({ n: 0 });
    expect(req.messages[1]!.content).not.toMatch(/^"/);
    expect(req.messages.map((m) => m.slug)).toEqual(['a', 'a-2', 'c']);
    expect(summary.unsupportedKeywords).toEqual(['if']);
  });

  it('picks the named server and refuses to guess an unknown one', async () => {
    const { document } = await parse('chat-3.0.yaml');
    expect(mapAsyncApi(document, { server: 'public', newId: seqIds() }).summary.server).toBe('public');
    expect(() => mapAsyncApi(document, { server: 'nope' })).toThrow(/nope/);
  });

  it('deterministic ids with newId', async () => {
    const { document } = await parse('chat-2.6.yaml');
    expect(mapAsyncApi(document, { newId: seqIds() })).toEqual(mapAsyncApi(document, { newId: seqIds() }));
  });

  it('a null channel address maps to an empty url; no ws server leaves the api url empty too', () => {
    const doc: AsyncApiDocument = {
      version: '3',
      declaredVersion: '3.0.0',
      title: 'NoAddr',
      servers: [{ key: 's', url: 'http://h.test', protocol: 'http', security: [], unresolvedVariables: [] }],
      channels: [{ key: 'c', address: null, servers: 'all', parameters: {}, bindings: { ws: {} }, tags: [] }],
      operations: [],
      notes: [],
    };
    const { api, summary } = mapAsyncApi(doc, { newId: seqIds() });
    expect(api.url).toBe('');
    expect(api.requests[0]?.url).toBe('');
    expect(summary.server).toBeUndefined();
    expect(summary.skipped).toContainEqual({ where: 'servers', reason: 'no ws or wss server: the API has no URL' });
  });

  it('a channel parameter resolves from enum when there is no default', () => {
    const doc: AsyncApiDocument = {
      version: '3',
      declaredVersion: '3.0.0',
      title: 'Enum',
      servers: [{ key: 's', url: 'ws://h.test', protocol: 'ws', security: [], unresolvedVariables: [] }],
      channels: [
        {
          key: 'c',
          address: '/{env}',
          servers: 'all',
          parameters: { env: { enum: ['prod', 'staging'] } },
          bindings: {},
          tags: [],
        },
      ],
      operations: [],
      notes: [],
    };
    const { api } = mapAsyncApi(doc, { newId: seqIds() });
    expect(api.requests[0]?.url).toBe('/prod');
  });

  it('a ws binding method other than GET is reported, and a subprotocol enum with no match is skipped', () => {
    const doc: AsyncApiDocument = {
      version: '3',
      declaredVersion: '3.0.0',
      title: 'Bindings',
      servers: [{ key: 's', url: 'ws://h.test', protocol: 'ws', security: [], unresolvedVariables: [] }],
      channels: [
        {
          key: 'c',
          address: '/c',
          servers: 'all',
          parameters: {},
          bindings: {
            ws: {
              method: 'POST',
              headers: { properties: { 'Sec-WebSocket-Protocol': { type: 'string' } } },
            },
            http: {},
          },
          tags: [],
        },
      ],
      operations: [],
      notes: [],
    };
    const { summary } = mapAsyncApi(doc, { newId: seqIds() });
    expect(summary.skipped).toContainEqual({
      where: 'channel c',
      reason: 'ws binding method POST is ignored: a handshake is always GET',
    });
    expect(summary.skipped).toContainEqual({
      where: 'channel c',
      reason: 'Sec-WebSocket-Protocol has no const or enum to take a subprotocol from',
    });
    expect(summary.skipped).toContainEqual({
      where: 'channel c',
      reason: 'http binding is ignored on a WebSocket channel',
    });
  });

  it('a subprotocol enum offers every matching name', () => {
    const doc: AsyncApiDocument = {
      version: '3',
      declaredVersion: '3.0.0',
      title: 'SubEnum',
      servers: [{ key: 's', url: 'ws://h.test', protocol: 'ws', security: [], unresolvedVariables: [] }],
      channels: [
        {
          key: 'c',
          address: '/c',
          servers: 'all',
          parameters: {},
          bindings: { ws: { headers: { properties: { 'sec-websocket-protocol': { enum: ['chat.v1', 'chat.v2'] } } } } },
          tags: [],
        },
      ],
      operations: [],
      notes: [],
    };
    const { api } = mapAsyncApi(doc, { newId: seqIds() });
    expect(api.requests[0]?.subprotocols).toEqual(['chat.v1', 'chat.v2']);
  });

  it('a message with an unsupported schemaFormat gets no sample, but its channel still maps', () => {
    const doc: AsyncApiDocument = {
      version: '3',
      declaredVersion: '3.0.0',
      title: 'Avro',
      servers: [{ key: 's', url: 'ws://h.test', protocol: 'ws', security: [], unresolvedVariables: [] }],
      channels: [{ key: 'c', address: '/c', servers: 'all', parameters: {}, bindings: {}, tags: [] }],
      operations: [
        {
          key: 'o',
          channel: 'c',
          direction: 'sent',
          messages: [
            {
              key: 'm',
              name: 'm',
              contentType: 'application/octet-stream',
              schemaFormat: 'application/vnd.apache.avro',
            },
          ],
        },
      ],
      notes: [],
    };
    const { api } = mapAsyncApi(doc, { newId: seqIds() });
    expect(api.requests[0]?.messages).toEqual([]);
  });
});

describe('importAsyncApi', () => {
  it('parses, maps, and records the definition', async () => {
    const source = { kind: 'file', path: fixture('chat-3.0.yaml').href } as const;
    const imported = await importAsyncApi(source, { fetchDocument: fileFetch, newId: seqIds() });
    expect(imported.declaredVersion).toBe('3.0.0');
    expect(imported.documents).toHaveLength(2);
    expect(imported.api.definition).toEqual({ kind: 'asyncapi', source: fixture('chat-3.0.yaml').href, cache: true });
  });

  const minimalDoc = 'asyncapi: 3.0.0\ninfo: {title: t, version: "1"}\n';
  const textFetch = (location: string) =>
    Promise.resolve({ location, bytes: new TextEncoder().encode(minimalDoc), text: minimalDoc });

  it('records a url source verbatim', async () => {
    const source = { kind: 'url', url: 'https://api.test/asyncapi.yaml' } as const;
    const imported = await importAsyncApi(source, { fetchDocument: textFetch, newId: seqIds() });
    expect(imported.api.definition).toMatchObject({ source: 'https://api.test/asyncapi.yaml' });
  });

  it('records a text source with a location verbatim', async () => {
    const source = { kind: 'text', text: minimalDoc, location: 'https://api.test/pasted.yaml' } as const;
    const imported = await importAsyncApi(source, { fetchDocument: fileFetch, newId: seqIds() });
    expect(imported.api.definition).toMatchObject({ source: 'https://api.test/pasted.yaml' });
  });

  it('falls back to inline:asyncapi for a text source with no location', async () => {
    const source = { kind: 'text', text: minimalDoc } as const;
    const imported = await importAsyncApi(source, { fetchDocument: fileFetch, newId: seqIds() });
    expect(imported.api.definition).toMatchObject({ source: 'inline:asyncapi' });
  });
});
