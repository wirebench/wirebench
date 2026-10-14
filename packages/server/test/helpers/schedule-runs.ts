/**
 * What an executor or scheduler test runs against (scheduled-runs spec §11): a workspace built with the
 * engine's own savers and handed over as a sync snapshot, a local HTTP server to send to, and one
 * schedule with a running run. Never a sleep: a request that hangs is released by the test.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createApi,
  createProject,
  createRestRequest,
  createWorkspace,
  entry,
  saveProject,
  saveWorkspace,
  workspaceProjectDir,
  type Project,
  type RestRequestDef,
  type ScheduleOptions,
  type ScheduleTarget,
  type SyncFile,
  type WorkspaceEnvironment,
} from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { newId } from '../../src/identity/tokens.js';
import type { ExecutorEnv } from '../../src/schedules/executor.js';
import * as repo from '../../src/schedules/repo.js';
import { sealValue, type StoredAlerts } from '../../src/schedules/seal.js';
import type { SchedulesSettings } from '../../src/schedules/settings.js';
import type { SchedulesCast } from './schedules.js';
import { SCHEDULES_KEY } from './schedules.js';

export const HEAD = 'c'.repeat(40);
/** A neutral fake secret, long enough for the masker. */
export const API_KEY = 'sk-fake-0123456789abcdef';

export interface FixtureServer {
  readonly url: string;
  /** Headers of every request received, in order. */
  readonly seen: IncomingHttpHeaders[];
  /** Resolves when a request reaches `/hang`, which answers only once the server closes. */
  readonly hanging: Promise<void>;
  close(): Promise<void>;
}

/** `/ok` 200, `/fail` 500 echoing `x-key`, `/hang` never answers. */
export async function fixtureServer(): Promise<FixtureServer> {
  const seen: IncomingHttpHeaders[] = [];
  let hung: () => void = () => undefined;
  const hanging = new Promise<void>((done) => {
    hung = done;
  });
  const server: Server = createServer((request, response) => {
    seen.push(request.headers);
    if (request.url === '/hang') {
      hung();
      return;
    }
    const status = request.url === '/fail' ? 500 : 200;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ key: request.headers['x-key'] ?? null }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    hanging,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** A request that sends the schedule's `API_KEY` secret, and `extra` headers, and wants a 200. */
export function probe(name: string, url: string, extra: Record<string, string> = {}): RestRequestDef {
  return {
    ...createRestRequest(name, { id: `req-${name.toLowerCase()}`, url }),
    headers: [entry('X-Key', '${secret:API_KEY}'), ...Object.entries(extra).map(([name, value]) => entry(name, value))],
    assertions: [{ type: 'status', equals: 200 }],
  };
}

/** One workspace, its `Billing` project holding `requests`, and a `prod` environment. */
export async function workspaceSnapshot(
  requests: readonly RestRequestDef[],
  options: { readonly protectedProd?: boolean; readonly extra?: Record<string, string> } = {},
): Promise<SyncFile[]> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-schedule-ws-'));
  try {
    const prod: WorkspaceEnvironment = {
      id: 'env-prod',
      name: 'prod',
      slug: 'prod',
      order: 0,
      properties: {},
      endpoints: {},
      disabledProperties: [],
      ...(options.protectedProd === true ? { protected: true } : {}),
    };
    const base = createProject('Billing', { id: 'project-billing' });
    const project: Project = {
      ...base,
      containers: { ...base.containers, rest: [createApi('Api', { id: 'api', slug: 'api', requests: [...requests] })] },
    };
    await saveWorkspace(
      {
        ...createWorkspace('Smoke', { id: 'workspace-smoke' }),
        projects: [{ id: 'project-billing', slug: 'Billing', source: 'internal' }],
        environments: [prod],
      },
      dir,
    );
    await saveProject(project, workspaceProjectDir(dir, 'Billing'));
    const files: SyncFile[] = [];
    for (const item of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!item.isFile()) continue;
      const path = join(item.parentPath, item.name)
        .slice(dir.length + 1)
        .split('\\')
        .join('/');
      files.push({ path, encoding: 'base64', content: (await readFile(join(dir, path))).toString('base64') });
    }
    for (const [path, content] of Object.entries(options.extra ?? {})) {
      files.push({ path, encoding: 'utf8', content });
    }
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A logger that keeps each `error` call's arguments, and drops the rest. */
export function quietLog(errors: unknown[] = []): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const logger = {
    level: 'error',
    fatal: quiet,
    warn: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    error: (...args: unknown[]) => {
      errors.push(args);
    },
    child: (): unknown => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

export function testSettings(overrides: Partial<SchedulesSettings> = {}): SchedulesSettings {
  return {
    enabled: true,
    secretKey: Buffer.from(SCHEDULES_KEY, 'base64'),
    concurrency: 2,
    maxAgeDays: 90,
    maxSnapshotBytes: 1024 * 1024,
    publicUrl: 'https://wirebench.example.test',
    ...overrides,
  };
}

/** An executor over the cast's database, with `files` as the workspace head (`null`: nothing pushed). */
export function executorEnv(
  c: SchedulesCast,
  files: readonly SyncFile[] | null,
  tmpRoot: string,
  overrides: Partial<ExecutorEnv> = {},
): ExecutorEnv {
  return {
    db: c.h.db,
    hooks: c.h.hooks,
    settings: testSettings(),
    snapshot: () => Promise.resolve(files === null ? { head: null, files: [] } : { head: HEAD, files: [...files] }),
    tmpRoot,
    version: '0.0.0-test',
    now: () => c.h.clock.now,
    setTimer: c.timers.setTimer,
    log: quietLog(),
    ...overrides,
  };
}

/** A schedule of the cast's workspace with the `API_KEY` secret sealed, and one running run of it. */
export async function seedRun(
  c: SchedulesCast,
  input: {
    readonly target?: Partial<ScheduleTarget>;
    readonly options?: Partial<ScheduleOptions>;
    readonly secret?: boolean;
    readonly alerts?: StoredAlerts;
  } = {},
): Promise<{ readonly scheduleId: string; readonly runId: string }> {
  const scheduleId = newId();
  await repo.insertSchedule(c.h.db, {
    id: scheduleId,
    workspaceId: c.workspaceId,
    name: `Nightly ${scheduleId}`,
    cron: '0 3 * * *',
    timeZone: 'UTC',
    target: { project: 'Billing', environment: 'prod', ...input.target },
    options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false, ...input.options },
    alerts: input.alerts ?? { targets: [], muteAfter: 3 },
    enabled: true,
    nextRunAt: null,
    createdBy: c.admin.user.id,
    at: c.h.clock.now,
  });
  if (input.secret !== false) {
    const key = Buffer.from(SCHEDULES_KEY, 'base64');
    await repo.setScheduleSecrets(c.h.db, scheduleId, { API_KEY: sealValue(key, API_KEY) }, c.h.clock.now);
  }
  const runId = newId();
  await repo.insertRun(c.h.db, { id: runId, scheduleId, trigger: 'manual', status: 'running', at: c.h.clock.now });
  return { scheduleId, runId };
}
