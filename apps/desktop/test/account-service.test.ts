// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { parse as parseYaml } from 'yaml';
import { AccountService, ACCOUNTS_FILE, TOKEN_LABEL_PREFIX } from '../src/main/account-service.js';
import type { LoopbackCallback } from '../src/main/loopback-callback.js';
import type { ServerClient } from '../src/main/server-client.js';

const URL_A = 'https://wb.test';
const USER = { id: '01J8Z0000000000000000000AB', email: 'alice@example.com', displayName: 'Alice', serverAdmin: true };
const TOKEN = `wbs_${'A'.repeat(43)}`;
const META = {
  name: 'wirebench-server',
  version: '1',
  apiVersion: 1,
  publicUrl: URL_A,
  auth: { local: true, oidc: true, oidcDisplayName: 'Corp' },
  capabilities: [],
};

/** An in-memory SecretStore: refs in, values out, labels kept. */
function fakeSecrets() {
  const entries = new Map<string, { value: string; label?: string }>();
  let n = 0;
  return {
    entries,
    // eslint-disable-next-line @typescript-eslint/require-await -- SecretStore.set is async; this fake has no await
    set: vi.fn(async (value: string, opts?: { label?: string }) => {
      const ref = `sec_${String(++n).padStart(26, '0')}`;
      entries.set(ref, { value, ...(opts?.label !== undefined ? { label: opts.label } : {}) });
      return ref;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- SecretStore.get is async; this fake has no await
    get: vi.fn(async (ref: string) => entries.get(ref)?.value),
    // eslint-disable-next-line @typescript-eslint/require-await -- SecretStore.delete is async; this fake has no await
    delete: vi.fn(async (ref: string) => entries.delete(ref)),
  };
}

function fakeClient(overrides: Partial<Record<keyof ServerClient, unknown>> = {}): ServerClient {
  return {
    meta: vi.fn().mockResolvedValue(META),
    signInLocal: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    startOidc: vi.fn().mockResolvedValue({
      flowId: 'flow-1',
      authorizationUrl: 'https://idp.test/authorize?x=1',
      expiresAt: '2026-09-24T12:10:00.000Z',
    }),
    completeOidc: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    signOut: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue({ user: USER, methods: { local: true, oidc: [] } }),
    lookupInvitation: vi.fn().mockResolvedValue({ email: 'alice@example.com', methods: { local: true, oidc: false } }),
    acceptInvitation: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    ...overrides,
  } as unknown as ServerClient;
}

/** A loopback whose result the test settles by hand. */
function fakeLoopback() {
  let settle: { resolve: (p: URLSearchParams) => void; reject: (e: Error) => void } | undefined;
  const listener: LoopbackCallback = {
    redirectUri: 'http://127.0.0.1:49152/callback',
    port: 49152,
    result: new Promise((resolve, reject) => {
      settle = { resolve, reject };
    }),
    cancel: vi.fn(() => settle?.reject(new WirebenchError('loopback-cancelled', 'cancelled'))),
  };
  return {
    listener,
    // eslint-disable-next-line @typescript-eslint/require-await -- startLoopbackCallback is async; this fake has no await
    start: vi.fn(async () => listener),
    answer: (params: Record<string, string>) => settle?.resolve(new URLSearchParams(params)),
  };
}

describe('AccountService', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-accounts-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const service = (
    client = fakeClient(),
    secrets = fakeSecrets(),
    loopback = fakeLoopback(),
    openExternal = vi.fn().mockResolvedValue(undefined),
  ) =>
    new AccountService({
      userDataDir: dir,
      client,
      secrets,
      loopback: loopback.start,
      openExternal,
      defaultDeviceName: () => 'test-host',
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    });

  it('probe normalises the URL and returns meta', async () => {
    const client = fakeClient();
    expect(await service(client).probe(' https://WB.test/path ')).toEqual({ url: URL_A, meta: META });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- expect() reads the mock fn, never calls it unbound
    expect(client.meta).toHaveBeenCalledWith(URL_A);
  });

  it('local sign-in stores the token in the secret store under the server label and the account in accounts.yaml, never the token', async () => {
    const client = fakeClient();
    const secrets = fakeSecrets();
    const changed = vi.fn();
    const s = service(client, secrets);
    s.onChange(changed);
    const account = await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- expect() reads the mock fn, never calls it unbound
    expect(client.signInLocal).toHaveBeenCalledWith(URL_A, {
      email: 'alice@example.com',
      password: 'pw'.repeat(6),
      device: { name: 'test-host' },
    });
    expect(account).toMatchObject({
      url: URL_A,
      userId: USER.id,
      email: 'alice@example.com',
      displayName: 'Alice',
      deviceName: 'test-host',
      addedAt: '2026-09-24T12:00:00.000Z',
    });
    expect(account.signedOut).toBeUndefined();
    expect([...secrets.entries.values()]).toEqual([{ value: TOKEN, label: `${TOKEN_LABEL_PREFIX}${URL_A}` }]);
    const file = parseYaml(await readFile(join(dir, ACCOUNTS_FILE), 'utf8')) as {
      version: number;
      servers: { tokenRef: string }[];
    };
    expect(file.version).toBe(1);
    expect(file.servers[0]?.tokenRef).toMatch(/^sec_/);
    expect(JSON.stringify(file)).not.toContain(TOKEN);
    expect(changed).toHaveBeenCalledWith([expect.objectContaining({ url: URL_A })]);
    expect(await s.tokenFor(URL_A)).toBe(TOKEN);
  });

  it('a second sign-in to the same server replaces the entry and the old secret', async () => {
    const secrets = fakeSecrets();
    const s = service(fakeClient(), secrets);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6), deviceName: 'first' });
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6), deviceName: 'second' });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.deviceName).toBe('second');
    expect(secrets.entries.size).toBe(1);
  });

  it('OIDC: starts the flow with the loopback port, opens the browser at the server’s URL, completes with the grant', async () => {
    const client = fakeClient();
    const loopback = fakeLoopback();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const s = service(client, fakeSecrets(), loopback, openExternal);
    const pending = s.startOidc({ url: URL_A });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://idp.test/authorize?x=1'));
    const startBody = (client.startOidc as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      codeChallenge: string;
      loopbackPort: number;
    };
    expect(startBody.loopbackPort).toBe(49152);
    expect(startBody.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    loopback.answer({ flow: 'flow-1', grant: 'G'.repeat(43) });
    const account = await pending;
    expect(account.email).toBe('alice@example.com');
    const completeBody = (client.completeOidc as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      flowId: string;
      grant: string;
      codeVerifier: string;
    };
    expect(completeBody).toMatchObject({ flowId: 'flow-1', grant: 'G'.repeat(43) });
    expect(completeBody.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('OIDC: an error on the loopback becomes that code; cancel and timeout have their own; one flow at a time', async () => {
    const loopback = fakeLoopback();
    const s = service(fakeClient(), fakeSecrets(), loopback);
    const pending = s.startOidc({ url: URL_A });
    await vi.waitFor(() => expect(loopback.start).toHaveBeenCalled());
    await expect(s.startOidc({ url: URL_A })).rejects.toMatchObject({ code: 'account-sign-in-pending' });
    loopback.answer({ flow: 'flow-1', error: 'identity-not-invited' });
    await expect(pending).rejects.toMatchObject({ code: 'identity-not-invited' });

    const second = fakeLoopback();
    const s2 = service(fakeClient(), fakeSecrets(), second);
    const pending2 = s2.startOidc({ url: URL_A });
    await vi.waitFor(() => expect(second.start).toHaveBeenCalled());
    expect(s2.cancelSignIn()).toEqual({ cancelled: true });
    await expect(pending2).rejects.toMatchObject({ code: 'account-sign-in-cancelled' });
    expect(s2.cancelSignIn()).toEqual({ cancelled: false });
  });

  it('sign out revokes on the server, deletes the secret and keeps the entry as signed out; a failed server call still clears', async () => {
    const client = fakeClient({ signOut: vi.fn().mockRejectedValue(new WirebenchError('server-unreachable', 'down')) });
    const secrets = fakeSecrets();
    const s = service(client, secrets);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });
    await s.signOut(URL_A);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- expect() reads the mock fn, never calls it unbound
    expect(client.signOut).toHaveBeenCalledWith(URL_A, TOKEN);
    expect(secrets.entries.size).toBe(0);
    expect(s.list()[0]).toMatchObject({ url: URL_A, signedOut: true });
    expect(await s.tokenFor(URL_A)).toBeUndefined();
    await expect(s.signOut('https://unknown.test')).rejects.toMatchObject({ code: 'account-unknown-server' });
  });

  it('remove revokes when signed in and drops the entry; markSignedOut flags an account the server no longer knows', async () => {
    const client = fakeClient();
    const s = service(client);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });
    s.markSignedOut(URL_A);
    expect(s.list()[0]?.signedOut).toBe(true);
    await s.remove(URL_A);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- expect() reads the mock fn, never calls it unbound
    expect(client.signOut).not.toHaveBeenCalled(); // already signed out: nothing to revoke
    expect(s.list()).toEqual([]);
    expect(parseYaml(await readFile(join(dir, ACCOUNTS_FILE), 'utf8'))).toEqual({ version: 1, servers: [] });
  });

  it('accepts an invitation the same way local sign-in does, and looks one up', async () => {
    const client = fakeClient();
    const s = service(client);
    expect((await s.lookupInvitation({ url: URL_A, secret: 'S'.repeat(43) })).email).toBe('alice@example.com');
    const account = await s.acceptInvitation({
      url: URL_A,
      secret: 'S'.repeat(43),
      displayName: 'Alice',
      password: 'pw'.repeat(6),
    });
    expect(account.userId).toBe(USER.id);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- expect() reads the mock fn, never calls it unbound
    expect(client.acceptInvitation).toHaveBeenCalledWith(URL_A, {
      secret: 'S'.repeat(43),
      displayName: 'Alice',
      password: 'pw'.repeat(6),
      device: { name: 'test-host' },
    });
  });

  it('refresh marks the account signed out on identity-unauthenticated, updates the name on success, and ignores an outage', async () => {
    const client = fakeClient();
    const secrets = fakeSecrets();
    const s = service(client, secrets);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });

    (client.me as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: { ...USER, displayName: 'Alice L.' },
      methods: { local: true, oidc: [] },
    });
    await s.refreshAll();
    expect(s.list()[0]?.displayName).toBe('Alice L.');

    (client.me as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new WirebenchError('server-unreachable', 'down'));
    await s.refresh(URL_A);
    expect(s.list()[0]?.signedOut).toBeUndefined();

    (client.me as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new WirebenchError('identity-unauthenticated', 'revoked'),
    );
    await s.refresh(URL_A);
    expect(s.list()[0]?.signedOut).toBe(true);
    expect(secrets.entries.size).toBe(0);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- expect() reads the mock fn, never calls it unbound
    expect(client.me).toHaveBeenCalledTimes(3);
    await s.refresh(URL_A); // signed out: no call
    // eslint-disable-next-line @typescript-eslint/unbound-method -- expect() reads the mock fn, never calls it unbound
    expect(client.me).toHaveBeenCalledTimes(3);
  });

  it('load reads an existing file and tolerates a malformed one', async () => {
    await writeFile(
      join(dir, ACCOUNTS_FILE),
      'version: 1\nservers:\n  - url: https://wb.test\n    userId: u\n    email: a@b.co\n    displayName: A\n    deviceName: d\n    tokenRef: sec_00000000000000000000000001\n    addedAt: "2026-09-24T12:00:00.000Z"\n',
    );
    const s = service();
    await s.load();
    expect(s.list()).toHaveLength(1);
    await writeFile(join(dir, ACCOUNTS_FILE), 'nonsense: [');
    const broken = service();
    await broken.load();
    expect(broken.list()).toEqual([]);
  });
});
