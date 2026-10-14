import { describe, expect, it } from 'vitest';
import type { HostsFileWire } from '../../src/shared/ssh-wire.js';
import {
  chainOf,
  initialGroup,
  missingFields,
  passwordSecretName,
  type SaveCheck,
} from '../../src/renderer/features/ssh/host-form-model.js';
import { sourceText } from '../../src/renderer/features/ssh/inherited-field.js';

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'prod',
      name: 'Production',
      tags: [],
      ssh: { user: 'deploy' },
      groups: [{ id: 'eu', name: 'EU', tags: [], ssh: {}, groups: [], hosts: [] }],
      hosts: [],
    },
  ],
  hosts: [],
};

const NEW_HOST: SaveCheck = {
  isHost: true,
  needsLogin: true,
  name: 'web',
  address: 'web.example',
  user: 'me',
  inheritedUser: undefined,
  auth: { kind: 'password', secret: '' },
  inheritedAuth: undefined,
  password: 'pw',
  sectionProblems: [],
};

describe('missingFields', () => {
  it('a complete new host has nothing missing', () => {
    expect(missingFields(NEW_HOST)).toEqual([]);
  });

  it('lists every gap in the order the form shows the fields', () => {
    expect(missingFields({ ...NEW_HOST, name: ' ', address: '', user: undefined, password: '' })).toEqual([
      'Name is required',
      'Address is required',
      'User is required',
      'Password is required',
    ]);
  });

  it('a user or a way to sign in supplied by the group is enough', () => {
    expect(
      missingFields({
        ...NEW_HOST,
        user: undefined,
        inheritedUser: 'deploy',
        auth: undefined,
        inheritedAuth: { kind: 'agent' },
      }),
    ).toEqual([]);
  });

  it('a new host with no way to sign in asks for one; a saved secret stands for a typed password', () => {
    expect(missingFields({ ...NEW_HOST, auth: undefined })).toEqual(['Choose how to sign in']);
    expect(missingFields({ ...NEW_HOST, auth: { kind: 'password', secret: 'web_pw' }, password: '' })).toEqual([]);
    expect(missingFields({ ...NEW_HOST, auth: { kind: 'key', secret: '' } })).toEqual(['Choose a private key']);
  });

  it('an edited host or a group does not need a user or a way to sign in, but a chosen password needs one', () => {
    const loose = { ...NEW_HOST, needsLogin: false, user: undefined, auth: undefined, password: '' };
    expect(missingFields(loose)).toEqual([]);
    expect(missingFields({ ...loose, isHost: false, address: '' })).toEqual([]);
    expect(missingFields({ ...loose, auth: { kind: 'password', secret: '' } })).toEqual(['Password is required']);
  });

  it("appends the Advanced sections' problems", () => {
    expect(missingFields({ ...NEW_HOST, sectionProblems: ['Font size must be a whole number from 8 to 32'] })).toEqual([
      'Font size must be a whole number from 8 to 32',
    ]);
  });
});

describe('passwordSecretName', () => {
  it('is <id>_password, made a valid secret name', () => {
    expect(passwordSecretName('web', [])).toBe('web_password');
    expect(passwordSecretName('web-1', [])).toBe('web_1_password');
    expect(passwordSecretName('1box', [])).toBe('_1box_password');
  });

  it('never takes a name already in use', () => {
    expect(passwordSecretName('web', ['web_password'])).toBe('web_password_2');
    expect(passwordSecretName('web', ['web_password', 'web_password_2'])).toBe('web_password_3');
  });
});

describe('initialGroup', () => {
  it('prefers the group the dialog was opened from, then the active chip, else the top level', () => {
    expect(initialGroup(FILE, 'eu', 'prod')).toBe('eu');
    expect(initialGroup(FILE, undefined, 'prod')).toBe('prod');
    expect(initialGroup(FILE, undefined, undefined)).toBeUndefined();
  });

  it('a group that is gone means the top level', () => {
    expect(initialGroup(FILE, undefined, 'gone')).toBeUndefined();
  });
});

describe('chainOf', () => {
  it('is the group and the groups around it, outermost first', () => {
    expect(chainOf(FILE, 'eu').map((g) => g.id)).toEqual(['prod', 'eu']);
    expect(chainOf(FILE, undefined)).toEqual([]);
  });
});

describe('sourceText', () => {
  it('shows the value with where it comes from', () => {
    expect(sourceText({ value: 22, from: 'default' })).toBe('22 · default');
    expect(sourceText({ value: 'deploy', from: { group: 'Production' } })).toBe('deploy · from Production');
    expect(sourceText({ value: true, from: 'default' }, (v) => (v ? 'on' : 'off'))).toBe('on · default');
    expect(sourceText({ value: undefined, from: 'default' })).toBeUndefined();
  });
});
