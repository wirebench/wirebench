/**
 * A tenant's export (hosted edition spec §22.9): one `.tar.gz` that holds
 *
 * - `manifest.json`: `format` 1, the server's version, the tenant, the times, every table's row count, columns and
 *   SHA-256, every workspace's bundle SHA-256, what was left out by id, and the audit chain block (the tenant's chain
 *   key in hex, its key id and the anchor), so the chain verifies with no database (§13 criterion 6);
 * - `tables/<table>.ndjson`: one JSON object per row, columns by name, `tenant_id` left out (the import's unit sets
 *   its own). A `bytea` is base64, a time is `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC (the audit chain's own form), an
 *   address is `abbrev(inet)`, a boolean or a 2- or 4-byte integer is JSON, and every other value is its PostgreSQL
 *   text, a `jsonb` included, so the chain's canonical text of each audit row is in the file as it was sealed;
 * - `repos/<workspaceId>.bundle`: `git bundle create … --all`, under the repository lock.
 *
 * The tables are read in one repeatable-read, read-only unit of the tenant; the bundles after it (spec §22.9, my
 * call: a lock over the whole export would stop the team's work). Sealed values are redacted as `tables.ts` says,
 * and no checkout, no user's `secrets.json` and no session is ever read. The archive is written beside its
 * destination and renamed onto it, so a reader never sees half of one.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { WirebenchError, type GitCli } from '@wirebench/engine';
import { keyId } from '../../audit-log/chain/canonical.js';
import { readAnchor } from '../../audit-log/repo.js';
import type { RepoStore } from '../../repos/repo-store.js';
import { tenantPaths, tenantRoot } from '../../tenancy/paths.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { TenantDbFactory, TenantQuerier } from '../../tenancy/tenant-db.js';
import { EXPORT_TABLES, exportedTables } from './tables.js';
import { writeTarGz, type TarSource } from './tar.js';

export const EXPORT_FORMAT = 1;
/** Rows per read of a table. */
const PAGE = 1000;

export interface ExportedColumn {
  readonly name: string;
  /** `format_type`'s name, which the import casts each value back to. */
  readonly type: string;
}

export interface ExportedTable {
  readonly rows: number;
  /** The file's size: an import stops writing one that passes it. */
  readonly bytes: number;
  readonly sha256: string;
  readonly columns: readonly ExportedColumn[];
}

/** The audit chain anchor, as the chain functions read it: sequence numbers as decimal text, bytes as hex. */
export interface ExportedAnchor {
  readonly seq: string;
  readonly hash: string;
  readonly keyId: string;
  readonly headSeq: string;
  readonly mac: string;
}

/** What the import cannot bring back, by id (spec §22.10): it prints each. */
export interface OmittedItem {
  readonly table: string;
  readonly id: string;
  readonly what: 'catch URL secret' | 'signature secret' | 'schedule secrets' | 'alert targets' | 'sealed setting';
}

export interface ExportManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly version: string;
  readonly tenant: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly edition: string;
    readonly region: string;
    readonly seats: number | null;
  };
  readonly exportedAt: string;
  /** When the tables' snapshot was taken, and when the last bundle was. */
  readonly tablesReadAt: string;
  readonly bundlesAt: string;
  readonly tables: Readonly<Record<string, ExportedTable>>;
  /** Each workspace's bundle SHA-256; `null` for a workspace whose repository has no commit yet. */
  readonly workspaces: Readonly<Record<string, { readonly bundle: string | null; readonly bytes: number | null }>>;
  /**
   * The tenant's chain key in hex (its UTF-8 bytes), its key id, and the anchor; `null` on a server with no chain
   * key, whose rows are never sealed.
   */
  readonly chain: {
    readonly keyHex: string;
    readonly keyId: string;
    readonly anchor: ExportedAnchor | null;
    /**
     * Audit events not sealed yet when the tables were read, left out: no link vouches for them. They stay on the
     * exporting server, and the next export, once they are sealed, holds them.
     */
    readonly unsealedLeftOut: number;
  } | null;
  readonly omitted: readonly OmittedItem[];
}

export interface ExportDeps {
  readonly db: TenantDbFactory;
  readonly repos: Pick<RepoStore, 'exists' | 'path' | 'withLock'>;
  /** With plumbing: `bundle` is on the server's list only. */
  readonly git: Pick<GitCli, 'run'>;
  readonly dataDir: string;
  readonly version: string;
  /** The tenant's audit chain key (`audit-log/chain/keys.ts`), or `undefined` without one. */
  readonly chainKey: string | undefined;
  readonly now: () => Date;
}

export interface ExportResult {
  readonly manifest: ExportManifest;
  readonly size: number;
  readonly sha256: string;
}

/** The most `manifest.json` may hold: past it, no reader parses it (an export's is a few kilobytes). */
export const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;

/**
 * An export's manifest, from its bytes: JSON, at most {@link MANIFEST_MAX_BYTES}, format 1.
 *
 * @throws WirebenchError `code` otherwise
 */
export function parseManifest(data: Buffer, code: string): ExportManifest {
  if (data.length > MANIFEST_MAX_BYTES) throw new WirebenchError(code, 'the manifest is larger than any export writes');
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch {
    throw new WirebenchError(code, 'the manifest is not JSON');
  }
  const manifest = parsed as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) {
    throw new WirebenchError(code, `the export is format ${String(manifest.format)}; this server reads format 1`);
  }
  return manifest;
}

/** `<tenantRoot>/exports`: where the server keeps a tenant's exports (spec §22.9). Never a link. */
export function exportsDir(dataDir: string, scope: TenantScope): string {
  const dir = join(tenantRoot(dataDir, scope), 'exports');
  try {
    const found = lstatSync(dir);
    if (!found.isDirectory() || found.isSymbolicLink()) {
      throw new WirebenchError(
        'control-plane-export-path-refused',
        "the tenant's exports directory is not a directory",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return dir;
}

/** How a column's value is written into its line, given the SQL that yields it. */
function render(type: string, value: string): string {
  switch (type) {
    case 'bytea':
      return `translate(encode(${value}, 'base64'), E'\\n', '')`;
    case 'timestamp with time zone':
      return `to_char((${value}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || case when (${value}) < timestamptz '0001-01-01 00:00:00+00' then ' BC' else '' end`;
    case 'inet':
      return `abbrev(${value})`;
    case 'boolean':
    case 'smallint':
    case 'integer':
      return value;
    default:
      return `(${value})::text`;
  }
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Every column but `tenant_id` of `tables`, in table order, from the catalog. */
async function columnsOf(tx: TenantQuerier, tables: readonly string[]): Promise<Map<string, ExportedColumn[]>> {
  const rows = await tx.query<{ table: string; name: string; type: string }>(
    `select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = to_regnamespace(current_schema()) and c.relname = any($1::text[])
        and a.attnum > 0 and not a.attisdropped and a.attname <> 'tenant_id'
      order by c.relname, a.attnum`,
    [tables],
  );
  const out = new Map<string, ExportedColumn[]>();
  for (const row of rows.rows) {
    const list = out.get(row.table) ?? [];
    list.push({ name: row.name, type: row.type });
    out.set(row.table, list);
  }
  return out;
}

/** The primary key's columns but `tenant_id`, in key order: what a table's rows are read in. */
async function keyOf(tx: TenantQuerier, table: string): Promise<string[]> {
  const rows = await tx.query<{ name: string }>(
    `select a.attname as name from pg_index i
       join pg_class c on c.oid = i.indrelid
       cross join lateral unnest(i.indkey) with ordinality as k(attnum, position)
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where c.relnamespace = to_regnamespace(current_schema()) and c.relname = $1 and i.indisprimary
        and a.attname <> 'tenant_id'
      order by k.position`,
    [table],
  );
  return rows.rows.map((row) => row.name);
}

/**
 * Which rows of a table an export reads, when not all: with a chain key, only the sealed audit events, in chain
 * order. An unsealed row carries no link, so nothing in the export could vouch for it, and an import refuses one.
 */
interface RowFilter {
  readonly where: string;
  readonly key: readonly string[];
}

const SEALED_ONLY: RowFilter = { where: 'chain_seq is not null', key: ['chain_seq'] };

/** One table's NDJSON at `path`, read page by page in the unit's snapshot. */
async function writeTable(
  tx: TenantQuerier,
  table: string,
  columns: readonly ExportedColumn[],
  path: string,
  filter?: RowFilter,
): Promise<ExportedTable> {
  const cls = EXPORT_TABLES[table];
  const redacted = cls?.kind === 'redact' ? cls.columns : {};
  const select = columns
    .map((column) => `${render(column.type, redacted[column.name] ?? quoted(column.name))} as ${quoted(column.name)}`)
    .join(', ');
  const key = filter?.key ?? (await keyOf(tx, table));
  const order = key.length > 0 ? `order by ${key.map(quoted).join(', ')}` : '';
  const where = filter === undefined ? '' : `where ${filter.where}`;
  const hash = createHash('sha256');
  const out = createWriteStream(path, { mode: 0o600 });
  let rows = 0;
  let bytes = 0;
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await tx.query<Record<string, unknown>>(
        `select ${select} from ${quoted(table)} ${where} ${order} limit ${String(PAGE)} offset ${String(offset)}`,
      );
      for (const row of page.rows) {
        const line = `${JSON.stringify(Object.fromEntries(columns.map((column) => [column.name, row[column.name] ?? null])))}\n`;
        hash.update(line, 'utf8');
        bytes += Buffer.byteLength(line, 'utf8');
        if (!out.write(line, 'utf8')) await once(out, 'drain');
        rows++;
      }
      if (page.rows.length < PAGE) break;
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
  return { rows, bytes, sha256: hash.digest('hex'), columns };
}

/** What the import cannot bring back (spec §22.10), read in the same snapshot as the rows. */
async function omittedItems(tx: TenantQuerier): Promise<OmittedItem[]> {
  const items: OmittedItem[] = [];
  const add = async (sql: string, table: string, what: OmittedItem['what']): Promise<void> => {
    for (const row of (await tx.query<{ id: string }>(sql)).rows) items.push({ table, id: row.id, what });
  };
  // Every catch URL: its secret is its address, and the import mints a new one.
  await add('select id from catch_urls order by id', 'catch_urls', 'catch URL secret');
  await add(
    'select id from catch_urls where signature_secret is not null order by id',
    'catch_urls',
    'signature secret',
  );
  await add("select id from schedules where secrets <> '{}'::jsonb order by id", 'schedules', 'schedule secrets');
  await add(
    "select id from schedules where jsonb_array_length(coalesce(alerts -> 'targets', '[]'::jsonb)) > 0 order by id",
    'schedules',
    'alert targets',
  );
  await add(
    'select section as id from tenant_settings where sealed is not null order by section',
    'tenant_settings',
    'sealed setting',
  );
  return items;
}

async function sha256Of(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** `scope`'s tenant row, as the manifest names it. */
async function tenantOf(tx: TenantQuerier): Promise<ExportManifest['tenant']> {
  // The tenants table is unscoped: the unit's own row, by the id it set.
  const row = (
    await tx.query<ExportManifest['tenant']>(
      'select id::text as id, slug, name, edition, region, seats from tenants where id = $1::uuid',
      [tx.scope.tenantId],
    )
  ).rows[0];
  if (row === undefined) throw new WirebenchError('control-plane-tenant-unknown', 'the tenant has no row');
  return row;
}

/**
 * Writes `scope`'s export to `out` (created, or replaced whole). The working files go to the tenant's `tmp/` and are
 * removed after, whatever happened.
 */
export async function writeExport(deps: ExportDeps, scope: TenantScope, out: string): Promise<ExportResult> {
  const work = join(tenantPaths(deps.dataDir, scope).tmp, `export-${randomBytes(6).toString('hex')}`);
  await mkdir(join(work, 'tables'), { recursive: true });
  await mkdir(join(work, 'repos'), { recursive: true });
  try {
    const tablesReadAt = deps.now().toISOString();
    const tables = exportedTables();
    const snapshot = await deps.db(scope).transaction(
      async (tx) => {
        const tenant = await tenantOf(tx);
        const columns = await columnsOf(tx, tables);
        const written: Record<string, ExportedTable> = {};
        for (const table of tables) {
          written[table] = await writeTable(
            tx,
            table,
            columns.get(table) ?? [],
            join(work, 'tables', `${table}.ndjson`),
            table === 'audit_events' && deps.chainKey !== undefined ? SEALED_ONLY : undefined,
          );
        }
        const unsealed =
          deps.chainKey === undefined
            ? 0
            : Number(
                (await tx.query<{ n: string }>('select count(*)::text as n from audit_events where chain_seq is null'))
                  .rows[0]?.n ?? 0,
              );
        const workspaces = (await tx.query<{ id: string }>('select id from workspaces order by id')).rows.map(
          (row) => row.id,
        );
        return { tenant, written, unsealed, workspaces, anchor: await readAnchor(tx), omitted: await omittedItems(tx) };
      },
      { readOnlySnapshot: true },
    );
    const bundles: Record<string, { bundle: string | null; bytes: number | null }> = {};
    for (const workspaceId of snapshot.workspaces) {
      const bundlePath = join(work, 'repos', `${workspaceId}.bundle`);
      const made = await deps.repos.withLock(scope, workspaceId, async () => {
        if (!(await deps.repos.exists(scope, workspaceId))) return false;
        const repo = deps.repos.path(scope, workspaceId);
        // An empty repository has no ref, and git refuses an empty bundle.
        const refs = await deps.git.run(repo, ['rev-parse', '--all']);
        if (refs.stdout.trim() === '') return false;
        await deps.git.run(repo, ['bundle', 'create', bundlePath, '--all'], { timeoutMs: 30 * 60_000 });
        return true;
      });
      const sum = made ? await sha256Of(bundlePath) : undefined;
      bundles[workspaceId] = { bundle: sum?.sha256 ?? null, bytes: sum?.size ?? null };
    }
    const key = deps.chainKey;
    const anchor = snapshot.anchor;
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      version: deps.version,
      tenant: snapshot.tenant,
      exportedAt: deps.now().toISOString(),
      tablesReadAt,
      bundlesAt: deps.now().toISOString(),
      tables: snapshot.written,
      workspaces: bundles,
      chain:
        key === undefined
          ? null
          : {
              keyHex: Buffer.from(key, 'utf8').toString('hex'),
              keyId: keyId(key),
              anchor:
                anchor === undefined
                  ? null
                  : {
                      seq: anchor.seq.toString(),
                      hash: anchor.hash.toString('hex'),
                      keyId: anchor.keyId,
                      headSeq: anchor.headSeq.toString(),
                      mac: anchor.mac.toString('hex'),
                    },
              unsealedLeftOut: snapshot.unsealed,
            },
      omitted: snapshot.omitted,
    };
    const sources: TarSource[] = [
      { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
      ...tables.map((table) => ({ name: `tables/${table}.ndjson`, path: join(work, 'tables', `${table}.ndjson`) })),
      ...Object.entries(bundles)
        .filter(([, entry]) => entry.bundle !== null)
        .map(([workspaceId]) => ({
          name: `repos/${workspaceId}.bundle`,
          path: join(work, 'repos', `${workspaceId}.bundle`),
        })),
    ];
    await mkdir(dirname(out), { recursive: true });
    const partial = `${out}.partial-${randomBytes(4).toString('hex')}`;
    try {
      await writeTarGz(partial, sources, { mtime: deps.now() });
      const { sha256, size } = await sha256Of(partial);
      await rename(partial, out);
      return { manifest, sha256, size };
    } finally {
      await rm(partial, { force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The size of a ready export's file, or `undefined` when it is gone. */
export async function exportFileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}
