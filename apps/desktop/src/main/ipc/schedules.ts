/**
 * The `schedules.*` channels (scheduled-runs spec §3.7, #517). Each hands the request to
 * `SchedulesService`, which resolves the account's token; the token never crosses the bridge.
 */
import { channels } from '../../shared/ipc.js';
import type { SchedulesService } from '../schedules/schedules-service.js';
import { registerHandler } from './register.js';

export interface SchedulesChannelDeps {
  readonly schedules: Pick<
    SchedulesService,
    | 'available'
    | 'list'
    | 'get'
    | 'create'
    | 'update'
    | 'remove'
    | 'setSecrets'
    | 'testAlerts'
    | 'runNow'
    | 'runs'
    | 'run'
    | 'cancelRun'
    | 'watch'
    | 'unwatch'
  >;
}

const DONE = { done: true } as const;

export function registerSchedulesChannels(deps: SchedulesChannelDeps): void {
  const s = deps.schedules;
  const ref = (r: { readonly url: string; readonly workspaceId: string; readonly scheduleId: string }) => ({
    url: r.url,
    workspaceId: r.workspaceId,
    scheduleId: r.scheduleId,
  });

  registerHandler(channels.schedules.available, async (r) => ({ available: await s.available(r.url) }));
  registerHandler(channels.schedules.list, async (r) => ({ schedules: await s.list(r.url, r.workspaceId) }));
  registerHandler(channels.schedules.get, async (r) => ({ schedule: await s.get(ref(r)) }));
  registerHandler(channels.schedules.create, async ({ url, workspaceId, ...body }) => ({
    schedule: await s.create(url, workspaceId, body),
  }));
  registerHandler(channels.schedules.update, async ({ url, workspaceId, scheduleId, ...patch }) => ({
    schedule: await s.update({ url, workspaceId, scheduleId }, patch),
  }));
  registerHandler(channels.schedules.remove, async (r) => {
    await s.remove(ref(r));
    return DONE;
  });
  registerHandler(channels.schedules.setSecrets, async (r) => ({
    schedule: await s.setSecrets(ref(r), r.secrets),
  }));
  registerHandler(channels.schedules.testAlerts, (r) => s.testAlerts(ref(r)));
  registerHandler(channels.schedules.runNow, async (r) => ({ run: await s.runNow(ref(r)) }));
  registerHandler(channels.schedules.runs, ({ after, limit, status, ...r }) =>
    s.runs(ref(r), {
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(status !== undefined ? { status } : {}),
    }),
  );
  registerHandler(channels.schedules.run, async (r) => ({ run: await s.run(ref(r), r.runId) }));
  registerHandler(channels.schedules.cancelRun, async (r) => {
    await s.cancelRun(ref(r), r.runId);
    return DONE;
  });
  registerHandler(channels.schedules.watch, (r) => {
    s.watch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(channels.schedules.unwatch, (r) => {
    s.unwatch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
}
