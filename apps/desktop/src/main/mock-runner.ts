/**
 * The mocks the desktop is running (#59): at most one server per mock id, started from the project's
 * in-memory model and its folder's definition cache, restarted when the project changes under it, and
 * stopped when its project closes or the app quits.
 *
 * Events go back to the window that started the mock, never to every window: one workspace's mock log
 * is not another's.
 */

import { isWirebenchError, startMock } from '@wirebench/engine';
import type { MockDef, MockExchangeEvent, Project, RunningMock, StartMockInput } from '@wirebench/engine';
import type { MockStateEvent } from '../shared/wire-types.js';

/** Where a started mock's events go: the window that started it. */
export interface MockSink {
  readonly state: (event: MockStateEvent) => void;
  readonly exchange: (mockId: string, event: MockExchangeEvent) => void;
}

/** What starting a mock needs: its project as it is now, the folder, and who is listening. */
export interface MockStartContext {
  readonly projectId: string;
  /** The window that started it (its web contents' id): a workspace closing stops its own mocks only. */
  readonly owner: number;
  readonly project: Project;
  readonly dir: string;
  readonly sink: MockSink;
  /** `0.0.0.0` when the preference says so; loopback otherwise. */
  readonly host: string;
}

interface Active {
  readonly projectId: string;
  readonly owner: number;
  readonly dir: string;
  readonly sink: MockSink;
  readonly host: string;
  /** The mock as it was started, to tell whether a project change touched it. */
  readonly fingerprint: string;
  readonly server: RunningMock;
}

export interface MockRunnerOptions {
  /** The engine's `startMock`; a test passes a fake. */
  readonly start?: (input: StartMockInput) => Promise<RunningMock>;
}

function fingerprintOf(mock: MockDef): string {
  return JSON.stringify(mock);
}

function messageOf(error: unknown): string {
  return isWirebenchError(error) || error instanceof Error ? error.message : String(error);
}

export const MOCK_LOOPBACK_HOST = '127.0.0.1';
export const MOCK_ALL_INTERFACES_HOST = '0.0.0.0';

export class MockRunner {
  private readonly active = new Map<string, Active>();
  /** One start, stop or restart at a time per mock, so two quick clicks never race for the port. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly start: (input: StartMockInput) => Promise<RunningMock>;

  constructor(options: MockRunnerOptions = {}) {
    this.start = options.start ?? startMock;
  }

  private serial<T>(mockId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(mockId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(mockId, settled);
    void settled.then(() => {
      if (this.queues.get(mockId) === settled) this.queues.delete(mockId);
    });
    return next;
  }

  /** Whether `mockId` is running, and where. */
  stateOf(mockId: string): MockStateEvent {
    const entry = this.active.get(mockId);
    return entry === undefined ? { mockId, running: false, warnings: [] } : this.runningState(mockId, entry);
  }

  private runningState(mockId: string, entry: Active): MockStateEvent {
    return {
      mockId,
      running: true,
      url: entry.server.url,
      exposed: entry.host !== MOCK_LOOPBACK_HOST,
      warnings: entry.server.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    };
  }

  /**
   * Starts `mockId`, or restarts it when it is already running. A failure to start is reported as a
   * stopped state with its `error`, and rethrown.
   */
  startMock(mockId: string, context: MockStartContext): Promise<MockStateEvent> {
    return this.serial(mockId, async () => {
      const previous = this.active.get(mockId);
      if (previous !== undefined) {
        this.active.delete(mockId);
        await previous.server.stop();
      }
      return this.launch(mockId, context, previous?.server.port);
    });
  }

  private async launch(mockId: string, context: MockStartContext, keepPort?: number): Promise<MockStateEvent> {
    const mock = context.project.mocks.find((candidate) => candidate.id === mockId);
    try {
      const server = await this.start({
        project: context.project,
        root: context.dir,
        mockId,
        host: context.host,
        // A restart keeps the port a `port: 0` mock was given, so its URL survives an edit.
        ...(keepPort !== undefined && mock?.port === 0 ? { port: keepPort } : {}),
        onExchange: (event) => {
          context.sink.exchange(mockId, event);
        },
      });
      const entry: Active = {
        projectId: context.projectId,
        owner: context.owner,
        dir: context.dir,
        sink: context.sink,
        host: context.host,
        fingerprint: mock === undefined ? '' : fingerprintOf(mock),
        server,
      };
      this.active.set(mockId, entry);
      const state = this.runningState(mockId, entry);
      context.sink.state(state);
      return state;
    } catch (error) {
      context.sink.state({ mockId, running: false, warnings: [], error: messageOf(error) });
      throw error;
    }
  }

  /** Stops `mockId`; false when it was not running. */
  stopMock(mockId: string): Promise<boolean> {
    return this.serial(mockId, async () => {
      const entry = this.active.get(mockId);
      if (entry === undefined) return false;
      this.active.delete(mockId);
      await entry.server.stop();
      entry.sink.state({ mockId, running: false, warnings: [] });
      return true;
    });
  }

  /** Puts every scenario of `mockId` back to its start state; false when it is not running. */
  reset(mockId: string): boolean {
    const entry = this.active.get(mockId);
    if (entry === undefined) return false;
    entry.server.reset();
    return true;
  }

  /**
   * After a change to `projectId`: a running mock the project no longer has stops, and one whose
   * definition changed restarts with the new one. A change that did not touch a mock leaves it — and
   * its scenario states — alone.
   */
  async projectChanged(projectId: string, project: Project | undefined): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const [mockId, entry] of this.active) {
      if (entry.projectId !== projectId) continue;
      const mock = project?.mocks.find((candidate) => candidate.id === mockId);
      if (project === undefined || mock === undefined) {
        work.push(this.stopMock(mockId));
      } else if (fingerprintOf(mock) !== entry.fingerprint) {
        const context = { projectId, owner: entry.owner, project, dir: entry.dir, sink: entry.sink, host: entry.host };
        work.push(this.startMock(mockId, context).catch(() => undefined));
      }
    }
    await Promise.all(work);
  }

  /** Stops every mock `matches` picks: a project or a workspace closing. */
  async stopWhere(matches: (owner: { readonly projectId: string; readonly owner: number }) => boolean): Promise<void> {
    const ids = [...this.active].filter(([, entry]) => matches(entry)).map(([mockId]) => mockId);
    await Promise.all(ids.map((mockId) => this.stopMock(mockId).catch(() => false)));
  }

  /** Stops everything: the app is quitting. */
  stopAll(): Promise<void> {
    return this.stopWhere(() => true);
  }

  /** The ids of every running mock. */
  runningIds(): string[] {
    return [...this.active.keys()];
  }

  /** How many mocks are running. */
  get size(): number {
    return this.active.size;
  }
}
