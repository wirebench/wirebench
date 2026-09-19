/**
 * `toWsSessionOptions` and `openWsSession` together: a saved request with Bearer auth and a
 * `${room}` reference in its query reaches the test server's `/echo` with the expanded query and
 * the authorization header set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expandWsInput } from '../../../src/ws/expand.js';
import { toWsSessionOptions } from '../../../src/ws/call.js';
import { openWsSession, type WsSessionHandle } from '../../../src/ws/session.js';
import { createWsRequest } from '../../../src/ws/model.js';
import { entry } from '../../../src/rest/model.js';
import { startTestWsServer, type TestWsServer } from '../../helpers/test-ws-server.js';

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let server: TestWsServer;
const openSessions: WsSessionHandle[] = [];

beforeAll(async () => {
  server = await startTestWsServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(async () => {
  for (const session of openSessions.splice(0)) {
    session.close();
    await session.done;
  }
});

describe('a saved WebSocket request as session options', () => {
  it('reaches /echo with the expanded query and the bearer header set', async () => {
    const scopes = { project: { room: '7' }, global: {}, system: {} };
    const request = createWsRequest('room', { url: '/echo', query: [entry('room', '${room}')] });

    const { input } = expandWsInput({ serverUrl: server.url, request, apiHeaders: [] }, scopes);
    const options = toWsSessionOptions(input, { auth: { type: 'bearer', token: 'secret' } });

    expect(options.url).toBe(`${server.url}/echo?room=7`);
    expect(options.headers?.['Authorization']).toBe('Bearer secret');

    const session = openWsSession(options);
    openSessions.push(session);
    await until(() => session.isOpen, 'open');
    session.close();
    await session.done;

    expect(server.handshakes).toHaveLength(1);
    const handshake = server.handshakes[0]!;
    expect(handshake.url).toBe('/echo?room=7');
    expect(handshake.headers.authorization).toBe('Bearer secret');
  });

  it('reaches /echo with no authorization header when the request has no auth', async () => {
    const scopes = { project: {}, global: {}, system: {} };
    const request = createWsRequest('anon', { url: '/echo' });

    const { input } = expandWsInput({ serverUrl: server.url, request, apiHeaders: [] }, scopes);
    const options = toWsSessionOptions(input, {});

    expect(options.headers?.['Authorization']).toBeUndefined();

    const session = openWsSession(options);
    openSessions.push(session);
    await until(() => session.isOpen, 'open');
    session.close();
    await session.done;

    const handshake = server.handshakes.at(-1)!;
    expect(handshake.headers.authorization).toBeUndefined();
  });
});
