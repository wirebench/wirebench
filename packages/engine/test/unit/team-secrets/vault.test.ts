import { describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import {
  buildVaultEntry,
  decryptValue,
  generateMachineKeys,
  healVaultEntry,
  openVaultEntry,
  replayAccessLog,
  rotateMarks,
  sealVaultEntry,
  signDocument,
  unwrapDataKey,
  vaultConflictWinner,
  vaultEntryId,
  verifiedKeys,
  verifyVaultEntry,
  WirebenchError,
  wrapsUnapprovedKey,
  type AccessAction,
  type AccessEntryFile,
  type AccessState,
  type KeyInfo,
  type MachineKeys,
  type VaultEntryFile,
} from '../../../src/index.js';

let clock = Date.parse('2026-09-26T10:00:00.000Z');
const tick = (): string => new Date((clock += 1000)).toISOString();

function requestOf(keys: MachineKeys, name: string) {
  return signDocument(
    {
      version: 1 as const,
      keyId: keys.keyId,
      encryptionKey: keys.encryptionKey,
      signingKey: keys.signingKey,
      name,
      email: `${name}@example.test`,
      machine: name,
      requestedAt: tick(),
    },
    keys,
  );
}

function entry(action: AccessAction, key: MachineKeys, by: MachineKeys, authority?: 'signed'): AccessEntryFile {
  const at = tick();
  return signDocument(
    {
      version: 1 as const,
      id: ulid(Date.parse(at)),
      action,
      ...(authority ? { authority } : {}),
      key: key.keyId,
      by: by.keyId,
      at,
    },
    by,
  );
}

const alice = generateMachineKeys();
const bob = generateMachineKeys();
const carol = generateMachineKeys();
const keys = verifiedKeys([requestOf(alice, 'alice'), requestOf(bob, 'bob'), requestOf(carol, 'carol')]);
const info = (k: MachineKeys): KeyInfo => keys.get(k.keyId)!;
const REF = { ref: 'sec_0123456789abcdef0123456789' } as const;

const genesis = entry('genesis', alice, alice, 'signed');
const approveBob = entry('approve', bob, alice);
const withBob = replayAccessLog(keys, [genesis, approveBob]);

function valueFor(value: string, state: AccessState, signer = alice): VaultEntryFile {
  return buildVaultEntry({
    secret: REF,
    label: 'Payments API key',
    value,
    recipients: [...state.approved].map((id) => keys.get(id)!),
    signer,
    at: tick(),
  });
}

describe('vault entries (§3.3, §3.4, §4)', () => {
  it('encrypts for every approved key, and only they can open it', () => {
    const written = valueFor('hunter2', withBob);
    expect(JSON.stringify(written)).not.toContain('hunter2');
    expect(Object.keys(written.wraps).sort()).toEqual([alice.keyId, bob.keyId].sort());
    expect(verifyVaultEntry(written, vaultEntryId(REF), withBob)).toBe('trusted');
    expect(openVaultEntry(written, alice)).toBe('hunter2');
    expect(openVaultEntry(written, bob)).toBe('hunter2');
    expect(openVaultEntry(written, carol)).toBeUndefined();
  });

  it('does not trust a moved entry, a signer that is not approved, or a changed field', () => {
    const written = valueFor('hunter2', withBob);
    expect(verifyVaultEntry(written, vaultEntryId({ ref: 'sec_other000000000000000000' }), withBob)).toBe('wrong-id');
    const byCarol = valueFor('x', withBob, carol);
    expect(verifyVaultEntry(byCarol, vaultEntryId(REF), withBob)).toBe('not-approved');
    expect(verifyVaultEntry({ ...written, label: 'Other' }, vaultEntryId(REF), withBob)).toBe('bad-signature');
  });

  it('treats an approved signer with no verified key request as not-approved, not bad-signature', () => {
    const written = valueFor('hunter2', withBob);
    const stateWithoutSignerKey: AccessState = {
      ...withBob,
      keys: new Map([...keys].filter(([keyId]) => keyId !== alice.keyId)),
    };
    expect(verifyVaultEntry(written, vaultEntryId(REF), stateWithoutSignerKey)).toBe('not-approved');
  });

  it('cannot be opened once re-signed for another secret: the entry id is the cipher’s additional data', () => {
    const written = valueFor('hunter2', withBob);
    const other = { ref: 'sec_other000000000000000000' };
    const moved = signDocument({ ...written, secret: other }, alice);
    expect(verifyVaultEntry(moved, vaultEntryId(other), withBob)).toBe('trusted');
    expect(openVaultEntry(moved, alice)).toBeUndefined();
  });

  it('heals a missing wrap for a newly approved key, keeping the value time and the other wraps', () => {
    const written = valueFor('hunter2', withBob);
    const withCarol = replayAccessLog(keys, [genesis, approveBob, entry('approve', carol, alice)]);
    expect(healVaultEntry(written, withBob, bob)).toBeUndefined();
    expect(healVaultEntry(written, withCarol, carol)).toBeUndefined();
    const healed = healVaultEntry(written, withCarol, bob)!;
    expect(healed.updatedAt).toBe(written.updatedAt);
    expect(healed.updatedBy).toBe(bob.keyId);
    expect(healed.wraps[alice.keyId]).toBe(written.wraps[alice.keyId]);
    expect(verifyVaultEntry(healed, vaultEntryId(REF), withCarol)).toBe('trusted');
    expect(openVaultEntry(healed, carol)).toBe('hunter2');
  });

  it('seals again for the remaining keys after a removal, and marks what the removed key could read', () => {
    const before = valueFor('hunter2', withBob);
    const oldBobWrap = before.wraps[bob.keyId]!;
    const oldDataKey = unwrapDataKey(oldBobWrap, bob);
    const remove = entry('remove', bob, alice);
    const without = replayAccessLog(keys, [genesis, approveBob, remove]);
    expect(wrapsUnapprovedKey(before, without)).toBe(true);
    const sealed = sealVaultEntry(before, 'hunter2', [info(alice)], alice);
    expect(sealed.updatedAt).toBe(before.updatedAt);
    expect(sealed.cipher).not.toBe(before.cipher);
    expect(openVaultEntry(sealed, bob)).toBeUndefined();
    expect(wrapsUnapprovedKey(sealed, without)).toBe(false);
    // The re-seal used a fresh data key, so bob's old wrap — even if he had kept it — no longer opens
    // the new cipher.
    expect(() => decryptValue(sealed.cipher, oldDataKey, vaultEntryId(REF))).toThrow(WirebenchError);

    const after = valueFor('rotated', without);
    const marks = rotateMarks(
      new Map([
        ['A'.repeat(26), sealed],
        ['B'.repeat(26), after],
      ]),
      without,
    );
    expect(marks).toEqual([{ entryId: 'A'.repeat(26), label: 'Payments API key', secret: REF, removedNames: ['bob'] }]);
  });

  it('marks a value dated exactly at the removal', () => {
    const remove = entry('remove', bob, alice);
    const without = replayAccessLog(keys, [genesis, approveBob, remove]);
    const at = buildVaultEntry({
      secret: REF,
      label: 'Payments API key',
      value: 'hunter2',
      recipients: [info(alice)],
      signer: alice,
      at: remove.at,
    });
    const marks = rotateMarks(new Map([['C'.repeat(26), at]]), without);
    expect(marks).toEqual([{ entryId: 'C'.repeat(26), label: 'Payments API key', secret: REF, removedNames: ['bob'] }]);
  });

  it('skips a recipient with a malformed key when building or sealing, and still wraps the rest', () => {
    const bad: KeyInfo = { ...info(bob), keyId: carol.keyId, encryptionKey: Buffer.alloc(16).toString('base64url') };
    const written = buildVaultEntry({
      secret: REF,
      label: 'Payments API key',
      value: 'hunter2',
      recipients: [info(alice), bad],
      signer: alice,
      at: tick(),
    });
    expect(Object.keys(written.wraps)).toEqual([alice.keyId]);
    expect(openVaultEntry(written, alice)).toBe('hunter2');

    const resealed = sealVaultEntry(written, 'hunter2', [info(alice), bad], alice);
    expect(Object.keys(resealed.wraps)).toEqual([alice.keyId]);
    expect(openVaultEntry(resealed, alice)).toBe('hunter2');
  });

  it('heals nothing when the only missing recipient has a bad key: returns undefined, not a re-signed no-op', () => {
    const written = valueFor('hunter2', withBob);
    const bad: KeyInfo = { ...info(carol), encryptionKey: Buffer.alloc(16).toString('base64url') };
    const stateWithBad: AccessState = {
      ...withBob,
      approved: new Set([...withBob.approved, carol.keyId]),
      keys: new Map([...keys, [carol.keyId, bad]]),
    };
    expect(healVaultEntry(written, stateWithBad, alice)).toBeUndefined();
  });

  it('heals a good missing recipient while skipping a bad one, and still returns an entry', () => {
    const written = valueFor('hunter2', withBob);
    const dave = generateMachineKeys();
    const goodDave: KeyInfo = {
      keyId: dave.keyId,
      encryptionKey: dave.encryptionKey,
      signingKey: dave.signingKey,
      name: 'dave',
      email: 'dave@example.test',
      machine: 'dave',
      requestedAt: tick(),
      fingerprint: '',
    };
    const badCarol: KeyInfo = { ...info(carol), encryptionKey: Buffer.alloc(16).toString('base64url') };
    const stateWithBoth: AccessState = {
      ...withBob,
      approved: new Set([...withBob.approved, dave.keyId, carol.keyId]),
      keys: new Map([...keys, [dave.keyId, goodDave], [carol.keyId, badCarol]]),
    };
    const healed = healVaultEntry(written, stateWithBoth, alice)!;
    expect(healed).not.toBeUndefined();
    expect(Object.keys(healed.wraps).sort()).toEqual([alice.keyId, bob.keyId, dave.keyId].sort());
    expect(openVaultEntry(healed, dave)).toBe('hunter2');
  });
});

describe('vaultConflictWinner (§3.5)', () => {
  const at = (updatedAt: string, updatedBy: string): VaultEntryFile =>
    ({ updatedAt, updatedBy }) as unknown as VaultEntryFile;

  it('keeps the later value, the lower key id on a tie, and the side that still has the file', () => {
    expect(vaultConflictWinner(at('2026-09-26T10:00:01.000Z', 'B'), at('2026-09-26T10:00:00.000Z', 'A'))).toBe('mine');
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'A'), at('2026-09-26T10:00:01.000Z', 'B'))).toBe(
      'theirs',
    );
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'A'), at('2026-09-26T10:00:00.000Z', 'B'))).toBe('mine');
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'B'), at('2026-09-26T10:00:00.000Z', 'A'))).toBe(
      'theirs',
    );
    expect(vaultConflictWinner(undefined, at('2026-09-26T10:00:00.000Z', 'A'))).toBe('theirs');
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'A'), undefined)).toBe('mine');
  });
});
