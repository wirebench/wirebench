/**
 * A shared workspace's schedules for the renderer (scheduled-runs spec §13, issue #517).
 *
 * Every call goes to the server as it is asked for: schedules live on the server, and nothing here
 * keeps a copy. What the service owns is the live subscription for each (server, workspace) the
 * Schedules view watches, reference counted like the hooks service's:
 * - `schedule-run` tells the renderer which schedule's run finished, so it re-reads that schedule;
 * - a reconnect tells it to re-read everything, because a run could have finished while the socket
 *   was down.
 *
 * Electron-free, like the other server modules of main (`server-token.ts`).
 */
import type {
  AlertTestResponse,
  Schedule,
  ScheduleRun,
  ScheduleRunDetail,
  ScheduleRunPage,
  ScheduleRunStatus,
  ScheduleSecrets,
  ScheduleUpdate,
} from '@wirebench/engine';
import type { LiveEvent, LiveState } from '../live/live-client.js';
import type { LiveClients } from '../live/live-clients.js';
import { normalizeServerUrl, type ScheduleCreateInput, type ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';

/** The server capability the module announces in `/meta` (scheduled-runs spec §5.2). */
export const SCHEDULES_CAPABILITY = 'scheduled-runs';

export interface ScheduleRef {
  readonly url: string;
  readonly workspaceId: string;
  readonly scheduleId: string;
}

/** What the renderer hears: one schedule's run finished, or (no `scheduleId`) re-read them all. */
export interface SchedulesChangedEvent {
  readonly url: string;
  readonly workspaceId: string;
  readonly scheduleId?: string;
  readonly runId?: string;
  readonly status?: ScheduleRunStatus;
}

export interface SchedulesEmitter {
  changed(event: SchedulesChangedEvent): void;
}

export interface SchedulesServiceDeps {
  readonly client: Pick<
    ServerClient,
    | 'meta'
    | 'listSchedules'
    | 'getSchedule'
    | 'createSchedule'
    | 'updateSchedule'
    | 'deleteSchedule'
    | 'setScheduleSecrets'
    | 'testScheduleAlerts'
    | 'runScheduleNow'
    | 'listScheduleRuns'
    | 'getScheduleRun'
    | 'cancelScheduleRun'
  >;
  readonly accounts: TokenSource;
  readonly live: Pick<LiveClients, 'subscribe'>;
  readonly emit: SchedulesEmitter;
}

interface Watch {
  count: number;
  stop: () => void;
  /** The last state the subscription reported; `undefined` until its first. */
  state: LiveState | undefined;
}

const watchKey = (url: string, workspaceId: string): string => `${url} ${workspaceId}`;

export class SchedulesService {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: SchedulesServiceDeps) {}

  /**
   * Whether the server runs schedules: it announces the module and its edition is Enterprise. A server
   * without either has no Schedules view (#517). No token needed. A license that lapses later answers
   * each call with `licensing-feature-required`, which the view shows.
   */
  async available(url: string): Promise<boolean> {
    const meta = await this.deps.client.meta(normalizeServerUrl(url));
    return meta.capabilities.includes(SCHEDULES_CAPABILITY) && meta.edition === 'enterprise';
  }

  list(url: string, workspaceId: string): Promise<Schedule[]> {
    return withToken(this.deps, url, (origin, token) => this.deps.client.listSchedules(origin, token, workspaceId));
  }

  get(ref: ScheduleRef): Promise<Schedule> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.getSchedule(origin, token, ref.workspaceId, ref.scheduleId),
    );
  }

  create(url: string, workspaceId: string, body: ScheduleCreateInput): Promise<Schedule> {
    return withToken(this.deps, url, (origin, token) =>
      this.deps.client.createSchedule(origin, token, workspaceId, body),
    );
  }

  update(ref: ScheduleRef, patch: ScheduleUpdate): Promise<Schedule> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.updateSchedule(origin, token, ref.workspaceId, ref.scheduleId, patch),
    );
  }

  async remove(ref: ScheduleRef): Promise<void> {
    await withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.deleteSchedule(origin, token, ref.workspaceId, ref.scheduleId),
    );
  }

  setSecrets(ref: ScheduleRef, secrets: ScheduleSecrets): Promise<Schedule> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.setScheduleSecrets(origin, token, ref.workspaceId, ref.scheduleId, secrets),
    );
  }

  testAlerts(ref: ScheduleRef): Promise<AlertTestResponse> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.testScheduleAlerts(origin, token, ref.workspaceId, ref.scheduleId),
    );
  }

  runNow(ref: ScheduleRef): Promise<ScheduleRun> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.runScheduleNow(origin, token, ref.workspaceId, ref.scheduleId),
    );
  }

  runs(
    ref: ScheduleRef,
    page: { readonly after?: string; readonly limit?: number; readonly status?: ScheduleRunStatus },
  ): Promise<ScheduleRunPage> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.listScheduleRuns(origin, token, ref.workspaceId, ref.scheduleId, page),
    );
  }

  run(ref: ScheduleRef, runId: string): Promise<ScheduleRunDetail> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.getScheduleRun(origin, token, ref.workspaceId, ref.scheduleId, runId),
    );
  }

  async cancelRun(ref: ScheduleRef, runId: string): Promise<void> {
    await withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.cancelScheduleRun(origin, token, ref.workspaceId, ref.scheduleId, runId),
    );
  }

  /** Follows the workspace's live messages until the matching {@link unwatch}. */
  watch(url: string, workspaceId: string): void {
    const origin = normalizeServerUrl(url);
    const key = watchKey(origin, workspaceId);
    const existing = this.watches.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    const watch: Watch = { count: 1, stop: () => undefined, state: undefined };
    this.watches.set(key, watch);
    watch.stop = this.deps.live.subscribe(origin, workspaceId, (event) => {
      this.onLive(origin, workspaceId, event);
    });
  }

  unwatch(url: string, workspaceId: string): void {
    const key = watchKey(normalizeServerUrl(url), workspaceId);
    const watch = this.watches.get(key);
    if (watch === undefined) return;
    watch.count -= 1;
    if (watch.count > 0) return;
    this.watches.delete(key);
    watch.stop();
  }

  /** Ends every subscription; the app calls it on quit. */
  dispose(): void {
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
  }

  private onLive(url: string, workspaceId: string, event: LiveEvent): void {
    const watch = this.watches.get(watchKey(url, workspaceId));
    if (watch === undefined) return;
    if (event.kind === 'state') {
      const before = watch.state;
      watch.state = event.state;
      // Back after a drop: any run may have finished meanwhile.
      if (event.state === 'connected' && before !== undefined && before !== 'connected') {
        this.deps.emit.changed({ url, workspaceId });
      }
      return;
    }
    const message = event.message;
    if (message.type !== 'schedule-run') return;
    this.deps.emit.changed({
      url,
      workspaceId,
      scheduleId: message.scheduleId,
      runId: message.runId,
      status: message.status,
    });
  }
}
