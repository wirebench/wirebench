import { describe, expect, it } from 'vitest';
import { ScimError } from '../../../src/sso/scim/errors.js';
import { applyGroupPatch, type GroupState } from '../../../src/sso/scim/group-patch.js';

const group = (members: string[] = []): GroupState => ({
  displayName: 'Eng',
  externalId: null,
  members: new Set(members),
});
const membersOf = (state: GroupState) => [...state.members].sort();

function scimTypeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ScimError) return error.scimType;
    throw error;
  }
  return 'accepted';
}

describe('applyGroupPatch (saml-scim spec §3.5)', () => {
  it('adds members from a value list', () => {
    expect(membersOf(applyGroupPatch(group(['a']), [{ op: 'Add', path: 'members', value: [{ value: 'b' }] }]))).toEqual(
      ['a', 'b'],
    );
  });

  it('removes a member by the members[value eq "…"] path (Entra)', () => {
    expect(membersOf(applyGroupPatch(group(['a', 'b']), [{ op: 'Remove', path: 'members[value eq "a"]' }]))).toEqual([
      'b',
    ]);
  });

  it('removes members by a value list (Okta), and every member with no value', () => {
    expect(
      membersOf(
        applyGroupPatch(group(['a', 'b', 'c']), [
          { op: 'remove', path: 'members', value: [{ value: 'a' }, { value: 'c' }] },
        ]),
      ),
    ).toEqual(['b']);
    expect(membersOf(applyGroupPatch(group(['a', 'b']), [{ op: 'remove', path: 'members' }]))).toEqual([]);
  });

  it('replaces members, and displayName with or without a path', () => {
    const next = applyGroupPatch(group(['a']), [
      { op: 'replace', path: 'members', value: [{ value: 'z' }] },
      { op: 'replace', value: { id: 'ignored', displayName: 'Platform' } },
    ]);
    expect(membersOf(next)).toEqual(['z']);
    expect(next.displayName).toBe('Platform');
  });

  it.each([
    ['an unknown path', [{ op: 'replace', path: 'colour', value: 'x' }], 'invalidPath'],
    ['an add with a member filter', [{ op: 'add', path: 'members[value eq "a"]' }], 'invalidPath'],
    ['a member without a value', [{ op: 'add', path: 'members', value: [{ display: 'x' }] }], 'invalidValue'],
    ['an empty displayName', [{ op: 'replace', path: 'displayName', value: ' ' }], 'invalidValue'],
    ['an unknown op', [{ op: 'copy', path: 'members' }], 'invalidSyntax'],
  ])('refuses %s', (_name, operations, scimType) => {
    expect(scimTypeOf(() => applyGroupPatch(group(), operations))).toBe(scimType);
  });
});
