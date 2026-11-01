/**
 * The tenants' data keys (hosted edition spec §19.7, ADR-0036). Each tenant has 32 random bytes, sealed in
 * `tenants.data_key` under the server root; every user key that seals a server host's files derives from it
 * (`userSecretsKey` in `host/server-platform.ts`), never from the root.
 *
 * - **The root** is reached through {@link KeyRoot} alone. Its first implementation is the environment key
 *   (`WIREBENCH_SERVER_SECRETS_KEY`); a KMS-held root is slice 5's, behind the same interface, and changes nothing
 *   on disk. The wrap is the secret box (AES-256-GCM) under `HKDF(root, salt 'wirebench-tenant-data-key', info
 *   tenantId)`, so a wrapped key copied onto another tenant's row does not open there.
 * - **The cache** ({@link TenantKeys}) holds each unwrapped key for the life of the process, and drops it when
 *   the tenant's row changes in this process (`invalidate`, called on every directory change). Until slice 5's
 *   notification, a change made by another process is not seen.
 * - **Lazy creation** is a compare-and-set on the null column; the loser re-reads and uses the winner's key.
 *
 * Nothing here logs, and no error carries a key, a wrapped key or the root (ADR-0004).
 */
import { hkdfSync, randomBytes } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import type { Querier } from '../db/querier.js';
import { open, seal } from '../hooks/secret-box.js';
import { CANONICAL_UUID } from './scope.js';

/** HKDF's salt for the wrapping key; changing it orphans every tenant's data key. */
const WRAP_SALT = 'wirebench-tenant-data-key';
const KEY_BYTES = 32;

/** The server root: what wraps and unwraps a tenant's data key, bound to the tenant's id. */
export interface KeyRoot {
  /** Seals `dataKey` for `tenantId`. */
  wrap(tenantId: string, dataKey: Buffer): Promise<Buffer>;
  /** @throws WirebenchError `tenancy-data-key-refused` when `wrapped` was not sealed for `tenantId` under this root. */
  unwrap(tenantId: string, wrapped: Buffer): Promise<Buffer>;
}

/** A fresh data key: 32 random bytes. */
export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Refuses any other form of a tenant id (Task 23 review M1). `$1::uuid` would still find the row for an
 * upper-case or braced id, but the wrapping key derived from it would differ: a key made that way would open for
 * no canonical caller again.
 *
 * @throws WirebenchError `tenancy-tenant-id-invalid`.
 */
function canonical(tenantId: string): string {
  if (!CANONICAL_UUID.test(tenantId)) throw invalidId();
  return tenantId;
}

function invalidId(): WirebenchError {
  return new WirebenchError('tenancy-tenant-id-invalid', 'a tenant id must be a lower-case UUID');
}

const refused = (): WirebenchError =>
  new WirebenchError(
    'tenancy-data-key-refused',
    "the tenant's data key does not open under the server root: the root changed, or the key is not this tenant's",
  );

/** `fn`'s result, or its throw as a rejection: the root's calls never throw synchronously. */
function settled<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The root as the environment holds it: `WIREBENCH_SERVER_SECRETS_KEY`. */
export function environmentKeyRoot(root: Buffer): KeyRoot {
  if (root.length !== KEY_BYTES) throw new Error('the server root must be 32 bytes');
  // A copy, so a caller that zeroes or reuses its buffer does not change the root under us.
  const held = Buffer.from(root);
  const wrapKey = (tenantId: string): Buffer =>
    Buffer.from(hkdfSync('sha256', held, WRAP_SALT, canonical(tenantId), KEY_BYTES));
  return {
    wrap: (tenantId, dataKey) =>
      settled(() => {
        if (dataKey.length !== KEY_BYTES) throw new Error('a data key must be 32 bytes');
        return seal(wrapKey(tenantId), dataKey.toString('base64'));
      }),
    unwrap: (tenantId, wrapped) =>
      settled(() => {
        const wrapping = wrapKey(tenantId);
        let key: Buffer;
        try {
          key = Buffer.from(open(wrapping, wrapped), 'base64');
        } catch {
          throw refused();
        }
        if (key.length !== KEY_BYTES) throw refused();
        return key;
      }),
  };
}

/**
 * What `admin tenancy status` says of `tenantId`'s data key (Task 23 review I1, M6): `none`; `made` when no root
 * is configured to try it with; `opens` or `refused` under `root`. Never the key or its wrap.
 */
export type DataKeyState = 'none' | 'made' | 'opens' | 'refused';

export async function dataKeyState(db: Querier, tenantId: string, root: KeyRoot | undefined): Promise<DataKeyState> {
  const rows = await db.query<{ key: Buffer | null }>('select data_key as key from tenants where id = $1::uuid', [
    canonical(tenantId),
  ]);
  const wrapped = rows.rows[0]?.key ?? null;
  if (wrapped === null) return 'none';
  if (root === undefined) return 'made';
  try {
    await root.unwrap(tenantId, wrapped);
    return 'opens';
  } catch (error) {
    if (error instanceof WirebenchError && error.code === 'tenancy-data-key-refused') return 'refused';
    throw error;
  }
}

/**
 * The unwrapped data keys of one process. `db` is the raw querier: `tenants` has no `tenant_id` and no policy,
 * and only `src/tenancy/` may read it (`check:tenant-scope`).
 */
export class TenantKeys {
  readonly #db: Querier;
  readonly #root: KeyRoot | undefined;
  /** The promise, so two callers in this process share one read (and one creation). */
  readonly #cache = new Map<string, Promise<Buffer>>();

  constructor(db: Querier, root: KeyRoot | undefined) {
    this.#db = db;
    this.#root = root;
  }

  /**
   * A new tenant's wrapped key, for its `insert`: `undefined` without a root, when the key waits for one.
   */
  async wrapNew(tenantId: string): Promise<Buffer | undefined> {
    return this.#root === undefined ? undefined : this.#root.wrap(canonical(tenantId), newDataKey());
  }

  /**
   * `tenantId`'s data key, made by a compare-and-set if its row has none yet.
   *
   * @throws WirebenchError `tenancy-tenant-id-invalid` for an id that is not a lower-case UUID; `tenancy-no-root`
   *   without a root; `tenancy-unknown-tenant` when the row is gone; `tenancy-data-key-refused` when the stored key
   *   does not open for this tenant; `tenancy-data-key-missing` when another process cleared it mid-creation.
   */
  dataKey(tenantId: string): Promise<Buffer> {
    if (!CANONICAL_UUID.test(tenantId)) return Promise.reject(invalidId());
    const cached = this.#cache.get(tenantId);
    if (cached !== undefined) return cached;
    const loading = this.#load(tenantId);
    this.#cache.set(tenantId, loading);
    // A failure is not kept: the next caller tries again (the root may have been fixed, the row restored).
    loading.catch(() => {
      if (this.#cache.get(tenantId) === loading) this.#cache.delete(tenantId);
    });
    return loading;
  }

  /** Drops `tenantId`'s key, or every key: its row changed in this process. */
  invalidate(tenantId?: string): void {
    if (tenantId === undefined) this.#cache.clear();
    else this.#cache.delete(tenantId);
  }

  async #load(tenantId: string): Promise<Buffer> {
    const root = this.#root;
    if (root === undefined) {
      throw new WirebenchError('tenancy-no-root', 'no tenant data key without WIREBENCH_SERVER_SECRETS_KEY');
    }
    const stored = await this.#read(tenantId);
    if (stored !== null) return root.unwrap(tenantId, stored);
    const dataKey = newDataKey();
    const wrapped = await root.wrap(tenantId, dataKey);
    const won = await this.#db.query<{ id: string }>(
      'update tenants set data_key = $1 where id = $2::uuid and data_key is null returning id',
      [wrapped, tenantId],
    );
    if (won.rows.length === 1) return dataKey;
    // Another process made it first, or the row is gone: read again, and use what is there.
    const winner = await this.#read(tenantId);
    if (winner === null) {
      throw new WirebenchError(
        'tenancy-data-key-missing',
        "the tenant's data key was cleared while it was being made; try again",
      );
    }
    return root.unwrap(tenantId, winner);
  }

  /** The row's wrapped key, `null` when it has none. */
  async #read(tenantId: string): Promise<Buffer | null> {
    const rows = await this.#db.query<{ key: Buffer | null }>(
      'select data_key as key from tenants where id = $1::uuid',
      [tenantId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new WirebenchError('tenancy-unknown-tenant', 'no tenant has this id');
    return row.key;
  }
}
