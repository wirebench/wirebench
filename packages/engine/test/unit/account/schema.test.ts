import { describe, expect, it } from 'vitest';
import { accountsFileSchema, parseAccountsFile } from '../../../src/index.js';

const SERVER = {
  url: 'https://wirebench.example.com',
  userId: '01J8Z0000000000000000000AB',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'MacBook of Alice',
  tokenRef: 'sec_0123456789abcdef0123456789',
  addedAt: '2026-09-24T12:00:00.000Z',
};
const TEST_ACCOUNT = {
  ...SERVER,
  userId: '01J8Z0000000000000000000CD',
  email: 'alice+test@example.com',
  tokenRef: 'sec_abcdefabcdefabcdefabcdefab',
};
const OTHER_SERVER = { ...SERVER, url: 'https://other.example.com', tokenRef: 'sec_11111111111111111111111111' };
const ref = (account: { url: string; userId: string }): { url: string; userId: string } => ({
  url: account.url,
  userId: account.userId,
});

describe('accounts.yaml schema', () => {
  it('parses the documented example, with and without signedOut', () => {
    expect(
      accountsFileSchema.parse({ version: 2, active: ref(SERVER), servers: [SERVER] }).servers[0]?.signedOut,
    ).toBeUndefined();
    expect(
      accountsFileSchema.parse({ version: 2, active: null, servers: [{ ...SERVER, signedOut: true }] }).servers[0]
        ?.signedOut,
    ).toBe(true);
  });
  it('refuses a token in the file: only a secret-store ref is allowed', () => {
    expect(
      accountsFileSchema.safeParse({ version: 2, active: null, servers: [{ ...SERVER, tokenRef: 'wbs_abc' }] }).success,
    ).toBe(false);
  });
  it('holds two accounts on one server, and lastActiveAt on each', () => {
    const file = accountsFileSchema.parse({
      version: 2,
      active: ref(TEST_ACCOUNT),
      servers: [
        { ...SERVER, lastActiveAt: '2026-11-01T00:00:00.000Z' },
        { ...TEST_ACCOUNT, lastActiveAt: '2026-11-07T00:00:00.000Z' },
      ],
    });
    expect(file.servers.map((server) => server.userId)).toEqual([SERVER.userId, TEST_ACCOUNT.userId]);
    expect(file.servers[1]?.lastActiveAt).toBe('2026-11-07T00:00:00.000Z');
  });
  it('refuses the same person twice on one server', () => {
    expect(accountsFileSchema.safeParse({ version: 2, active: null, servers: [SERVER, SERVER] }).success).toBe(false);
  });
  it('the active account must name a signed-in entry', () => {
    expect(accountsFileSchema.safeParse({ version: 2, active: ref(OTHER_SERVER), servers: [SERVER] }).success).toBe(
      false,
    );
    expect(
      accountsFileSchema.safeParse({ version: 2, active: ref(SERVER), servers: [{ ...SERVER, signedOut: true }] })
        .success,
    ).toBe(false);
  });
  it('reads a version 1 file as version 2: every entry kept, the first signed-in one active', () => {
    const v1 = { version: 1, servers: [{ ...SERVER, signedOut: true }, OTHER_SERVER] };
    const before = structuredClone(v1);
    expect(parseAccountsFile(v1)).toEqual({
      version: 2,
      active: ref(OTHER_SERVER),
      servers: [{ ...SERVER, signedOut: true }, OTHER_SERVER],
    });
    // Pure: the document read is not changed.
    expect(v1).toEqual(before);
    expect(parseAccountsFile({ version: 1, servers: [{ ...SERVER, signedOut: true }] }).active).toBeNull();
  });
  it('a hand-edited active that names no signed-in entry keeps the accounts, the first signed-in one active', () => {
    expect(parseAccountsFile({ version: 2, active: ref(OTHER_SERVER), servers: [SERVER] }).active).toEqual(ref(SERVER));
  });
  it('parseAccountsFile yields an empty file for anything malformed or newer, never throws', () => {
    const empty = { version: 2, active: null, servers: [] };
    expect(parseAccountsFile(undefined)).toEqual(empty);
    expect(parseAccountsFile({ version: 3, servers: [] })).toEqual(empty);
    expect(parseAccountsFile({ version: 2, servers: [] })).toEqual(empty);
    expect(parseAccountsFile('garbage')).toEqual(empty);
  });
});
