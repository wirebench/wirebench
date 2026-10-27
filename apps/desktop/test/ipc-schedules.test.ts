// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, createProject, createRestRequest, WirebenchError } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerSchedulesChannels } = await import('../src/main/ipc/schedules.js');
const { channels } = await import('../src/shared/ipc.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const SCHEDULE_ID = '01J8ZC5Q0V7R3T9XK2M4N6S001';
const RUN_ID = '01J8ZE00000000000000000R01';
const REF = { url: SERVER, workspaceId: WS, scheduleId: SCHEDULE_ID };
const RUN = {
  id: RUN_ID,
  scheduleId: SCHEDULE_ID,
  trigger: 'manual',
  status: 'queued',
  reason: null,
  commit: null,
  environment: null,
  queuedAt: '2026-10-16T08:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  summary: null,
};
const SCHEDULE = {
  id: SCHEDULE_ID,
  workspaceId: WS,
  name: 'Smoke',
  cron: '*/5 * * * *',
  timeZone: 'UTC',
  target: { project: 'CountryInfo' },
  options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
  alerts: { targets: [{ kind: 'webhook', host: 'ops.example.com', hint: 'ab12', signed: true }], muteAfter: 3 },
  secrets: [{ name: 'API_KEY', hint: null }],
  enabled: true,
  nextRunAt: '2026-10-16T08:05:00.000Z',
  alertState: 'ok',
  failureStreak: 0,
  createdBy: null,
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  lastRun: null,
};
const DETAIL = {
  ...RUN,
  status: 'failed',
  results: [
    {
      path: 'CountryInfo/a.yaml',
      name: 'List',
      protocol: 'rest',
      outcome: 'failed',
      assertions: [{ type: 'status', label: 'Status', outcome: 'failed', message: 'expected 200, got 500' }],
    },
  ],
  alerts: [{ kind: 'failure', target: 0, state: 'dead', attempts: 8, lastError: 'ops.example.com: 503' }],
};

function fakeService() {
  return {
    available: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue([SCHEDULE]),
    get: vi.fn().mockResolvedValue(SCHEDULE),
    create: vi.fn().mockResolvedValue(SCHEDULE),
    update: vi.fn().mockResolvedValue(SCHEDULE),
    remove: vi.fn().mockResolvedValue(undefined),
    setSecrets: vi.fn().mockResolvedValue(SCHEDULE),
    testAlerts: vi.fn().mockResolvedValue({ results: [{ index: 0, kind: 'webhook', ok: false, error: '503' }] }),
    runNow: vi.fn().mockResolvedValue(RUN),
    runs: vi.fn().mockResolvedValue({ runs: [RUN], next: 'c1' }),
    run: vi.fn().mockResolvedValue(DETAIL),
    cancelRun: vi.fn().mockRejectedValue(new WirebenchError('schedules-run-finished', 'This run has finished.')),
    watch: vi.fn(),
    unwatch: vi.fn(),
  };
}

function deps(schedules = fakeService(), model: Project | null = shop()) {
  return {
    schedules,
    modelOf: () => model ?? undefined,
    registryOf: () => undefined,
    environmentsOf: () => [
      { id: 'E1', name: 'Dev' },
      { id: 'E2', name: 'Prod', protected: true },
    ],
  };
}

function shop(): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    containers: { rest: [createApi('Shop', { id: 'A1', requests: [createRestRequest('top', { id: 'top' })] })] },
  };
}

describe('schedules.* channels (#517)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers every channel the contract declares', () => {
    registerSchedulesChannels(table, deps());
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(channels.schedules)
        .map((c) => c.name)
        .sort(),
    );
  });

  it('passes each request to the service and answers in wire shapes', async () => {
    const schedules = fakeService();
    registerSchedulesChannels(table, deps(schedules));
    expect(await invoke('schedules.available', { url: SERVER })).toEqual({ ok: true, value: { available: true } });
    expect(await invoke('schedules.list', { url: SERVER, workspaceId: WS })).toEqual({
      ok: true,
      value: { schedules: [SCHEDULE] },
    });
    expect(await invoke('schedules.get', REF)).toEqual({ ok: true, value: { schedule: SCHEDULE } });
    await invoke('schedules.create', {
      url: SERVER,
      workspaceId: WS,
      name: 'Smoke',
      schedule: 'every 5m',
      target: { project: 'CountryInfo' },
    });
    expect(schedules.create).toHaveBeenCalledWith(SERVER, WS, {
      name: 'Smoke',
      schedule: 'every 5m',
      target: { project: 'CountryInfo' },
    });
    await invoke('schedules.update', { ...REF, enabled: false });
    expect(schedules.update).toHaveBeenCalledWith(REF, { enabled: false });
    expect(await invoke('schedules.remove', REF)).toEqual({ ok: true, value: { done: true } });
    await invoke('schedules.setSecrets', { ...REF, secrets: { API_KEY: 'v', OLD: null } });
    expect(schedules.setSecrets).toHaveBeenCalledWith(REF, { API_KEY: 'v', OLD: null });
    expect(await invoke('schedules.testAlerts', REF)).toEqual({
      ok: true,
      value: { results: [{ index: 0, kind: 'webhook', ok: false, error: '503' }] },
    });
    expect(await invoke('schedules.runNow', REF)).toEqual({ ok: true, value: { run: RUN } });
    expect(await invoke('schedules.runs', { ...REF, after: 'c1' })).toEqual({
      ok: true,
      value: { runs: [RUN], next: 'c1' },
    });
    expect(schedules.runs).toHaveBeenCalledWith(REF, { after: 'c1' });
    expect(await invoke('schedules.run', { ...REF, runId: RUN_ID })).toEqual({ ok: true, value: { run: DETAIL } });
    expect(schedules.run).toHaveBeenCalledWith(REF, RUN_ID);
    await invoke('schedules.watch', { url: SERVER, workspaceId: WS });
    await invoke('schedules.unwatch', { url: SERVER, workspaceId: WS });
    expect(schedules.watch).toHaveBeenCalledWith(SERVER, WS);
    expect(schedules.unwatch).toHaveBeenCalledWith(SERVER, WS);
  });

  it('answers a service refusal with its code', async () => {
    registerSchedulesChannels(table, deps());
    expect(await invoke('schedules.cancelRun', { ...REF, runId: RUN_ID })).toMatchObject({
      ok: false,
      error: { code: 'schedules-run-finished' },
    });
  });

  it('lists what a project can schedule, with its environments', async () => {
    registerSchedulesChannels(table, deps());
    expect(await invoke('schedules.choices', { projectId: 'P1' })).toEqual({
      ok: true,
      value: {
        items: [
          { id: 'A1', kind: 'api', label: 'Shop', depth: 0, selectors: ['Shop'] },
          { id: 'top', kind: 'request', label: 'top', depth: 1, selectors: ['Shop/top'] },
        ],
        sequences: [],
        environments: [
          { id: 'E1', name: 'Dev' },
          { id: 'E2', name: 'Prod', protected: true },
        ],
      },
    });
  });

  it('lists nothing for a project that is not open', async () => {
    registerSchedulesChannels(table, deps(fakeService(), null));
    expect(await invoke('schedules.choices', { projectId: 'P9' })).toEqual({
      ok: true,
      value: { items: [], sequences: [], environments: [] },
    });
  });

  it('fills in the target of an explorer row, or none', async () => {
    registerSchedulesChannels(table, deps());
    expect(await invoke('schedules.targetFor', { entityId: 'top' })).toEqual({
      ok: true,
      value: { target: { project: 'P1', select: ['Shop/top'] } },
    });
    expect(await invoke('schedules.targetFor', { entityId: 'nope' })).toEqual({ ok: true, value: { target: null } });
  });
});
