// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError, type MetaResponse } from '@wirebench/engine';
import type { LiveEvent } from '../../src/main/live/live-client.js';
import {
  SchedulesService,
  type SchedulesChangedEvent,
  type SchedulesServiceDeps,
} from '../../src/main/schedules/schedules-service.js';

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const SCHEDULE = '01J8ZC5Q0V7R3T9XK2M4N6S001';
const RUN = '01J8ZE00000000000000000R01';
const REF = { url: `${SERVER}/some/path`, workspaceId: WS, scheduleId: SCHEDULE };
const TOKEN = 'wbs_token';

const META: MetaResponse = {
  name: 'wirebench-server',
  version: '6.1.0',
  apiVersion: 1,
  publicUrl: SERVER,
  auth: { local: true, oidc: false },
  capabilities: ['scheduled-runs'],
  edition: 'enterprise',
};

function harness(options: { token?: string | undefined; meta?: MetaResponse } = {}) {
  const listeners: ((event: LiveEvent) => void)[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const subscribe = vi.fn((_url: string, _workspaceId: string, listener: (event: LiveEvent) => void) => {
    listeners.push(listener);
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  const resolved = <T>(value: T) => vi.fn(() => Promise.resolve(value));
  const client = {
    meta: resolved(options.meta ?? META),
    listSchedules: resolved([]),
    getSchedule: resolved({}),
    createSchedule: resolved({}),
    updateSchedule: resolved({}),
    deleteSchedule: resolved(undefined),
    setScheduleSecrets: resolved({}),
    testScheduleAlerts: resolved({ results: [] }),
    runScheduleNow: resolved({}),
    listScheduleRuns: resolved({ runs: [] }),
    getScheduleRun: resolved({}),
    cancelScheduleRun: resolved(undefined),
  };
  const markSignedOut = vi.fn();
  const changed: SchedulesChangedEvent[] = [];
  const deps = {
    client,
    accounts: {
      tokenFor: vi.fn(() => Promise.resolve('token' in options ? options.token : TOKEN)),
      markSignedOut,
    },
    live: { subscribe },
    emit: { changed: (event: SchedulesChangedEvent) => changed.push(event) },
  } as unknown as SchedulesServiceDeps;
  return { service: new SchedulesService(deps), client, subscribe, listeners, stops, changed, markSignedOut };
}

describe('SchedulesService', () => {
  it('is available only on an Enterprise server that announces the module', async () => {
    expect(await harness().service.available(SERVER)).toBe(true);
    expect(await harness({ meta: { ...META, edition: 'team' } }).service.available(SERVER)).toBe(false);
    expect(await harness({ meta: { ...META, capabilities: [] } }).service.available(SERVER)).toBe(false);
    const older: MetaResponse = { ...META };
    delete older.edition;
    expect(await harness({ meta: older }).service.available(SERVER)).toBe(false);
  });

  it('calls each route on the origin with the account token', async () => {
    const { service, client } = harness();
    await service.list(SERVER, WS);
    await service.get(REF);
    await service.create(SERVER, WS, { name: 'Smoke', schedule: '@hourly', target: { project: 'Api' } });
    await service.update(REF, { enabled: false });
    await service.remove(REF);
    await service.setSecrets(REF, { API_KEY: 'v' });
    await service.testAlerts(REF);
    await service.runNow(REF);
    await service.runs(REF, { after: 'c1', limit: 20 });
    await service.run(REF, RUN);
    await service.cancelRun(REF, RUN);
    expect(client.listSchedules).toHaveBeenCalledWith(SERVER, TOKEN, WS);
    expect(client.getSchedule).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE);
    expect(client.createSchedule).toHaveBeenCalledWith(SERVER, TOKEN, WS, {
      name: 'Smoke',
      schedule: '@hourly',
      target: { project: 'Api' },
    });
    expect(client.updateSchedule).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE, { enabled: false });
    expect(client.deleteSchedule).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE);
    expect(client.setScheduleSecrets).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE, { API_KEY: 'v' });
    expect(client.testScheduleAlerts).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE);
    expect(client.runScheduleNow).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE);
    expect(client.listScheduleRuns).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE, { after: 'c1', limit: 20 });
    expect(client.getScheduleRun).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE, RUN);
    expect(client.cancelScheduleRun).toHaveBeenCalledWith(SERVER, TOKEN, WS, SCHEDULE, RUN);
  });

  it('refuses without a token and signs the account out when the server rejects it', async () => {
    await expect(harness({ token: undefined }).service.list(SERVER, WS)).rejects.toMatchObject({
      code: 'account-signed-out',
    });
    const { service, client, markSignedOut } = harness();
    client.listSchedules.mockRejectedValueOnce(new WirebenchError('identity-unauthenticated', 'expired'));
    await expect(service.list(SERVER, WS)).rejects.toMatchObject({ code: 'identity-unauthenticated' });
    expect(markSignedOut).toHaveBeenCalledWith(SERVER);
  });

  it('turns a schedule-run message into a change for that schedule', () => {
    const { service, listeners, changed } = harness();
    service.watch(SERVER, WS);
    listeners[0]?.({
      kind: 'message',
      message: { type: 'schedule-run', workspaceId: WS, scheduleId: SCHEDULE, runId: RUN, status: 'passed' },
    });
    listeners[0]?.({ kind: 'message', message: { type: 'hooks', workspaceId: WS } });
    expect(changed).toEqual([{ url: SERVER, workspaceId: WS, scheduleId: SCHEDULE, runId: RUN, status: 'passed' }]);
  });

  it('asks for a full re-read after a reconnect, not on the first connect', () => {
    const { service, listeners, changed } = harness();
    service.watch(SERVER, WS);
    listeners[0]?.({ kind: 'state', state: 'connected' });
    listeners[0]?.({ kind: 'state', state: 'connecting' });
    listeners[0]?.({ kind: 'state', state: 'connected' });
    expect(changed).toEqual([{ url: SERVER, workspaceId: WS }]);
  });

  it('subscribes once per workspace and stops with the last unwatch', () => {
    const { service, subscribe, stops, listeners, changed } = harness();
    service.watch(SERVER, WS);
    service.watch(`${SERVER}/`, WS);
    expect(subscribe).toHaveBeenCalledTimes(1);
    service.unwatch(SERVER, WS);
    expect(stops[0]).not.toHaveBeenCalled();
    service.unwatch(SERVER, WS);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    listeners[0]?.({
      kind: 'message',
      message: { type: 'schedule-run', workspaceId: WS, scheduleId: SCHEDULE, runId: RUN, status: 'failed' },
    });
    expect(changed).toEqual([]);
    service.unwatch(SERVER, WS);
    service.watch(SERVER, WS);
    service.dispose();
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });
});
