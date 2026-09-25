import { describe, expect, it } from 'vitest';
import { parseServerArgs, UsageError } from '../../src/args.js';

describe('parseServerArgs', () => {
  it('defaults to serve', () => {
    expect(parseServerArgs([])).toEqual({ command: 'serve' });
    expect(parseServerArgs(['serve'])).toEqual({ command: 'serve' });
  });
  it('parses migrate and its --check flag', () => {
    expect(parseServerArgs(['migrate'])).toEqual({ command: 'migrate', check: false });
    expect(parseServerArgs(['migrate', '--check'])).toEqual({ command: 'migrate', check: true });
  });
  it('parses config check, help and version', () => {
    expect(parseServerArgs(['config', 'check'])).toEqual({ command: 'config-check' });
    expect(parseServerArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseServerArgs(['--version'])).toEqual({ command: 'version' });
  });
  it('rejects unknown commands and flags', () => {
    expect(() => parseServerArgs(['frobnicate'])).toThrow(UsageError);
    expect(() => parseServerArgs(['serve', '--port'])).toThrow(UsageError);
    expect(() => parseServerArgs(['serve', '--check'])).toThrow(UsageError);
    expect(() => parseServerArgs(['config'])).toThrow(UsageError);
  });
});

describe('admin commands (§3.7)', () => {
  it('parses invite, list-invitations and revoke-invitation', () => {
    expect(parseServerArgs(['admin', 'invite', 'alice@example.com'])).toEqual({
      command: 'admin-invite',
      email: 'alice@example.com',
      serverAdmin: true,
    });
    expect(parseServerArgs(['admin', 'invite', 'alice@example.com', '--no-admin'])).toEqual({
      command: 'admin-invite',
      email: 'alice@example.com',
      serverAdmin: false,
    });
    expect(parseServerArgs(['admin', 'list-invitations'])).toEqual({ command: 'admin-list-invitations' });
    expect(parseServerArgs(['admin', 'revoke-invitation', '01J8Z'])).toEqual({
      command: 'admin-revoke-invitation',
      id: '01J8Z',
    });
  });
  it('refuses a missing email or id, an unknown sub-command, and --no-admin elsewhere', () => {
    expect(() => parseServerArgs(['admin', 'invite'])).toThrow(/usage: wirebench-server admin invite <email>/);
    expect(() => parseServerArgs(['admin', 'revoke-invitation'])).toThrow(/usage/);
    expect(() => parseServerArgs(['admin', 'frobnicate'])).toThrow(/unknown admin command/);
    expect(() => parseServerArgs(['serve', '--no-admin'])).toThrow(/--no-admin only applies to admin invite/);
  });
});
