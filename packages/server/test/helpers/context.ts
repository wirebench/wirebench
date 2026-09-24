import { GitCli, findGit } from '@wirebench/engine';
import { loadConfig } from '../../src/config.js';
import { MetaRegistry, ServerEvents, type Database, type ServerContext } from '../../src/context.js';

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
    repos: { path: (id: string) => `${dataDir}/repos/${id}.git` },
    git: new GitCli(location, { hooksDir: dataDir }),
    log: undefined as unknown as ServerContext['log'], // buildServer replaces it with the app's logger
    meta: new MetaRegistry(),
    events: new ServerEvents(),
    ...rest,
  };
}
