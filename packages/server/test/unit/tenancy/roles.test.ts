import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appRoleGrants, READ_ONLY_TABLES } from '../../../src/tenancy/grants.js';
import {
  appRoleOf,
  roleMode,
  roleNameOf,
  saslprep,
  scramVerifier,
  SCRAM_ITERATIONS,
} from '../../../src/tenancy/roles.js';

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
      certificate: false,
    });
    expect(appRoleOf('postgres://app@db/wirebench?sslcert=/c.crt')).toEqual({ role: 'app', certificate: true });
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
  it('quotes every name, grants table by table in one block, and sets the default privileges', () => {
    const statements = appRoleGrants({ schema: 'we"ird', owner: 'own er', app: "o'app" });
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe(`grant usage on schema "we""ird" to "o'app"`);
    expect(statements[1]).toMatch(/^do \$grants\$\n[\s\S]*\n\$grants\$$/);
    expect(statements[1]).toContain(`where n.nspname = 'we"ird'`);
    expect(statements[1]).toContain(`'o''app'`);
    expect(statements[1]).toContain(`array['schema_migrations', 'server_identity']::text[]`);
    expect(statements[1]).toContain(`'grant select on %I.%I to %I'`);
    expect(statements[1]).toContain(`'revoke insert, update, delete, truncate on %I.%I from %I'`);
    expect(statements[1]).toContain(`'grant select, insert, update, delete on %I.%I to %I'`);
    expect(statements[2]).toBe(
      `alter default privileges for role "own er" in schema "we""ird" grant select, insert, update, delete on tables to "o'app"`,
    );
    expect(READ_ONLY_TABLES).toEqual(['schema_migrations', 'server_identity']);
    expect(statements.join('\n')).not.toMatch(/\bexecute on\b|\bcreate on\b|\bon all tables\b/);
  });

  it('refuses a name with a "$", which could end the block', () => {
    for (const names of [
      { schema: 's$grants$', owner: 'o', app: 'a' },
      { schema: 's', owner: 'o', app: 'a$' },
    ]) {
      expect(() => appRoleGrants(names)).toThrow(expect.objectContaining({ code: 'tenancy-role-name-invalid' }));
    }
  });
});

describe('saslprep (RFC 4013, as pg and PostgreSQL apply it)', () => {
  it('maps non-ASCII spaces to a space, drops the mapped-to-nothing characters, and NFKC-normalises', () => {
    expect(saslprep('\uFB01')).toBe('fi');
    expect(saslprep('a\u00A0b\u3000c')).toBe('a b c');
    expect(saslprep('soft\u00ADhyphen\u200D')).toBe('softhyphen');
    expect(saslprep('caf\u0065\u0301')).toBe('caf\u00E9');
    expect(saslprep('\uFF21')).toBe('A');
    expect(saslprep('plain-ascii-0019')).toBe('plain-ascii-0019');
  });

  it('builds the verifier from the prepared password', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    expect(scramVerifier('\uFB01', salt)).toBe(scramVerifier('fi', salt));
    expect(scramVerifier('a\u00A0b', salt)).toBe(scramVerifier('a b', salt));
  });
});

describe('roleMode', () => {
  const app = 'postgres://wirebench_app:a@db/wirebench';
  const owner = 'postgres://wirebench:o@db/wirebench';
  it('is one role with no migration URL, the same URL, or two URLs naming one role', () => {
    expect(roleMode({ databaseUrl: app })).toBe('one-role');
    expect(roleMode({ databaseUrl: 'host=db user=x', migrationDatabaseUrl: 'host=db user=x' })).toBe('one-role');
    expect(roleMode({ databaseUrl: owner, migrationDatabaseUrl: 'postgres://wirebench:o@direct-db/wirebench' })).toBe(
      'one-role',
    );
    expect(roleMode({ databaseUrl: app, migrationDatabaseUrl: owner })).toBe('two-roles');
  });
  it('refuses a keyword string beside a different migration URL, naming the variable', () => {
    expect(() => roleMode({ databaseUrl: app, migrationDatabaseUrl: 'host=db user=wirebench' })).toThrow(
      /WIREBENCH_SERVER_MIGRATION_DATABASE_URL must be a postgres:\/\/ URL/,
    );
    expect(() => roleMode({ databaseUrl: 'host=db user=app', migrationDatabaseUrl: owner })).toThrow(
      /WIREBENCH_SERVER_DATABASE_URL must be a postgres:\/\/ URL/,
    );
  });
});
