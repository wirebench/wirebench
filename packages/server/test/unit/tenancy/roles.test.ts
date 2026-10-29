import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appRoleGrants, READ_ONLY_TABLES } from '../../../src/tenancy/grants.js';
import { appRoleOf, roleNameOf, scramVerifier, SCRAM_ITERATIONS } from '../../../src/tenancy/roles.js';

describe('scramVerifier', () => {
  it('is PostgreSQL’s stored form, and never carries the password', () => {
    const verifier = scramVerifier('pencil-and-paper');
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(verifier).not.toContain('pencil');
    expect(scramVerifier('pencil-and-paper')).not.toBe(verifier); // a fresh salt each time
  });

  it('holds StoredKey = H(HMAC(SaltedPassword, "Client Key")) and ServerKey = HMAC(SaltedPassword, "Server Key")', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const salted = pbkdf2Sync('pencil', salt, SCRAM_ITERATIONS, 32, 'sha256');
    const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest());
    const server = createHmac('sha256', salted).update('Server Key');
    expect(scramVerifier('pencil', salt)).toBe(
      `SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$${stored.digest('base64')}:${server.digest('base64')}`,
    );
  });
});

describe('the app URL', () => {
  it('names the role and its password, decoded', () => {
    expect(appRoleOf('postgres://wirebench_app:p%40ss@db:5432/wirebench')).toEqual({
      role: 'wirebench_app',
      password: 'p@ss',
    });
    expect(appRoleOf('postgres://app@db/wirebench')).toEqual({ role: 'app' });
    expect(roleNameOf('postgres://My%20Role:x@db/w')).toBe('My Role');
    expect(roleNameOf('host=db user=x')).toBeUndefined();
  });

  it('refuses a URL with no user, without echoing it', () => {
    expect(() => appRoleOf('postgres://db/s3cret')).toThrow(
      expect.objectContaining({ code: 'tenancy-app-url-invalid' }),
    );
    expect(() => appRoleOf('host=db password=s3cret')).toThrow(
      expect.objectContaining({
        code: 'tenancy-app-url-invalid',
        message: expect.not.stringContaining('s3cret') as unknown,
      }),
    );
  });
});

describe('appRoleGrants', () => {
  it('quotes every name, grants on all tables and by default, and narrows the read-only tables', () => {
    const statements = appRoleGrants({ schema: 'we"ird', owner: 'own er', app: "o'app" });
    expect(statements[0]).toBe(`grant usage on schema "we""ird" to "o'app"`);
    expect(statements[1]).toBe(`grant select, insert, update, delete on all tables in schema "we""ird" to "o'app"`);
    expect(statements[2]).toBe(
      `alter default privileges for role "own er" in schema "we""ird" grant select, insert, update, delete on tables to "o'app"`,
    );
    expect(statements[3]).toContain(`'we"ird'`);
    expect(statements[3]).toContain(`'o''app'`);
    for (const table of READ_ONLY_TABLES) expect(statements[3]).toContain(`'${table}'`);
    expect(statements.join('\n')).not.toMatch(/\bexecute on\b|\bcreate on\b/);
  });
});
