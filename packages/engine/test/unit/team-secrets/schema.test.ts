import { describe, expect, it } from 'vitest';
import { generateMachineKeys } from '../../../src/team-secrets/keys.js';
import {
  accessEntryFileSchema,
  accessEntryPath,
  isTeamSecretsPath,
  isVaultEntryPath,
  keyRequestFileSchema,
  keyRequestPath,
  parseTeamSecretsFile,
  readTeamSecretsFiles,
  teamSecretsFileText,
  vaultEntryId,
  vaultEntryIdOfPath,
  vaultEntryPath,
} from '../../../src/team-secrets/schema.js';
import { signDocument } from '../../../src/team-secrets/sign.js';

describe('team-secrets paths and ids', () => {
  it('derives a stable 26-character id per secret, different for a ref and a token', () => {
    const ref = vaultEntryId({ ref: 'sec_0123456789abcdef0123456789' });
    expect(ref).toMatch(/^[A-Z2-7]{26}$/);
    expect(vaultEntryId({ ref: 'sec_0123456789abcdef0123456789' })).toBe(ref);
    expect(vaultEntryId({ token: { projectId: 'P', name: 'api_key' } })).not.toBe(ref);
    expect(vaultEntryId({ token: { projectId: 'P', name: 'api_key' } })).not.toBe(
      vaultEntryId({ token: { projectId: 'Q', name: 'api_key' } }),
    );
  });

  it('recognises exactly the three kinds of team-secrets file', () => {
    const id = vaultEntryId({ ref: 'sec_x' });
    expect(isTeamSecretsPath(vaultEntryPath(id))).toBe(true);
    expect(isVaultEntryPath(vaultEntryPath(id))).toBe(true);
    expect(vaultEntryIdOfPath(vaultEntryPath(id))).toBe(id);
    expect(isVaultEntryPath(keyRequestPath('A'.repeat(26)))).toBe(false);
    expect(isTeamSecretsPath(accessEntryPath('01J8ZK6Q3V4W5X6Y7Z8A9B0C1D'))).toBe(true);
    for (const path of [
      'team-secrets/other/X.yaml',
      'team-secrets/values/x.yaml',
      'team-secrets/values',
      'projects/a.yaml',
    ]) {
      expect(isTeamSecretsPath(path)).toBe(false);
    }
  });
});

describe('reading the tree', () => {
  it('parses valid files, and lists malformed ones or ones whose name does not match their id', () => {
    const keys = generateMachineKeys();
    const doc = signDocument(
      {
        version: 1 as const,
        keyId: keys.keyId,
        encryptionKey: keys.encryptionKey,
        signingKey: keys.signingKey,
        name: 'Alex Doe',
        email: 'alex@example.com',
        machine: 'alex-mbp',
        requestedAt: '2026-09-26T10:00:00.000Z',
      },
      keys,
    );
    const text = teamSecretsFileText(doc);
    expect(parseTeamSecretsFile(keyRequestFileSchema, text)).toEqual(doc);
    const other = 'B'.repeat(26);
    const files = readTeamSecretsFiles(
      new Map([
        [keyRequestPath(keys.keyId), text],
        [keyRequestPath(other), text],
        [accessEntryPath('01J8ZK6Q3V4W5X6Y7Z8A9B0C1D'), 'version: [unclosed'],
      ]),
    );
    expect(files.keys).toEqual([doc]);
    expect(files.invalid.sort()).toEqual([accessEntryPath('01J8ZK6Q3V4W5X6Y7Z8A9B0C1D'), keyRequestPath(other)].sort());
  });

  it('rejects a valid vault entry filed under another secret’s id', () => {
    const keys = generateMachineKeys();
    const secretA = { ref: 'sec_aaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const idB = vaultEntryId({ ref: 'sec_bbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const doc = signDocument(
      {
        version: 1 as const,
        secret: secretA,
        label: 'API key',
        cipher: 'AAAA',
        wraps: { [keys.keyId]: 'BBBB' },
        updatedAt: '2026-09-26T10:00:00.000Z',
        updatedBy: keys.keyId,
      },
      keys,
    );
    const files = readTeamSecretsFiles(new Map([[vaultEntryPath(idB), teamSecretsFileText(doc)]]));
    expect(files.values.size).toBe(0);
    expect(files.invalid).toEqual([vaultEntryPath(idB)]);
  });
});

describe('strict schemas', () => {
  const keys = generateMachineKeys();

  it('rejects an unknown field on a key request', () => {
    const doc = signDocument(
      {
        version: 1 as const,
        keyId: keys.keyId,
        encryptionKey: keys.encryptionKey,
        signingKey: keys.signingKey,
        name: 'Alex Doe',
        email: 'alex@example.com',
        machine: 'alex-mbp',
        requestedAt: '2026-09-26T10:00:00.000Z',
      },
      keys,
    );
    expect(keyRequestFileSchema.safeParse(doc).success).toBe(true);
    expect(keyRequestFileSchema.safeParse({ ...doc, extra: 'nope' }).success).toBe(false);
  });

  it('requires authority on a genesis entry and forbids it on any other action', () => {
    const genesis = signDocument(
      {
        version: 1 as const,
        id: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1D',
        action: 'genesis' as const,
        authority: 'signed' as const,
        key: keys.keyId,
        by: keys.keyId,
        at: '2026-09-26T10:00:00.000Z',
      },
      keys,
    );
    expect(accessEntryFileSchema.safeParse(genesis).success).toBe(true);

    const genesisNoAuthority = signDocument({ ...genesis, authority: undefined }, keys);
    expect(accessEntryFileSchema.safeParse(genesisNoAuthority).success).toBe(false);

    const approveWithAuthority = signDocument(
      {
        version: 1 as const,
        id: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1E',
        action: 'approve' as const,
        authority: 'signed' as const,
        key: keys.keyId,
        by: keys.keyId,
        at: '2026-09-26T10:00:01.000Z',
      },
      keys,
    );
    expect(accessEntryFileSchema.safeParse(approveWithAuthority).success).toBe(false);
  });

  it('requires the signature to be exactly 86 base64url characters', () => {
    const genesis = signDocument(
      {
        version: 1 as const,
        id: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1D',
        action: 'genesis' as const,
        authority: 'signed' as const,
        key: keys.keyId,
        by: keys.keyId,
        at: '2026-09-26T10:00:00.000Z',
      },
      keys,
    );
    expect(accessEntryFileSchema.safeParse(genesis).success).toBe(true);
    expect(accessEntryFileSchema.safeParse({ ...genesis, signature: genesis.signature.slice(0, -1) }).success).toBe(
      false,
    );
    expect(accessEntryFileSchema.safeParse({ ...genesis, signature: `${genesis.signature}A` }).success).toBe(false);
  });
});
