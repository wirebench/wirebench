/**
 * An imported AsyncAPI contract sent for real: whatever text it chose for its server URL, channel
 * address, parameter defaults, binding samples and message examples, neither a stored secret, an
 * environment variable nor a project property reaches the wire: a `{name}` slot the document gives
 * no value is dialled as the literal `{name}` it wrote (#287).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importAsyncApi } from '../../../src/asyncapi/import.js';
import { createProject } from '../../../src/index.js';
import type { Project } from '../../../src/project/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { openExchange } from '../../../src/run/open.js';
import { createRunScope } from '../../../src/run/scope.js';
import type { WsApi } from '../../../src/ws/model.js';
import type { WsSelected } from '../../../src/ws/run.js';
import { fileFetch } from '../../helpers/file-fetch.js';
import { testHost } from '../../helpers/send-host.js';
import { startTestWsServer, type TestWsServer } from '../../helpers/test-ws-server.js';

const ENV_NAME = 'WB_287_X';
const ENV_VALUE = 'ENV-VALUE-287';
const SECRET_VALUE = 'SECRET-VALUE-287';
const PROPERTY_VALUE = 'PROPERTY-VALUE-287';

let server: TestWsServer;
let host: string;

beforeAll(async () => {
  server = await startTestWsServer();
  host = new URL(server.url).host;
  process.env[ENV_NAME] = ENV_VALUE;
});

afterAll(async () => {
  delete process.env[ENV_NAME];
  await server.close();
});

/** A 3.0 contract served by the test server, with one channel Wirebench sends `m` on. */
function contract(parts: {
  readonly pathname: string;
  readonly variables?: string;
  readonly address: string;
  readonly parameters?: string;
  readonly bindings?: string;
  readonly message: string;
}): string {
  return [
    'asyncapi: 3.0.0',
    'info: {title: t, version: "1"}',
    'servers:',
    '  s:',
    `    host: ${JSON.stringify(host)}`,
    `    pathname: ${JSON.stringify(parts.pathname)}`,
    '    protocol: ws',
    ...(parts.variables !== undefined ? [`    variables: ${parts.variables}`] : []),
    'channels:',
    '  c:',
    `    address: ${JSON.stringify(parts.address)}`,
    ...(parts.parameters !== undefined ? [`    parameters: ${parts.parameters}`] : []),
    ...(parts.bindings !== undefined ? [`    bindings: ${parts.bindings}`] : []),
    `    messages: {m: ${parts.message}}`,
    'operations:',
    "  o: {action: receive, channel: {$ref: '#/channels/c'}, messages: [{$ref: '#/channels/c/messages/m'}]}",
    '',
  ].join('\n');
}

/** What one send put on the wire: the upgrade it dialled, if any, and the text frames it sent. */
interface Wire {
  readonly url?: string;
  readonly frames: readonly string[];
  /** The code the send was refused with before it dialled, if it was. */
  readonly refused?: string;
}

/**
 * Imports `yaml` and runs its one request against the test server, the way a run sends it, then
 * checks that nothing the server saw — upgrade, headers or frames — holds the secret or the
 * environment value.
 */
async function send(yaml: string): Promise<Wire> {
  const { api } = await importAsyncApi({ kind: 'text', text: yaml }, { fetchDocument: fileFetch });
  const imported: WsApi = { ...api, slug: 'chat' };
  const request = imported.requests[0]!;
  const p: Project = {
    ...createProject('AsyncAPI #287', { id: 'p-287' }),
    // A property under the very name a slot uses: a slot must never read it.
    properties: { token: PROPERTY_VALUE },
    wsApis: [imported],
  };
  const item: WsSelected = { kind: 'websocket', path: 'Chat/c', group: 'Chat', api: imported, chain: [], request };
  const sendHost = testHost({ 'secret:tok': SECRET_VALUE, tok: SECRET_VALUE });
  const context: RunContext = { project: p, projectDir: '/nowhere', overrides: {}, host: sendHost };
  const handshakes = server.handshakes.length;
  const received = server.received.length;
  const handle = openExchange(item, sendHost, { scope: createRunScope(context), interactive: false });
  let wire: Wire;
  try {
    const sent = await handle.result;
    const ws = sent.exchange?.kind === 'websocket' ? sent.exchange.ws : undefined;
    const frames = (ws?.frames ?? []).filter((f) => f.direction === 'sent' && f.text !== undefined);
    wire = { url: decodeURIComponent(server.handshakes.at(-1)!.url), frames: frames.map((f) => f.text!) };
  } catch (error) {
    wire = { frames: [], refused: (error as { code?: string }).code ?? String(error) };
  }
  const seen = [
    ...server.handshakes.slice(handshakes).flatMap((h) => [decodeURIComponent(h.url), JSON.stringify(h.headers)]),
    ...server.received.slice(received).map((f) => f.payload.toString()),
  ].join('\n');
  expect(seen).not.toContain(ENV_VALUE);
  expect(seen).not.toContain(SECRET_VALUE);
  expect(seen).not.toContain(PROPERTY_VALUE);
  expect(server.handshakes.length - handshakes).toBe(wire.refused === undefined ? 1 : 0);
  return wire;
}

const reference = `\${#System#${ENV_NAME}}`;

describe('an imported AsyncAPI contract on the wire (#287)', () => {
  it('a server URL slot naming a secret is dialled as literal text', async () => {
    const { url } = await send(
      contract({ pathname: '/{secret:tok}', address: '/x', message: '{payload: {type: string}}' }),
    );
    expect(url).toBe('/{secret:tok}/x');
  });

  it('a server URL slot naming a System property is never dialled with the environment value', async () => {
    // The literal `#` starts a fragment, which a WebSocket URL may not carry: the send stops before it dials.
    const wire = await send(
      contract({ pathname: `/a{#System#${ENV_NAME}}`, address: '', message: '{payload: {type: string}}' }),
    );
    expect(wire.refused).toBe('ws-bad-options');
  });

  it('a {token} slot with no value is dialled as written, never reading the token property', async () => {
    const { url } = await send(
      contract({
        pathname: '/{token}',
        variables: '{token: {description: x}}',
        address: '/r/{token}',
        message: '{payload: {type: string}}',
      }),
    );
    expect(url).toBe('/{token}/r/{token}');
  });

  it('a server variable default fills its slot', async () => {
    const { url } = await send(
      contract({
        pathname: '/{env}',
        variables: '{env: {default: echo}}',
        address: '/x',
        message: '{payload: {type: string}}',
      }),
    );
    expect(url).toBe('/echo/x');
  });

  it('a channel parameter default holding a System reference is never expanded', async () => {
    const wire = await send(
      contract({
        pathname: '/',
        address: '/r/{room}',
        parameters: `{room: {default: ${JSON.stringify(`x${reference}`)}}}`,
        message: '{payload: {type: string}}',
      }),
    );
    expect(wire.refused).toBe('ws-bad-options');
  });

  it('a channel parameter default holding a secret reference is dialled as written', async () => {
    const { url } = await send(
      contract({
        pathname: '/',
        address: '/r/{room}',
        parameters: '{room: {default: "${secret:tok}"}}',
        message: '{payload: {type: string}}',
      }),
    );
    expect(url).toBe('/r/${secret:tok}');
  });

  it('a message example and binding samples holding references are sent literally', async () => {
    const { url, frames } = await send(
      contract({
        pathname: '/',
        address: '/q',
        bindings: `{ws: {query: {type: object, properties: {q: {type: string, const: ${JSON.stringify(reference)}}}}, headers: {type: object, properties: {x-h: {type: string, const: "\${secret:tok}"}}}}}`,
        message: `{payload: {type: string}, examples: [{payload: ${JSON.stringify(reference)}}]}`,
      }),
    );
    expect(url).toBe(`/q?q=${reference}`);
    expect(server.handshakes.at(-1)!.headers['x-h']).toBe('${secret:tok}');
    expect(frames).toEqual([reference]);
  });
});
