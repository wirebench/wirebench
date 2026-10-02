/**
 * What a WebSocket session looks like to assertions (request-assertions spec §3): each received
 * text message in order, a JSON one as its value and any other as its text; no binary, control
 * or sent frame.
 */
import { describe, expect, it } from 'vitest';
import { wsSubject } from '../../../src/ws/run.js';
import type { WsExchange } from '../../../src/ws/model.js';

function exchange(frames: readonly object[], refused = false): WsExchange {
  return {
    handshake: { status: refused ? undefined : 101, responseHeaders: { upgrade: 'websocket' } },
    frames,
    durationMs: 12,
  } as unknown as WsExchange;
}

const received = (text: string) => ({ direction: 'received', opcode: 'text', text });

describe('wsSubject', () => {
  it('parses JSON messages and keeps any other text as a string', () => {
    const subject = wsSubject(
      exchange([
        { direction: 'sent', opcode: 'text', text: '{"op":"sub"}' },
        received('{"type":"ready"}'),
        received('pong'),
        { direction: 'received', opcode: 'binary', base64: 'AAEC' },
        { direction: 'received', opcode: 'ping', base64: 'aGk=' },
        received('123'),
        received('"hi"'),
        received('{"id":7}'),
      ]),
    );
    expect(JSON.parse(subject.bodyText)).toEqual([{ type: 'ready' }, 'pong', 123, 'hi', { id: 7 }]);
    expect(subject).toMatchObject({ protocol: 'websocket', status: 101, bodyKind: 'json', durationMs: 12 });
    expect(subject.headers).toEqual([['upgrade', 'websocket']]);
  });

  it('reads a refused handshake as status 0', () => {
    expect(wsSubject(exchange([], true)).status).toBe(0);
  });
});
