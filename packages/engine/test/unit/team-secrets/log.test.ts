import { describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { generateMachineKeys, type MachineKeys } from '../../../src/team-secrets/keys.js';
import { nextAccessEntryId, replayAccessLog, verifiedKeys } from '../../../src/team-secrets/log.js';
import type { AccessAction, AccessEntryFile, KeyRequestFile } from '../../../src/team-secrets/schema.js';
import { signDocument } from '../../../src/team-secrets/sign.js';

let clock = Date.parse('2026-09-26T10:00:00.000Z');

function request(keys: MachineKeys, name: string): KeyRequestFile {
  return signDocument(
    {
      version: 1 as const,
      keyId: keys.keyId,
      encryptionKey: keys.encryptionKey,
      signingKey: keys.signingKey,
      name,
      email: `${name.toLowerCase()}@example.test`,
      machine: `${name.toLowerCase()}-laptop`,
      requestedAt: '2026-09-26T09:00:00.000Z',
    },
    keys,
  );
}

function entry(
  action: AccessAction,
  key: MachineKeys,
  by: MachineKeys,
  extra: { authority?: 'signed' | 'server' } = {},
): AccessEntryFile {
  clock += 1000;
  return signDocument(
    {
      version: 1 as const,
      id: ulid(clock),
      action,
      ...extra,
      key: key.keyId,
      by: by.keyId,
      at: new Date(clock).toISOString(),
    },
    by,
  );
}

const alice = generateMachineKeys();
const bob = generateMachineKeys();
const carol = generateMachineKeys();
const keys = verifiedKeys([request(alice, 'Alice'), request(bob, 'Bob'), request(carol, 'Carol')]);

describe('verifiedKeys', () => {
  it('keeps self-signed requests whose id matches their keys, with a fingerprint', () => {
    expect([...keys.keys()].sort()).toEqual([alice.keyId, bob.keyId, carol.keyId].sort());
    expect(keys.get(alice.keyId)?.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  });

  it('drops a request signed by another key, or naming another key id', () => {
    const forged = { ...request(bob, 'Bob'), name: 'Mallory' };
    const renamed = { ...request(bob, 'Bob'), keyId: alice.keyId };
    expect(verifiedKeys([forged, renamed]).size).toBe(0);
  });
});

describe('replayAccessLog (signed authority)', () => {
  it('is off without a genesis', () => {
    const state = replayAccessLog(keys, []);
    expect(state.on).toBe(false);
    expect(state.approved.size).toBe(0);
  });

  it('replays in ULID order whatever order the files are listed in', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'signed' });
    const approve = entry('approve', bob, alice);
    const grant = entry('grant-admin', bob, alice);
    const revoke = entry('revoke-admin', alice, bob);
    const state = replayAccessLog(keys, [revoke, grant, approve, genesis]);
    expect(state.authority).toBe('signed');
    expect([...state.approved].sort()).toEqual([alice.keyId, bob.keyId].sort());
    expect([...state.admins]).toEqual([bob.keyId]);
    expect(state.problems).toEqual([]);
  });

  it('ignores an approval signed by a non-admin, and one with a bad signature', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'signed' });
    const approveBob = entry('approve', bob, alice);
    const bobApprovesCarol = entry('approve', carol, bob);
    const tampered = { ...entry('approve', carol, alice), key: bob.keyId };
    const state = replayAccessLog(keys, [genesis, approveBob, bobApprovesCarol, tampered]);
    expect(state.approved.has(carol.keyId)).toBe(false);
    expect(state.problems).toEqual([
      { id: bobApprovesCarol.id, problem: 'not-allowed' },
      { id: tampered.id, problem: 'bad-signature' },
    ]);
  });

  it('removes a key for good and records when, and refuses to remove or revoke the last admin', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'signed' });
    const approve = entry('approve', bob, alice);
    const remove = entry('remove', bob, alice);
    const again = entry('approve', bob, alice);
    const lastRevoke = entry('revoke-admin', alice, alice);
    const lastRemove = entry('remove', alice, alice);
    const state = replayAccessLog(keys, [genesis, approve, remove, again, lastRevoke, lastRemove]);
    expect([...state.approved]).toEqual([alice.keyId]);
    expect(state.removed).toEqual([{ keyId: bob.keyId, at: remove.at, by: alice.keyId, entryId: remove.id }]);
    expect(state.problems.map((p) => p.problem)).toEqual(['removed-key', 'last-admin', 'last-admin']);
  });

  it('refuses a second genesis, and honours only the pinned one', () => {
    const first = entry('genesis', alice, alice, { authority: 'signed' });
    const second = entry('genesis', bob, bob, { authority: 'signed' });
    expect(replayAccessLog(keys, [first, second]).problems).toEqual([{ id: second.id, problem: 'second-genesis' }]);

    // A backdated genesis sorts first; the pin keeps the one this machine saw.
    clock -= 60_000;
    const backdated = entry('genesis', carol, carol, { authority: 'signed' });
    const pinned = replayAccessLog(keys, [first, backdated], { genesisId: first.id });
    expect(pinned.genesisId).toBe(first.id);
    expect(pinned.approved.has(carol.keyId)).toBe(false);
  });
});

describe('nextAccessEntryId', () => {
  it('sorts after every existing entry even when this clock is behind', () => {
    const later = ulid(Date.parse('2030-01-01T00:00:00.000Z'));
    const next = nextAccessEntryId([ulid(clock), later], clock);
    expect(next > later).toBe(true);
    expect(nextAccessEntryId([], clock) > ulid(clock - 1000)).toBe(true);
  });
});

describe('replayAccessLog (server authority)', () => {
  it('accepts an approval by any approved key, and has no admin entries', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'server' });
    const approveBob = entry('approve', bob, alice);
    const bobApprovesCarol = entry('approve', carol, bob);
    const grant = entry('grant-admin', bob, alice);
    const state = replayAccessLog(keys, [genesis, approveBob, bobApprovesCarol, grant]);
    expect([...state.approved].sort()).toEqual([alice.keyId, bob.keyId, carol.keyId].sort());
    expect(state.admins.size).toBe(0);
    expect(state.problems).toEqual([{ id: grant.id, problem: 'wrong-authority' }]);
  });
});
