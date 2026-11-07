// @vitest-environment node
/**
 * Switch accounts (spec §2, §6; plan rulings 1–4): two people on one server, the active account and where it
 * goes on a sign-out, and a version 1 `accounts.yaml` read through the service.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AccountService, ACCOUNTS_FILE, tokenLabel } from '../src/account-service.js';
import type { ServerClient } from '../src/server-client.js';

const URL_A = 'https://wb.test';
const URL_B = 'https://other.test';
const ALICE = {
  id: '01J8Z0000000000000000000AA',
  email: 'alice@example.com',
  displayName: 'Alice',
  serverAdmin: false,
};
const ALICE_TEST = {
  id: '01J8Z0000000000000000000AT',
  email: 'alice+test@example.com',
  displayName: 'Alice (test)',
  serverAdmin: false,
};
const BOB = { id: '01J8Z0000000000000000000BB', email: 'bob@example.com', displayName: 'Bob', serverAdmin: false };
const token = (letter: string): string => `wbs_${letter.repeat(43)}`;

function fakeSecrets() {
  const entries = new Map<string, { value: string; label?: string }>();
  let n = 0;
  return {
    entries,
    set: vi.fn((value: string, opts?: { label?: string }) => {
      const ref = `sec_${String(++n).padStart(26, '0')}`;
      entries.set(ref, { value, ...(opts?.label !== undefined ? { label: opts.label } : {}) });
      return Promise.resolve(ref);
    }),
    get: vi.fn((ref: string) => Promise.resolve(entries.get(ref)?.value)),
    delete: vi.fn((ref: string) => Promise.resolve(entries.delete(ref))),
  };
}

/** `signInLocal` answers as whoever `identifier` names, with a token of their own. */
function fakeClient() {
  const people: Record<string, { user: typeof ALICE; token: string }> = {
    alice: { user: ALICE, token: token('A') },
    'alice-test': { user: ALICE_TEST, token: token('T') },
    bob: { user: BOB, token: token('B') },
  };
  const mocks = {
    signInLocal: vi.fn((_url: string, body: { identifier: string }) => Promise.resolve(people[body.identifier])),
    signOut: vi.fn(() => Promise.resolve(undefined)),
    me: vi.fn(() => Promise.reject(new Error('offline'))),
  };
  return { mocks, client: mocks as unknown as ServerClient };
}

describe('AccountService — switching accounts', () => {
  let dir: string;
  let clock: number;
  let secrets: ReturnType<typeof fakeSecrets>;
  let client: ReturnType<typeof fakeClient>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-accounts-switch-'));
    clock = Date.parse('2026-11-07T10:00:00.000Z');
    secrets = fakeSecrets();
    client = fakeClient();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const service = (): AccountService =>
    new AccountService({
      userDataDir: dir,
      client: client.client,
      secrets,
      openExternal: () => Promise.resolve(),
      defaultDeviceName: () => 'test-host',
      // Each reading a minute later, so "most recently active" has an order.
      now: () => new Date((clock += 60_000)),
    });
  const signIn = (s: AccountService, url: string, identifier: string) =>
    s.signInLocal({ url, identifier, password: 'pw'.repeat(6) });
  const ref = (url: string, user: { id: string }) => ({ url, userId: user.id });
  const file = async () =>
    parseYaml(await readFile(join(dir, ACCOUNTS_FILE), 'utf8')) as {
      version: number;
      active: { url: string; userId: string } | null;
      servers: { url: string; userId: string; tokenRef: string; lastActiveAt?: string; signedOut?: true }[];
    };

  it('a second person on one server is a second account, with a token of its own, and becomes active', async () => {
    const s = service();
    await s.load();
    await signIn(s, URL_A, 'alice');
    expect(s.active()).toEqual(ref(URL_A, ALICE));
    await signIn(s, URL_A, 'alice-test');

    expect(s.list().map((account) => account.userId)).toEqual([ALICE_TEST.id, ALICE.id]);
    expect(s.active()).toEqual(ref(URL_A, ALICE_TEST));
    expect([...secrets.entries.values()].map((entry) => entry.label).sort()).toEqual(
      [tokenLabel(URL_A, ALICE.id), tokenLabel(URL_A, ALICE_TEST.id)].sort(),
    );
    expect(tokenLabel(URL_A, ALICE.id)).toBe(`wirebench-server:${URL_A}#${ALICE.id}`);
    expect(await s.tokenFor(ref(URL_A, ALICE))).toBe(token('A'));
    expect(await s.tokenFor(ref(URL_A, ALICE_TEST))).toBe(token('T'));
    // A URL alone (ruling 1) stands for the server's active account.
    expect(await s.tokenFor(URL_A)).toBe(token('T'));
    expect(s.accountFor(URL_A)?.userId).toBe(ALICE_TEST.id);

    const stored = await file();
    expect(stored.version).toBe(2);
    expect(stored.active).toEqual(ref(URL_A, ALICE_TEST));
    expect(stored.servers).toHaveLength(2);
  });

  it('signing in again as the same person replaces that account’s token, not the other’s', async () => {
    const s = service();
    await s.load();
    await signIn(s, URL_A, 'alice');
    await signIn(s, URL_A, 'alice-test');
    await signIn(s, URL_A, 'alice');
    expect(s.list()).toHaveLength(2);
    expect(s.active()).toEqual(ref(URL_A, ALICE));
    expect(secrets.entries.size).toBe(2);
    expect(await s.tokenFor(ref(URL_A, ALICE_TEST))).toBe(token('T'));
  });

  it('setActive stamps lastActiveAt and survives a restart; a URL alone then follows it', async () => {
    const s = service();
    await s.load();
    await signIn(s, URL_A, 'alice');
    await signIn(s, URL_A, 'alice-test');
    await s.setActive(ref(URL_A, ALICE));
    const stamped = s.accountFor(ref(URL_A, ALICE))?.lastActiveAt;
    expect(stamped).toBeDefined();
    expect(stamped! > s.accountFor(ref(URL_A, ALICE_TEST))!.lastActiveAt!).toBe(true);

    const again = service();
    await again.load();
    expect(again.active()).toEqual(ref(URL_A, ALICE));
    expect(await again.tokenFor(URL_A)).toBe(token('A'));
    expect(again.list()[0]?.userId).toBe(ALICE.id);
  });

  it('setActive refuses a signed-out or unknown account', async () => {
    const s = service();
    await s.load();
    await signIn(s, URL_A, 'alice');
    await signIn(s, URL_A, 'alice-test');
    await s.signOut(ref(URL_A, ALICE));
    await expect(s.setActive(ref(URL_A, ALICE))).rejects.toMatchObject({ code: 'account-signed-out' });
    await expect(s.setActive(ref(URL_B, BOB))).rejects.toMatchObject({ code: 'account-unknown-server' });
    expect(s.active()).toEqual(ref(URL_A, ALICE_TEST));
  });

  it('signing the active account out makes the most recently active other one active, then none', async () => {
    const s = service();
    await s.load();
    await signIn(s, URL_A, 'alice');
    await signIn(s, URL_B, 'bob');
    await signIn(s, URL_A, 'alice-test');
    await s.setActive(ref(URL_B, BOB));
    await s.setActive(ref(URL_A, ALICE));
    // Most recent first: Alice (active), Bob, Alice (test).
    await s.signOut(ref(URL_A, ALICE));
    expect(s.active()).toEqual(ref(URL_B, BOB));
    expect(client.mocks.signOut).toHaveBeenCalledWith(URL_A, token('A'));
    // Signing out one that is not active leaves the active one alone.
    await s.signOut(ref(URL_A, ALICE_TEST));
    expect(s.active()).toEqual(ref(URL_B, BOB));
    await s.signOut(ref(URL_B, BOB));
    expect(s.active()).toBeNull();
    expect((await file()).active).toBeNull();
    expect(s.list().every((account) => account.signedOut === true)).toBe(true);
  });

  it('a token the server refused, or removing the active account, promotes the next one too', async () => {
    const s = service();
    await s.load();
    await signIn(s, URL_A, 'alice');
    await signIn(s, URL_A, 'alice-test');
    s.markSignedOut(ref(URL_A, ALICE_TEST));
    expect(s.active()).toEqual(ref(URL_A, ALICE));
    expect(s.accountFor(ref(URL_A, ALICE_TEST))?.signedOut).toBe(true);
    await signIn(s, URL_A, 'alice-test');
    await s.remove(ref(URL_A, ALICE_TEST));
    expect(s.list().map((account) => account.userId)).toEqual([ALICE.id]);
    expect(s.active()).toEqual(ref(URL_A, ALICE));
  });

  it('reads a version 1 file without rewriting it, keeps its token refs, and writes version 2 at the next change', async () => {
    const v1 = {
      version: 1,
      servers: [
        {
          url: URL_B,
          userId: BOB.id,
          email: BOB.email,
          displayName: BOB.displayName,
          deviceName: 'Mac',
          tokenRef: 'sec_00000000000000000000000077',
          addedAt: '2026-09-24T12:00:00.000Z',
          signedOut: true,
        },
        {
          url: URL_A,
          userId: ALICE.id,
          email: ALICE.email,
          displayName: ALICE.displayName,
          deviceName: 'Mac',
          tokenRef: 'sec_00000000000000000000000088',
          addedAt: '2026-09-24T12:00:00.000Z',
        },
      ],
    };
    const text = stringifyYaml(v1);
    await writeFile(join(dir, ACCOUNTS_FILE), text, 'utf8');
    secrets.entries.set('sec_00000000000000000000000088', { value: token('A'), label: `wirebench-server:${URL_A}` });

    const s = service();
    await s.load();
    // The first signed-in entry is active; the file on disk is untouched by the read.
    expect(s.active()).toEqual(ref(URL_A, ALICE));
    expect(await readFile(join(dir, ACCOUNTS_FILE), 'utf8')).toBe(text);
    expect(await s.tokenFor(URL_A)).toBe(token('A'));

    await signIn(s, URL_A, 'alice-test');
    const stored = await file();
    expect(stored.version).toBe(2);
    expect(stored.active).toEqual(ref(URL_A, ALICE_TEST));
    // Ruling 4: a version 1 token keeps its ref; nothing in the secret store is rewritten.
    expect(stored.servers.find((server) => server.userId === ALICE.id)?.tokenRef).toBe(
      'sec_00000000000000000000000088',
    );
    expect(secrets.entries.get('sec_00000000000000000000000088')?.value).toBe(token('A'));
    expect(stored.servers.map((server) => server.userId).sort()).toEqual([ALICE.id, ALICE_TEST.id, BOB.id].sort());
  });
});
