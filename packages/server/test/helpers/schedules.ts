/**
 * A server with the scheduled-runs module (scheduled-runs spec §11): licensing with a test key, audit-log
 * recording, a team with an admin, an editor and a viewer, and one workspace. `install` sets the edition.
 */
import type { Feature } from '@wirebench/engine';
import { auditLogModule } from '../../src/audit-log/module.js';
import type { ServerModule } from '../../src/context.js';
import { schedulesModule } from '../../src/schedules/module.js';
import type { Scheduler } from '../../src/schedules/scheduler.js';
import { upsertGrant } from '../../src/teams/repo.js';
import { signedInUser, type IdentityHarness, type SignedInUser, type TestClock } from './identity.js';
import { license, licensingHarness, testKeys } from './licensing.js';
import { seedTeam, seedWorkspace } from './teams.js';
import { manualTimers, type ManualTimers } from './timers.js';

/** The schedules key every harness starts with, unless `env` overrides it. */
export const SCHEDULES_KEY = Buffer.alloc(32, 9).toString('base64');

export interface SchedulesCast {
  readonly h: IdentityHarness;
  readonly timers: ManualTimers;
  /** A server admin, who installs licenses. */
  readonly root: SignedInUser;
  /** The workspace's team admin: a workspace admin. */
  readonly admin: SignedInUser;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  /** On the server, in no team. */
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
  /** The module's scheduler, which passes only when the test asks (`runOnce`). */
  scheduler(): Scheduler;
  /** Runs the scheduler started, each held until it is aborted or the test releases it. */
  readonly started: HeldRun[];
  install(edition: 'team' | 'enterprise', features?: readonly Feature[]): Promise<void>;
  close(): Promise<void>;
}

export interface HeldRun {
  readonly runId: string;
  readonly signal: AbortSignal;
  release(): void;
}

export async function schedulesHarness(
  options: {
    readonly env?: Record<string, string>;
    /** The modules after licensing; by default scheduled-runs and audit-log. */
    readonly modules?: (clock: TestClock, timers: ManualTimers) => readonly ServerModule[];
    /** Installs an Enterprise license before returning; true unless false. */
    readonly enterprise?: boolean;
  } = {},
): Promise<SchedulesCast> {
  const keys = testKeys();
  const timers = manualTimers();
  const started: HeldRun[] = [];
  let scheduler: Scheduler | undefined;
  const execute = (runId: string, signal: AbortSignal): Promise<void> =>
    new Promise<void>((done) => {
      // A run claimed during a stop starts already aborted.
      if (signal.aborted) done();
      else signal.addEventListener('abort', () => done(), { once: true });
      started.push({ runId, signal, release: done });
    });
  const h = await licensingHarness(keys, {
    env: { WIREBENCH_SERVER_SCHEDULES_SECRET_KEY: SCHEDULES_KEY, ...options.env },
    extra: (clock) =>
      options.modules?.(clock, timers) ?? [
        schedulesModule({
          now: () => clock.now,
          setTimer: timers.setTimer,
          startScheduler: false,
          execute,
          onScheduler: (made) => {
            scheduler = made;
          },
        }),
        auditLogModule({ now: () => clock.now, setTimer: timers.setTimer }),
      ],
  });
  const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const team = await seedTeam(h, { name: 'Operations', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Smoke', defaultRole: 'viewer' });
  await upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  const install = async (edition: 'team' | 'enterprise', features?: readonly Feature[]): Promise<void> => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: root.headers,
      payload: { license: license(keys, { edition, ...(features !== undefined ? { features: [...features] } : {}) }) },
    });
    if (res.statusCode !== 200) {
      throw new Error(`license install answered ${res.statusCode}: ${res.body}`);
    }
  };
  if (options.enterprise !== false) {
    await install('enterprise');
  }
  return {
    h,
    timers,
    root,
    admin,
    editor,
    viewer,
    stranger,
    workspaceId,
    scheduler: () => {
      if (scheduler === undefined) throw new Error('this harness has no scheduled-runs module');
      return scheduler;
    },
    started,
    install,
    close: () => h.close(),
  };
}
