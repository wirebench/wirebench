import { GitCli, detectInText, findGit } from '@wirebench/engine';
import { loadConfig } from '../../src/config.js';
import {
  MetaRegistry,
  permissiveLicense,
  serverHooks,
  type AuditInput,
  type Database,
  type Querier,
  type ServerContext,
  type ServerHooks,
} from '../../src/context.js';
import type { RepoStore } from '../../src/repos/repo-store.js';

/** A database whose every query succeeds with no rows; `failing` flips `select 1` to a rejection. */
export function fakeDatabase(options: { failing?: boolean } = {}): Database {
  const querier = {
    query: (text: string) =>
      options.failing === true && text.trim().toLowerCase() === 'select 1'
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve({ rows: [], rowCount: 0 }),
  };
  return { ...querier, transaction: async (fn) => fn(querier), close: () => Promise.resolve() } as Database;
}

export async function testContext(
  overrides: Partial<ServerContext> & { dataDir?: string } = {},
): Promise<ServerContext> {
  const location = await findGit({});
  if (location === undefined) throw new Error('git is required for the server tests');
  const dataDir = overrides.dataDir ?? process.cwd();
  const { dataDir: droppedDataDir, ...rest } = overrides;
  void droppedDataDir; // not a ServerContext field; only used above to pick dataDir
  return {
    config: loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: 'postgres://test',
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: dataDir,
        WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      },
      '0.0.0-test',
    ),
    db: fakeDatabase(),
    // `RepoStore` is a class with private fields now (Task 6); this fake only ever needs `path`
    // from tests that don't exercise the real store, so it is cast through `unknown` rather than
    // built as a real `RepoStore` instance.
    repos: { path: (id: string) => `${dataDir}/repos/${id}.git` } as unknown as RepoStore,
    git: new GitCli(location, { hooksDir: dataDir }),
    log: undefined as unknown as ServerContext['log'], // buildServer replaces it with the app's logger
    meta: new MetaRegistry(),
    hooks: serverHooks(),
    license: permissiveLicense(),
    ...rest,
  };
}

/** Wirebench's own token (`identity/tokens.ts` `TOKEN_PREFIX`) and license shapes, which the credential rules do not know. */
const WIREBENCH_SHAPES: readonly RegExp[] = [/wbs_[A-Za-z0-9_-]{20,}/, /wbl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/];

/**
 * Every audit row, serialised, scanned with the engine's secret rules (`detectInText`, the patterns the
 * secret-scanning spec defines) plus the two shapes above. Ids and commit hashes pass: the engine flags
 * high entropy only under a secret-sounding name, and a body name must be one of `SECRET_BODY_KEYS` exactly.
 */
export async function expectNoSecretsInAudit(db: Querier): Promise<void> {
  const rows = await db.query<Record<string, unknown>>('select actor_email, user_agent, details from audit_events');
  for (const row of rows.rows) {
    const text = JSON.stringify(row);
    // `tokenId` is the device-token row's id, never the token (§3.5: only its hash is stored); the engine's
    // entropy rule flags any high-entropy value under a name containing "token", so the id is dropped for that scan.
    const scanned = JSON.stringify(row, (key, value: unknown) => (key === 'tokenId' ? undefined : value));
    if (detectInText(scanned).length > 0 || WIREBENCH_SHAPES.some((shape) => shape.test(text))) {
      throw new Error(`audit row carries a secret-shaped value: ${text}`);
    }
  }
}

/** Pushes a hook that keeps every event; `events` is what a test asserts on. */
export function recordingAudit(hooks: ServerHooks): AuditInput[] {
  const events: AuditInput[] = [];
  hooks.audit.push((_tx, event) => {
    events.push(event);
    return Promise.resolve();
  });
  return events;
}
