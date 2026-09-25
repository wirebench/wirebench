/**
 * The `server-sync` ServerModule (spec §5.1). It is registered after teams-access in the shared
 * `/api/v1` scope, so identity's `onRequest` hook has set `request.caller` before
 * `requireWorkspaceRole` runs. It has no migrations: the bare repositories hold everything (§4.3).
 */
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { TMP_DIR } from '../repos/repo-store.js';
import { CommitStore, sweepIndexFiles } from './commit-store.js';
import type { SyncEnv } from './env.js';
import { changesRoutes } from './routes/changes.js';
import { commitRoutes } from './routes/commits.js';
import { headRoutes } from './routes/head.js';
import { logRoutes } from './routes/log.js';
import { snapshotRoutes } from './routes/snapshot.js';

const MIB = 1024 * 1024;

export function syncModule(): ServerModule {
  return {
    name: 'server-sync',

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      // Absolute, as the store requires: git and Node resolve a relative index path differently.
      const tmpDir = resolve(ctx.config.dataDir, TMP_DIR);
      // R11: a crash mid-push leaves its private index file behind. Before the first route exists,
      // nothing can own one, so every leftover goes.
      await sweepIndexFiles(tmpDir);
      const store = new CommitStore({
        git: ctx.git.withPlumbing(),
        repos: ctx.repos,
        tmpDir,
        // R5: one operator setting bounds a push (Fastify's bodyLimit) and a snapshot (the store).
        limitBytes: ctx.config.bodyLimitMb * MIB,
      });
      const env: SyncEnv = { ctx, store };
      ctx.meta.addCapability('sync');
      headRoutes(env)(app);
      snapshotRoutes(env)(app);
      changesRoutes(env)(app);
      commitRoutes(env)(app);
      logRoutes(env)(app);
    },
  };
}
