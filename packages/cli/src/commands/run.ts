import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  createSecretMasker,
  envVariablesFor,
  isWirebenchError,
  loadProject,
  loadWorkspace,
  runRequests,
  secretNeedsOf,
  selectRequests,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { Environment, Project, RequestResult, RunResult, SecretNeed, SelectedRequest } from '@wirebench/engine';
import { UsageError } from '../args.js';
import type { RunArgs } from '../args.js';
import { ExitCode, exitCodeFor } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { createEnvSecrets } from '../env-secrets.js';
import { proxyFromEnv } from '../proxy-env.js';
import { createCliReporter } from '../reporters/cli.js';
import { renderHtml } from '../reporters/html.js';
import { renderJson } from '../reporters/json.js';
import { renderJunit } from '../reporters/junit.js';
import { createMaskedReporters } from '../reporters/mask.js';
import type { Reporter } from '../reporters/types.js';
import { writeReport } from '../reporters/write.js';

const require = createRequire(import.meta.url);

/** `{ name, version }` for the `json` report's `tool` field, read from the CLI's own `package.json`. */
function cliTool(): { readonly name: string; readonly version: string } {
  const { version } = require('../../package.json') as { readonly version: string };
  return { name: 'wirebench', version };
}

/** A file reporter's `onRunDone` renders once the whole result is in, then writes it — the path
 * resolves against the process's working directory (Node's own default for a relative path),
 * never against the project directory. */
function createFileReporter(file: string, render: (result: RunResult) => string): Reporter {
  return { onRunDone: (result) => writeReport(file, render(result)) };
}

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
    if (spec.kind === 'junit') {
      return createFileReporter(spec.file, renderJunit);
    }
    if (spec.kind === 'json') {
      const tool = cliTool();
      return createFileReporter(spec.file, (result) => renderJson(result, tool));
    }
    const tool = cliTool();
    return createFileReporter(spec.file, (result) => renderHtml(result, tool));
  });
}

/** A loaded project, its chosen environment and the requests a selection covers. */
export interface LoadedSelection {
  readonly project: Project;
  readonly environment?: Environment;
  readonly selected: readonly SelectedRequest[];
}

/**
 * What `run` and `secrets list` share: load the project, pick the environment, select. Returns an
 * exit code instead when the path is refused; throws `UsageError` for a bad environment or selector.
 */
export async function loadSelection(
  args: { readonly path: string; readonly env?: string; readonly selectors: readonly string[] },
  io: CliIo,
): Promise<LoadedSelection | ExitCode> {
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
  return { project, ...(environment !== undefined ? { environment } : {}), selected };
}

/** `Set A (or B) to run "path".` — the engine's wording is the app's advice, not a pipeline's. */
function explainMissingSecret(result: RequestResult, needs: readonly SecretNeed[]): RequestResult {
  const ref = result.error?.code === 'secret-missing' ? result.error.details?.['ref'] : undefined;
  if (result.error === undefined || typeof ref !== 'string') {
    return result;
  }
  const [first, ...rest] = envVariablesFor(needs.find((need) => need.ref === ref) ?? { ref });
  const alternatives = rest.length > 0 ? ` (or ${rest.join(', ')})` : '';
  return {
    ...result,
    error: { ...result.error, message: `Set ${first ?? ''}${alternatives} to run "${result.path}".` },
  };
}

/**
 * `wirebench run`: everything that can be refused is refused before the first send — a workspace
 * for a project, an unloadable project, an unknown environment, a selector that matches nothing —
 * because a pipeline that tested nothing must not be told it passed.
 *
 * This function is the only holder of raw results: reporters are built straight into the masking
 * wrapper, so no reporter — one added later included — can be handed a secret value.
 */
export async function runCommand(args: RunArgs, io: CliIo): Promise<ExitCode> {
  const loaded = await loadSelection(args, io);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const { project, environment, selected } = loaded;
  const needs = secretNeedsOf(selected, project);
  const secrets = createEnvSecrets(needs, io.env);
  const output = createMaskedReporters(
    buildReporters(args, io),
    () => createSecretMasker(secrets.values()),
    (raw) => explainMissingSecret(raw, needs),
  );
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
        projectDir: args.path,
        ...(environment !== undefined ? { environmentId: environment.id } : {}),
        overrides: args.vars,
        getSecret: secrets.getSecret,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        insecure: args.insecure,
        proxyFor,
        signal: controller.signal,
      },
      {
        bail: args.bail,
        ...(args.slaMs !== undefined ? { defaultSlaMs: args.slaMs } : {}),
        requireAssertions: args.requireAssertions,
        onRequestDone: (request) => output.onRequestDone(request),
      },
    );
  } catch (error) {
    // An unexpected failure is printed by `main`; its message must not carry a value either.
    if (error instanceof Error) {
      error.message = createSecretMasker(secrets.values())(error.message);
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  await output.onRunDone(result);
  // A request cut off mid-flight comes back errored; the interruption is what the pipeline needs.
  return interrupted ? ExitCode.Interrupted : exitCodeFor(result.summary);
}
