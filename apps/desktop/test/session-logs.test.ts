// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FULL_SCREEN_NOTE, SECRET_MASK, parseHostsFile } from '@wirebench/ssh';
import type { HopCredentials } from '@wirebench/ssh';
import { describe, expect, it } from 'vitest';
import { SessionLogStore, SessionLogSwitches, sessionLogPlanner } from '../src/main/session-logs.js';
import type { SessionLogStart } from '../src/main/session-logs.js';
import { resolveLogSwitch } from '@wirebench/wire/session-log-switch';

const enc = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const WS = 'ws-1';

function store(opts: { maxBytes?: number; raw?: boolean; clock?: () => Date } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-session-logs-'));
  const logs = new SessionLogStore({
    root,
    limits: () => ({ maxBytes: opts.maxBytes ?? 500 * 1024 * 1024, raw: opts.raw ?? false }),
    ...(opts.clock ? { now: opts.clock } : {}),
    log: () => undefined,
  });
  return { root, logs };
}

/** A clock that moves a minute on each read. */
function ticking(start = Date.UTC(2026, 9, 13, 18, 30, 0)) {
  let at = start;
  return () => {
    const now = new Date(at);
    at += 60_000;
    return now;
  };
}

const start = (over: Partial<SessionLogStart> = {}): SessionLogStart => ({
  workspaceId: WS,
  hostId: 'web',
  hostName: 'Web',
  address: '10.0.0.1',
  port: 22,
  user: 'me',
  sessionId: '6f1c2d3e-aaaa-bbbb-cccc-000000000000',
  secrets: [],
  ...over,
});

describe('resolveLogSwitch', () => {
  it('is off by default', () => {
    expect(resolveLogSwitch({}, 'web', ['prod'])).toEqual({ on: false, from: 'default' });
  });

  it('takes the nearest setting: the host, then the groups from leaf to root', () => {
    const switches = { 'group:root': true, 'group:prod': false };
    expect(resolveLogSwitch(switches, 'web', ['root', 'prod'])).toEqual({ on: false, from: { group: 'prod' } });
    expect(resolveLogSwitch(switches, 'web', ['root'])).toEqual({ on: true, from: { group: 'root' } });
    expect(resolveLogSwitch({ ...switches, 'host:web': true }, 'web', ['root', 'prod'])).toEqual({
      on: true,
      from: 'host',
    });
  });
});

describe('SessionLogSwitches', () => {
  it('keeps each workspace’s switches in a file on this machine, and null clears one', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wb-log-switches-')), 'ssh-session-logs.json');
    const switches = new SessionLogSwitches(file, () => undefined);
    await switches.set(WS, { kind: 'host', id: 'web' }, true);
    await switches.set(WS, { kind: 'group', id: 'prod' }, false);
    await switches.set('ws-2', { kind: 'host', id: 'web' }, false);
    const again = new SessionLogSwitches(file, () => undefined);
    expect(await again.all(WS)).toEqual({ 'host:web': true, 'group:prod': false });
    await again.set(WS, { kind: 'host', id: 'web' }, null);
    expect(await again.all(WS)).toEqual({ 'group:prod': false });
    expect(await again.all('ws-3')).toEqual({});
  });

  it('reads a broken file as no switches', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wb-log-switches-')), 'ssh-session-logs.json');
    writeFileSync(file, '{ nope');
    expect(await new SessionLogSwitches(file, () => undefined).all(WS)).toEqual({});
  });
});

describe('SessionLogStore', () => {
  it('writes the output as plain text, and a sidecar with who, where and when', async () => {
    const { root, logs } = store({ clock: ticking() });
    const writer = logs.start(start({ server: { url: 'https://wb.example', recording: true } }));
    writer.push(enc('\x1b]0;me@web\x07\x1b[32m$\x1b[0m echo hi\r\nhi\r\n'));
    writer.push(enc('\x1b[?1049hvim stuff\x1b[?1049l$ exit\r\n'));
    await writer.end({ code: 0, reason: 'exit' });

    const [entry] = await logs.list(WS, 'web');
    expect(entry).toMatchObject({
      id: '20261013T183000Z-6f1c2d3e',
      hostId: 'web',
      hostName: 'Web',
      address: '10.0.0.1',
      port: 22,
      user: 'me',
      workspaceId: WS,
      startedAt: '2026-10-13T18:30:00.000Z',
      endedAt: '2026-10-13T18:31:00.000Z',
      exitCode: 0,
      reason: 'exit',
      raw: false,
      live: false,
      server: { url: 'https://wb.example', recording: true },
    });
    const id = entry?.id ?? '';
    const dir = join(root, WS, 'web');
    expect(readFileSync(join(dir, `${id}.log`), 'utf8')).toBe(`$ echo hi\nhi\n${FULL_SCREEN_NOTE}\n$ exit\n`);
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.log`]);
    expect((await logs.read(WS, 'web', id)).text).toContain('$ echo hi');
  });

  it('never writes a secret used at connect, in the text or the raw stream, however it is cut', async () => {
    const { root, logs } = store({ raw: true });
    const writer = logs.start(start({ secrets: ['hunter2', 'pass phrase'] }));
    const bytes = enc('Password: hunter2\r\nkey: pass\x1b[1m phrase\x1b[0m!\r\n');
    for (let i = 0; i < bytes.length; i += 3) writer.push(bytes.subarray(i, i + 3));
    await writer.end({ code: 0, reason: 'exit' });
    const dir = join(root, WS, 'web');
    const files = readdirSync(dir);
    const read = (ext: string): string => readFileSync(join(dir, files.find((f) => f.endsWith(ext)) ?? ''), 'utf8');
    expect(read('.log')).toBe(`Password: ${SECRET_MASK}\nkey: ${SECRET_MASK}!\n`);
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf8');
      expect(content).not.toContain('hunter2');
      expect(content).not.toContain('pass phrase');
    }
    expect(read('.raw')).toContain(`Password: ${SECRET_MASK}`);
    expect(read('.raw')).toContain('\x1b[1m');
  });

  it('lists a running session as live, newest first, and refuses to delete it', async () => {
    const { logs } = store({ clock: ticking() });
    const first = logs.start(start({ sessionId: 'aaaaaaaa-1' }));
    await first.end({ code: 0, reason: 'exit' });
    const second = logs.start(start({ sessionId: 'bbbbbbbb-2' }));
    second.push(enc('working\r\n'));
    await second.settled();
    const listed = await logs.list(WS, 'web');
    expect(listed.map((e) => [e.id.slice(-8), e.live])).toEqual([
      ['bbbbbbbb', true],
      ['aaaaaaaa', false],
    ]);
    expect(listed[0]?.bytes).toBe('working\n'.length);
    await expect(logs.remove(WS, 'web', listed[0]?.id ?? '')).rejects.toMatchObject({ code: 'session-log-live' });
    await second.end(undefined);
  });

  it('searches a host’s logs, case-insensitively, with the first matching line', async () => {
    const { logs } = store({ clock: ticking() });
    const a = logs.start(start({ sessionId: 'aaaaaaaa' }));
    a.push(enc('migrate: 3 applied\r\nERROR: none\r\nerror again\r\n'));
    await a.end({ code: 0, reason: 'exit' });
    const b = logs.start(start({ sessionId: 'bbbbbbbb' }));
    b.push(enc('all fine\r\n'));
    await b.end({ code: 0, reason: 'exit' });
    const matches = await logs.search(WS, 'web', 'error');
    expect(matches).toEqual([
      { id: expect.stringMatching(/-aaaaaaaa$/) as unknown, count: 2, line: 2, text: 'ERROR: none' },
    ]);
  });

  it('deletes a log with its sidecar and raw stream, and refuses an id that is not a log', async () => {
    const { root, logs } = store({ raw: true });
    const w = logs.start(start());
    w.push(enc('x\r\n'));
    await w.end({ code: 0, reason: 'exit' });
    const [entry] = await logs.list(WS, 'web');
    await logs.remove(WS, 'web', entry?.id ?? '');
    expect(readdirSync(join(root, WS, 'web'))).toEqual([]);
    await expect(logs.read(WS, 'web', '../../etc/passwd')).rejects.toMatchObject({ code: 'session-log-unknown' });
    await expect(logs.list(WS, '../x')).rejects.toMatchObject({ code: 'session-log-unknown' });
  });

  it('deletes the oldest logs, across hosts, once all of them pass the size limit; a live one stays', async () => {
    const { root, logs } = store({ maxBytes: 3000, clock: ticking() });
    const line = `${'x'.repeat(999)}\n`;
    const live = logs.start(start({ hostId: 'db', sessionId: 'l0000000' }));
    live.push(enc(line));
    for (const [host, id] of [
      ['web', 'a1111111'],
      ['db', 'b2222222'],
      ['web', 'c3333333'],
    ] as const) {
      const w = logs.start(start({ hostId: host, sessionId: id }));
      w.push(enc(line));
      await w.end({ code: 0, reason: 'exit' });
    }
    const left = [...(await logs.list(WS, 'web')), ...(await logs.list(WS, 'db'))].map((e) => e.id.slice(-8)).sort();
    expect(left).toEqual(['c3333333', 'l0000000']);
    expect(existsSync(join(root, WS, 'web'))).toBe(true);
    await live.end(undefined);
  });

  it('lists every host’s logs, newest first, when no host is named (#534)', async () => {
    const { logs } = store({ clock: ticking() });
    for (const [host, id] of [
      ['web', 'a1111111'],
      ['db', 'b2222222'],
      ['web', 'c3333333'],
    ] as const) {
      await logs.start(start({ hostId: host, sessionId: id })).end({ code: 0, reason: 'exit' });
    }
    const all = await logs.list(WS);
    expect(all.map((e) => [e.hostId, e.id.slice(-8)])).toEqual([
      ['web', 'c3333333'],
      ['db', 'b2222222'],
      ['web', 'a1111111'],
    ]);
    expect(await logs.list('other-workspace')).toEqual([]);
  });
});

describe('sessionLogPlanner', () => {
  const FILE = parseHostsFile(
    `version: 1\ngroups:\n  - id: prod\n    name: Prod\n    hosts:\n      - { id: web, name: Web, address: 10.0.0.1, ssh: { user: me, auth: { agent: true } } }\n`,
  );
  const hops: HopCredentials[] = [
    {
      address: 'jump',
      port: 22,
      user: 'j',
      auth: { kind: 'password', password: 'jump-pw' },
      keepAlive: 0,
      connectTimeout: 5,
    },
    {
      address: '10.0.0.1',
      port: 2222,
      user: 'me',
      auth: { kind: 'key', privateKey: 'PRIVATE', passphrase: 'phrase' },
      keepAlive: 0,
      connectTimeout: 5,
    },
  ];

  function planner(
    switches: Record<string, boolean>,
    workspace: { id: string; upload?: { url: string; workspaceId: string } } | null = { id: WS },
  ) {
    const started: SessionLogStart[] = [];
    const plan = sessionLogPlanner({
      store: {
        start: (info) => (
          started.push(info),
          { push: () => undefined, end: () => Promise.resolve(), settled: () => Promise.resolve() }
        ),
      },
      switches: { all: () => Promise.resolve(switches) },
      workspaceOf: () =>
        workspace ? { ...workspace, server: { url: 'https://wb.example', recording: false } } : undefined,
      hosts: () => ({ current: () => FILE }),
    });
    return { plan, started };
  }

  it('starts a log for a host whose group turned logging on, with every connect secret to mask', async () => {
    const { plan, started } = planner({ 'group:prod': true });
    const start = await plan({} as never, { hostId: 'web', hops });
    start?.('6f1c2d3e-0000');
    expect(started).toEqual([
      {
        workspaceId: WS,
        hostId: 'web',
        hostName: 'Web',
        address: '10.0.0.1',
        port: 2222,
        user: 'me',
        sessionId: '6f1c2d3e-0000',
        secrets: ['jump-pw', 'PRIVATE', 'phrase'],
        server: { url: 'https://wb.example', recording: false },
      },
    ]);
  });

  it('starts nothing when the host is not logged or no workspace is open', async () => {
    expect(await planner({}).plan({} as never, { hostId: 'web', hops })).toBeUndefined();
    expect(
      await planner({ 'group:prod': true, 'host:web': false }).plan({} as never, { hostId: 'web', hops }),
    ).toBeUndefined();
    expect(await planner({ 'host:web': true }, null).plan({} as never, { hostId: 'web', hops })).toBeUndefined();
  });

  it('logs every session, switches or not, while the workspace server records them, and names the upload (#430)', async () => {
    const upload = { url: 'https://wb.example', workspaceId: 'SRV' };
    const { plan, started } = planner({ 'host:web': false }, { id: WS, upload });
    const begin = await plan({} as never, { hostId: 'web', hops });
    begin?.('6f1c2d3e-0000');
    expect(started).toEqual([expect.objectContaining({ hostId: 'web', upload })]);
  });
});
