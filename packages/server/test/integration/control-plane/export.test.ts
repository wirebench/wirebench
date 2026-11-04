/**
 * Slice 7 Task 20 (hosted edition spec §22.9): a tenant's export. The archive holds the manifest, the tables and the
 * bundles and nothing else: no sealed value, no session, no checkout. Every checksum in the manifest matches what is
 * in the archive, an empty repository has no bundle, one export runs per tenant, three are kept, they expire after
 * seven days, and the requester is mailed a link to the settings screen.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ExportManifest } from '../../../src/control-plane/export/export.js';
import { EXPORT_DAYS } from '../../../src/control-plane/export/runner.js';
import { recordAudit, SYSTEM_SOURCE } from '../../../src/context.js';
import { readTarGz } from '../../../src/control-plane/export/tar.js';
import type { ControlMail } from '../../../src/control-plane/mail.js';
import { tenantRoot } from '../../../src/tenancy/paths.js';
import { describeDb } from '../../helpers/database.js';
import { describeGit } from '../../helpers/git.js';
import { CHAIN_KEY, exportFixture, SEALED_MARKERS, type ExportFixture } from './export-fixture.js';

/** Each suite's set-up builds servers and repositories: under load that is past the 10 s default. */
const SETUP_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;

async function entriesOf(path: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  for await (const entry of readTarGz(path)) entries.set(entry.name, await entry.buffer());
  return entries;
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describeDb('a tenant export (spec §22.9)', () => {
  describeGit('the archive', () => {
    let x: ExportFixture;
    beforeEach(async () => {
      x = await exportFixture();
    }, SETUP_MS);
    afterEach(() => x.f.h.close(), SETUP_MS);

    it('holds the manifest, the tables and the bundles, and no sealed value, session or checkout', async () => {
      // A checkout with a user's sealed secrets, which no export reads.
      const checkout = join(tenantRoot(x.f.h.dataDir, x.scope), 'checkouts', x.f.admin.user.id);
      await mkdir(checkout, { recursive: true });
      await writeFile(join(checkout, 'secrets.json'), '{"x":"SEALED-CHECKOUT"}');
      const runner = x.runner();
      const queued = await runner.request(x.scope, x.f.admin.user.id);
      const done = await runner.runNext(x.scope);
      expect(done).toMatchObject({ id: queued.id, status: 'ready' });
      const path = runner.path(x.scope, queued.id);
      const entries = await entriesOf(path);
      for (const name of entries.keys())
        expect(name).toMatch(/^(manifest\.json|tables\/[a-z_]+\.ndjson|repos\/[0-9A-Z]{26}\.bundle)$/);
      for (const skipped of ['device_tokens', 'oidc_flows', 'browser_flows', 'audit_forward_queue', 'tenant_exports']) {
        expect(entries.has(`tables/${skipped}.ndjson`), skipped).toBe(false);
      }
      const raw = gunzipSync(await readFile(path)).toString('latin1');
      for (const marker of [...SEALED_MARKERS, 'SEALED-CHECKOUT']) {
        expect(raw.includes(marker), marker).toBe(false);
        expect(raw.includes(Buffer.from(marker).toString('base64').slice(0, 16)), `${marker} in base64`).toBe(false);
      }
      expect(raw.includes(x.f.admin.token)).toBe(false);
      // A catch URL's own secret is its address: never exported either.
      expect(raw.includes('C'.repeat(26))).toBe(false);
      // The redacted rows are still there, without what was sealed.
      const catchUrl = JSON.parse(entries.get('tables/catch_urls.ndjson')!.toString().trim()) as Record<
        string,
        unknown
      >;
      expect(catchUrl).toMatchObject({
        id: x.catchUrlId,
        secret: '',
        signature: null,
        signature_secret: null,
        reject_unverified: false,
      });
      expect(catchUrl).not.toHaveProperty('tenant_id');
      const schedule = JSON.parse(entries.get('tables/schedules.ndjson')!.toString().trim()) as Record<string, string>;
      expect(JSON.parse(schedule.secrets!)).toEqual({});
      expect(JSON.parse(schedule.alerts!)).toEqual({ targets: [], muteAfter: 3 });
      // People sign in after an import: password hashes travel.
      expect(entries.get('tables/local_credentials.ndjson')!.toString()).toContain('test-password-hash');
    });

    it('records every checksum, the bundles, what was left out and the audit chain block', async () => {
      // An event not sealed yet: left out, and counted.
      await x.f.h.tdb.transaction((tx) =>
        recordAudit(x.f.h.hooks, tx, {
          ...SYSTEM_SOURCE,
          action: 'audit.verified',
          target: { kind: 'server' },
          details: { marker: 'UNSEALED-EVENT' },
        }),
      );
      const runner = x.runner();
      const queued = await runner.request(x.scope, 'operator');
      const done = await runner.runNext(x.scope);
      const path = runner.path(x.scope, queued.id);
      const file = await readFile(path);
      expect(done).toMatchObject({ sizeBytes: file.length, sha256: sha(file) });
      const entries = await entriesOf(path);
      const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as ExportManifest;
      expect(manifest).toMatchObject({ format: 1, version: '0.0.0-test', tenant: { id: x.scope.tenantId } });
      for (const [table, info] of Object.entries(manifest.tables)) {
        const body = entries.get(`tables/${table}.ndjson`);
        expect(body, table).toBeDefined();
        expect(sha(body!), table).toBe(info.sha256);
        expect(body!.toString().split('\n').filter(Boolean)).toHaveLength(info.rows);
      }
      expect(manifest.tables.users!.rows).toBe(4);
      expect(manifest.workspaces[x.emptyWorkspace]).toEqual({ bundle: null, bytes: null });
      for (const [table, info] of Object.entries(manifest.tables)) {
        expect(entries.get(`tables/${table}.ndjson`)!.length, table).toBe(info.bytes);
      }
      const bundle = entries.get(`repos/${x.pushedWorkspace}.bundle`)!;
      expect(sha(bundle)).toBe(manifest.workspaces[x.pushedWorkspace]!.bundle);
      expect(bundle.length).toBe(manifest.workspaces[x.pushedWorkspace]!.bytes);
      expect(bundle.toString('latin1')).toContain(`${x.head} refs/heads/main`);
      expect(manifest.omitted).toEqual(
        expect.arrayContaining([
          { table: 'catch_urls', id: x.catchUrlId, what: 'catch URL secret' },
          { table: 'catch_urls', id: x.catchUrlId, what: 'signature secret' },
          { table: 'schedules', id: x.scheduleId, what: 'schedule secrets' },
          { table: 'schedules', id: x.scheduleId, what: 'alert targets' },
          { table: 'tenant_settings', id: 'oidc', what: 'sealed setting' },
        ]),
      );
      expect(manifest.chain).toMatchObject({
        keyHex: Buffer.from(CHAIN_KEY).toString('hex'),
        anchor: { seq: '0' },
        unsealedLeftOut: 1,
      });
      expect(entries.get('tables/audit_events.ndjson')!.toString()).not.toContain('UNSEALED-EVENT');
      const audit = await x.f.h.tdb.query<{ details: Record<string, unknown> }>(
        "select details from audit_events where action = 'tenant.exported'",
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.details).toMatchObject({ exportId: queued.id, by: 'operator' });
    });

    it('runs one export per tenant at a time', async () => {
      const runner = x.runner();
      await runner.request(x.scope, 'operator');
      await expect(runner.request(x.scope, 'operator')).rejects.toMatchObject({
        code: 'control-plane-export-running',
        details: { status: 409 },
      });
      const [first, second] = await Promise.all([runner.runNext(x.scope), runner.runNext(x.scope)]);
      expect([first?.status, second?.status].sort()).toEqual(['ready', undefined].sort());
      expect(await runner.runNext(x.scope)).toBeUndefined();
    });

    it('keeps three, expires them after seven days, and mails the requester when one is ready', async () => {
      const sent: { to: readonly string[]; mail: ControlMail }[] = [];
      const runner = x.runner({
        mail: {
          send: (to, mail) => {
            sent.push({ to, mail });
            return Promise.resolve();
          },
          config: x.f.h.ctx.config,
          mailHost: 'mail.test',
        },
      });
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push((await runner.request(x.scope, x.f.admin.user.id)).id);
        await runner.runNext(x.scope);
        x.f.h.clock.advance(60_000);
      }
      expect((await runner.list(x.scope)).map((row) => row.id)).toEqual(ids.slice(1).reverse());
      expect(existsSync(runner.path(x.scope, ids[0]!))).toBe(false);
      await expect(runner.ready(x.scope, ids[0]!)).rejects.toMatchObject({ details: { status: 404 } });
      expect(sent).toHaveLength(4);
      expect(sent[0]!.to).toEqual([x.f.admin.user.email]);
      expect(sent[0]!.mail.text).toContain('/settings');
      x.f.h.clock.advance(EXPORT_DAYS * DAY_MS);
      await runner.sweep(x.scope);
      expect(await runner.list(x.scope)).toEqual([]);
      for (const id of ids) expect(existsSync(runner.path(x.scope, id))).toBe(false);
    });
  });
});
