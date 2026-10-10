/**
 * `wirebench mock` (#61, docs/specs/2026-10-08-headless-mock-design.md): starts the engine's mock server
 * for each selected mock and serves until SIGINT or SIGTERM. stdout carries the listening lines and the
 * request log, as text or JSON lines; warnings and errors go to stderr.
 */
import { join } from 'node:path';
import { isWirebenchError, loadProject, startMock } from '@wirebench/engine';
import type { MockDef, MockExchangeEvent, Project, RunningMock } from '@wirebench/engine';
import { UsageError } from '../args.js';
import type { MockArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { exists } from '../workspace-lookup.js';
import { stopped } from './mcp.js';
import { refuseWorkspace } from './run.js';

/** Read when `--host` is absent; the CLI image sets it to `0.0.0.0`. */
export const MOCK_HOST_VARIABLE = 'WIREBENCH_MOCK_HOST';

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

function describeMocks(project: Project): string {
  return project.mocks.map((mock) => `  ${mock.name} (${mock.slug}, ${mock.id})`).join('\n');
}

/** The mocks `names` select, each once, in the project's order; every mock when `names` is empty. */
export function selectMocks(project: Project, names: readonly string[]): readonly MockDef[] {
  if (project.mocks.length === 0) {
    throw new UsageError('The project has no mocks');
  }
  if (names.length === 0) {
    return project.mocks;
  }
  const chosen = new Set<MockDef>();
  for (const name of names) {
    const byId = project.mocks.filter((mock) => mock.id === name);
    const bySlug = project.mocks.filter((mock) => mock.slug === name);
    const byName = project.mocks.filter((mock) => mock.name === name);
    const matches = byId.length > 0 ? byId : bySlug.length > 0 ? bySlug : byName;
    if (matches.length !== 1) {
      throw new UsageError(
        `${matches.length === 0 ? 'No mock is named' : 'More than one mock is named'} "${name}"; the project's mocks:\n${describeMocks(project)}`,
      );
    }
    chosen.add(matches[0] as MockDef);
  }
  return project.mocks.filter((mock) => chosen.has(mock));
}

function exchangeLine(mock: MockDef, event: MockExchangeEvent): string {
  const response = event.responseName ?? event.responseId;
  const handled =
    event.operation === undefined ? '' : ` ${event.operation}${response !== undefined ? ` → ${response}` : ''}`;
  const lines = [
    `${event.at} ${mock.name} ${event.method} ${event.url} ${String(event.status)}${handled} ${String(event.durationMs)}ms`,
  ];
  for (const problem of event.problems) {
    lines.push(`  ${problem.code}: ${problem.message}`);
  }
  const { error } = event;
  // A refusal for invalid input repeats its problem as the error; say it once.
  if (error !== undefined && !event.problems.some((p) => p.code === error.code && p.message === error.message)) {
    lines.push(`  ${error.code}: ${error.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface MockCommandOptions {
  /** Ends serving when it aborts; without one, SIGINT or SIGTERM does. */
  readonly stop?: AbortSignal;
}

/**
 * The project at `path`, its load problems written to stderr as warnings; or the exit code when it is
 * a workspace or does not load (the error already written).
 */
export async function loadMockProject(path: string, io: CliIo): Promise<Project | ExitCode> {
  try {
    if (!(await exists(join(path, 'wirebench.yaml'))) && (await exists(join(path, 'workspace.yaml')))) {
      return await refuseWorkspace(path, io);
    }
    const loaded = await loadProject(path);
    for (const problem of loaded.problems) {
      io.stderr.write(`warning: ${problem.code}: ${problem.message} (${problem.file})\n`);
    }
    return loaded.project;
  } catch (error) {
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.Usage;
    }
    throw error;
  }
}

export async function mockCommand(args: MockArgs, io: CliIo, options: MockCommandOptions = {}): Promise<ExitCode> {
  const project = await loadMockProject(args.path, io);
  if (typeof project === 'number') return project;

  const mocks = selectMocks(project, args.mocks);
  if (args.port !== undefined && mocks.length !== 1) {
    throw new UsageError(`--port takes one mock; ${String(mocks.length)} are selected`);
  }
  const envHost = io.env[MOCK_HOST_VARIABLE]?.trim();
  const host = args.host ?? (envHost !== undefined && envHost !== '' ? envHost : '127.0.0.1');
  if (!LOOPBACK.test(host)) {
    io.stderr.write(`warning: listening on ${host}: any client that can reach the port can call the mocks\n`);
  }

  const write = (line: string): void => {
    io.stdout.write(line);
  };
  const running: { readonly mock: MockDef; readonly server: RunningMock }[] = [];
  try {
    for (const mock of mocks) {
      const server = await startMock({
        project,
        root: args.path,
        mockId: mock.id,
        host,
        ...(args.port !== undefined ? { port: args.port } : {}),
        onExchange: (event) => {
          if (args.quiet) return;
          write(
            args.json
              ? `${JSON.stringify({ type: 'exchange', mockId: mock.id, mock: mock.name, ...event })}\n`
              : exchangeLine(mock, event),
          );
        },
      });
      running.push({ mock, server });
    }
  } catch (error) {
    await Promise.all(running.map(({ server }) => server.stop()));
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.RunError;
    }
    throw error;
  }

  for (const { mock, server } of running) {
    for (const warning of server.warnings) {
      io.stderr.write(`warning: ${mock.name}: ${warning.code}: ${warning.message}\n`);
    }
    write(
      args.json
        ? `${JSON.stringify({ type: 'listening', mockId: mock.id, mock: mock.name, url: server.url, host: server.host, port: server.port })}\n`
        : `listening ${mock.name} ${server.url}\n`,
    );
  }

  await stopped(options.stop);
  await Promise.all(running.map(({ server }) => server.stop()));
  return ExitCode.Ok;
}
