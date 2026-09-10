import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendHistory, openHistory } from '../../../src/project/history.js';
import type { HistoryEntry } from '../../../src/project/history.js';
import { tempProjectDir } from './fixture.js';

let counter = 0;

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  counter += 1;
  return {
    id: `entry-${String(counter).padStart(4, '0')}`,
    at: new Date(2026, 0, 1, 0, 0, counter).toISOString(),
    projectId: 'proj-1',
    requestName: `Request ${counter}`,
    interfaceName: 'Calculator',
    operationName: 'Add',
    endpoint: 'https://example.test/calc',
    soapVersion: '1.1',
    durationMs: 12,
    ok: true,
    status: 200,
    request: { envelopeXml: '<Envelope/>', headers: [] },
    response: { envelopeXml: '<Envelope/>', rawHeaders: [], status: 200, statusText: 'OK' },
    sizeBytes: 42,
    ...overrides,
  };
}

describe('appendHistory / openHistory', () => {
  it('appends and lists newest first', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    const a = makeEntry({ requestName: 'A' });
    const b = makeEntry({ requestName: 'B' });
    await handle.append(a);
    await handle.append(b);

    expect(handle.list().map((e) => e.requestName)).toEqual(['B', 'A']);
    expect(handle.count()).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('gets one entry by id', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    const a = makeEntry({ requestName: 'A' });
    await handle.append(a);
    expect(handle.get(a.id)?.requestName).toBe('A');
    expect(handle.get('nope')).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it('searches case-insensitively across name/operation/interface/endpoint/status/fault/tags', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    await handle.append(makeEntry({ requestName: 'GetWeather', operationName: 'Get', endpoint: 'https://a.test' }));
    await handle.append(
      makeEntry({
        requestName: 'Other',
        operationName: 'Sub',
        endpoint: 'https://b.test',
        ok: false,
        fault: { code: 'Client', reason: 'Bad Input' },
      }),
    );
    await handle.append(makeEntry({ requestName: 'Tagged', tags: ['nightly-run'] }));

    expect(handle.list({ query: 'weather' }).map((e) => e.requestName)).toEqual(['GetWeather']);
    expect(handle.list({ query: 'BAD INPUT' }).map((e) => e.requestName)).toEqual(['Other']);
    expect(handle.list({ query: 'nightly' }).map((e) => e.requestName)).toEqual(['Tagged']);
    expect(handle.list({ query: 'b.test' }).map((e) => e.requestName)).toEqual(['Other']);
    await rm(dir, { recursive: true, force: true });
  });

  it('supports limit and before for paging', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    const entries = [makeEntry(), makeEntry(), makeEntry(), makeEntry()];
    for (const entry of entries) {
      await handle.append(entry);
    }
    const page1 = handle.list({ limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1.map((e) => e.id)).toEqual([entries[3]?.id, entries[2]?.id]);

    const secondCursor = page1[1]?.id;
    expect(secondCursor).toBeDefined();
    const page2 = handle.list({ limit: 2, before: secondCursor as string });
    expect(page2.map((e) => e.id)).toEqual([entries[1]?.id, entries[0]?.id]);
    await rm(dir, { recursive: true, force: true });
  });

  it('clears the history', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    await handle.append(makeEntry());
    await handle.append(makeEntry());
    const cleared = await handle.clear();
    expect(cleared).toBe(2);
    expect(handle.count()).toBe(0);
    expect(handle.list()).toEqual([]);
    const onDisk = await readFile(file, 'utf8');
    expect(onDisk).toBe('');
    await rm(dir, { recursive: true, force: true });
  });

  it('rotates at the cap, keeping only the newest entries', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file, { cap: 5 });
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 8; i += 1) {
      const entry = makeEntry();
      entries.push(entry);
      await handle.append(entry);
    }
    expect(handle.count()).toBe(5);
    const ids = handle.list().map((e) => e.id);
    expect(ids).toEqual([...entries.slice(3)].reverse().map((e) => e.id));

    // Reopening re-reads the rotated file, so the cap survives a process restart too.
    const reopened = await openHistory(file, { cap: 5 });
    expect(reopened.count()).toBe(5);
    await rm(dir, { recursive: true, force: true });
  });

  it('skips corrupt lines and counts them as problems', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    await handle.append(makeEntry({ requestName: 'Good1' }));
    await handle.append(makeEntry({ requestName: 'Good2' }));
    const current = await readFile(file, 'utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, `${current}not json at all\n{"id":"partial"\n`);

    const reopened = await openHistory(file);
    expect(reopened.count()).toBe(2);
    expect(reopened.problems).toBe(2);
    expect(reopened.list().map((e) => e.requestName)).toEqual(['Good2', 'Good1']);
    await rm(dir, { recursive: true, force: true });
  });

  it('serialises concurrent appends without losing entries', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    const handle = await openHistory(file);
    await Promise.all(Array.from({ length: 20 }, () => handle.append(makeEntry())));
    expect(handle.count()).toBe(20);
    const reopened = await openHistory(file);
    expect(reopened.count()).toBe(20);
    await rm(dir, { recursive: true, force: true });
  });

  it('appendHistory (stateless) appends one entry, rotating against the cap', async () => {
    const dir = await tempProjectDir();
    const file = join(dir, 'history.jsonl');
    await appendHistory(file, makeEntry({ requestName: 'One' }), { cap: 2 });
    await appendHistory(file, makeEntry({ requestName: 'Two' }), { cap: 2 });
    await appendHistory(file, makeEntry({ requestName: 'Three' }), { cap: 2 });

    const handle = await openHistory(file);
    expect(handle.list().map((e) => e.requestName)).toEqual(['Three', 'Two']);
    await rm(dir, { recursive: true, force: true });
  });
});
