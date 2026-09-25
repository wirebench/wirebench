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

describe('accounts.yaml schema', () => {
  it('parses the documented example, with and without signedOut', () => {
    expect(accountsFileSchema.parse({ version: 1, servers: [SERVER] }).servers[0]?.signedOut).toBeUndefined();
    expect(
      accountsFileSchema.parse({ version: 1, servers: [{ ...SERVER, signedOut: true }] }).servers[0]?.signedOut,
    ).toBe(true);
  });
  it('refuses a token in the file: only a secret-store ref is allowed', () => {
    expect(accountsFileSchema.safeParse({ version: 1, servers: [{ ...SERVER, tokenRef: 'wbs_abc' }] }).success).toBe(
      false,
    );
  });
  it('parseAccountsFile yields an empty file for anything malformed, never throws', () => {
    expect(parseAccountsFile(undefined)).toEqual({ version: 1, servers: [] });
    expect(parseAccountsFile({ version: 2, servers: [] })).toEqual({ version: 1, servers: [] });
    expect(parseAccountsFile('garbage')).toEqual({ version: 1, servers: [] });
  });
});
