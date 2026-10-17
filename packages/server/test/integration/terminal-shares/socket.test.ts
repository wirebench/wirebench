import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TERMINAL_SHARE_CLOSE,
  TERMINAL_SHARE_PATH,
  terminalShareServerMessageSchema,
  type TerminalShareInfo,
  type TerminalShareServerMessage,
} from '@wirebench/engine';
import type { AuditInput } from '../../../src/context.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { mintToken } from '../../../src/identity/tokens.js';
import { liveModule } from '../../../src/live/module.js';
import { syncModule } from '../../../src/sync/module.js';
import { terminalSharesModule } from '../../../src/terminal-shares/module.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licenseInstallRecorded, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';
import { manualTimers } from '../../helpers/timers.js';

const WAIT_MS = 5_000;

interface ShareClient {
  readonly texts: TerminalShareServerMessage[];
  readonly binaries: string[];
  next<T extends TerminalShareServerMessage['type']>(
    type: T,
  ): Promise<Extract<TerminalShareServerMessage, { type: T }>>;
  binary(count: number): Promise<string[]>;
  send(message: unknown): void;
  sendBinary(data: string): void;
  readonly closed: Promise<number>;
}

async function openShare(port: number, auth?: unknown): Promise<ShareClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_SHARE_PATH}`);
  socket.binaryType = 'arraybuffer';
  const texts: TerminalShareServerMessage[] = [];
  const binaries: string[] = [];
  const taken = new Set<TerminalShareServerMessage>();
  const listeners: (() => void)[] = [];
  const changed = (): void => {
    for (const listener of listeners.splice(0)) listener();
  };
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
      changed();
    });
  });
  socket.addEventListener('message', (event) => {
    const data: unknown = event.data;
    if (typeof data === 'string') texts.push(terminalShareServerMessageSchema.parse(JSON.parse(data)));
    else binaries.push(Buffer.from(data as ArrayBuffer).toString('utf8'));
    changed();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the share socket did not open')), { once: true });
  });
  const until = <T>(probe: () => T | undefined, what: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${what}; saw ${JSON.stringify(texts)}`)), WAIT_MS);
      const check = (): void => {
        const found = probe();
        if (found !== undefined) {
          clearTimeout(timer);
          resolve(found);
        } else listeners.push(check);
      };
      check();
    });
  const client: ShareClient = {
    texts,
    binaries,
    next: (type) =>
      until(() => {
        const found = texts.find((m) => m.type === type && !taken.has(m));
        if (found !== undefined) taken.add(found);
        return found as Extract<TerminalShareServerMessage, { type: typeof type }> | undefined;
      }, type),
    binary: (count) => until(() => (binaries.length >= count ? binaries.slice(0, count) : undefined), 'binary'),
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    sendBinary: (data) => {
      socket.send(Buffer.from(data));
    },
    closed,
  };
  if (auth !== undefined) client.send(auth);
  return client;
}

describeDb('terminal shares (#429)', () => {
  const keys = testKeys();
  const timers = manualTimers();
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let port: number;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let ada: Awaited<ReturnType<typeof signedInUser>>;
  let bo: Awaited<ReturnType<typeof signedInUser>>;
  let outsider: Awaited<ReturnType<typeof signedInUser>>;
  let ws: string;
  let base: string;

  beforeAll(async () => {
    h = await licensingHarness(keys, {
      extra: (clock) => [
        syncModule(),
        liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
        auditLogModule({ now: () => clock.now }),
        terminalSharesModule({ now: () => clock.now, setTimer: timers.setTimer }),
      ],
    });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    port = address.port;
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    ada = await signedInUser(h, { email: 'ada@example.com' });
    bo = await signedInUser(h, { email: 'bo@example.com' });
    outsider = await signedInUser(h, { email: 'out@example.com' });
    const team = await seedTeam(h, { name: 'Ops', admins: [admin], members: [ada, bo] });
    await seedTeam(h, { name: 'Elsewhere', members: [outsider] });
    ws = (await call<{ id: string }>(h, admin, 'POST', `/teams/${team.id}/workspaces`, { name: 'Prod' })).body.id;
    base = `/workspaces/${ws}/terminal-shares`;
    events = recordingAudit(h.hooks);
  });
  afterAll(() => h.close());

  const actions = (): string[] => events.filter((e) => e.action.startsWith('terminal_share.')).map((e) => e.action);
  const create = async (): Promise<string> => {
    const res = await call<{ shareId: string }>(h, ada, 'POST', base, { hostName: 'web', cols: 80, rows: 24 });
    expect(res.status).toBe(201);
    return res.body.shareId;
  };
  const auth = (token: string, shareId: string) => ({ type: 'auth', token, workspaceId: ws, shareId });

  it('needs the terminal-sharing feature', async () => {
    const res = await call<{ code: string }>(h, ada, 'POST', base, { hostName: 'web', cols: 80, rows: 24 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('licensing-feature-required');
    const put = await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
    expect(put.status).toBe(200);
    await licenseInstallRecorded(h);
  });

  it('creates a share and describes it to members only', async () => {
    const shareId = await create();
    expect(shareId).toMatch(/^[a-z2-7]{26}$/);
    await expect
      .poll(() => events.at(-1), { timeout: WAIT_MS })
      .toMatchObject({
        action: 'terminal_share.started',
        target: { kind: 'terminal-share', id: shareId },
        workspaceId: ws,
        details: { hostName: 'web' },
      });
    const info = await call<TerminalShareInfo>(h, bo, 'GET', `${base}/${shareId}`);
    expect(info.body).toEqual({ hostName: 'web', ownerName: 'ada', viewers: 0 });
    expect((await call<{ code: string }>(h, outsider, 'GET', `${base}/${shareId}`)).body.code).toBe(
      'teams-workspace-not-found',
    );
    const missing = await call<{ code: string }>(h, bo, 'GET', `${base}/${'a'.repeat(26)}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('terminal-share-not-found');
  });

  it('relays the screen, hands control over on request and ends for everyone', async () => {
    const shareId = await create();
    const owner = await openShare(port, auth(ada.token, shareId));
    expect(await owner.next('ready')).toEqual({ type: 'ready', role: 'owner' });
    owner.sendBinary('$ uptime\r\n');
    const viewer = await openShare(port, auth(bo.token, shareId));
    expect(await viewer.next('viewer-ready')).toEqual({
      type: 'viewer-ready',
      hostName: 'web',
      ownerName: 'ada',
      cols: 80,
      rows: 24,
    });
    expect(await viewer.binary(1)).toEqual(['$ uptime\r\n']);
    owner.sendBinary(' 10:00 up 3 days\r\n');
    expect((await viewer.binary(2))[1]).toBe(' 10:00 up 3 days\r\n');
    expect((await owner.next('presence')).viewers).toEqual([]);
    expect((await owner.next('presence')).viewers).toEqual([
      { userId: bo.user.id, name: 'bo', control: false, requesting: false },
    ]);

    viewer.send({ type: 'request-control' });
    expect((await owner.next('presence')).viewers[0]).toMatchObject({ requesting: true });
    owner.send({ type: 'grant', userId: bo.user.id });
    expect(await viewer.next('control')).toEqual({ type: 'control', userId: null });
    expect(await viewer.next('control')).toEqual({ type: 'control', userId: bo.user.id });
    const data = Buffer.from('ls\r').toString('base64');
    viewer.send({ type: 'input', data });
    expect(await owner.next('input')).toEqual({ type: 'input', userId: bo.user.id, data });
    owner.send({ type: 'take-back' });
    expect(await viewer.next('control')).toEqual({ type: 'control', userId: null });

    // A viewer may not send output.
    const pushy = await openShare(port, auth(bo.token, shareId));
    await pushy.next('viewer-ready');
    pushy.sendBinary('rm -rf /');
    expect(await pushy.closed).toBe(TERMINAL_SHARE_CLOSE.badMessage);

    owner.send({ type: 'end' });
    expect(await viewer.next('ended')).toEqual({ type: 'ended', reason: 'ended' });
    expect(await viewer.closed).toBe(TERMINAL_SHARE_CLOSE.ended);
    expect(await owner.closed).toBe(TERMINAL_SHARE_CLOSE.ended);
    await expect
      .poll(actions, { timeout: WAIT_MS })
      .toEqual(
        expect.arrayContaining([
          'terminal_share.joined',
          'terminal_share.control_granted',
          'terminal_share.control_returned',
          'terminal_share.ended',
        ]),
      );
    // No output and no input in any audit row.
    expect(JSON.stringify(events)).not.toContain('uptime');
    expect(JSON.stringify(events)).not.toContain(data);
  });

  it('a removed viewer is closed and kept out', async () => {
    const shareId = await create();
    const owner = await openShare(port, auth(ada.token, shareId));
    await owner.next('ready');
    const viewer = await openShare(port, auth(bo.token, shareId));
    await viewer.next('viewer-ready');
    owner.send({ type: 'remove', userId: bo.user.id });
    expect(await viewer.next('ended')).toEqual({ type: 'ended', reason: 'removed' });
    expect(await viewer.closed).toBe(TERMINAL_SHARE_CLOSE.forbidden);
    const again = await openShare(port, auth(bo.token, shareId));
    expect(await again.closed).toBe(TERMINAL_SHARE_CLOSE.forbidden);
    await expect.poll(actions, { timeout: WAIT_MS }).toContain('terminal_share.viewer_removed');
    owner.send({ type: 'end' });
    await owner.closed;
  });

  it('refuses a bad token, an outsider, an unknown share, a second owner and an early message', async () => {
    const shareId = await create();
    expect(await (await openShare(port, auth(mintToken().token, shareId))).closed).toBe(
      TERMINAL_SHARE_CLOSE.unauthenticated,
    );
    expect(await (await openShare(port, auth(outsider.token, shareId))).closed).toBe(TERMINAL_SHARE_CLOSE.forbidden);
    expect(await (await openShare(port, auth(bo.token, 'b'.repeat(26)))).closed).toBe(TERMINAL_SHARE_CLOSE.notFound);
    const owner = await openShare(port, auth(ada.token, shareId));
    await owner.next('ready');
    expect(await (await openShare(port, auth(ada.token, shareId))).closed).toBe(TERMINAL_SHARE_CLOSE.tooMany);
    expect(await (await openShare(port, { type: 'request-control' })).closed).toBe(TERMINAL_SHARE_CLOSE.badMessage);
    // The owner leaving ends the share.
    const viewer = await openShare(port, auth(bo.token, shareId));
    await viewer.next('viewer-ready');
    owner.send({ type: 'end' });
    expect(await viewer.next('ended')).toEqual({ type: 'ended', reason: 'ended' });
  });

  it('a share whose owner never connects is dropped', async () => {
    const shareId = await create();
    expect(timers.fire(30_000)).toBeGreaterThan(0);
    expect((await call<{ code: string }>(h, bo, 'GET', `${base}/${shareId}`)).status).toBe(404);
    // The started row is written without waiting, so it may land after this one.
    await expect
      .poll(() => events.find((e) => e.action === 'terminal_share.ended' && e.target?.id === shareId), {
        timeout: WAIT_MS,
      })
      .toMatchObject({ details: { reason: 'owner-left' } });
  });
});
