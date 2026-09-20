import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openHistory, historyWsOf } from '../../../src/project/history.js';
import type { HistoryEntry } from '../../../src/project/history.js';
import type { WsExchange, WsFrame } from '../../../src/ws/model.js';
import { tempProjectDir } from './fixture.js';

let counter = 0;

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  counter += 1;
  return {
    id: `ws-entry-${String(counter).padStart(4, '0')}`,
    at: new Date(2026, 0, 1, 0, 0, counter).toISOString(),
    projectId: 'proj-1',
    requestName: `Request ${counter}`,
    interfaceName: 'Live',
    operationName: 'Connect',
    endpoint: 'wss://example.test/socket',
    soapVersion: 'none',
    durationMs: 12,
    ok: true,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 42,
    ...overrides,
  };
}

function makeFrame(index: number, overrides: Partial<WsFrame> = {}): WsFrame {
  return {
    index,
    direction: index % 2 === 0 ? 'sent' : 'received',
    opcode: 'text',
    at: index,
    size: 10,
    text: `frame-${index}`,
    ...overrides,
  };
}

function makeExchange(overrides: Partial<WsExchange> = {}): WsExchange {
  return {
    kind: 'websocket',
    url: 'wss://example.test/socket',
    handshake: {
      url: 'wss://example.test/socket',
      requestHeaders: {},
      requestedSubprotocols: [],
      status: 101,
      protocol: 'chat',
      startedAt: new Date(2026, 0, 1).toISOString(),
      durationMs: 5,
    },
    frames: [],
    closed: { code: 1000, reason: 'normal', by: 'client' },
    counts: { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 },
    durationMs: 100,
    ...overrides,
  };
}

describe('history: websocket kind', () => {
  it('a kind: websocket entry survives a jsonl write and read unchanged', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    const exchange = makeExchange({ frames: [makeFrame(0), makeFrame(1)] });
    const entry = makeEntry({ kind: 'websocket', ws: historyWsOf(exchange) });
    await handle.append(entry);

    const reopened = await openHistory(file);
    expect(reopened.get(entry.id)).toEqual(entry);
    await rm(dir, { recursive: true, force: true });
  });

  it('a legacy line with no kind still reads as soap', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const entry = makeEntry();
    expect(entry.kind).toBeUndefined();
    await writeFile(file, `${JSON.stringify(entry)}\n`);

    const handle = await openHistory(file);
    expect(handle.get(entry.id)?.kind).toBe('soap');
    await rm(dir, { recursive: true, force: true });
  });

  it('historyWsOf of a 1000-frame exchange caps at both ends', () => {
    const frames = Array.from({ length: 1000 }, (_, i) => makeFrame(i));
    const ws = historyWsOf(makeExchange({ frames }));
    expect(ws.truncated).toBe(true);
    expect(ws.omittedFrames).toBe(500);
    expect(ws.frames).toHaveLength(500);
  });

  it('historyWsOf of a 2-frame exchange sets neither truncated nor omittedFrames', () => {
    const ws = historyWsOf(makeExchange({ frames: [makeFrame(0), makeFrame(1)] }));
    expect(ws.truncated).toBeUndefined();
    expect(ws.omittedFrames).toBeUndefined();
    expect(ws).not.toHaveProperty('truncated');
    expect(ws).not.toHaveProperty('omittedFrames');
  });

  it('a failed handshake carries error and no status', () => {
    const ws = historyWsOf(
      makeExchange({
        handshake: {
          url: 'wss://example.test/socket',
          requestHeaders: {},
          requestedSubprotocols: [],
          startedAt: new Date(2026, 0, 1).toISOString(),
          durationMs: 3,
          error: 'ECONNREFUSED',
        },
      }),
    );
    expect(ws.error).toBe('ECONNREFUSED');
    expect(ws.status).toBeUndefined();
    expect(ws).not.toHaveProperty('status');
  });

  it('the search haystack matches an entry by ws.url and ws.protocol', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    const exchange = makeExchange({ url: 'wss://chatty.example.test/room', frames: [] });
    const entry = makeEntry({
      kind: 'websocket',
      requestName: 'ChatSocket',
      ws: historyWsOf(exchange),
    });
    await handle.append(entry);

    expect(handle.list({ query: 'chatty.example.test' }).map((e) => e.id)).toEqual([entry.id]);
    expect(handle.list({ query: 'chat' }).map((e) => e.id)).toEqual([entry.id]);
    await rm(dir, { recursive: true, force: true });
  });
});
