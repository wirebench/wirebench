import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CookieJar,
  createIssuedTokenSource,
  createSourceCache,
  createSecretMasker,
  dataFormatOf,
  featureDisabled,
  isProtectedEnvironment,
  isWirebenchError,
  jarCookieHost,
  loadProject,
  loadWorkspace,
  parseDataFile,
  planIterations,
  readGoldenFile,
  runSuite,
  secretNeedsOf,
  selectSuite,
  workspaceProjectDir,
  writeGoldenFile,
} from '@wirebench/engine';
import type {
  CallbackWaiting,
  DataTable,
  Environment,
  GoldenFile,
  Project,
  ProtocolRegistry,
  ReporterContribution,
  RunContext,
  RunResult,
  RunWorkspace,
  SelectedRequest,
  SequenceDef,
  SuiteSelection,
  WorkspaceEnvironment,
} from '@wirebench/engine';
import { UsageError } from '../args.js';
import type { FeatureArgs, RunArgs } from '../args.js';
import { ExitCode, exitCodeFor } from '../exit-codes.js';
import { featuresFor } from '../features.js';
import type { CliIo } from '../main.js';
import { cliSecrets } from '../source-secrets.js';
import { cliSendHost } from '../send-host.js';
import { verboseIssuedTokens } from '../verbose-sts.js';
import { proxyFromEnv } from '../proxy-env.js';
import { explainFailure, maskerDetects } from '../secret-advice.js';
import { captureSourceFromEnv } from '../server-captures.js';
import { createCliReporter } from '../reporters/cli.js';
import { createMaskedReporters } from '../reporters/mask.js';
import type { Reporter } from '../reporters/types.js';
import { writeReport } from '../reporters/write.js';
import { cliVersion } from '../version.js';
import { enclosingWorkspace, exists } from '../workspace-lookup.js';

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
export async function refuseWorkspace(path: string, io: CliIo): Promise<ExitCode> {
  const { workspace } = await loadWorkspace(path);
  io.stderr.write('This is a workspace; run one of its projects:\n');
  for (const ref of workspace.projects) {
    io.stderr.write(
      `  ${ref.source === 'linked' && ref.path !== undefined ? ref.path : workspaceProjectDir(path, ref.slug)}\n`,
    );
  }
  return ExitCode.Usage;
}

/**
 * The run's reporters: the console one, or each file reporter the registry has under the id given.
 *
 * @throws UsageError for an id no enabled reporter has, before anything is read or sent
 */
function buildReporters(args: RunArgs, io: CliIo, registry: ProtocolRegistry): Reporter[] {
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
    let reporter: ReporterContribution;
    try {
      reporter = registry.extensions.reporter(spec.reporter);
    } catch (error) {
      const off = isWirebenchError(error) && error.code === 'feature-disabled' ? ` (${error.message})` : '';
      throw new UsageError(`--reporter must be "cli" or "<kind>=<file>", got "${spec.reporter}=${spec.file}"${off}`);
    }
    const tool = cliTool();
    return createFileReporter(spec.file, (result) => reporter.render(result, tool));
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
 * Loads the project at `path` and the workspace around it, printing each load problem as a warning.
 * Returns an exit code instead when the path is a workspace (`Usage`) or the project cannot be
 * loaded (`loadFailure`: a usage error for `run`, a run error for `scripts convert`).
 */
export async function loadTarget(
  path: string,
  io: CliIo,
  loadFailure: ExitCode = ExitCode.Usage,
  registry?: ProtocolRegistry,
): Promise<{ readonly project: Project; readonly workspace?: RunWorkspace } | ExitCode> {
  try {
    if (!(await exists(join(path, 'wirebench.yaml'))) && (await exists(join(path, 'workspace.yaml')))) {
      return await refuseWorkspace(path, io);
    }
    // Through the verb's registry: a kind that is off loads as a placeholder, never a rewrite.
    const loaded = await loadProject(path, registry !== undefined ? { registry } : {});
    for (const problem of loaded.problems) {
      io.stderr.write(`warning: ${problem.code}: ${problem.message} (${problem.file})\n`);
    }
    const workspace = await enclosingWorkspace(path, (line) => io.stderr.write(`warning: ${line}\n`));
    return { project: loaded.project, ...(workspace !== undefined ? { workspace } : {}) };
  } catch (error) {
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return loadFailure;
    }
    throw error;
  }
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
  registry?: ProtocolRegistry,
): Promise<LoadedSelection | ExitCode> {
  const target = await loadTarget(args.path, io, ExitCode.Usage, registry);
  if (typeof target === 'number') {
    return target;
  }
  const { project, workspace } = target;

  let selection: SuiteSelection;
  try {
    selection = selectSuite(
      project,
      workspace,
      {
        ...(args.env !== undefined ? { environment: args.env } : {}),
        select: args.selectors,
        ...(args.sequences !== undefined ? { sequences: args.sequences } : {}),
      },
      registry,
    );
  } catch (error) {
    // A bad environment, sequence or selector is a usage error, as it always has been.
    if (isWirebenchError(error)) {
      throw new UsageError(error.message);
    }
    throw error;
  }
  return { project, ...(workspace !== undefined ? { workspace } : {}), ...selection };
}

/**
 * The data file `--data` names, read and parsed before anything is sent (#336). A file that cannot be
 * read or parsed is a usage error: printed with its code, exit 2.
 */
async function readDataTable(path: string, io: CliIo): Promise<DataTable | ExitCode> {
  try {
    const format = dataFormatOf(path);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      const reason = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
      io.stderr.write(`data-file-unreadable: the data file ${path} cannot be read (${reason})\n`);
      return ExitCode.Usage;
    }
    return parseDataFile(text, format);
  } catch (error) {
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${path}: ${error.message}\n`);
      return ExitCode.Usage;
    }
    throw error;
  }
}

/**
 * `wirebench run`: everything that can be refused is refused before the first send — a workspace
 * for a project, an unloadable project, an unknown environment, a selector that matches nothing —
 * because a pipeline that tested nothing must not be told it passed.
 *
 * This function is the only holder of raw results: reporters are built straight into the masking
 * wrapper, so no reporter — one added later included — can be handed a secret value.
 */
export async function runCommand(args: RunArgs & FeatureArgs, io: CliIo): Promise<ExitCode> {
  const registry = featuresFor(args, io);
  if (args.sequences.length > 0 && !registry.features.isEnabled('sequences')) {
    // Refused before the project is read, let alone anything sent (feature switches spec §5.1).
    const off = featureDisabled(registry.features, 'sequences');
    io.stderr.write(`${off.code}: ${off.message}\n`);
    return ExitCode.Usage;
  }
  const reporters = buildReporters(args, io, registry);
  const loaded = await loadSelection(args, io, registry);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const { project, workspace, environment, selected, sequences } = loaded;
  if (environment !== undefined && isProtectedEnvironment(project, environment)) {
    if (args.refuseProtected) {
      io.stderr.write(
        `environment-protected: "${environment.name}" is a protected environment; --refuse-protected refuses it\n`,
      );
      return ExitCode.Usage;
    }
    io.stderr.write(`warning: "${environment.name}" is a protected environment\n`);
  }
  const table = args.data !== undefined ? await readDataTable(args.data, io) : undefined;
  if (typeof table === 'number') {
    return table;
  }
  const plan = planIterations({
    ...(table !== undefined ? { rows: table.rows } : {}),
    ...(args.iterations !== undefined ? { iterations: args.iterations } : {}),
    ...(args.dataOverrun !== undefined ? { overrun: args.dataOverrun } : {}),
  });
  const needs = secretNeedsOf(selected, project, args.vars, workspace?.workspace, registry);
  // OAuth2 access tokens are secrets the run obtains rather than reads: the engine reports each
  // one as it arrives, and every mask built after that — they are built per result — hides it.
  // A value a secret source hands out is masked too, including in that source's own error text.
  const tokens = new Set<string>();
  let known: () => string[] = () => [...tokens];
  const maskNow = (): ((text: string) => string) => createSecretMasker(known());
  const secrets = cliSecrets(needs, io.env, workspace?.workspace, args.secretSources, createSourceCache(), (text) =>
    maskNow()(text),
  );
  known = () => [...secrets.values(), ...tokens];
  const output = createMaskedReporters(reporters, maskNow, (raw) => explainFailure(raw, needs));
  const proxyFor = proxyFromEnv(io.env);
  // Callback assertions read captures with a CI token (callback-assertion §4); masked like every secret.
  const captures = captureSourceFromEnv(io.env, { proxyFor });
  if (captures.token !== undefined) {
    tokens.add(captures.token);
  }
  const onCallbackWaiting = (path: string, waiting: readonly CallbackWaiting[]): void =>
    output.onCallbackWaiting(path, waiting);

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  const context: Omit<RunContext, 'scripting'> = {
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
      // `--allow-commands`: every MCP stdio server of the run, sequence steps included, may start.
      allowCommands: args.allowCommands,
      // `--verbose` reports each token request on stderr: host and status, never the token.
      ...(args.verbose
        ? {
            issuedTokens: verboseIssuedTokens(
              createIssuedTokenSource({ onSecretValue: (value) => tokens.add(value) }),
              (line) => io.stderr.write(`${line}\n`),
            ),
          }
        : {}),
    }),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    insecure: args.insecure,
    signal: controller.signal,
    containsKnownSecret: maskerDetects(maskNow),
    // The run, its sequence steps and its scripts dispatch through the verb's switches.
    registry,
  };
  let result: RunResult;
  try {
    const outcome = await runSuite(context, {
      selection: {
        ...(environment !== undefined ? { environment } : {}),
        selected,
        ...(sequences !== undefined ? { sequences } : {}),
      },
      plan,
      bail: args.bail,
      requireAssertions: args.requireAssertions,
      ...(args.slaMs !== undefined ? { slaMs: args.slaMs } : {}),
      ...(args.delayMs !== undefined ? { delayMs: args.delayMs } : {}),
      ...(args.baseline
        ? {
            baseline: {
              // Read from the folder the project was loaded from; nothing is written (#36).
              source: (item: SelectedRequest) => readGoldenFile(args.path, project, item.request.id),
              require: args.requireBaseline,
            },
          }
        : {}),
      ...(args.updateBaseline
        ? {
            updateBaseline: {
              // The runner's one write (#217): golden sidecars beside the requests, nothing else.
              source: (item: SelectedRequest) => readGoldenFile(args.path, project, item.request.id),
              sink: (item: SelectedRequest, golden: GoldenFile) =>
                writeGoldenFile(args.path, project, item.request.id, golden),
            },
          }
        : {}),
      onRequestDone: (request) => output.onRequestDone(request),
      captures: captures.source,
      onCallbackWaiting,
      containsKnownSecret: maskerDetects(maskNow),
      onSecretValue: (value) => tokens.add(value),
    });
    if (outcome.kind === 'scripts-refused') {
      // A wrong script path fails the run up front, the same way in CI as in the app (#63).
      for (const error of outcome.errors) {
        io.stderr.write(`${error.code}: ${maskNow()(error.message)}\n`);
      }
      return ExitCode.Usage;
    }
    result = outcome.result;
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
  }

  await output.onRunDone(result);
  // A request cut off mid-flight comes back errored; the interruption is what the pipeline needs.
  return interrupted ? ExitCode.Interrupted : exitCodeFor(result.summary);
}
