// @vitest-environment node
/**
 * The embedder's account (hosted edition spec §17.3): a host inside a Wirebench Server is signed in to
 * that server with whatever token the embedder holds now. Nothing about it is stored, and the host can
 * neither sign in to, sign out of nor remove it.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { stringify as stringifyYaml } from 'yaml';
import { ACCOUNT_MANAGED_BY_SERVER, AccountService, ACCOUNTS_FILE } from '../src/account-service.js';
import type { ServerClient } from '../src/server-client.js';

const URL_A = 'https://wb.test';
const OTHER = 'https://other.test';
const USER = { id: '01J8Z0000000000000000000AB', email: 'alice@example.com', displayName: 'Alice', serverAdmin: false };
const TOKEN_1 = `wbs_${'A'.repeat(43)}`;
const TOKEN_2 = `wbs_${'B'.repeat(43)}`;

function fakeSecrets() {
  return {
    set: vi.fn(() => Promise.resolve(`sec_${'0'.repeat(26)}`)),
    get: vi.fn(() => Promise.resolve(undefined)),
    delete: vi.fn(() => Promise.resolve(true)),
  };
}

/** The server client's calls an embedded account may make, each a mock the test reads. */
function fakeClient() {
  const mocks = {
    me: vi.fn().mockResolvedValue({ user: USER, methods: { local: true, oidc: false } }),
    signInLocal: vi.fn(),
    acceptInvitation: vi.fn(),
    startOidc: vi.fn(),
    startSaml: vi.fn(),
    signOut: vi.fn(),
  };
  return { mocks, client: mocks as unknown as ServerClient };
}

describe('AccountService with an embedded account', () => {
  let dir: string;
  let credential: string | undefined;
  let client: ReturnType<typeof fakeClient>['mocks'];
  let serverClient: ServerClient;
  let secrets: ReturnType<typeof fakeSecrets>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-accounts-embedded-'));
    credential = TOKEN_1;
    ({ mocks: client, client: serverClient } = fakeClient());
    secrets = fakeSecrets();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const service = (): AccountService =>
    new AccountService({
      userDataDir: dir,
      client: serverClient,
      secrets,
      openExternal: () => Promise.resolve(),
      now: () => new Date('2026-10-28T12:00:00.000Z'),
      embedded: { url: 'https://WB.test/', credential: () => credential },
    });

  it('lists the account signed in, with the credential as its token and who `me` says it is', async () => {
    const s = service();
    await s.load();
    await s.refreshAll();
    expect(client.me).toHaveBeenCalledWith(URL_A, TOKEN_1);
    expect(s.list()).toEqual([
      {
        url: URL_A,
        userId: USER.id,
        email: USER.email,
        displayName: USER.displayName,
        deviceName: 'Web browser',
        tokenRef: expect.stringMatching(/^sec_[0-9a-f]{26}$/) as unknown,
        addedAt: '2026-10-28T12:00:00.000Z',
      },
    ]);
    await expect(s.tokenFor(URL_A)).resolves.toBe(TOKEN_1);
    credential = TOKEN_2;
    await expect(s.tokenFor(`${URL_A}/`)).resolves.toBe(TOKEN_2);
  });

  it('stores nothing: no accounts.yaml and no secret-store entry', async () => {
    const s = service();
    await s.load();
    await s.refreshAll();
    expect(existsSync(join(dir, ACCOUNTS_FILE))).toBe(false);
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it('a new credential gets a new ref and tells the listeners, so the live client reconnects', async () => {
    const s = service();
    await s.load();
    await s.refresh(URL_A);
    const before = s.list()[0]!.tokenRef;
    const changed = vi.fn();
    s.onChange(changed);
    await s.refresh(URL_A);
    expect(changed).not.toHaveBeenCalled();
    credential = TOKEN_2;
    await s.refresh(URL_A);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(s.list()[0]!.tokenRef).not.toBe(before);
    expect(client.me).toHaveBeenLastCalledWith(URL_A, TOKEN_2);
  });

  it('reads signed out while there is no credential, and the listeners hear it', async () => {
    const s = service();
    await s.load();
    await s.refresh(URL_A);
    const changed = vi.fn();
    s.onChange(changed);
    credential = undefined;
    await s.refresh(URL_A);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(s.list()[0]!.signedOut).toBe(true);
    await expect(s.tokenFor(URL_A)).resolves.toBeUndefined();
  });

  it('refuses to sign in to, sign out of or remove the embedded account', async () => {
    const s = service();
    await s.load();
    const refused = { code: ACCOUNT_MANAGED_BY_SERVER } as const;
    await expect(s.signOut(URL_A)).rejects.toMatchObject(refused);
    await expect(s.remove(URL_A)).rejects.toMatchObject(refused);
    await expect(s.signInLocal({ url: URL_A, email: 'a@example.com', password: 'x'.repeat(12) })).rejects.toMatchObject(
      refused,
    );
    await expect(
      s.acceptInvitation({ url: URL_A, secret: 's', displayName: 'A', password: 'x'.repeat(12) }),
    ).rejects.toMatchObject(refused);
    await expect(s.startOidc({ url: URL_A })).rejects.toMatchObject(refused);
    await expect(s.startSaml({ url: URL_A })).rejects.toMatchObject(refused);
    expect(client.signInLocal).not.toHaveBeenCalled();
    expect(client.signOut).not.toHaveBeenCalled();
    expect(s.list()).toHaveLength(1);
  });

  it('a refused `me` or a markSignedOut changes nothing: the embedder ends its own sessions', async () => {
    client.me.mockRejectedValue(new WirebenchError('identity-unauthenticated', 'no'));
    const s = service();
    await s.load();
    await s.refresh(URL_A);
    s.markSignedOut(URL_A);
    expect(s.list()[0]!.signedOut).toBeUndefined();
    await expect(s.tokenFor(URL_A)).resolves.toBe(TOKEN_1);
  });

  it('ignores an entry for the embedded origin left in accounts.yaml, and keeps the others', async () => {
    const stored = (url: string) => ({
      url,
      userId: 'u',
      email: 'e@example.com',
      displayName: 'E',
      deviceName: 'd',
      tokenRef: `sec_${'1'.repeat(26)}`,
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    await writeFile(
      join(dir, ACCOUNTS_FILE),
      stringifyYaml({ version: 1, servers: [stored(URL_A), stored(OTHER)] }),
      'utf8',
    );
    const s = service();
    await s.load();
    expect(s.list().map((account) => [account.url, account.deviceName])).toEqual([
      [OTHER, 'd'],
      [URL_A, 'Web browser'],
    ]);
  });
});
