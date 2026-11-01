import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseServerArgs, UsageError } from '../../src/args.js';

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

  it('parses admin schedules list, enable, disable and runs, with --workspace and --limit where they apply', () => {
    expect(parseServerArgs(['admin', 'schedules', 'list'])).toEqual({ command: 'admin-schedules-list' });
    expect(parseServerArgs(['admin', 'schedules', 'list', '--workspace', 'W1'])).toEqual({
      command: 'admin-schedules-list',
      workspace: 'W1',
    });
    expect(parseServerArgs(['admin', 'schedules', 'enable', 'S1'])).toEqual({
      command: 'admin-schedules-enable',
      id: 'S1',
    });
    expect(parseServerArgs(['admin', 'schedules', 'disable', 'S1'])).toEqual({
      command: 'admin-schedules-disable',
      id: 'S1',
    });
    expect(parseServerArgs(['admin', 'schedules', 'runs', 'S1'])).toEqual({
      command: 'admin-schedules-runs',
      id: 'S1',
      limit: 50,
    });
    expect(parseServerArgs(['admin', 'schedules', 'runs', 'S1', '--limit', '200'])).toEqual({
      command: 'admin-schedules-runs',
      id: 'S1',
      limit: 200,
    });
    for (const bad of ['0', '201', '2.5', 'many']) {
      expect(() => parseServerArgs(['admin', 'schedules', 'runs', 'S1', '--limit', bad])).toThrow(
        /--limit must be a whole number from 1 to 200/,
      );
    }
    expect(() => parseServerArgs(['admin', 'schedules', 'enable'])).toThrow(/usage: wirebench-server admin schedules/);
    expect(() => parseServerArgs(['admin', 'schedules'])).toThrow(/\| runs <id> \[--limit <n>\]/);
    expect(() => parseServerArgs(['admin', 'schedules', 'list', '--limit', '5'])).toThrow(
      /--limit applies to admin schedules runs only/,
    );
    expect(() => parseServerArgs(['admin', 'schedules', 'runs', 'S1', '--workspace', 'W1'])).toThrow(/--workspace/);
    expect(() => parseServerArgs(['admin', 'license', 'show', '--workspace', 'W1'])).toThrow(/--workspace/);
  });
});

describe('admin tenancy role (hosted spec §19.4)', () => {
  it('parses the command and its --print-sql flag', () => {
    expect(parseServerArgs(['admin', 'tenancy', 'role'])).toEqual({ command: 'admin-tenancy-role', printSql: false });
    expect(parseServerArgs(['admin', 'tenancy', 'role', '--print-sql'])).toEqual({
      command: 'admin-tenancy-role',
      printSql: true,
    });
  });
  it('refuses another tenancy sub-command, and --print-sql anywhere else', () => {
    expect(() => parseServerArgs(['admin', 'tenancy'])).toThrow(/usage: wirebench-server admin tenancy role/);
    expect(() => parseServerArgs(['admin', 'tenancy', 'revert'])).toThrow(/usage: wirebench-server admin tenancy role/);
    expect(() => parseServerArgs(['migrate', '--print-sql'])).toThrow(/--print-sql applies to admin tenancy role only/);
  });
});

describe('admin tenancy check and status (hosted spec §19.10, §19.11)', () => {
  it('parses both, with nothing after them', () => {
    expect(parseServerArgs(['admin', 'tenancy', 'check'])).toEqual({ command: 'admin-tenancy-check' });
    expect(parseServerArgs(['admin', 'tenancy', 'status'])).toEqual({ command: 'admin-tenancy-status' });
    expect(() => parseServerArgs(['admin', 'tenancy', 'check', 'extra'])).toThrow(
      /usage: wirebench-server admin tenancy/,
    );
    expect(() => parseServerArgs(['admin', 'tenancy', 'status', '--tenant', 'acme'])).toThrow(/--tenant/);
  });
  it('lists both in the help', () => {
    expect(HELP_TEXT).toContain('wirebench-server admin tenancy check');
    expect(HELP_TEXT).toContain('wirebench-server admin tenancy status');
  });
});

describe('--tenant (hosted spec §19.11)', () => {
  it('rides on every admin command but tenancy role', () => {
    const cases: [string[], string][] = [
      [['admin', 'invite', 'a@example.com'], 'admin-invite'],
      [['admin', 'list-invitations'], 'admin-list-invitations'],
      [['admin', 'revoke-invitation', 'I1'], 'admin-revoke-invitation'],
      [['admin', 'license', 'show'], 'admin-license-show'],
      [['admin', 'license', 'install', 'f.lic'], 'admin-license-install'],
      [['admin', 'license', 'remove'], 'admin-license-remove'],
      [['admin', 'audit', 'export'], 'admin-audit-export'],
      [['admin', 'audit', 'verify'], 'admin-audit-verify'],
      [['admin', 'schedules', 'list'], 'admin-schedules-list'],
      [['admin', 'schedules', 'enable', 'S1'], 'admin-schedules-enable'],
      [['admin', 'schedules', 'disable', 'S1'], 'admin-schedules-disable'],
      [['admin', 'schedules', 'runs', 'S1'], 'admin-schedules-runs'],
      [['admin', 'scim-token', 'create', 'idp'], 'admin-scim-token-create'],
      [['admin', 'scim-token', 'list'], 'admin-scim-token-list'],
      [['admin', 'scim-token', 'revoke', 'K1'], 'admin-scim-token-revoke'],
      [['admin', 'scim-group', 'list'], 'admin-scim-group-list'],
      [['admin', 'scim-group', 'link', 'G', 'T'], 'admin-scim-group-link'],
      [['admin', 'scim-group', 'unlink', 'G'], 'admin-scim-group-unlink'],
    ];
    for (const [args, command] of cases) {
      expect(parseServerArgs([...args, '--tenant', 'acme']), args.join(' ')).toMatchObject({ command, tenant: 'acme' });
      expect(parseServerArgs(args), args.join(' ')).not.toHaveProperty('tenant');
    }
  });

  it('refuses it outside the admin commands, on tenancy role, and with a value that is no slug', () => {
    expect(() => parseServerArgs(['serve', '--tenant', 'acme'])).toThrow(UsageError);
    expect(() => parseServerArgs(['migrate', '--tenant', 'acme'])).toThrow(/--tenant applies to the admin commands/);
    expect(() => parseServerArgs(['admin', 'tenancy', 'role', '--tenant', 'acme'])).toThrow(/not to admin tenancy/);
    for (const slug of ['Acme', '-acme', 'acme-', 'ac me', '', 'x'.repeat(41)]) {
      expect(() => parseServerArgs(['admin', 'list-invitations', '--tenant', slug]), slug).toThrow(UsageError);
    }
  });
});
