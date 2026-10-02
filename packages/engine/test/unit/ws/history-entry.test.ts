/**
 * `buildWsHistoryEntry`: one WebSocket session as History records it, for every host that writes
 * History. The pattern rules redact the handshake headers and the URL's credential parameters
 * (and an API key's own parameter, whatever it is called); the host's masks hide the secret values
 * it knows of in the headers, the URL, every frame's text or bytes and the close reasons.
 */
import { describe, expect, it } from 'vitest';
import { createSecretBytesMasker, createSecretMasker, REDACTED_MARKER } from '../../../src/index.js';
import { buildWsHistoryEntry } from '../../../src/ws/history-entry.js';
import type { WsExchange } from '../../../src/ws/model.js';

const SECRET = 'live-secret-9f3a7c';

function exchange(overrides: Partial<WsExchange> = {}): WsExchange {
  return {
    kind: 'websocket',
    url: `wss://api.test/chat?key=${SECRET}&room=1`,
    handshake: {
      url: `wss://api.test/chat?key=${SECRET}&room=1`,
      requestHeaders: { Authorization: 'Bearer plain-token', 'X-Trace': `t-${SECRET}` },
      requestedSubprotocols: [],
      status: 101,
      statusText: 'Switching Protocols',
      responseHeaders: { 'sec-websocket-accept': 'abc123=' },
      startedAt: '2026-10-02T08:30:05.000Z',
      durationMs: 25,
    },
    frames: [
      { index: 0, direction: 'sent', opcode: 'text', at: 5, size: 30, text: `{"token":"${SECRET}"}` },
      {
        index: 1,
        direction: 'received',
        opcode: 'binary',
        at: 8,
        size: 22,
        base64: Buffer.from(`\u0001${SECRET}\u0002`, 'latin1').toString('base64'),
      },
      { index: 2, direction: 'received', opcode: 'close', at: 9, size: 4, close: { code: 1000, reason: SECRET } },
    ],
    closed: { code: 1000, reason: `bye ${SECRET}`, by: 'client' },
    counts: { sent: 1, received: 2, bytesSent: 30, bytesReceived: 26 },
    durationMs: 120,
    ...overrides,
  };
}

const masks = { text: createSecretMasker([SECRET]), base64: createSecretBytesMasker([SECRET]) };

describe('buildWsHistoryEntry', () => {
  it('carries the SOAP-shaped fields, the ws block and the tags', () => {
    const entry = buildWsHistoryEntry(
      'p1',
      {
        requestId: 'ws-1',
        requestName: 'Echo',
        apiName: 'Chat',
        folderPath: 'Rooms / Lobby',
        exchange: exchange(),
        handshakeOpened: true,
        tags: ['cli'],
      },
      masks,
    );
    expect(entry).toMatchObject({
      kind: 'websocket',
      projectId: 'p1',
      requestId: 'ws-1',
      requestName: 'Echo',
      interfaceName: 'Chat',
      operationName: 'Rooms / Lobby',
      soapVersion: 'none',
      method: 'GET',
      status: 101,
      ok: true,
      durationMs: 120,
      sizeBytes: 56,
      tags: ['cli'],
      response: { status: 101, statusText: 'Switching Protocols', rawHeaders: [['sec-websocket-accept', 'abc123=']] },
    });
    expect(entry.ws).toMatchObject({ closeCode: 1000, closedBy: 'client', counts: { sent: 1, received: 2 } });
    expect(entry.ws?.frames).toHaveLength(3);
  });

  it('redacts the headers and the URL by pattern, and masks every known value everywhere', () => {
    const entry = buildWsHistoryEntry(
      'p1',
      {
        requestId: 'ws-1',
        requestName: 'Echo',
        apiName: 'Chat',
        folderPath: '',
        exchange: exchange(),
        handshakeOpened: true,
        keyParams: ['room'],
      },
      masks,
    );
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(JSON.stringify(entry)).not.toContain('plain-token');
    expect(entry.request.headers).toEqual([
      { name: 'Authorization', value: REDACTED_MARKER },
      { name: 'X-Trace', value: `t-${REDACTED_MARKER}` },
    ]);
    // `room` is no credential by name; as the API key's parameter it is masked all the same.
    expect(entry.endpoint).not.toContain('room=1');
    const [sent, received, close] = entry.ws?.frames ?? [];
    expect(sent?.text).toBe(`{"token":"${REDACTED_MARKER}"}`);
    expect(Buffer.from(received?.base64 ?? '', 'base64').toString('latin1')).toBe(`\u0001${REDACTED_MARKER}\u0002`);
    expect(close?.close).toEqual({ code: 1000, reason: REDACTED_MARKER });
    expect(entry.ws?.closeReason).toBe(`bye ${REDACTED_MARKER}`);
    // The size stays the size on the wire.
    expect(sent?.size).toBe(30);
  });

  it('a handshake that never opened is not ok and carries its error', () => {
    const entry = buildWsHistoryEntry(
      'p1',
      {
        requestId: 'ws-1',
        requestName: 'Echo',
        apiName: 'Chat',
        folderPath: '',
        exchange: exchange({
          handshake: {
            url: 'wss://api.test/chat',
            requestHeaders: {},
            requestedSubprotocols: [],
            startedAt: '2026-10-02T08:30:05.000Z',
            durationMs: 10,
            error: 'connect ECONNREFUSED',
          },
          frames: [],
          closed: { code: 1006, reason: '', by: 'error' },
        }),
        handshakeOpened: false,
      },
      masks,
    );
    expect(entry.ok).toBe(false);
    expect(entry.status).toBeUndefined();
    expect(entry.response).toBeUndefined();
    expect(entry.error).toEqual({ code: 'ws-handshake-failed', message: 'connect ECONNREFUSED' });
    expect(entry.tags).toBeUndefined();
  });
});
