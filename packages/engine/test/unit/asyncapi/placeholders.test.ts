/**
 * A contract chooses the text of its server URLs, channel addresses, parameter and variable values,
 * binding samples and message examples. None of it may become a reference that reads a property, a
 * secret or the environment: a `{name}` slot is filled from the document's own default or enum, or
 * else kept as the literal `{name}` it wrote, and every `${` the document wrote is sent as written
 * (#287).
 */
import { describe, expect, it } from 'vitest';
import { importAsyncApi } from '../../../src/asyncapi/import.js';
import { expand, type PropertyScopes } from '../../../src/project/properties.js';
import { fileFetch } from '../../helpers/file-fetch.js';

const scopes: PropertyScopes = {
  project: { env: 'staging', token: 'PROPERTY-VALUE' },
  global: {},
  system: { X: 'ENV-VALUE' },
  secrets: { tok: 'SECRET-VALUE' },
};

/** The text as a send would put it on the wire, and what the expansion read on the way. */
const sent = (text: string): string => {
  const result = expand(text, scopes);
  expect(result.used).toEqual([]);
  return result.text;
};

const seqIds = () => {
  let n = 0;
  return () => `id-${String((n += 1)).padStart(4, '0')}`;
};

const load = (yaml: string) =>
  importAsyncApi({ kind: 'text', text: yaml }, { fetchDocument: fileFetch, newId: seqIds() });

/** A 3.0 document with one server and one channel Wirebench sends `m` on. */
function doc(parts: {
  readonly host?: string;
  readonly pathname: string;
  readonly variables?: string;
  readonly address?: string;
  readonly parameters?: string;
  readonly bindings?: string;
  readonly message?: string;
}): string {
  return [
    'asyncapi: 3.0.0',
    'info: {title: t, version: "1"}',
    'servers:',
    '  s:',
    `    host: ${JSON.stringify(parts.host ?? 'evil.test')}`,
    `    pathname: ${JSON.stringify(parts.pathname)}`,
    '    protocol: ws',
    ...(parts.variables !== undefined ? [`    variables: ${parts.variables}`] : []),
    'channels:',
    '  c:',
    `    address: ${JSON.stringify(parts.address ?? '/c')}`,
    ...(parts.parameters !== undefined ? [`    parameters: ${parts.parameters}`] : []),
    ...(parts.bindings !== undefined ? [`    bindings: ${parts.bindings}`] : []),
    `    messages: {m: ${parts.message ?? '{payload: {type: string}}'}}`,
    'operations:',
    "  o: {action: receive, channel: {$ref: '#/channels/c'}, messages: [{$ref: '#/channels/c/messages/m'}]}",
    '',
  ].join('\n');
}

/** A 2.6 document with one server whose `url` is written as given, and one channel. */
function doc2(url: string, variables?: string, channel = '/c'): string {
  return [
    'asyncapi: 2.6.0',
    'info: {title: t, version: "1"}',
    'servers:',
    '  s:',
    `    url: ${JSON.stringify(url)}`,
    '    protocol: ws',
    ...(variables !== undefined ? [`    variables: ${variables}`] : []),
    'channels:',
    `  ${JSON.stringify(channel)}:`,
    '    publish: {message: {payload: {type: string}}}',
    '',
  ].join('\n');
}

const keptLiteral = (where: string, name: string) => ({
  where,
  reason: `{${name}} has no ${where.startsWith('server') ? 'default or enum' : 'default, enum or example'}: it is sent as the literal text {${name}}`,
});

describe('AsyncAPI import: contract text never becomes a reference (#287)', () => {
  it('a server URL slot naming a secret is imported as literal text', async () => {
    const { api, summary } = await load(doc({ pathname: '/{secret:tok}' }));
    expect(api.url).toBe('ws://evil.test/{secret:tok}');
    expect(sent(api.url)).toBe('ws://evil.test/{secret:tok}');
    expect(summary.unresolved).toEqual(['secret:tok']);
    expect(summary.skipped).toContainEqual(keptLiteral('server s', 'secret:tok'));
  });

  it('a server URL slot naming a System property is imported as literal text', async () => {
    const { api } = await load(doc({ pathname: '/{#System#X}' }));
    expect(api.url).toBe('ws://evil.test/{#System#X}');
    expect(sent(api.url)).toBe('ws://evil.test/{#System#X}');
  });

  it('a {token} slot with no value is sent as written, never reading the token property', async () => {
    const { api, summary } = await load(
      doc({ pathname: '/{token}', variables: '{token: {description: x}}', address: '/r/{token}' }),
    );
    expect(sent(api.url)).toBe('ws://evil.test/{token}');
    expect(sent(api.requests[0]!.url)).toBe('/r/{token}');
    expect(summary.unresolved).toEqual(['token']);
    expect(summary.skipped).toContainEqual(keptLiteral('server s', 'token'));
    expect(summary.skipped).toContainEqual(keptLiteral('channel c', 'token'));
  });

  it.each([
    ['a scope prefix', '{#Env#env}'],
    ['a colon', '{a:b}'],
    ['a hash', '{a#b}'],
    ['whitespace', '{ env }'],
    ['a dollar', '{$env}'],
    ['nested braces', '{{env}}'],
    ['a brace inside', '{a{env}}'],
  ])('a slot with %s stays literal text', async (_what, slot) => {
    const { api } = await load(doc({ pathname: `/${slot}` }));
    expect(sent(api.url)).toBe(`ws://evil.test/${slot}`);
  });

  it('a long run of open braces is read in linear time', async () => {
    const run = '{{|'.repeat(20_000);
    const started = performance.now();
    const { api } = await load(doc({ pathname: `/${run}`, address: `/${run}` }));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(sent(api.url)).toBe(`ws://evil.test/${run}`);
  });

  it('contract text holding ${…} around the slots is escaped, not expanded', async () => {
    const { api } = await load(doc({ pathname: '/${secret:tok}/${env}/{env}' }));
    expect(api.url).toBe('ws://evil.test/$${secret:tok}/$${env}/{env}');
    expect(sent(api.url)).toBe('ws://evil.test/${secret:tok}/${env}/{env}');
  });

  it('server variable defaults and enums are literal values, never slots or references', async () => {
    const { api, summary } = await load(
      doc({
        pathname: '/{a}/{b}/{c}/{d}{e}',
        variables:
          '{a: {default: "${#System#X}"}, b: {enum: ["{secret:tok}"]}, c: {default: "{env}"}, d: {default: "$"}, e: {default: "{#System#X}"}}',
      }),
    );
    expect(api.url).toBe('ws://evil.test/$${#System#X}/{secret:tok}/{env}/$${#System#X}');
    expect(sent(api.url)).toBe('ws://evil.test/${#System#X}/{secret:tok}/{env}/${#System#X}');
    expect(summary.unresolved).toEqual([]);
  });

  it('a channel parameter default and a message example are sent literally', async () => {
    const { api, summary } = await load(
      doc({
        pathname: '/',
        address: '/{room}/{secret:tok}',
        parameters: '{room: {default: "${#System#X}"}}',
        message: '{payload: {type: string}, examples: [{payload: "${#System#X}"}]}',
      }),
    );
    const request = api.requests[0]!;
    expect(sent(request.url)).toBe('/${#System#X}/{secret:tok}');
    expect(summary.skipped).toContainEqual(keptLiteral('channel c', 'secret:tok'));
    const message = request.messages[0]!;
    expect(message.content).toBe('$${#System#X}');
    expect(message.contract?.generated).toBe(message.content);
    expect(sent(message.content)).toBe('${#System#X}');
  });

  it('a generated JSON sample and an object example are sent literally', async () => {
    const { api } = await load(
      doc({
        pathname: '/',
        message:
          '{payload: {type: object, properties: {t: {type: string}}}, examples: [{payload: {t: "${secret:tok}"}}]}',
      }),
    );
    const content = api.requests[0]!.messages[0]!.content;
    expect(JSON.parse(sent(content))).toEqual({ t: '${secret:tok}' });
  });

  it('ws binding query and header samples, names and subprotocols are sent literally', async () => {
    const { api } = await load(
      doc({
        pathname: '/',
        bindings:
          '{ws: {query: {type: object, properties: {"q${env}": {type: string, const: "${#System#X}"}}}, headers: {type: object, properties: {"x-h": {type: string, default: "${secret:tok}"}, Sec-WebSocket-Protocol: {type: string, enum: ["${#System#X}", "{token}"]}}}}}',
      }),
    );
    const request = api.requests[0]!;
    expect(request.query.map((q) => [sent(q.name), sent(q.value)])).toEqual([['q${env}', '${#System#X}']]);
    expect(request.headers.map((h) => [sent(h.name), sent(h.value)])).toEqual([['x-h', '${secret:tok}']]);
    // A subprotocol is never a slot: `{token}` is its text, not a parameter.
    expect(request.subprotocols.map(sent)).toEqual(['${#System#X}', '{token}']);
  });

  describe('2.x servers', () => {
    it('a slot with a default is filled from it', async () => {
      const { api, summary } = await load(doc2('{region}.evil.test/ws', '{region: {default: eu}}'));
      expect(api.url).toBe('ws://eu.evil.test/ws');
      expect(summary.unresolved).toEqual([]);
    });

    it('a default that supplies the scheme is not prefixed again', async () => {
      const { api } = await load(doc2('{base}/path', '{base: {default: "wss://evil.test"}}'));
      expect(api.url).toBe('wss://evil.test/path');
    });

    it('a slot with no default or enum is kept literal and reported', async () => {
      const { api, summary } = await load(doc2('evil.test/{token}', '{token: {description: x}}'));
      expect(sent(api.url)).toBe('ws://evil.test/{token}');
      expect(summary.unresolved).toEqual(['token']);
      expect(summary.skipped).toContainEqual(keptLiteral('server s', 'token'));
    });

    it('a channel parameter with no value is kept literal', async () => {
      const { api, summary } = await load(doc2('evil.test', undefined, '/rooms/{token}'));
      expect(sent(api.requests[0]!.url)).toBe('/rooms/{token}');
      expect(summary.skipped).toContainEqual(keptLiteral('channel /rooms/{token}', 'token'));
    });
  });
});
