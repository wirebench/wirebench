/**
 * Slice 7 Task 19 (hosted edition spec §22.9): every scoped table is classified for the export. The catalog is the
 * list: a table the forced policy holds that `EXPORT_TABLES` does not name fails here, as an unclassified route fails
 * the route map, and so does a classified table that no longer exists or a redacted column that is gone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EXPORT_TABLES, exportedTables } from '../../../src/control-plane/export/tables.js';
import { SCOPED_TABLES } from '../../helpers/catalog.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';

describeDb('the export classification (spec §22.9)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const forcedTables = async (): Promise<string[]> =>
    (
      await db.owner.query<{ table: string }>(
        `select relname as table from pg_class
          where relnamespace = to_regnamespace(current_schema()) and relkind = 'r' and relforcerowsecurity
          order by 1`,
      )
    ).rows.map((row) => row.table);

  it('classifies every table the forced policy holds, and nothing else', async () => {
    const forced = await forcedTables();
    const unclassified = forced.filter((table) => !(table in EXPORT_TABLES));
    expect(unclassified, 'scoped tables missing from control-plane/export/tables.ts').toEqual([]);
    expect(Object.keys(EXPORT_TABLES).sort()).toEqual(forced);
    expect([...SCOPED_TABLES].sort()).toEqual(forced);
  });

  it('redacts only columns that exist, and every sealed value', async () => {
    const columns = await db.owner.query<{ table: string; column: string }>(
      `select c.relname as table, a.attname as column from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relnamespace = to_regnamespace(current_schema()) and a.attnum > 0 and not a.attisdropped`,
    );
    const has = new Set(columns.rows.map((row) => `${row.table}.${row.column}`));
    for (const [table, cls] of Object.entries(EXPORT_TABLES)) {
      if (cls.kind !== 'redact') continue;
      for (const column of Object.keys(cls.columns)) expect(has, `${table}.${column}`).toContain(`${table}.${column}`);
    }
    const redacted = (table: string) => {
      const cls = EXPORT_TABLES[table];
      return cls?.kind === 'redact' ? Object.keys(cls.columns) : [];
    };
    // The sealed values of spec §22.9, and the short-lived and control-plane tables it skips.
    expect(redacted('catch_urls')).toContain('signature_secret');
    expect(redacted('schedules')).toEqual(expect.arrayContaining(['secrets', 'alerts']));
    expect(redacted('tenant_settings')).toEqual(['sealed']);
    for (const table of [
      'oidc_flows',
      'browser_flows',
      'saml_flows',
      'device_tokens',
      'agent_pairing_codes',
      'agent_nonces',
      'host_leases',
      'limiter_buckets',
      'send_slots',
      'terminal_share_locations',
      'audit_forward_queue',
      'subscriptions',
      'tenant_exports',
    ]) {
      expect(EXPORT_TABLES[table]?.kind, table).toBe('skip');
    }
    expect(exportedTables()).toContain('audit_events');
    expect(exportedTables()).toContain('audit_chain_anchor');
  });

  it('gives every exported table a unique key, so an import resumed after a crash inserts nothing twice', async () => {
    const keyed = await db.owner.query<{ table: string }>(
      `select distinct c.relname as table from pg_index i join pg_class c on c.oid = i.indrelid
        where c.relnamespace = to_regnamespace(current_schema()) and i.indisunique`,
    );
    const tables = new Set(keyed.rows.map((row) => row.table));
    expect(exportedTables().filter((table) => !tables.has(table))).toEqual([]);
  });
});
