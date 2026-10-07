/**
 * A contract chooses the text of its server URLs, channel addresses, parameter and variable values,
 * binding samples and message examples. None of it may become a reference that reads a secret, the
 * environment or another scope: only a `{name}` slot with a plain name becomes a `${name}` property,
 * and everything else the contract wrote is sent exactly as written (#287).
 */
import { describe, expect, it } from 'vitest';
import { importAsyncApi } from '../../../src/asyncapi/import.js';
import { expand, type PropertyScopes } from '../../../src/project/properties.js';
import { fileFetch } from '../../helpers/file-fetch.js';

const scopes: PropertyScopes = {
  project: { env: 'staging' },
  global: {},
  system: { X: 'ENV-VALUE' },
  secrets: { tok: 'SECRET-VALUE' },
};

/** The text as a send would put it on the wire. */
const sent = (text: string): string => expand(text, scopes).text;

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

describe('AsyncAPI import: contract text never becomes a secret or System reference (#287)', () => {
  it('a server URL slot naming a secret is imported as literal text', async () => {
    const { api, summary } = await load(doc({ pathname: '/{secret:tok}' }));
    expect(api.url).toBe('ws://evil.test/{secret:tok}');
    expect(sent(api.url)).toBe('ws://evil.test/{secret:tok}');
    expect(summary.unresolved).toEqual([]);
    expect(summary.skipped).toContainEqual({
      where: 'server s',
      reason: '{secret:tok} is not a plain property name: it is kept as literal text',
    });
  });

  it('a server URL slot naming a System property is imported as literal text', async () => {
    const { api, summary } = await load(doc({ pathname: '/{#System#X}' }));
    expect(api.url).toBe('ws://evil.test/{#System#X}');
    expect(sent(api.url)).not.toContain('ENV-VALUE');
    expect(summary.unresolved).toEqual([]);
  });

  it('a plain server variable still becomes a property and resolves', async () => {
    const { api, summary } = await load(doc({ pathname: '/{env}', variables: '{env: {description: stage}}' }));
    expect(api.url).toBe('ws://evil.test/${env}');
    expect(sent(api.url)).toBe('ws://evil.test/staging');
    expect(summary.unresolved).toEqual(['env']);
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
    const { api, summary } = await load(doc({ pathname: `/${slot}` }));
    expect(sent(api.url)).toBe(`ws://evil.test/${slot}`);
    expect(summary.unresolved).toEqual([]);
  });

  it('contract text holding ${…} around the slots is escaped, not expanded', async () => {
    const { api } = await load(doc({ pathname: '/${secret:tok}/${env}/{env}' }));
    expect(api.url).toBe('ws://evil.test/$${secret:tok}/$${env}/${env}');
    expect(sent(api.url)).toBe('ws://evil.test/${secret:tok}/${env}/staging');
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
    const { api } = await load(
      doc({
        pathname: '/',
        address: '/{room}/{secret:tok}',
        parameters: '{room: {default: "${#System#X}"}}',
        message: '{payload: {type: string}, examples: [{payload: "${#System#X}"}]}',
      }),
    );
    const request = api.requests[0]!;
    expect(sent(request.url)).toBe('/${#System#X}/{secret:tok}');
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
          '{ws: {query: {type: object, properties: {"q${env}": {type: string, const: "${#System#X}"}}}, headers: {type: object, properties: {"x-h": {type: string, default: "${secret:tok}"}, Sec-WebSocket-Protocol: {type: string, const: "${#System#X}"}}}}}',
      }),
    );
    const request = api.requests[0]!;
    expect(request.query.map((q) => [sent(q.name), sent(q.value)])).toEqual([['q${env}', '${#System#X}']]);
    expect(request.headers.map((h) => [sent(h.name), sent(h.value)])).toEqual([['x-h', '${secret:tok}']]);
    expect(request.subprotocols.map(sent)).toEqual(['${#System#X}']);
  });
});
