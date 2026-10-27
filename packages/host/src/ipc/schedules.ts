/**
 * The `schedules.*` channels (scheduled-runs spec §3.7, #517). Each hands the request to
 * `SchedulesService`, which resolves the account's token; the token never crosses the bridge.
 */
import type { Project, ProtocolRegistry } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { SchedulesService } from '../schedules/schedules-service.js';
import { scheduleChoices, scheduleTargetFor } from '../schedules/targets.js';
import { registerHandler, type HandlerTable } from './register.js';

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
  /** The open model of the project that owns `entityId`; throws `unknown-entity` for none. */
  readonly modelOf: (entityId: string) => Project | undefined;
  /** The protocol registry the project's runs use; `undefined` for the built-in one. */
  readonly registryOf: (entityId: string) => ProtocolRegistry | undefined;
  /** The environments a run of the project can use, in order. */
  readonly environmentsOf: (projectId: string) => readonly {
    readonly id: string;
    readonly name: string;
    readonly protected?: boolean;
  }[];
}

const DONE = { done: true } as const;

export function registerSchedulesChannels(table: HandlerTable, deps: SchedulesChannelDeps): void {
  const s = deps.schedules;
  const ref = (r: { readonly url: string; readonly workspaceId: string; readonly scheduleId: string }) => ({
    url: r.url,
    workspaceId: r.workspaceId,
    scheduleId: r.scheduleId,
  });

  registerHandler(table, channels.schedules.available, async (r) => ({ available: await s.available(r.url) }));
  registerHandler(table, channels.schedules.list, async (r) => ({ schedules: await s.list(r.url, r.workspaceId) }));
  registerHandler(table, channels.schedules.get, async (r) => ({ schedule: await s.get(ref(r)) }));
  registerHandler(table, channels.schedules.create, async ({ url, workspaceId, ...body }) => ({
    schedule: await s.create(url, workspaceId, body),
  }));
  registerHandler(table, channels.schedules.update, async ({ url, workspaceId, scheduleId, ...patch }) => ({
    schedule: await s.update({ url, workspaceId, scheduleId }, patch),
  }));
  registerHandler(table, channels.schedules.remove, async (r) => {
    await s.remove(ref(r));
    return DONE;
  });
  registerHandler(table, channels.schedules.setSecrets, async (r) => ({
    schedule: await s.setSecrets(ref(r), r.secrets),
  }));
  registerHandler(table, channels.schedules.testAlerts, (r) => s.testAlerts(ref(r)));
  registerHandler(table, channels.schedules.runNow, async (r) => ({ run: await s.runNow(ref(r)) }));
  registerHandler(table, channels.schedules.runs, ({ after, limit, status, ...r }) =>
    s.runs(ref(r), {
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(status !== undefined ? { status } : {}),
    }),
  );
  registerHandler(table, channels.schedules.run, async (r) => ({ run: await s.run(ref(r), r.runId) }));
  registerHandler(table, channels.schedules.cancelRun, async (r) => {
    await s.cancelRun(ref(r), r.runId);
    return DONE;
  });
  registerHandler(table, channels.schedules.choices, (r) => {
    const project = deps.modelOf(r.projectId);
    if (project === undefined) return Promise.resolve({ items: [], sequences: [], environments: [] });
    const choices = scheduleChoices(project, deps.registryOf(r.projectId));
    const environments = deps.environmentsOf(r.projectId).map((environment) => ({
      id: environment.id,
      name: environment.name,
      ...(environment.protected === true ? { protected: true } : {}),
    }));
    return Promise.resolve({ ...choices, environments });
  });
  registerHandler(table, channels.schedules.targetFor, (r) => {
    const project = deps.modelOf(r.entityId);
    const target =
      project === undefined ? undefined : scheduleTargetFor(project, r.entityId, deps.registryOf(r.entityId));
    return Promise.resolve({ target: target ?? null });
  });
  registerHandler(table, channels.schedules.watch, (r) => {
    s.watch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(table, channels.schedules.unwatch, (r) => {
    s.unwatch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
}
