import { describe, expect, it } from 'vitest';
import { FORBIDDEN_HANDSHAKE_HEADERS, toWsSessionOptions, type WsCallInput } from '../../../src/ws/call.js';
import { WsError } from '../../../src/errors.js';
import { entry } from '../../../src/rest/model.js';
import { createWsRequest } from '../../../src/ws/model.js';

function callInput(
  overrides: Partial<WsCallInput['request']> = {},
  apiHeaders: WsCallInput['apiHeaders'] = [],
): WsCallInput {
  return {
    serverUrl: 'wss://example.test',
    request: {
      ...createWsRequest('r'),
      url: '/chat',
      query: [],
      headers: [],
      subprotocols: [],
      settings: {},
      ...overrides,
    },
    apiHeaders,
  };
}

describe('toWsSessionOptions', () => {
  it('resolves the URL and merges API headers under request headers', () => {
    const options = toWsSessionOptions(
      callInput({ headers: [entry('X-Custom', 'req')] }, [entry('X-Custom', 'api'), entry('X-Api', 'api')]),
      { auth: { type: 'bearer', token: 't' } },
    );
    expect(options.url).toBe('wss://example.test/chat');
    expect(options.headers?.['X-Custom']).toBe('req');
    expect(options.headers?.['X-Api']).toBe('api');
  });

  it('a request header beats an API header whatever the case', () => {
    const options = toWsSessionOptions(
      callInput({ headers: [entry('x-custom', 'req')] }, [entry('X-Custom', 'api')]),
      {},
    );
    expect(Object.keys(options.headers ?? {})).toEqual(['x-custom']);
    expect(options.headers?.['x-custom']).toBe('req');
  });

  it('drops forbidden handshake headers rather than throwing', () => {
    const options = toWsSessionOptions(
      callInput({ headers: [entry('Sec-WebSocket-Key', 'x'), entry('Upgrade', 'y'), entry('X-Ok', 'z')] }),
      {},
    );
    expect(options.headers).toEqual({ 'X-Ok': 'z' });
    expect(FORBIDDEN_HANDSHAKE_HEADERS.has('sec-websocket-key')).toBe(true);
  });

  it('no auth means no authorization header and no extra query rows', () => {
    const options = toWsSessionOptions(callInput({ query: [entry('room', '7')] }), {});
    expect(options.headers?.['Authorization']).toBeUndefined();
    expect(options.headers?.['authorization']).toBeUndefined();
    expect(options.url).toBe('wss://example.test/chat?room=7');
  });

  it('Bearer lands in the authorization header', () => {
    const options = toWsSessionOptions(callInput(), { auth: { type: 'bearer', token: 'abc', scheme: 'Token' } });
    expect(options.headers?.['Authorization']).toBe('Token abc');
  });

  it('Basic is encoded directly, without a transport challenge', () => {
    const options = toWsSessionOptions(callInput(), {
      auth: { type: 'basic', username: 'u', password: 'p', preemptive: false },
    });
    expect(options.headers?.['Authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('an API key in a header lands in the header', () => {
    const options = toWsSessionOptions(callInput(), {
      auth: { type: 'api-key', name: 'X-Key', value: 'v', in: 'header' },
    });
    expect(options.headers?.['X-Key']).toBe('v');
  });

  it('an API key in the query lands in the URL', () => {
    const options = toWsSessionOptions(callInput(), {
      auth: { type: 'api-key', name: 'key', value: 'v', in: 'query' },
    });
    expect(options.url).toBe('wss://example.test/chat?key=v');
  });

  it('NTLM throws ws-auth-unsupported with an actionable message', () => {
    expect(() => toWsSessionOptions(callInput(), { auth: { type: 'ntlm', username: 'u', password: 'p' } })).toThrow(
      WsError,
    );
    try {
      toWsSessionOptions(callInput(), { auth: { type: 'ntlm', username: 'u', password: 'p' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WsError);
      expect((err as WsError).code).toBe('ws-auth-unsupported');
      expect((err as WsError).message).toMatch(/round trip/);
    }
  });

  it('carries settings.handshakeTimeoutMs, maxMessageBytes and bindAddress through', () => {
    const options = toWsSessionOptions(
      callInput({ settings: { handshakeTimeoutMs: 5000, maxMessageBytes: 1024, bindAddress: '10.0.0.1' } }),
      { auth: { type: 'oauth2', accessToken: 't' } },
    );
    expect(options.handshakeTimeoutMs).toBe(5000);
    expect(options.maxMessageBytes).toBe(1024);
    expect(options.localAddress).toBe('10.0.0.1');
  });

  it('settings.trustInvalid turns into tls.rejectUnauthorized: false, merged over material.tls', () => {
    const options = toWsSessionOptions(callInput({ settings: { trustInvalid: true } }), {
      auth: { type: 'oauth2', accessToken: 't' },
      tls: { minVersion: 'TLSv1.2' },
    });
    expect(options.tls).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
  });
});
