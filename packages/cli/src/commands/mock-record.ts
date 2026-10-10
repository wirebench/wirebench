/**
 * `wirebench mock record` (#60, `docs/specs/2026-10-08-mock-recording-design.md` §CLI): records
 * traffic to a real system as stubs of a mock, and saves them when the recording stops.
 */
import {
  addRecordedStubs,
  generateMock,
  isWirebenchError,
  loadProject,
  restApisOf,
  saveProject,
  soapInterfacesOf,
  startRecorder,
} from '@wirebench/engine';
import type { MockDef, Project, RecordExchangeEvent, RunningRecorder } from '@wirebench/engine';
import type { MockRecordArgs } from '../args-mock-record.js';
import { secretValuesIn } from '../env-secrets.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { proxyFromEnv } from '../proxy-env.js';
import { UsageError } from '../usage-error.js';

export interface MockRecordOptions {
  /** Ends the recording when it aborts; without one, SIGINT or SIGTERM does. */
  readonly stop?: AbortSignal;
  /** Called once the recorder listens; for tests. */
  readonly onListening?: (recorder: RunningRecorder) => void;
}

/** Resolves when `stop` aborts, or, without one, on the process's first SIGINT or SIGTERM. */
function stopped(stop: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stop !== undefined) {
      if (stop.aborted) resolve();
      else stop.addEventListener('abort', () => resolve(), { once: true });
      return;
    }
    const onSignal = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The mock named `wanted` (name or slug, any case). */
function findMock(project: Project, wanted: string): MockDef | undefined {
  return project.mocks.find((mock) => same(mock.name, wanted) || same(mock.slug, wanted));
}

/** The id of the interface or API named `wanted` (name or slug, any case). */
function findContainer(project: Project, wanted: string): string | undefined {
  return [...soapInterfacesOf(project), ...restApisOf(project)].find(
    (container) => same(container.name, wanted) || same(container.slug, wanted),
  )?.id;
}

/** One log line: `<method> <url> <status> <operation|-> recorded|<reason>`. */
function line(event: RecordExchangeEvent): string {
  const outcome = event.recorded ? 'recorded' : (event.problems[0]?.code ?? event.error?.code ?? 'not recorded');
  return `${event.method} ${event.url} ${String(event.status)} ${event.operation ?? '-'} ${outcome}\n`;
}

/**
 * Records until stopped, then adds the stubs to the mock and saves the project.
 *
 * @returns 0 once a recording ran, kept or not; 2 for a bad target; 3 when the recorder cannot start
 * @throws UsageError for an unknown mock or `--from`
 */
export async function mockRecordCommand(
  args: MockRecordArgs,
  io: CliIo,
  options: MockRecordOptions = {},
): Promise<ExitCode> {
  const loaded = await loadProject(args.path);
  for (const problem of loaded.problems) {
    io.stderr.write(`${problem.code}: ${problem.message} (${problem.file})\n`);
  }
  let project = loaded.project;
  let mock = findMock(project, args.mock);
  if (mock === undefined) {
    if (args.from === undefined) {
      throw new UsageError(`The project has no mock called "${args.mock}"; pass --from <interface|api> to create one`);
    }
    const containerId = findContainer(project, args.from);
    if (containerId === undefined) {
      throw new UsageError(`The project has no interface or API called "${args.from}"`);
    }
    try {
      // Recording adds each operation it reaches; the generated sample responses are not wanted.
      mock = { ...(await generateMock(project, args.path, containerId, { name: args.mock })), operations: [] };
    } catch (error) {
      if (!isWirebenchError(error)) throw error;
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.RunError;
    }
    project = { ...project, mocks: [...project.mocks, mock] };
  }

  const proxy = proxyFromEnv(io.env)(args.target);
  let recorder: RunningRecorder;
  try {
    recorder = await startRecorder({
      project,
      root: args.path,
      mockId: mock.id,
      target: args.target,
      ...(args.host !== undefined ? { host: args.host } : {}),
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.insecure ? { tls: { rejectUnauthorized: false } } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
      secrets: secretValuesIn(io.env),
      onExchange: (event) => io.stderr.write(line(event)),
    });
  } catch (error) {
    if (!isWirebenchError(error)) throw error;
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.code === 'mock-record-target-invalid' ? ExitCode.Usage : ExitCode.RunError;
  }
  io.stderr.write(`recording ${recorder.url} -> ${args.target}\n`);
  options.onListening?.(recorder);
  await stopped(options.stop);
  await recorder.stop();

  const recordings = recorder.recordings();
  if (recordings.length === 0) {
    io.stderr.write('nothing recorded; the project is unchanged\n');
    return ExitCode.Ok;
  }
  const result = addRecordedStubs(mock, recordings, { replace: args.replace, dedupe: args.dedupe });
  const saved = result.mock;
  await saveProject(
    { ...project, mocks: project.mocks.map((each) => (each.id === saved.id ? saved : each)) },
    args.path,
  );
  io.stderr.write(
    `saved ${String(result.added)} stubs to mocks/${saved.slug}/ (${String(result.skipped.length)} skipped)\n`,
  );
  return ExitCode.Ok;
}
