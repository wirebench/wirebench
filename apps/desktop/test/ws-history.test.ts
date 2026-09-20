// @vitest-environment node
/**
 * `buildWsHistoryEntry`/`HistoryService.recordWsSession`: one History entry per WebSocket session,
 * written from the redacted `WsExchangeSummary` `openWsSession` resolves with — a refused handshake
 * included (`closedBy: 'error'`), and a chatty session capped to 500 frames.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWsHistoryEntry, HistoryService } from '../src/main/history-service.js';
import { makeWsExchange } from './mocks/wire-fixtures.js';
import type { WsFrameWire } from '../src/shared/wire-types.js';

describe('buildWsHistoryEntry', () => {
  it('carries the SOAP-shaped fields, the ws block, and redacts the handshake headers and URL', () => {
    const entry = buildWsHistoryEntry('p1', {
      requestId: 'ws-1',
      requestName: 'Echo',
      apiName: 'Chat',
      folderPath: 'Sockets',
      exchange: makeWsExchange(),
      handshakeOpened: true,
    });
    expect(entry.kind).toBe('websocket');
    expect(entry.method).toBe('GET');
    expect(entry.requestId).toBe('ws-1');
    expect(entry.requestName).toBe('Echo');
    expect(entry.interfaceName).toBe('Chat');
    expect(entry.operationName).toBe('Sockets');
    expect(entry.status).toBe(101);
    expect(entry.ok).toBe(true);
    expect(entry.ws?.closedBy).toBe('client');
    expect(entry.ws?.closeCode).toBe(1000);
    expect(entry.ws?.frames).toHaveLength(2);
    expect(entry.request.headers).toEqual([{ name: 'Authorization', value: '<redacted>' }]);
    expect(JSON.stringify(entry)).not.toContain('plain-token');
  });

  it('a refused handshake (non-101) is not ok, and closedBy reflects how the session actually closed', () => {
    const entry = buildWsHistoryEntry('p1', {
      requestId: 'ws-1',
      requestName: 'Echo',
      apiName: 'Chat',
      folderPath: '',
      exchange: makeWsExchange({
        handshake: {
          url: 'wss://api.test/chat',
          requestHeaders: {},
          requestedSubprotocols: [],
          status: 401,
          responseHeaders: {},
          startedAt: '2026-09-19T08:30:05.000Z',
          durationMs: 10,
        },
        frames: [],
        closed: { code: 1006, reason: '', by: 'error' },
        counts: { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 },
        durationMs: 10,
      }),
      handshakeOpened: false,
    });
    expect(entry.status).toBe(401);
    expect(entry.ok).toBe(false);
    expect(entry.ws?.closedBy).toBe('error');
  });

  it('a session that opened but whose handshake carries no status (e.g. through a proxy tunnel) is still ok: true', () => {
    // `handshake.status` is optional on the engine's handshake and can be absent even for a
    // session that opened fine — `ok` must follow `handshakeOpened`, not `ws.status === 101`,
    // or such a session would read as a failure it never was.
    const entry = buildWsHistoryEntry('p1', {
      requestId: 'ws-1',
      requestName: 'Echo',
      apiName: 'Chat',
      folderPath: '',
      exchange: makeWsExchange({
        handshake: {
          url: 'wss://api.test/chat',
          requestHeaders: {},
          requestedSubprotocols: [],
          responseHeaders: {},
          startedAt: '2026-09-19T08:30:05.000Z',
          durationMs: 10,
        },
        closed: { code: 1000, reason: 'normal', by: 'client' },
      }),
      handshakeOpened: true,
    });
    expect(entry.status).toBeUndefined();
    expect(entry.ok).toBe(true);
    expect(entry.ws?.closedBy).toBe('client');
  });

  it('masks an API key travelling in the URL query, whatever it is called', () => {
    const entry = buildWsHistoryEntry('p1', {
      requestId: 'ws-1',
      requestName: 'Echo',
      apiName: 'Chat',
      folderPath: '',
      exchange: makeWsExchange({
        url: 'wss://api.test/chat?x-custom-cred=shh-secret',
        handshake: { ...makeWsExchange().handshake, url: 'wss://api.test/chat?x-custom-cred=shh-secret' },
      }),
      handshakeOpened: true,
      keyParams: ['x-custom-cred'],
    });
    expect(JSON.stringify(entry)).not.toContain('shh-secret');
  });

  it('a 1000-frame session is capped to 500 kept frames with omittedFrames: 500', () => {
    const frames: WsFrameWire[] = Array.from({ length: 1000 }, (_, index) => ({
      index,
      direction: index % 2 === 0 ? 'sent' : 'received',
      opcode: 'text',
      at: index,
      size: 2,
      text: 'hi',
    }));
    const entry = buildWsHistoryEntry('p1', {
      requestId: 'ws-1',
      requestName: 'Echo',
      apiName: 'Chat',
      folderPath: '',
      exchange: makeWsExchange({ frames, counts: { sent: 500, received: 500, bytesSent: 1000, bytesReceived: 1000 } }),
      handshakeOpened: true,
    });
    expect(entry.ws?.frames).toHaveLength(500);
    expect(entry.ws?.truncated).toBe(true);
    expect(entry.ws?.omittedFrames).toBe(500);
  });
});

describe('HistoryService.recordWsSession', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-ws-history-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('appends one entry, returned and persisted, for the project whose file is open', async () => {
    const history = new HistoryService(userDataDir);
    await history.open('p1');
    const wire = await history.recordWsSession('p1', {
      requestId: 'ws-1',
      requestName: 'Echo',
      apiName: 'Chat',
      folderPath: '',
      exchange: makeWsExchange(),
      handshakeOpened: true,
    });
    expect(wire?.kind).toBe('websocket');
    const { entries } = history.list({ projectId: 'p1' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ws?.frames).toHaveLength(2);
  });

  it('is a no-op — returns undefined — for a project whose history file is not open', async () => {
    const history = new HistoryService(userDataDir);
    const wire = await history.recordWsSession('never-opened', {
      requestId: 'ws-1',
      requestName: 'Echo',
      apiName: 'Chat',
      folderPath: '',
      exchange: makeWsExchange(),
      handshakeOpened: true,
    });
    expect(wire).toBeUndefined();
  });
});
