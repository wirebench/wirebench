// @vitest-environment node
/**
 * The desktop's mock runner (#59): one server per mock, restarted only when an edit touches the mock
 * (keeping a `port: 0` mock's port), stopped when the mock or its project goes, and a closing window
 * stopping only the mocks it started.
 */
import { describe, expect, it } from 'vitest';
import { createMock, createProject, WirebenchError } from '@wirebench/engine';
import type { MockDef, Project, RunningMock, StartMockInput } from '@wirebench/engine';
import { MockRunner } from '../src/main/mock-runner.js';
import type { MockSink } from '../src/main/mock-runner.js';
import type { MockStateEvent } from '../src/shared/wire-types.js';

function fakeServers() {
  const starts: StartMockInput[] = [];
  let stops = 0;
  let resets = 0;
  let nextPort = 40_000;
  const start = (input: StartMockInput): Promise<RunningMock> => {
    starts.push(input);
    if (input.mockId === 'broken') {
      return Promise.reject(new WirebenchError('mock-port-in-use', 'Port 8089 is in use'));
    }
    const port = input.port ?? nextPort++;
    return Promise.resolve({
      url: `http://${input.host ?? '127.0.0.1'}:${port}/`,
      host: input.host ?? '127.0.0.1',
      port,
      warnings: [],
      reset: () => {
        resets += 1;
      },
      stop: () => {
        stops += 1;
        return Promise.resolve();
      },
    });
  };
  return { start, starts, stops: () => stops, resets: () => resets };
}

function projectWith(...mocks: MockDef[]): Project {
  return { ...createProject('P', { id: 'P1' }), mocks };
}

function sink(states: MockStateEvent[]): MockSink {
  return { state: (event) => states.push(event), exchange: () => undefined };
}

const mock = (id: string, port = 0): MockDef => createMock(id, { containerId: 'C1' }, { id, port });

describe('MockRunner', () => {
  it('starts, reports where it listens, resets and stops', async () => {
    const servers = fakeServers();
    const runner = new MockRunner({ start: servers.start });
    const states: MockStateEvent[] = [];
    const context = {
      projectId: 'P1',
      owner: 1,
      project: projectWith(mock('M1')),
      dir: '/p',
      sink: sink(states),
      host: '127.0.0.1',
    };
    const started = await runner.startMock('M1', context);
    expect(started).toMatchObject({ mockId: 'M1', running: true, url: 'http://127.0.0.1:40000/', exposed: false });
    expect(runner.reset('M1')).toBe(true);
    expect(servers.resets()).toBe(1);
    expect(await runner.stopMock('M1')).toBe(true);
    expect(await runner.stopMock('M1')).toBe(false);
    expect(states.map((state) => state.running)).toEqual([true, false]);
    expect(runner.reset('M1')).toBe(false);
  });

  it('says it listens on every interface when started that way', async () => {
    const runner = new MockRunner({ start: fakeServers().start });
    const context = {
      projectId: 'P1',
      owner: 1,
      project: projectWith(mock('M1')),
      dir: '/p',
      sink: sink([]),
      host: '0.0.0.0',
    };
    expect((await runner.startMock('M1', context)).exposed).toBe(true);
  });

  it('reports a failed start as a stopped state with the reason', async () => {
    const runner = new MockRunner({ start: fakeServers().start });
    const states: MockStateEvent[] = [];
    const context = {
      projectId: 'P1',
      owner: 1,
      project: projectWith(mock('broken')),
      dir: '/p',
      sink: sink(states),
      host: '127.0.0.1',
    };
    await expect(runner.startMock('broken', context)).rejects.toMatchObject({ code: 'mock-port-in-use' });
    expect(states).toEqual([{ mockId: 'broken', running: false, warnings: [], error: 'Port 8089 is in use' }]);
  });

  it('restarts on an edit to the mock, keeping its port, and leaves it alone otherwise', async () => {
    const servers = fakeServers();
    const runner = new MockRunner({ start: servers.start });
    const project = projectWith(mock('M1'), mock('M2', 9000));
    const context = { projectId: 'P1', owner: 1, project, dir: '/p', sink: sink([]), host: '127.0.0.1' };
    await runner.startMock('M1', context);
    await runner.startMock('M2', context);

    await runner.projectChanged('P1', { ...project, name: 'Renamed' });
    expect(servers.starts).toHaveLength(2);

    const edited = { ...project, mocks: [{ ...project.mocks[0]!, path: '/v2' }, project.mocks[1]!] };
    await runner.projectChanged('P1', edited);
    expect(servers.starts).toHaveLength(3);
    expect(servers.starts[2]).toMatchObject({ mockId: 'M1', port: 40000 });
    expect(runner.stateOf('M1').url).toBe('http://127.0.0.1:40000/');

    await runner.projectChanged('P1', { ...edited, mocks: [edited.mocks[0]!] });
    expect(runner.runningIds()).toEqual(['M1']);
    await runner.projectChanged('P1', undefined);
    expect(runner.size).toBe(0);
  });

  it('stops by project, or every mock one window started', async () => {
    const runner = new MockRunner({ start: fakeServers().start });
    const base = { dir: '/p', sink: sink([]), host: '127.0.0.1' };
    await runner.startMock('M1', { ...base, projectId: 'P1', owner: 1, project: projectWith(mock('M1')) });
    await runner.startMock('M2', { ...base, projectId: 'P2', owner: 1, project: projectWith(mock('M2')) });
    await runner.startMock('M3', { ...base, projectId: 'P3', owner: 2, project: projectWith(mock('M3')) });
    await runner.stopWhere((entry) => entry.projectId === 'P1');
    expect(runner.runningIds().sort()).toEqual(['M2', 'M3']);
    await runner.stopWhere((entry) => entry.owner === 1);
    expect(runner.runningIds()).toEqual(['M3']);
    await runner.stopAll();
    expect(runner.size).toBe(0);
  });

  it('runs one start at a time per mock, so a double click ends with one server', async () => {
    const servers = fakeServers();
    const runner = new MockRunner({ start: servers.start });
    const context = {
      projectId: 'P1',
      owner: 1,
      project: projectWith(mock('M1', 9000)),
      dir: '/p',
      sink: sink([]),
      host: '127.0.0.1',
    };
    await Promise.all([runner.startMock('M1', context), runner.startMock('M1', context)]);
    expect(servers.starts).toHaveLength(2);
    expect(servers.stops()).toBe(1);
    expect(runner.size).toBe(1);
  });
});
