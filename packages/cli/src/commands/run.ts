import { join } from 'node:path';
import {
  checkRunScripts,
  CookieJar,
  createScriptChecker,
  createScriptSandbox,
  createSecretMasker,
  isWirebenchError,
  jarCookieHost,
  loadProject,
  loadWorkspace,
  readGoldenFile,
  RequestScripting,
  runRequests,
  secretNeedsOf,
  selectRequests,
  workspaceProjectDir,
} from '@wirebench/engine';
import type {
  CallbackWaiting,
  Environment,
  Project,
  RunContext,
  RunResult,
  RunWorkspace,
  SelectedRequest,
  SequenceDef,
  WorkspaceEnvironment,
} from '@wirebench/engine';
import { UsageError } from '../args.js';
import type { RunArgs } from '../args.js';
import { ExitCode, exitCodeFor } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { createEnvSecrets } from '../env-secrets.js';
import { pickEnvironment } from '../ops/environment.js';
import { OpsError } from '../ops/errors.js';
import { cliSendHost } from '../send-host.js';
import { proxyFromEnv } from '../proxy-env.js';
import { explainMissingSecret, knownSecretIn } from '../secret-advice.js';
import { captureSourceFromEnv } from '../server-captures.js';
import { createCliReporter } from '../reporters/cli.js';
import { renderHtml } from '../reporters/html.js';
import { renderJson } from '../reporters/json.js';
import { renderJunit } from '../reporters/junit.js';
import { createMaskedReporters } from '../reporters/mask.js';
import type { Reporter } from '../reporters/types.js';
import { writeReport } from '../reporters/write.js';
import { cliVersion } from '../version.js';
import { enclosingWorkspace, exists } from '../workspace-lookup.js';
import { resolveSteps, runSequences, selectSequences } from './sequence.js';

/** `{ name, version }` for the `json` report's `tool` field, read from the CLI's own `package.json`. */
function cliTool(): { readonly name: string; readonly version: string } {
  return { name: 'wirebench', version: cliVersion() };
}

/** A file reporter's `onRunDone` renders once the whole result is in, then writes it — the path
 * resolves against the process's working directory (Node's own default for a relative path),
 * never against the project directory. */
function createFileReporter(file: string, render: (result: RunResult) => string): Reporter {
  return { onRunDone: (result) => writeReport(file, render(result)) };
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

function buildReporters(args: RunArgs, io: CliIo): Reporter[] {
  const color = args.color && io.env['NO_COLOR'] === undefined && io.stdout.isTTY === true;
  return args.reporters.map((spec) => {
    if (spec.kind === 'cli') {
      return createCliReporter(io.stdout, {
        color,
        quiet: args.quiet,
        verbose: args.verbose,
        interactive: io.stdout.isTTY === true,
      });
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

/**
 * A loaded project, the workspace it sits inside (if any), its chosen environment — the
 * workspace's when there is a workspace — and the requests a selection covers.
 */
export interface LoadedSelection {
  readonly project: Project;
  readonly workspace?: RunWorkspace;
  readonly environment?: Environment | WorkspaceEnvironment;
  /** The requests to send: the selection's, or every request the sequences' steps name. */
  readonly selected: readonly SelectedRequest[];
  /** Set when the run is of sequences (`--sequence`). */
  readonly sequences?: readonly SequenceDef[];
}

/**
 * What `run` and `secrets list` share: load the project and the workspace around it, pick the
 * environment, select. Returns an exit code instead when the path is refused; throws `UsageError`
 * for a bad environment or selector.
 */
export async function loadSelection(
  args: {
    readonly path: string;
    readonly env?: string;
    readonly selectors: readonly string[];
    readonly sequences?: readonly string[];
  },
  io: CliIo,
): Promise<LoadedSelection | ExitCode> {
  const { path } = args;
  let project: Project;
  let workspace: RunWorkspace | undefined;
  try {
    if (!(await exists(join(path, 'wirebench.yaml'))) && (await exists(join(path, 'workspace.yaml')))) {
      return await refuseWorkspace(path, io);
    }
    const loaded = await loadProject(path);
    project = loaded.project;
    for (const problem of loaded.problems) {
      io.stderr.write(`warning: ${problem.code}: ${problem.message} (${problem.file})\n`);
    }
    workspace = await enclosingWorkspace(path, (line) => io.stderr.write(`warning: ${line}\n`));
  } catch (error) {
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.Usage;
    }
    throw error;
  }

  let environment: Environment | WorkspaceEnvironment | undefined;
  try {
    environment =
      workspace === undefined
        ? pickEnvironment(project.environments, 'project', args.env)
        : pickEnvironment(workspace.workspace.environments, 'workspace', args.env);
  } catch (error) {
    // `wirebench run` reports a bad environment as a usage error, as it always has.
    if (error instanceof OpsError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
  if (args.sequences !== undefined && args.sequences.length > 0) {
    const sequences = selectSequences(project, args.sequences);
    const selected = resolveSteps(project, sequences);
    return {
      project,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(environment !== undefined ? { environment } : {}),
      selected,
      sequences,
    };
  }
  const { selected, unmatched } = selectRequests(project, args.selectors);
  if (unmatched.length > 0) {
    throw new UsageError(`selector matched nothing: ${unmatched.join(', ')}`);
  }
  if (selected.length === 0) {
    throw new UsageError('nothing to run: the project has no requests');
  }
  return {
    project,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(environment !== undefined ? { environment } : {}),
    selected,
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
  const { project, workspace, environment, selected, sequences } = loaded;
  const needs = secretNeedsOf(selected, project, args.vars, workspace?.workspace);
  const secrets = createEnvSecrets(needs, io.env);
  // OAuth2 access tokens are secrets the run obtains rather than reads: the engine reports each
  // one as it arrives, and every mask built after that — they are built per result — hides it.
  const tokens = new Set<string>();
  const maskNow = (): ((text: string) => string) => createSecretMasker([...secrets.values(), ...tokens]);
  const output = createMaskedReporters(buildReporters(args, io), maskNow, (raw) => explainMissingSecret(raw, needs));
  const proxyFor = proxyFromEnv(io.env);
  // Callback assertions read captures with a CI token (callback-assertion §4); masked like every secret.
  const captures = captureSourceFromEnv(io.env, { proxyFor });
  if (captures.token !== undefined) {
    tokens.add(captures.token);
  }
  const onCallbackWaiting = (path: string, waiting: readonly CallbackWaiting[]): void =>
    output.onCallbackWaiting(path, waiting);

  const sandbox = createScriptSandbox();
  const checker = createScriptChecker();
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  const context: RunContext = {
    project,
    projectDir: args.path,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(environment !== undefined ? { environmentId: environment.id } : {}),
    overrides: args.vars,
    host: cliSendHost({
      getSecret: secrets.getSecret,
      env: io.env,
      // An OAuth2 token, and a sequence value that is (or holds) a secret: every mask built after this hides it.
      onSecretValue: (value) => tokens.add(value),
      // One jar for the whole run: every request, sequence step and iteration shares it.
      cookies: jarCookieHost(new CookieJar()),
    }),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    insecure: args.insecure,
    signal: controller.signal,
    containsKnownSecret: (value) => knownSecretIn(value, [...secrets.values(), ...tokens]),
    scripting: new RequestScripting({ sandbox, checker, onSecretValue: (value) => tokens.add(value) }),
  };
  let result: RunResult;
  try {
    // Every script is checked before anything is sent: a wrong path fails the run up front, the
    // same way in CI as in the app (#63).
    const scriptErrors = await checkRunScripts(selected, context);
    if (scriptErrors.length > 0) {
      for (const error of scriptErrors) {
        io.stderr.write(`${error.code}: ${maskNow()(error.message)}\n`);
      }
      return ExitCode.Usage;
    }
    result =
      sequences !== undefined
        ? await runSequences(sequences, context, {
            bail: args.bail,
            requireAssertions: args.requireAssertions,
            ...(args.slaMs !== undefined ? { slaMs: args.slaMs } : {}),
            signal: controller.signal,
            onStepDone: (step) => output.onRequestDone(step),
            containsKnownSecret: (value) => knownSecretIn(value, [...secrets.values(), ...tokens]),
            captures: captures.source,
            onCallbackWaiting,
          })
        : await runRequests(selected, context, {
            bail: args.bail,
            ...(args.slaMs !== undefined ? { defaultSlaMs: args.slaMs } : {}),
            requireAssertions: args.requireAssertions,
            ...(args.baseline
              ? {
                  baseline: {
                    // Read from the folder the project was loaded from; nothing is written (#36).
                    source: (item: SelectedRequest) => readGoldenFile(args.path, project, item.request.id),
                    require: args.requireBaseline,
                  },
                }
              : {}),
            onRequestDone: (request) => output.onRequestDone(request),
            captures: captures.source,
            onCallbackWaiting,
          });
  } catch (error) {
    // An unexpected failure is printed by `main`; its message must not carry a value either. Only
    // the message is masked: `main` never prints `error.stack`, which still holds the raw text. A
    // flag that prints stacks (a `--debug`) must mask them too.
    if (error instanceof Error) {
      error.message = maskNow()(error.message);
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await Promise.all([sandbox.dispose(), checker.dispose()]);
  }

  await output.onRunDone(result);
  // A request cut off mid-flight comes back errored; the interruption is what the pipeline needs.
  return interrupted ? ExitCode.Interrupted : exitCodeFor(result.summary);
}
