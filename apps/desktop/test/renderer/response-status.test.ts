import { describe, expect, it } from 'vitest';
import { responseSize, toneFor } from '../../src/renderer/features/request-editor/response-status.js';
import { makeWsHandshakeExchange } from '../mocks/exchange-fixtures.js';

describe('a WebSocket handshake summary', () => {
  it('always reads as ok — a refused handshake is a failure row instead', () => {
    expect(toneFor(makeWsHandshakeExchange())).toBe('ok');
  });

  it('has no response body of its own', () => {
    expect(responseSize(makeWsHandshakeExchange())).toBe(0);
  });
});
