/**
 * `admin tenant import <file>` (hosted edition spec §22.10): an export restored into a tenant. Each step is
 * resumable from the manifest, so an import a crash stopped is run again with the same command:
 *
 * 1. **The checks.** The archive is unpacked into the target tenant's `tmp/`, every file against its SHA-256 in the
 *    manifest (`import-checksum-mismatch`), and the audit chain verified under the export's own key, with no
 *    database (`import-chain-broken`).
 * 2. **The tables**, in foreign-key order read from the catalog, each in one unit of the target tenant, so
 *    `tenant_id` is the target's own. Every exported table has a unique key, and every insert is
 *    `on conflict do nothing`, so a table half-written before a crash is finished, not doubled. A schedule that held
 *    secrets comes back disabled; the audit rows come back unsealed.
 * 3. **The repositories**: each made if missing, then its bundle verified and fetched into it (`refs/*:refs/*`).
 * 4. **The re-key** (§19.12's promise): under the chain lock, the target's chain is sealed again from the first
 *    event, under the target tenant's key; then `tenant.imported` records the source tenant, its key id and the last
 *    sequence and hash the source sealed, which is how the source chain's seal is kept.
 *
 * A marker in the tenant's `tmp/` (`import.json`) names the export being imported; it is what lets a second run
 * resume where an emptiness check would refuse, and it is removed when the import is done. What the import cannot
 * bring back is returned by id: the export's own list (sealed values), and the schedules it disabled.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { WirebenchError, type GitCli } from '@wirebench/engine';
import { link } from '../../audit-log/chain/canonical.js';
import { lockChain } from '../../audit-log/chain/lock.js';
import {
  claimUnsealed,
  insertGenesis,
  sealRows,
  setAnchorHead,
  type ChainLink,
  type RowSeal,
} from '../../audit-log/repo.js';
import { recordAudit, SYSTEM_SOURCE, type ServerHooks } from '../../context.js';
import { mintCatchSecret } from '../../hooks/secret.js';
import { isWorkspaceId, type RepoStore } from '../../repos/repo-store.js';
import { tenantPaths } from '../../tenancy/paths.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { TenantDbFactory, TenantQuerier } from '../../tenancy/tenant-db.js';
import type { TenantRow } from '../../tenancy/directory.js';
import type { HostedEdition, TenantLifecycle } from '../tenants.js';
import { EXPORT_FORMAT, type ExportManifest, type OmittedItem } from './export.js';
import { exportedTables } from './tables.js';
import { readTarGz } from './tar.js';
import { verifyExportChain } from './verify-export.js';

/** Rows per insert, and the most text one insert's parameter holds (a session log's chunks are large). */
const BATCH = 500;
const BATCH_CHARS = 8 * 1024 * 1024;
/** The audit chain's own columns: the re-key writes them, so the import never does. */
const CHAIN_COLUMNS = new Set(['chain_seq', 'chain_hash']);
/** Tables the import writes no rows of: the re-key makes the target's anchor. */
const NOT_INSERTED = new Set(['audit_chain_anchor']);

/**
 * What the import writes in place of an exported value, per table: a catch URL's secret, which the export blanks
 * (spec §22.9), is minted fresh, so the catch URL gets a new address and the old one never answers again.
 */
const REWRITES: Readonly<Record<string, (row: Record<string, unknown>) => void>> = {
  catch_urls: (row) => {
    row['secret'] = mintCatchSecret();
  },
};

const refuse = (code: string, message: string): WirebenchError => new WirebenchError(code, message);

export interface ImportDeps {
  readonly db: TenantDbFactory;
  readonly repos: Pick<RepoStore, 'exists' | 'create' | 'path' | 'withLock'>;
  /** With plumbing (`bundle`). */
  readonly git: Pick<GitCli, 'run'>;
  readonly dataDir: string;
  readonly hooks: ServerHooks;
  /** The target tenant's chain key; `undefined` leaves the audit rows unsealed, as the server's sealer would. */
  readonly chainKeyOf: (scope: TenantScope) => string | undefined;
  /** A test's crash: called after each table is written. */
  readonly afterTable?: (table: string) => Promise<void> | void;
}

/** What did not come back, by id (spec §22.10). */
export interface ImportReport {
  readonly tables: Readonly<Record<string, number>>;
  readonly workspaces: number;
  readonly notRestored: readonly (
    OmittedItem | { readonly table: 'schedules'; readonly id: string; readonly what: 'disabled' }
  )[];
  /** Whether this run picked up an import a crash had stopped. */
  readonly resumed: boolean;
}

interface Marker {
  readonly sourceTenantId: string;
  readonly exportedAt: string;
}

const markerPath = (dataDir: string, scope: TenantScope): string =>
  join(tenantPaths(dataDir, scope).tmp, 'import.json');

/** The import `scope` was in the middle of, if any. */
export async function importInProgress(dataDir: string, scope: TenantScope): Promise<Marker | undefined> {
  try {
    return JSON.parse(await readFile(markerPath(dataDir, scope), 'utf8')) as Marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Whether `marker` is this export's. */
export function sameExport(marker: Marker | undefined, manifest: ExportManifest): boolean {
  return (
    marker !== undefined && marker.sourceTenantId === manifest.tenant.id && marker.exportedAt === manifest.exportedAt
  );
}

/**
 * The manifest of the export at `path`.
 *
 * @throws WirebenchError `import-format` for an archive that is not a format-1 export
 */
export async function readManifest(path: string): Promise<ExportManifest> {
  for await (const entry of readTarGz(path)) {
    if (entry.name !== 'manifest.json') continue;
    const manifest = JSON.parse((await entry.buffer()).toString('utf8')) as ExportManifest;
    if (manifest.format !== EXPORT_FORMAT) {
      throw refuse('import-format', `the export is format ${String(manifest.format)}; this server reads format 1`);
    }
    return manifest;
  }
  throw refuse('import-format', 'the file has no manifest.json: it is not a Wirebench export');
}

/**
 * The export's audit chain, verified under its own key (spec §22.10).
 *
 * @throws WirebenchError `import-chain-broken` when it does not verify, naming the event
 */
export async function checkExportChain(path: string): Promise<void> {
  const outcome = await verifyExportChain(path);
  if (outcome.kind === 'no-key') return;
  if (outcome.kind === 'wrong-key') {
    throw refuse('import-chain-broken', `the export's chain was sealed with another key (${outcome.chainKeyId})`);
  }
  // The export leaves unsealed events out (spec §22.9): one in the file was put there afterwards, and no link of the
  // chain vouches for it.
  if (outcome.unsealed > 0) {
    throw refuse(
      'import-chain-broken',
      `the export holds ${String(outcome.unsealed)} audit events no link of its chain vouches for`,
    );
  }
  if (outcome.result === 'broken' || !outcome.checksum) {
    const broken = outcome.broken;
    throw refuse(
      'import-chain-broken',
      broken === undefined
        ? "the export's audit events do not match the manifest's checksum"
        : `the export's audit chain is broken: ${broken.reason} at seq ${broken.seq.toString()}${broken.id !== undefined ? ` (event ${broken.id})` : ''}`,
    );
  }
}

/** The archive unpacked under `dir`, every file checked against the manifest. */
async function unpack(path: string, manifest: ExportManifest, dir: string): Promise<void> {
  const expected = new Map<string, string>();
  for (const [table, info] of Object.entries(manifest.tables)) expected.set(`tables/${table}.ndjson`, info.sha256);
  for (const [workspaceId, info] of Object.entries(manifest.workspaces)) {
    if (!isWorkspaceId(workspaceId)) throw refuse('import-format', 'the manifest names a workspace id that is not one');
    if (info.bundle !== null) expected.set(`repos/${workspaceId}.bundle`, info.bundle);
  }
  await mkdir(join(dir, 'tables'), { recursive: true });
  await mkdir(join(dir, 'repos'), { recursive: true });
  const seen = new Set<string>();
  for await (const entry of readTarGz(path)) {
    const sha = expected.get(entry.name);
    // Only the files the manifest names are written, each at a path made from a checked table name or workspace id.
    if (sha === undefined) continue;
    const hash = createHash('sha256');
    const out = createWriteStream(join(dir, entry.name), { mode: 0o600 });
    for await (const chunk of entry.chunks()) {
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'close');
    if (hash.digest('hex') !== sha) {
      throw refuse('import-checksum-mismatch', `${entry.name} does not match its checksum in the manifest`);
    }
    seen.add(entry.name);
  }
  const missing = [...expected.keys()].filter((name) => !seen.has(name));
  if (missing.length > 0) throw refuse('import-checksum-mismatch', `the export lacks ${missing.join(', ')}`);
}

/** The target's columns of `tables` (but `tenant_id`), and their types, from the catalog. */
async function targetColumns(tx: TenantQuerier, tables: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const rows = await tx.query<{ table: string; name: string; type: string }>(
    `select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = to_regnamespace(current_schema()) and c.relname = any($1::text[])
        and a.attnum > 0 and not a.attisdropped and a.attname <> 'tenant_id'`,
    [tables],
  );
  const out = new Map<string, Map<string, string>>();
  for (const row of rows.rows) {
    const columns = out.get(row.table) ?? new Map<string, string>();
    columns.set(row.name, row.type);
    out.set(row.table, columns);
  }
  return out;
}

/** `tables` in foreign-key order: every table after the ones it references, read from the catalog. */
export async function foreignKeyOrder(tx: TenantQuerier, tables: readonly string[]): Promise<string[]> {
  const edges = await tx.query<{ from: string; to: string }>(
    `select c.relname as from, r.relname as to from pg_constraint k
       join pg_class c on c.oid = k.conrelid join pg_class r on r.oid = k.confrelid
      where k.contype = 'f' and c.relnamespace = to_regnamespace(current_schema())
        and c.relname = any($1::text[]) and r.relname = any($1::text[]) and c.relname <> r.relname`,
    [tables],
  );
  const needs = new Map<string, Set<string>>(tables.map((table) => [table, new Set<string>()]));
  for (const edge of edges.rows) needs.get(edge.from)?.add(edge.to);
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < tables.length) {
    const ready = [...needs.keys()]
      .filter((table) => !placed.has(table) && [...needs.get(table)!].every((to) => placed.has(to)))
      .sort();
    if (ready.length === 0) throw refuse('import-format', 'the tables reference each other in a cycle');
    for (const table of ready) {
      order.push(table);
      placed.add(table);
    }
  }
  return order;
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** One table's NDJSON inserted in batches, in one unit; the rows it inserted. */
async function insertTable(
  tx: TenantQuerier,
  table: string,
  file: string,
  exported: readonly string[],
  target: Map<string, string>,
): Promise<number> {
  const missing = exported.filter((column) => !target.has(column));
  if (missing.length > 0) {
    throw refuse('import-schema-mismatch', `${table} here has no ${missing.join(', ')}: upgrade this server first`);
  }
  const columns = exported.filter((column) => !CHAIN_COLUMNS.has(column) || table !== 'audit_events');
  if (columns.length === 0) return 0;
  const cast = (column: string): string => {
    const type = target.get(column)!;
    const value = `x.${quoted(column)}`;
    return type === 'bytea' ? `decode(${value}, 'base64')` : `${value}::${type}`;
  };
  const statement = `insert into ${quoted(table)} (${columns.map(quoted).join(', ')})
    select ${columns.map(cast).join(', ')}
      from jsonb_to_recordset($1::jsonb) as x(${columns.map((column) => `${quoted(column)} text`).join(', ')})
    on conflict do nothing`;
  let inserted = 0;
  let batch: string[] = [];
  let chars = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const result = await tx.query(statement, [`[${batch.join(',')}]`]);
    inserted += result.rowCount ?? 0;
    batch = [];
    chars = 0;
  };
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const rewrite = REWRITES[table];
  for await (const read of lines) {
    if (read === '') continue;
    let line = read;
    if (rewrite !== undefined) {
      const row = JSON.parse(read) as Record<string, unknown>;
      rewrite(row);
      line = JSON.stringify(row);
    }
    batch.push(line);
    chars += line.length;
    if (batch.length >= BATCH || chars >= BATCH_CHARS) await flush();
  }
  await flush();
  return inserted;
}

/** Seals `scope`'s whole chain again from the first event, under `key` (spec §22.10). */
async function rekey(tx: TenantQuerier, key: string): Promise<void> {
  await lockChain(tx);
  await tx.query('update audit_events set chain_seq = null, chain_hash = null where chain_seq is not null');
  await tx.query('delete from audit_chain_anchor');
  const anchor = await insertGenesis(tx, key);
  let head: ChainLink = { seq: anchor.seq, hash: anchor.hash };
  for (;;) {
    const rows = await claimUnsealed(tx, BATCH);
    if (rows.length === 0) break;
    const seals: RowSeal[] = [];
    for (const row of rows) {
      const seq = head.seq + 1n;
      const hash = link(key, head.hash, seq, row);
      seals.push({ id: row.id!, seq, hash });
      head = { seq, hash };
    }
    await sealRows(tx, seals);
  }
  if (head.seq > anchor.seq) await setAnchorHead(tx, key, anchor, head.seq);
}

/** The source chain's last sealed link, as the export holds it: what `tenant.imported` keeps. */
async function sourceHead(file: string): Promise<{ seq: string; hash: string } | null> {
  let best: { seq: bigint; hash: string } | null = null;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line === '') continue;
    const row = JSON.parse(line) as { chain_seq?: string | null; chain_hash?: string | null };
    if (row.chain_seq === null || row.chain_seq === undefined) continue;
    const seq = BigInt(row.chain_seq);
    if (best === null || seq > best.seq) {
      best = { seq, hash: Buffer.from(row.chain_hash ?? '', 'base64').toString('hex') };
    }
  }
  return best === null ? null : { seq: best.seq.toString(), hash: best.hash };
}

/**
 * Restores the export at `path` (checked by the caller with {@link checkExportChain}) into `scope`, resuming an
 * import of the same export a crash stopped.
 */
export async function importInto(
  deps: ImportDeps,
  scope: TenantScope,
  path: string,
  manifest: ExportManifest,
): Promise<ImportReport> {
  // Only the tables an export may hold: a manifest naming another (`tenants`, a skipped one) is no export of ours,
  // and no other name is ever joined into a path.
  const allowed = new Set(exportedTables());
  const foreign = Object.keys(manifest.tables).filter((table) => !allowed.has(table));
  if (foreign.length > 0) {
    throw refuse('import-format', `the export names tables no export holds: ${foreign.join(', ')}`);
  }
  const marker = await importInProgress(deps.dataDir, scope);
  const resumed = sameExport(marker, manifest);
  const tmp = tenantPaths(deps.dataDir, scope).tmp;
  await mkdir(tmp, { recursive: true });
  await writeFile(
    markerPath(deps.dataDir, scope),
    JSON.stringify({ sourceTenantId: manifest.tenant.id, exportedAt: manifest.exportedAt } satisfies Marker),
    { mode: 0o600 },
  );
  const work = join(tmp, `import-${randomBytes(6).toString('hex')}`);
  try {
    await unpack(path, manifest, work);
    const db = deps.db(scope);
    const exported = Object.keys(manifest.tables).filter((table) => !NOT_INSERTED.has(table));
    const { order, columns } = await db.transaction(async (tx) => ({
      order: await foreignKeyOrder(tx, exported),
      columns: await targetColumns(tx, exported),
    }));
    const counts: Record<string, number> = {};
    for (const table of order) {
      const target = columns.get(table);
      if (target === undefined) throw refuse('import-schema-mismatch', `this server has no table ${table}`);
      const names = manifest.tables[table]!.columns.map((column) => column.name);
      counts[table] = await db.transaction((tx) =>
        insertTable(tx, table, join(work, 'tables', `${table}.ndjson`), names, target),
      );
      await deps.afterTable?.(table);
    }
    // A schedule whose secrets stayed behind would run without them: it comes back off.
    const disabled = [
      ...new Set(manifest.omitted.filter((item) => item.what === 'schedule secrets').map((item) => item.id)),
    ];
    if (disabled.length > 0) {
      await db.query('update schedules set enabled = false where id = any($1::text[])', [disabled]);
    }
    for (const workspaceId of Object.keys(manifest.workspaces)) {
      const bundle = manifest.workspaces[workspaceId]!.bundle;
      await deps.repos.withLock(scope, workspaceId, async () => {
        if (!(await deps.repos.exists(scope, workspaceId))) await deps.repos.create(scope, workspaceId);
        if (bundle === null) return;
        const repo = deps.repos.path(scope, workspaceId);
        const file = join(work, 'repos', `${workspaceId}.bundle`);
        await deps.git.run(repo, ['bundle', 'verify', '--quiet', file]);
        await deps.git.run(repo, ['fetch', '--quiet', '--no-tags', file, 'refs/*:refs/*'], { timeoutMs: 30 * 60_000 });
      });
    }
    const key = deps.chainKeyOf(scope);
    const head = await sourceHead(join(work, 'tables', 'audit_events.ndjson'));
    await db.transaction(async (tx) => {
      const done = await tx.query(
        `select 1 from audit_events where action = 'tenant.imported'
          and details ->> 'sourceTenantId' = $1 and details ->> 'exportedAt' = $2 limit 1`,
        [manifest.tenant.id, manifest.exportedAt],
      );
      if (done.rows.length > 0) return;
      if (key !== undefined) await rekey(tx, key);
      await recordAudit(deps.hooks, tx, {
        ...SYSTEM_SOURCE,
        action: 'tenant.imported',
        target: { kind: 'tenant', id: scope.tenantId },
        details: {
          sourceTenantId: manifest.tenant.id,
          exportedAt: manifest.exportedAt,
          sourceKeyId: manifest.chain?.keyId ?? null,
          sourceLastSeq: head?.seq ?? null,
          sourceLastHash: head?.hash ?? null,
          by: 'operator',
        },
      });
    });
    await rm(markerPath(deps.dataDir, scope), { force: true });
    return {
      tables: counts,
      workspaces: Object.keys(manifest.workspaces).length,
      notRestored: [
        ...manifest.omitted,
        ...disabled.map((id) => ({ table: 'schedules' as const, id, what: 'disabled' as const })),
      ],
      resumed,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * A self-hosted target (spec §22.10): its one tenant, which must hold no user and no workspace, unless this export's
 * import is the one a crash stopped there.
 *
 * @throws WirebenchError `import-target-not-empty`
 */
export async function assertImportTarget(
  deps: Pick<ImportDeps, 'db' | 'dataDir'>,
  scope: TenantScope,
  manifest: ExportManifest,
): Promise<void> {
  if (sameExport(await importInProgress(deps.dataDir, scope), manifest)) return;
  const rows = await deps
    .db(scope)
    .query<{ taken: boolean }>('select exists (select 1 from users) or exists (select 1 from workspaces) as taken');
  if (rows.rows[0]?.taken === true) {
    throw refuse('import-target-not-empty', 'this server already has users or workspaces: import into an empty one');
  }
}

/**
 * A self-hosted import (spec §22.10): into the server's one tenant, which must be empty.
 *
 * @throws WirebenchError `import-format`, `import-chain-broken`, `import-checksum-mismatch`, `import-target-not-empty`
 */
export async function importSelfHosted(deps: ImportDeps, scope: TenantScope, path: string): Promise<ImportReport> {
  const manifest = await readManifest(path);
  await checkExportChain(path);
  await assertImportTarget(deps, scope, manifest);
  return importInto(deps, scope, path, manifest);
}

export interface HostedImportOptions {
  readonly slug?: string;
  readonly name?: string;
  readonly edition?: HostedEdition;
  readonly seats?: number;
}

/**
 * A hosted import (spec §22.10): a new tenant, edition source `operator`, created suspended (`importing`) and resumed
 * at the end. The slug, name, edition and seats are the export's unless given; a self-hosted export's `community`
 * comes in as `team`. A tenant still `importing` under that slug, with no other export's import under way, is the one
 * a crash stopped: the import resumes there.
 */
export async function importHosted(
  deps: ImportDeps,
  lifecycle: TenantLifecycle,
  path: string,
  options: HostedImportOptions = {},
): Promise<{ readonly tenant: TenantRow; readonly scope: TenantScope; readonly report: ImportReport }> {
  const manifest = await readManifest(path);
  await checkExportChain(path);
  const slug = options.slug ?? manifest.tenant.slug;
  const stopped = await lifecycle.importing(slug);
  const marker = stopped === undefined ? undefined : await importInProgress(deps.dataDir, stopped.scope);
  const resumable = stopped !== undefined && (marker === undefined || sameExport(marker, manifest));
  const seats = options.seats ?? manifest.tenant.seats ?? undefined;
  const target = resumable
    ? stopped
    : await lifecycle.create({
        slug,
        name: options.name ?? manifest.tenant.name,
        edition: options.edition ?? (manifest.tenant.edition === 'enterprise' ? 'enterprise' : 'team'),
        ...(seats !== undefined ? { seats } : {}),
        editionSource: 'operator',
        suspendedReason: 'importing',
      });
  const report = await importInto(deps, target.scope, path, manifest);
  const resumed = await lifecycle.resume(slug);
  return { tenant: resumed ?? target, scope: target.scope, report };
}
