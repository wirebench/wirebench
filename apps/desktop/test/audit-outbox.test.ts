import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DesktopAuditEvent } from '@wirebench/engine';
import { AuditOutbox } from '../src/main/audit/outbox.js';

const ev = (n: number): DesktopAuditEvent => ({
  action: 'desktop.request_sent',
  details: {
    protocol: 'rest',
    method: 'GET',
    url: `https://a.example/${String(n)}`,
    status: 200,
    outcome: 'ok',
    durationMs: 1,
    environment: null,
    requestId: 'r',
    requestName: 'n',
    sentAt: '2026-10-03T10:00:00.000Z',
  },
});
const urls = (items: readonly { event: DesktopAuditEvent }[]): string[] =>
  items.map((i) => (i.event.action === 'desktop.request_sent' ? i.event.details.url.slice(-1) : '?'));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-outbox-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AuditOutbox', () => {
  it('keeps order across a new outbox on the same directory', async () => {
    const a = new AuditOutbox(dir);
    for (const n of [1, 2, 3]) await a.append(ev(n));
    const b = new AuditOutbox(dir);
    await b.append(ev(4));
    expect(urls(await b.peek(10))).toEqual(['1', '2', '3', '4']);
    expect(urls(await b.peek(2))).toEqual(['1', '2']);
  });

  it('removes by name and clears everything', async () => {
    const o = new AuditOutbox(dir);
    for (const n of [1, 2, 3]) await o.append(ev(n));
    const items = await o.peek(2);
    await o.remove(items.map((i) => i.name));
    expect(urls(await o.peek(10))).toEqual(['3']);
    await o.clear();
    expect(await o.peek(10)).toEqual([]);
    expect(await o.dropped()).toBe(0);
  });

  it('drops the oldest past the cap and counts them', async () => {
    const o = new AuditOutbox(dir, { max: 3 });
    for (const n of [1, 2, 3, 4, 5]) await o.append(ev(n));
    expect(urls(await o.peek(10))).toEqual(['3', '4', '5']);
    expect(await o.dropped()).toBe(2);
    expect(await new AuditOutbox(dir, { max: 3 }).dropped()).toBe(2);
    await o.clearDropped(2);
    expect(await o.dropped()).toBe(0);
    expect((await readdir(dir)).filter((f) => f === 'dropped.json')).toEqual([]);
  });

  it('skips a corrupt file instead of throwing', async () => {
    const o = new AuditOutbox(dir);
    await o.append(ev(1));
    await writeFile(join(dir, '9999999999.json'), '{nope');
    await o.append(ev(2));
    expect(urls(await o.peek(10))).toEqual(['1', '2']);
  });
});
