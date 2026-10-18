// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { SessionLogUploader, UPLOAD_BACKOFF_START_MS, UPLOAD_SUFFIX } from '../src/main/session-log-uploader.js';
import { SessionLogStore } from '../src/main/session-logs.js';
import type { SessionLogMeta } from '../src/main/session-logs.js';

const URL = 'https://wb.example';
const TARGET = { url: URL, workspaceId: 'SRV' };

/** A server that keeps one log per client id, and can be told to fail the next call. */
function fakeServer() {
  const logs = new Map<string, { id: string; bytes: Buffer; ended?: { reason: string } }>();
  const calls: string[] = [];
  let failNext: Error | undefined;
  const fail = (): void => {
    const error = failNext;
    failNext = undefined;
    if (error) throw error;
  };
  const byId = (id: string) => [...logs.values()].find((l) => l.id === id)!;
  const client = {
    openSessionLog: (_url: string, _token: string, _ws: string, body: { clientLogId: string }) => {
      calls.push('open');
      fail();
      const log = logs.get(body.clientLogId) ?? { id: `L${logs.size + 1}`, bytes: Buffer.alloc(0) };
      logs.set(body.clientLogId, log);
      return Promise.resolve({ id: log.id, size: log.bytes.length, ended: log.ended !== undefined });
    },
    appendSessionLog: (_u: string, _t: string, _w: string, id: string, body: { offset: number; data: string }) => {
      calls.push(`chunk@${body.offset}`);
      fail();
      const log = byId(id);
      if (body.offset !== log.bytes.length) throw new WirebenchError('session-logs-offset', 'offset');
      log.bytes = Buffer.concat([log.bytes, Buffer.from(body.data, 'base64')]);
      return Promise.resolve({ size: log.bytes.length, truncated: false });
    },
    endSessionLog: (_u: string, _t: string, _w: string, id: string, body: { reason: string }) => {
      calls.push(`end:${body.reason}`);
      fail();
      byId(id).ended = body;
      return Promise.resolve();
    },
  };
  return {
    client,
    calls,
    logs,
    failWith: (error: Error) => {
      failNext = error;
    },
  };
}

/** Timers run by hand: `fire` runs every armed one. */
function manualTimers() {
  let armed: { fn: () => void; ms: number; id: number }[] = [];
  let next = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      next += 1;
      armed.push({ fn, ms, id: next });
      return next;
    },
    clearTimeout: (handle: unknown) => {
      armed = armed.filter((t) => t.id !== handle);
    },
    delays: () => armed.map((t) => t.ms),
    fire: () => {
      const due = armed;
      armed = [];
      for (const t of due) t.fn();
    },
  };
}

function uploaderWith(server: ReturnType<typeof fakeServer>, timers: ReturnType<typeof manualTimers>) {
  return new SessionLogUploader({
    client: server.client,
    accounts: { tokenFor: () => Promise.resolve('wbt_token'), markSignedOut: () => undefined },
    now: () => new Date('2026-10-17T10:00:00.000Z'),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    log: () => undefined,
  });
}

/** Fires the timers and waits for the uploads they start, a few rounds (a follow-up arms a new timer). */
async function settle(uploader: SessionLogUploader, timers: ReturnType<typeof manualTimers>): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    timers.fire();
    await uploader.idle();
  }
}

const META: SessionLogMeta = {
  version: 1,
  id: '20261017T100000Z-abcd1234',
  workspaceId: 'ws',
  hostId: 'web',
  hostName: 'Web',
  address: '10.0.0.1',
  port: 22,
  user: 'deploy',
  startedAt: '2026-10-17T10:00:00.000Z',
  raw: false,
};

describe('SessionLogUploader (#430)', () => {
  it('streams what a log store writes, masked, ends it, and leaves no upload state behind', async () => {
    const server = fakeServer();
    const timers = manualTimers();
    const uploader = uploaderWith(server, timers);
    const root = mkdtempSync(join(tmpdir(), 'wb-upload-'));
    const store = new SessionLogStore({
      root,
      limits: () => ({ maxBytes: 1024 * 1024, raw: false }),
      uploader,
      log: () => undefined,
    });
    const writer = store.start({
      workspaceId: 'ws',
      hostId: 'web',
      hostName: 'Web',
      address: '10.0.0.1',
      port: 22,
      user: 'deploy',
      sessionId: 'abcd1234-0000',
      secrets: ['hunter2'],
      upload: TARGET,
    });
    writer.push(Buffer.from('$ echo hunter2\nhunter2\n'));
    await writer.settled();
    await settle(uploader, timers);
    const [clientId, log] = [...server.logs.entries()][0]!;
    expect(log.bytes.toString()).not.toContain('hunter2');
    expect(log.bytes.toString().split('\n')).toHaveLength(3);
    writer.push(Buffer.from('bye\n'));
    await writer.end({ code: 0, reason: 'exit' });
    await settle(uploader, timers);
    expect(log.bytes.toString().endsWith('bye\n')).toBe(true);
    expect(log.bytes.toString()).toBe(readFileSync(join(root, 'ws', 'web', `${clientId}.log`), 'utf8'));
    expect(log.ended).toMatchObject({ reason: 'exit' });
    expect(server.calls.filter((c) => c === 'open')).toHaveLength(1);
    expect(existsSync(join(root, 'ws', 'web', `${clientId}${UPLOAD_SUFFIX}`))).toBe(false);
  });

  it('a stale offset reopens the log and sends from the size the server holds', async () => {
    const server = fakeServer();
    const timers = manualTimers();
    const uploader = uploaderWith(server, timers);
    const dir = mkdtempSync(join(tmpdir(), 'wb-upload-'));
    writeFileSync(join(dir, `${META.id}.log`), 'one\ntwo\n');
    const upload = await uploader.begin(dir, META, TARGET);
    const state = JSON.parse(readFileSync(join(dir, `${META.id}${UPLOAD_SUFFIX}`), 'utf8')) as { sent: number };
    expect(state.sent).toBe(0);
    // The open goes through; then another run's chunk lands first, so this one's offset is stale.
    timers.fire();
    await uploader.idle();
    expect(server.calls).toEqual(['open', 'chunk@0']);
    server.logs.get(META.id)!.bytes = Buffer.from('one\n');
    writeFileSync(join(dir, `${META.id}.log`), 'one\ntwo\nthree\n');
    upload.ended({ ...META, endedAt: '2026-10-17T10:05:00.000Z', reason: 'exit', exitCode: 0 });
    await settle(uploader, timers);
    expect(server.calls).toEqual(['open', 'chunk@0', 'chunk@8', 'open', 'chunk@4', 'end:exit']);
    expect(server.logs.get(META.id)!.bytes.toString()).toBe('one\ntwo\nthree\n');
  });

  it('backs off after a failure and carries on', async () => {
    const server = fakeServer();
    const timers = manualTimers();
    const uploader = uploaderWith(server, timers);
    const dir = mkdtempSync(join(tmpdir(), 'wb-upload-'));
    writeFileSync(join(dir, `${META.id}.log`), 'hello\n');
    server.failWith(new WirebenchError('server-unreachable', 'down'));
    await uploader.begin(dir, META, TARGET);
    timers.fire();
    await uploader.idle();
    expect(timers.delays()).toEqual([UPLOAD_BACKOFF_START_MS]);
    await settle(uploader, timers);
    expect(server.logs.get(META.id)!.bytes.toString()).toBe('hello\n');
  });

  it('stops for good when the server no longer takes the log', async () => {
    const server = fakeServer();
    const timers = manualTimers();
    const uploader = uploaderWith(server, timers);
    const dir = mkdtempSync(join(tmpdir(), 'wb-upload-'));
    writeFileSync(join(dir, `${META.id}.log`), 'hello\n');
    server.failWith(new WirebenchError('session-logs-recording-off', 'off', { details: { status: 409 } }));
    await uploader.begin(dir, META, TARGET);
    await settle(uploader, timers);
    expect(server.calls).toEqual(['open']);
    expect(timers.delays()).toEqual([]);
    expect(existsSync(join(dir, `${META.id}${UPLOAD_SUFFIX}`))).toBe(false);
  });

  it('resumes what an earlier run left half sent; a log cut off by a crash ends as lost', async () => {
    const server = fakeServer();
    const timers = manualTimers();
    const uploader = uploaderWith(server, timers);
    const root = mkdtempSync(join(tmpdir(), 'wb-upload-'));
    const dir = join(root, 'ws', 'web');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${META.id}.log`), 'one\ntwo\n');
    writeFileSync(join(dir, `${META.id}.json`), JSON.stringify(META));
    server.logs.set(META.id, { id: 'L1', bytes: Buffer.from('one\n') });
    writeFileSync(
      join(dir, `${META.id}${UPLOAD_SUFFIX}`),
      JSON.stringify({ version: 1, url: URL, workspaceId: 'SRV', serverLogId: 'L1', sent: 4 }),
    );
    await uploader.resume(root);
    await settle(uploader, timers);
    expect(server.logs.get(META.id)!.bytes.toString()).toBe('one\ntwo\n');
    expect(server.calls).toEqual(['chunk@4', 'end:lost']);
    expect(existsSync(join(dir, `${META.id}${UPLOAD_SUFFIX}`))).toBe(false);
  });
});
