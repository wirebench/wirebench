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
  it('parses admin license install, show and remove', () => {
    expect(parseServerArgs(['admin', 'license', 'install', 'team.lic'])).toEqual({
      command: 'admin-license-install',
      file: 'team.lic',
    });
    expect(parseServerArgs(['admin', 'license', 'show'])).toEqual({ command: 'admin-license-show' });
    expect(parseServerArgs(['admin', 'license', 'remove'])).toEqual({ command: 'admin-license-remove' });
    expect(() => parseServerArgs(['admin', 'license', 'install'])).toThrow(/admin license install <file>/);
    expect(() => parseServerArgs(['admin', 'license'])).toThrow(/install <file> \| show \| remove/);
  });

  it('parses admin audit export with its four options', () => {
    expect(parseServerArgs(['admin', 'audit', 'export'])).toEqual({ command: 'admin-audit-export' });
    expect(
      parseServerArgs([
        'admin',
        'audit',
        'export',
        '--from',
        '2026-10-01T00:00:00Z',
        '--to',
        '2026-11-01T00:00:00Z',
        '--action',
        'auth.',
        '--workspace',
        'W1',
      ]),
    ).toEqual({
      command: 'admin-audit-export',
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      action: 'auth.',
      workspace: 'W1',
    });
    expect(() => parseServerArgs(['admin', 'audit'])).toThrow(/usage: wirebench-server admin audit export/);
    expect(() => parseServerArgs(['admin', 'audit', 'export', '--from', 'yesterday'])).toThrow(/ISO 8601/);
    expect(() => parseServerArgs(['admin', 'license', 'show', '--from', 'x'])).toThrow(/--from/);
  });

  it('parses admin audit verify with --head and --json, and names the flag on a bad head', () => {
    const hex = 'ab'.repeat(32);
    expect(parseServerArgs(['admin', 'audit', 'verify'])).toEqual({ command: 'admin-audit-verify', json: false });
    expect(parseServerArgs(['admin', 'audit', 'verify', '--json', '--head', `42:${hex.toUpperCase()}`])).toEqual({
      command: 'admin-audit-verify',
      head: { seq: 42n, hash: hex },
      json: true,
    });
    for (const bad of [
      '42',
      `0:${hex}`,
      `-1:${hex}`,
      `42:${hex.slice(2)}`,
      `42:${'zz'.repeat(32)}`,
      `9223372036854775808:${hex}`,
    ]) {
      expect(() => parseServerArgs(['admin', 'audit', 'verify', `--head=${bad}`])).toThrow(
        /--head must be <seq>:<hex>/,
      );
    }
    expect(() => parseServerArgs(['admin', 'audit', 'export', '--json'])).toThrow(
      /--json applies to admin audit verify only/,
    );
    expect(() => parseServerArgs(['admin', 'audit', 'verify', '--from', '2026-10-01T00:00:00Z'])).toThrow(/--from/);
    expect(() => parseServerArgs(['admin', 'audit', 'frobnicate'])).toThrow(/\| verify \[--head <seq>:<hex>\]/);
  });
});
