import { describe, expect, it } from 'vitest';
import { ScimError } from '../../../src/sso/scim/errors.js';
import { parseFilter } from '../../../src/sso/scim/filter.js';
import { applyUserPatch, type UserState } from '../../../src/sso/scim/patch.js';

const USER_FILTERS = ['userName', 'externalId', 'emails.value'];

function scimTypeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ScimError) return error.scimType;
    throw error;
  }
  return 'accepted';
}

describe('parseFilter (saml-scim spec §3.5)', () => {
  it.each([
    ['userName eq "ada@example.com"', { attribute: 'userName', value: 'ada@example.com' }],
    ['USERNAME EQ "Ada@Example.com"', { attribute: 'userName', value: 'Ada@Example.com' }],
    ['externalId eq "00u1"', { attribute: 'externalId', value: '00u1' }],
    ['emails[type eq "work"].value eq "a@b.co"', { attribute: 'emails.value', value: 'a@b.co' }],
    ['emails.value eq "a@b.co"', { attribute: 'emails.value', value: 'a@b.co' }],
    ['userName eq "quo\\"te\\\\d"', { attribute: 'userName', value: 'quo"te\\d' }],
  ])('reads %s', (text, expected) => {
    expect(parseFilter(text, USER_FILTERS)).toEqual(expected);
  });

  it('reads no filter as none', () => {
    expect(parseFilter(undefined, USER_FILTERS)).toBeUndefined();
    expect(parseFilter('  ', USER_FILTERS)).toBeUndefined();
  });

  it.each([
    'userName co "ada"',
    'userName sw "ada"',
    'userName pr',
    'userName eq "a" and externalId eq "b"',
    'userName eq "a" or userName eq "b"',
    'not (userName eq "a")',
    'displayName eq "Ada"',
    'userName eq ada',
  ])('refuses %s as invalidFilter', (text) => {
    expect(scimTypeOf(() => parseFilter(text, USER_FILTERS))).toBe('invalidFilter');
  });
});

describe('applyUserPatch (saml-scim spec §3.5)', () => {
  const ada: UserState = { userName: 'ada@example.com', displayName: 'Ada', externalId: null, active: true };

  it('Entra: a replace per path, with "False" as a string', () => {
    expect(
      applyUserPatch(ada, [
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'Replace', path: 'displayName', value: 'Ada L.' },
      ]),
    ).toEqual({ ...ada, active: false, displayName: 'Ada L.' });
  });

  it('Entra: a replace without a path', () => {
    expect(applyUserPatch(ada, [{ op: 'replace', value: { active: 'True', displayName: 'A' } }])).toEqual({
      ...ada,
      displayName: 'A',
    });
  });

  it('Okta: replace { active: false }', () => {
    expect(applyUserPatch(ada, [{ op: 'replace', value: { active: false } }]).active).toBe(false);
  });

  it('add of externalId, and the work email path changes userName', () => {
    expect(
      applyUserPatch(ada, [
        { op: 'add', path: 'externalId', value: 'x-1' },
        { op: 'replace', path: 'emails[type eq "work"].value', value: 'ada@new.example' },
      ]),
    ).toEqual({ ...ada, externalId: 'x-1', userName: 'ada@new.example' });
  });

  it('remove of displayName falls back to the email’s local part; remove of externalId clears it', () => {
    expect(
      applyUserPatch({ ...ada, externalId: 'x' }, [
        { op: 'remove', path: 'displayName' },
        { op: 'remove', path: 'externalId' },
      ]),
    ).toEqual({ ...ada, displayName: 'ada', externalId: null });
  });

  it('name.formatted, with or without a path, is the display name', () => {
    expect(applyUserPatch(ada, [{ op: 'replace', path: 'name.formatted', value: 'Countess' }]).displayName).toBe(
      'Countess',
    );
    expect(applyUserPatch(ada, [{ op: 'replace', value: { name: { formatted: 'C' } } }]).displayName).toBe('C');
  });

  it('accepts and ignores schema attributes Wirebench does not keep', () => {
    expect(
      applyUserPatch(ada, [
        { op: 'add', path: 'title', value: 'Engineer' },
        { op: 'replace', path: 'name.givenName', value: 'Ada' },
        { op: 'add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'R&D' },
        { op: 'replace', value: { preferredLanguage: 'en', phoneNumbers: [] } },
      ]),
    ).toEqual(ada);
  });

  it.each([
    ['an unknown path', [{ op: 'replace', path: 'favouriteColour', value: 'red' }], 'invalidPath'],
    ['an unknown operation', [{ op: 'move', path: 'displayName', value: 'x' }], 'invalidSyntax'],
    ['a remove without a path', [{ op: 'remove' }], 'noTarget'],
    ['removing active', [{ op: 'remove', path: 'active' }], 'mutability'],
    ['a non-boolean active', [{ op: 'replace', path: 'active', value: 'maybe' }], 'invalidValue'],
  ])('refuses %s', (_name, operations, scimType) => {
    expect(scimTypeOf(() => applyUserPatch(ada, operations))).toBe(scimType);
  });
});
