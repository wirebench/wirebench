import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isWirebenchError,
  loadProject,
  loadWorkspace,
  runRequests,
  selectRequests,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { Environment, Project, RunResult } from '@wirebench/engine';
import { UsageError } from '../args.js';
import type { RunArgs } from '../args.js';
import { ExitCode, exitCodeFor } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { proxyFromEnv } from '../proxy-env.js';
import { createCliReporter } from '../reporters/cli.js';
import type { Reporter } from '../reporters/types.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A workspace where a project was expected: name the projects instead of guessing which one. */
async function refuseWorkspace(path: string, io: CliIo): Promise<ExitCode> {
  const { workspace } = await loadWorkspace(path);
  io.stderr.write('This is a workspace; run one of its projects:\n');
  for (const ref of workspace.projects) {
    io.stderr.write(
      `  ${ref.source === 'linked' && ref.path !== undefined ? ref.path : workspaceProjectDir(path, ref.slug)}\n`,
    );
  }
  return ExitCode.Usage;
}

/** `--env` by name first, then by slug or id; required as soon as the project has any environment. */
function pickEnvironment(project: Project, wanted: string | undefined): Environment | undefined {
  const { environments } = project;
  if (environments.length === 0) {
    if (wanted !== undefined) {
      throw new UsageError(`unknown environment "${wanted}": this project defines none`);
    }
    return undefined;
  }
  const names = environments.map((e) => e.name).join(', ');
  if (wanted === undefined) {
    throw new UsageError(`an environment is required (--env <name>); environments: ${names}`);
  }
  const found =
    environments.find((e) => e.name === wanted) ?? environments.find((e) => e.slug === wanted || e.id === wanted);
  if (found === undefined) {
    throw new UsageError(`unknown environment "${wanted}"; environments: ${names}`);
  }
  return found;
}

function buildReporters(args: RunArgs, io: CliIo): Reporter[] {
  const color = args.color && io.env['NO_COLOR'] === undefined && io.stdout.isTTY === true;
  return args.reporters.map((spec) => {
    if (spec.kind === 'cli') {
      return createCliReporter(io.stdout, { color, quiet: args.quiet, verbose: args.verbose });
    }
    throw new UsageError(`--reporter ${spec.kind} is not available yet`);
  });
}

/**
 * `wirebench run`: everything that can be refused is refused before the first send — a workspace
 * for a project, an unloadable project, an unknown environment, a selector that matches nothing —
 * because a pipeline that tested nothing must not be told it passed.
 */
export async function runCommand(args: RunArgs, io: CliIo): Promise<ExitCode> {
  const { path } = args;
  let project: Project;
  try {
    if (!(await exists(join(path, 'wirebench.yaml'))) && (await exists(join(path, 'workspace.yaml')))) {
      return await refuseWorkspace(path, io);
    }
    const loaded = await loadProject(path);
    project = loaded.project;
    for (const problem of loaded.problems) {
      io.stderr.write(`warning: ${problem.code}: ${problem.message} (${problem.file})\n`);
    }
  } catch (error) {
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.Usage;
    }
    throw error;
  }

  const environment = pickEnvironment(project, args.env);
  const { selected, unmatched } = selectRequests(project, args.selectors);
  if (unmatched.length > 0) {
    throw new UsageError(`selector matched nothing: ${unmatched.join(', ')}`);
  }
  if (selected.length === 0) {
    throw new UsageError('nothing to run: the project has no requests');
  }
  const reporters = buildReporters(args, io);
  const proxyFor = proxyFromEnv(io.env);

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  let result: RunResult;
  try {
    result = await runRequests(
      selected,
      {
        project,
        projectDir: path,
        ...(environment !== undefined ? { environmentId: environment.id } : {}),
        overrides: args.vars,
        // Task 14 reads secrets from the environment; until then every secret is missing.
        getSecret: () => Promise.resolve(undefined),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        insecure: args.insecure,
        proxyFor,
        signal: controller.signal,
      },
      {
        bail: args.bail,
        ...(args.slaMs !== undefined ? { defaultSlaMs: args.slaMs } : {}),
        requireAssertions: args.requireAssertions,
        onRequestDone: (request) => {
          for (const reporter of reporters) {
            reporter.onRequestDone?.(request);
          }
        },
      },
    );
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  for (const reporter of reporters) {
    await reporter.onRunDone(result);
  }
  // A request cut off mid-flight comes back errored; the interruption is what the pipeline needs.
  return interrupted ? ExitCode.Interrupted : exitCodeFor(result.summary);
}
