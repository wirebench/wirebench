import { describe, expect, it } from 'vitest';
import { parseAsyncApi } from '../../../src/asyncapi/parse.js';
import { detectImportFormat } from '../../../src/import-detect.js';
import { AsyncApiError } from '../../../src/errors.js';
import { fileFetch } from '../../helpers/file-fetch.js';

const fixture = (name: string) => new URL(`../../fixtures/asyncapi/${name}`, import.meta.url);
// A file source is a `file:` URL in this repo (the host turns paths into URLs), not a bare path.
const parse = (name: string) => parseAsyncApi({ kind: 'file', path: fixture(name).href }, { fetchDocument: fileFetch });
const text = (body: string) => parseAsyncApi({ kind: 'text', text: body }, { fetchDocument: fileFetch });

describe('parseAsyncApi', () => {
  it('2.6: publish is sent, subscribe is received, oneOf is two messages', async () => {
    const { document } = await parse('chat-2.6.yaml');
    expect(document.version).toBe('2');
    const ops = document.operations.filter((o) => o.channel === '/chat/{roomId}');
    expect(ops.map((o) => [o.direction, o.messages.map((m) => m.name)])).toEqual([
      ['sent', ['sendMessage']],
      ['received', ['chatMessage', 'presence']],
    ]);
  });
  it('3.0: receive is sent, send is received, reply inverts, $ref sibling is kept', async () => {
    const { document, documents } = await parse('chat-3.0.yaml');
    expect(document.operations.find((o) => o.key === 'sendChat')?.direction).toBe('sent');
    expect(document.operations.find((o) => o.key === 'onChat')?.direction).toBe('received');
    expect(documents.map((d) => d.location.split('/').at(-1))).toEqual(['chat-3.0.yaml', 'schemas.yaml']);
    expect(document.servers.find((s) => s.key === 'public')?.url).toBe('wss://eu.chat.example.test/ws');
  });
  it('refuses an unsupported version by name', async () => {
    await expect(parse('unsupported-1.2.yaml')).rejects.toMatchObject({ code: 'asyncapi-version-unsupported' });
    await expect(parse('unsupported-1.2.yaml')).rejects.toBeInstanceOf(AsyncApiError);
  });

  it('2.6: servers, channels and messages are read in full', async () => {
    const { document } = await parse('chat-2.6.yaml');
    expect(document.declaredVersion).toBe('2.6.0');
    expect(document.title).toBe('Chat service');
    const pub = document.servers.find((s) => s.key === 'public');
    expect(pub).toMatchObject({ url: 'wss://eu.chat.example.test/ws', protocol: 'wss', unresolvedVariables: [] });
    expect(pub?.security).toEqual([{ key: 'apiKeyQuery', type: 'httpApiKey', in: 'query', name: 'token' }]);
    expect(document.servers.find((s) => s.key === 'broker')?.url).toBe('kafka://broker.chat.example.test:9092');
    const chat = document.channels.find((c) => c.key === '/chat/{roomId}');
    expect(chat).toMatchObject({ address: '/chat/{roomId}', servers: ['public'] });
    expect(chat?.parameters['roomId']).toEqual({ default: 'lobby', examples: ['lobby', 'general'] });
    expect(Object.keys(chat?.bindings ?? {})).toEqual(['ws']);
    expect(document.channels.find((c) => c.key === 'audit')?.servers).toEqual(['broker']);
    const sent = document.operations.find((o) => o.key === 'sendMessage')?.messages[0];
    expect(sent).toMatchObject({
      key: 'sendMessage',
      contentType: 'application/json',
      example: { type: 'message', text: 'Hello' },
    });
    const avro = document.operations.find((o) => o.key === 'auditTrail')?.messages[0];
    expect(avro).toMatchObject({
      contentType: 'application/octet-stream',
      schemaFormat: 'application/vnd.apache.avro;version=1.9.0',
    });
  });

  it('3.0: channel keys, message keys, security and the inverted reply', async () => {
    const { document, problems } = await parse('chat-3.0.yaml');
    expect(problems).toEqual([]);
    expect(document.version).toBe('3');
    const send = document.operations.find((o) => o.key === 'sendChat');
    expect(send).toMatchObject({ channel: 'userChat' });
    expect(send?.messages.map((m) => m.key)).toEqual(['sendChat']);
    expect(send?.messages[0]?.payload).toMatchObject({ required: ['type', 'text'] });
    expect(document.operations.find((o) => o.key === 'onChat')?.messages.map((m) => m.name)).toEqual([
      'chatMessage',
      'presence',
    ]);
    const reply = document.operations.find((o) => o.key === 'sendChat#reply');
    expect(reply).toMatchObject({ channel: 'userChat', direction: 'received' });
    expect(reply?.messages.map((m) => m.key)).toEqual(['ack']);
    // No messages listed: every message of the channel.
    expect(document.operations.find((o) => o.key === 'auditTrail')?.messages.map((m) => m.key)).toEqual([
      'auditRecord',
    ]);
    const userChat = document.channels.find((c) => c.key === 'userChat');
    expect(userChat).toMatchObject({ address: '/chat/{roomId}', servers: ['public'], tags: ['chat'] });
    expect(document.servers.find((s) => s.key === 'public')?.security).toEqual([
      { key: 'bearerAuth', type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    ]);
    expect(document.servers.find((s) => s.key === 'telemetry')).toMatchObject({
      protocol: 'mqtt',
      url: 'mqtt://mqtt.chat.example.test:1883',
    });
  });

  it('lists a server variable with no default or enum as unresolved', async () => {
    const { document } = await text(
      'asyncapi: 3.0.0\ninfo: {title: t, version: "1"}\nservers:\n  s:\n    host: "{tenant}.example.test"\n    protocol: ws\n    variables:\n      tenant: {description: x}\n',
    );
    expect(document.servers[0]).toMatchObject({ url: 'ws://{tenant}.example.test', unresolvedVariables: ['tenant'] });
  });

  it('notes what it cannot map instead of throwing', async () => {
    const { document } = await text(
      'asyncapi: 3.0.0\ninfo: {title: t, version: "1"}\noperations:\n  lost: {action: send}\n  odd: {action: shout, channel: {address: x}}\n',
    );
    expect(document.operations).toEqual([]);
    expect(document.notes.map((n) => n.where)).toEqual(['operations/lost', 'operations/odd']);
  });

  it('throws malformed on unparseable text or a document without a version', async () => {
    await expect(text('{ not json')).rejects.toMatchObject({ code: 'asyncapi-malformed' });
    await expect(text('info: {title: t}')).rejects.toMatchObject({ code: 'asyncapi-malformed' });
    await expect(text('- a list')).rejects.toBeInstanceOf(AsyncApiError);
  });
});

describe('detectImportFormat — asyncapi', () => {
  it('is definite on the asyncapi key and wins over the .yaml fallback', () => {
    expect(detectImportFormat({ text: 'asyncapi: 3.0.0\ninfo: {title: x, version: "1"}', filename: 'a.yaml' })).toEqual(
      { kind: 'asyncapi', label: 'AsyncAPI 3.0.0', confidence: 'definite' },
    );
    expect(detectImportFormat({ filename: 'chat.asyncapi.yml' }).kind).toBe('asyncapi');
  });
});
