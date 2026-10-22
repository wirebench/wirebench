/**
 * `wirebench lint` (#342 spec §6): reads an OpenAPI document — a file, a URL, or a project's cached
 * definition — lints it with the built-in rule sets and the project's own, prints the findings,
 * writes the reports and answers the CI gate with its exit code.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  apiDefinitionDir,
  countFindings,
  createCachedApiFetch,
  failsAt,
  lintOpenApi,
  lintReportJson,
  lintReportSarif,
  readApiDefinitionCache,
  readProjectLintRulesets,
  restApisOf,
} from '@wirebench/engine';
import type {
  FetchDocument,
  LintFinding,
  LintReport,
  LintReportOptions,
  LintRulesetFile,
  ProtocolRegistry,
} from '@wirebench/engine';
import type { LintArgs, LintReporter } from '../args-lint.js';
import { ExitCode } from '../exit-codes.js';
import type { FeatureArgs } from '../features.js';
import { featuresFor } from '../features.js';
import type { CliIo } from '../main.js';
import { OpsError, exitCodeForError, toOpsError } from '../ops/errors.js';
import { fetcherFor, readSource } from '../ops/import.js';
import { openProject } from '../ops/project.js';
import { writeReport } from '../reporters/write.js';
import { cliVersion } from '../version.js';

const PROJECT_PREFIX = 'project:';

/** Lint's own refusals that are the caller's to fix: exit 2, like the shared usage codes. */
const LINT_USAGE_CODES: ReadonlySet<string> = new Set([
  'lint-unsupported-version',
  'lint-ruleset-invalid',
  'openapi-not-a-document',
]);

/** The document to lint, how its references are read, and whether remote ones may be. */
interface Loaded {
  readonly text: string;
  readonly location: string;
  readonly fetchDocument: FetchDocument;
  readonly allowRemoteRefs: boolean;
}

/** The REST API of the project named `name` (or with that slug), its cached definition read offline. */
async function fromProject(
  name: string,
  projectDir: string,
  warn: (message: string) => void,
  registry: ProtocolRegistry,
): Promise<Loaded> {
  const { project } = await openProject({ projectDir, warn, registry });
  const api = restApisOf(project).find((candidate) => candidate.name === name || candidate.slug === name);
  if (api === undefined) {
    throw new OpsError('container-not-found', `No REST API is named "${name}"`, { container: name });
  }
  const dir = apiDefinitionDir(projectDir, api.slug);
  let cached: Awaited<ReturnType<typeof readApiDefinitionCache>>;
  try {
    cached = await readApiDefinitionCache(dir);
  } catch {
    throw new OpsError(
      'definition-cache-missing',
      `The API "${api.name}" has no readable cached OpenAPI document; import it again with definitions cached`,
      { api: api.name },
    );
  }
  const offline = createCachedApiFetch(cached.manifest, dir, (location) =>
    Promise.reject(new OpsError('definition-cache-missing', `"${location}" is not in this API's definition cache`)),
  );
  const root = await offline(cached.manifest.rootLocation);
  // Every reference is read from the cache, never the network, so a remote one is as safe as a local one.
  return { text: root.text, location: root.location, fetchDocument: offline, allowRemoteRefs: true };
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isFile(),
    () => false,
  );
}

/** The project's `lint/` files (when there is a project), then each `--ruleset` file, in order. */
async function rulesetFiles(args: LintArgs): Promise<LintRulesetFile[]> {
  const projectDir = resolve(args.project ?? '.');
  const isProject = args.project !== undefined || (await isFile(join(projectDir, 'wirebench.yaml')));
  const files = isProject ? await readProjectLintRulesets(projectDir) : [];
  for (const path of args.rulesets.map((given) => resolve(given))) {
    try {
      files.push({ name: shortPath(path), text: await readFile(path, 'utf8') });
    } catch {
      throw new OpsError('file-not-found', `Cannot read the rule set ${path}`, { path });
    }
  }
  return files;
}

/**
 * `path` relative to the working directory — what an editor or code scanning matches — unless that
 * climbs more than two folders (a temp file, another checkout), where the full path reads better.
 */
function shortPath(path: string): string {
  const near = relative(process.cwd(), path).split('\\').join('/');
  const climbs = near.split('/').filter((segment) => segment === '..').length;
  return near === '' || isAbsolute(near) || climbs > 2 ? path : near;
}

/** A finding's document as the user knows it: a path relative to here for a file, the URL otherwise. */
function display(location: string): string {
  if (!location.startsWith('file:')) return location;
  try {
    return shortPath(fileURLToPath(location));
  } catch {
    return location;
  }
}

function findingLine(finding: LintFinding): string {
  const position =
    finding.range === undefined ? '' : `:${String(finding.range.start.line)}:${String(finding.range.start.column)}`;
  const at = finding.path === '' ? '' : `  (${finding.path})`;
  return `${display(finding.source)}${position}  ${finding.severity.padEnd(7)}  ${finding.rule}  ${finding.message}${at}`;
}

function summaryLine(report: LintReport, document: string): string {
  const counts = countFindings(report.findings);
  const part = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;
  return `${part(counts.error, 'error')}, ${part(counts.warning, 'warning')}, ${part(counts.info, 'info')}, ${part(counts.hint, 'hint')} in ${document}`;
}

function render(reporter: LintReporter, report: LintReport, options: LintReportOptions): string {
  const body = reporter.kind === 'sarif' ? lintReportSarif(report, options) : lintReportJson(report, options);
  return `${JSON.stringify(body, null, 2)}\n`;
}

export async function lintCommand(args: LintArgs & FeatureArgs, io: CliIo): Promise<ExitCode> {
  const warn = (message: string): void => {
    io.stderr.write(`warning: ${message}\n`);
  };
  let report: LintReport;
  try {
    const rulesets = await rulesetFiles(args);
    let loaded: Loaded;
    if (args.definition.startsWith(PROJECT_PREFIX)) {
      loaded = await fromProject(
        args.definition.slice(PROJECT_PREFIX.length),
        resolve(args.project ?? '.'),
        warn,
        featuresFor(args, io),
      );
    } else {
      const fetchDocument = fetcherFor(io.env);
      const read = await readSource(args.definition, fetchDocument);
      loaded = { text: read.text, location: read.location, fetchDocument, allowRemoteRefs: args.allowRemoteRefs };
    }
    report = await lintOpenApi(
      { text: loaded.text, location: loaded.location },
      { fetchDocument: loaded.fetchDocument, allowRemoteRefs: loaded.allowRemoteRefs, rulesets },
    );
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return LINT_USAGE_CODES.has(failure.code) ? ExitCode.Usage : exitCodeForError(failure);
  }

  const document =
    args.definition.startsWith(PROJECT_PREFIX) || /^https?:\/\//i.test(args.definition)
      ? args.definition
      : display(pathToFileURL(resolve(args.definition)).href);
  if (!args.quiet) {
    for (const finding of report.findings) io.stdout.write(`${findingLine(finding)}\n`);
  }
  io.stdout.write(`${summaryLine(report, document)}\n`);
  const options: LintReportOptions = {
    tool: { name: 'wirebench', version: cliVersion() },
    document,
    displayLocation: display,
  };
  for (const reporter of args.reporters) {
    await writeReport(resolve(reporter.file), render(reporter, report, options));
  }
  return failsAt(report.findings, args.failSeverity) ? ExitCode.AssertionFailed : ExitCode.Ok;
}
