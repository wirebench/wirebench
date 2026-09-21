import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openHistory, historySseOf } from '../../../src/project/history.js';
import type { HistoryEntry, RestEventStreamLike } from '../../../src/project/history.js';
import type { SseRow } from '../../../src/rest/sse.js';
import { tempProjectDir } from './fixture.js';

let counter = 0;

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  counter += 1;
  return {
    id: `sse-entry-${String(counter).padStart(4, '0')}`,
    at: new Date(2026, 0, 1, 0, 0, counter).toISOString(),
    projectId: 'proj-1',
    requestName: `Request ${counter}`,
    interfaceName: 'Live',
    operationName: 'Stream',
    endpoint: 'https://example.test/stream',
    soapVersion: 'none',
    method: 'GET',
    durationMs: 12,
    ok: true,
    status: 200,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 42,
    kind: 'rest',
    ...overrides,
  };
}

function makeRow(index: number, overrides: Partial<Extract<SseRow, { kind: 'event' }>> = {}): SseRow {
  return {
    kind: 'event',
    index,
    at: index,
    size: 10,
    event: 'message',
    data: `row-${index}`,
    lastEventId: '',
    ...overrides,
  };
}

function makeStream(overrides: Partial<RestEventStreamLike> = {}): RestEventStreamLike {
  return {
    rows: [],
    counts: { events: 0, comments: 0, retries: 0, bytes: 0 },
    lastEventId: '',
    endedBy: 'server',
    droppedRows: 0,
    truncated: false,
    omittedRows: 0,
    ...overrides,
  };
}

describe('history: rest event stream', () => {
  it('a kind: rest entry with sse survives a jsonl write and read unchanged', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    const stream = makeStream({
      rows: [makeRow(0), makeRow(1)],
      counts: { events: 2, comments: 0, retries: 0, bytes: 20 },
    });
    const entry = makeEntry({ sse: historySseOf(stream) });
    await handle.append(entry);

    const reopened = await openHistory(file);
    expect(reopened.get(entry.id)).toEqual(entry);
    await rm(dir, { recursive: true, force: true });
  });

  it('historySseOf of a 1000-event stream caps at both ends and totals every omitted row', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => makeRow(i));
    const sse = historySseOf(makeStream({ rows, counts: { events: 1000, comments: 0, retries: 0, bytes: 10_000 } }));
    expect(sse.truncated).toBe(true);
    expect(sse.omittedRows).toBe(500);
    expect(sse.rows).toHaveLength(500);
  });

  it('rows already dropped by the live store, or omitted by the summary cap, are folded into omittedRows', () => {
    const rows = [makeRow(0), makeRow(1)];
    const sse = historySseOf(makeStream({ rows, droppedRows: 3, truncated: true, omittedRows: 4 }));
    expect(sse.truncated).toBe(true);
    expect(sse.omittedRows).toBe(7);
    expect(sse.rows).toHaveLength(2);
  });

  it('a small, uncapped stream sets neither truncated nor omittedRows', () => {
    const sse = historySseOf(makeStream({ rows: [makeRow(0), makeRow(1)] }));
    expect(sse.truncated).toBeUndefined();
    expect(sse.omittedRows).toBeUndefined();
    expect(sse).not.toHaveProperty('truncated');
    expect(sse).not.toHaveProperty('omittedRows');
  });

  it('carries the outcome fields through: lastEventId, endedBy, error', () => {
    const sse = historySseOf(makeStream({ lastEventId: 'evt-9', endedBy: 'error', error: 'ECONNRESET' }));
    expect(sse.lastEventId).toBe('evt-9');
    expect(sse.endedBy).toBe('error');
    expect(sse.error).toBe('ECONNRESET');
  });

  it('the search haystack matches an entry by its event data', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    const stream = makeStream({
      rows: [makeRow(0, { data: 'temperature-spike-detected' })],
      counts: { events: 1, comments: 0, retries: 0, bytes: 10 },
    });
    const entry = makeEntry({ requestName: 'Sensors', sse: historySseOf(stream) });
    await handle.append(entry);

    expect(handle.list({ query: 'temperature-spike' }).map((e) => e.id)).toEqual([entry.id]);
    expect(handle.list({ query: 'no-such-text' })).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});
