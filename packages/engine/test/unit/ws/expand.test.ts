import { describe, expect, it } from 'vitest';
import { expandWsInput, expandWsMessage, type WsCallInput } from '../../../src/ws/expand.js';
import { entry } from '../../../src/rest/model.js';
import { createWsRequest } from '../../../src/ws/model.js';

describe('expandWsInput', () => {
  const scopes = { project: { host: 'api.test', room: '7', quote: 'say "hi"' }, global: {}, system: {} };

  function callInput(overrides: Partial<WsCallInput['request']> = {}): WsCallInput {
    return {
      serverUrl: 'wss://${host}',
      request: {
        ...createWsRequest('r'),
        url: '',
        query: [],
        headers: [],
        subprotocols: [],
        settings: {},
        ...overrides,
      },
      apiHeaders: [],
    };
  }

  it('expands the URL, query values, header values and subprotocols', () => {
    const { input, unresolved } = expandWsInput(
      callInput({
        url: '/chat/${room}',
        query: [entry('room', '${room}')],
        headers: [entry('x-room', '${room}')],
        subprotocols: ['chat.${room}'],
      }),
      scopes,
    );
    expect(input.serverUrl).toBe('wss://${host}'); // serverUrl itself is resolved by resolveWsUrl, not expanded here
    expect(input.request.url).toBe('/chat/7');
    expect(input.request.query).toEqual([entry('room', '7')]);
    expect(input.request.headers).toEqual([entry('x-room', '7')]);
    expect(input.request.subprotocols).toEqual(['chat.7']);
    expect(unresolved).toEqual([]);
  });

  it('expands API headers too, and header/query row names', () => {
    const { input } = expandWsInput(callInput({ headers: [entry('x-${room}', 'v')] }), scopes);
    expect(input.request.headers).toEqual([entry('x-7', 'v')]);

    const withApiHeaders = expandWsInput({ ...callInput(), apiHeaders: [entry('x-api', '${room}')] }, scopes);
    expect(withApiHeaders.input.apiHeaders).toEqual([entry('x-api', '7')]);
  });

  it('reports an unknown reference once per place it appears', () => {
    const { unresolved } = expandWsInput(
      callInput({
        url: '/${nope}',
        query: [entry('q', '${nope}')],
        headers: [entry('h', '${nope}')],
        subprotocols: ['${nope}'],
      }),
      scopes,
    );
    expect(unresolved).toHaveLength(4);
    expect(unresolved.every((ref) => ref.name === 'nope')).toBe(true);
  });
});

describe('expandWsMessage', () => {
  const scopes = { project: { quote: 'say "hi"' }, global: {}, system: {} };

  it('expands without escaping by default', () => {
    const { text, unresolved } = expandWsMessage('{"q": "${quote}"}', scopes, { escape: false });
    expect(text).toBe('{"q": "say "hi""}');
    expect(unresolved).toEqual([]);
  });

  it('JSON-escapes a substituted value when asked', () => {
    const { text } = expandWsMessage('{"q": "${quote}"}', scopes, { escape: true });
    expect(text).toBe('{"q": "say \\"hi\\""}');
  });

  it('reports an unknown reference', () => {
    const { unresolved } = expandWsMessage('${nope}', scopes, { escape: false });
    expect(unresolved.map((ref) => ref.name)).toEqual(['nope']);
  });
});
