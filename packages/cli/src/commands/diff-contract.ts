/**
 * `wirebench diff-contract` (#56 spec §6): reads two versions of a contract — a file, a URL, or a
 * project's cached definition — compares them with the engine's contract diff, prints the changes,
 * writes the reports and answers the CI gate with its exit code.
 */
import { resolve } from 'node:path';
import {
  contractDiffJson,
  detectImportFormat,
  diffOpenApiContracts,
  diffWsdlContracts,
  importWsdl,
  parseOpenApi,
  renderContractDiffHtml,
  renderContractDiffMarkdown,
  restApisOf,
  soapInterfacesOf,
  summarize,
  summarizeSoapOperations,
  summarizeWsa,
  summarizeWssPolicy,
  summaryLine,
} from '@wirebench/engine';
import type { ContractChange, ContractDiff, FetchDocument, OpenApiDocument, WsdlImportResult } from '@wirebench/engine';
import type { DiffContractArgs, DiffContractReporter } from '../args-diff-contract.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { OpsError, exitCodeForError, toOpsError } from '../ops/errors.js';
import { fetcherFor, readSource } from '../ops/import.js';
import { openProject, readOpenApi, readWsdl } from '../ops/project.js';
import { writeReport } from '../reporters/write.js';
import { cliVersion } from '../version.js';

const PROJECT_PREFIX = 'project:';

type LoadedContract =
  | { readonly format: 'wsdl'; readonly wsdl: WsdlImportResult }
  | { readonly format: 'openapi'; readonly document: OpenApiDocument };

/** The interface or REST API of the project named `name` (or with that slug), its cached definition read offline. */
async function fromProject(name: string, projectDir: string, warn: (message: string) => void): Promise<LoadedContract> {
  const { project } = await openProject({ projectDir, warn });
  const matches = (container: { readonly name: string; readonly slug: string }): boolean =>
    container.name === name || container.slug === name;
  const iface = soapInterfacesOf(project).find(matches);
  const api = restApisOf(project).find(matches);
  if (iface !== undefined && api !== undefined) {
    throw new OpsError('item-ambiguous', `Both an interface and an API are named "${name}"; use the slug`, { name });
  }
  if (iface !== undefined) {
    const { definition, bundle, schemaSet } = await readWsdl(projectDir, iface);
    return {
      format: 'wsdl',
      wsdl: {
        definition,
        bundle,
        schemaSet,
        problems: [],
        operations: summarizeSoapOperations(definition),
        wsa: summarizeWsa(definition),
        wssPolicy: summarizeWssPolicy(definition),
        fromCache: true,
      },
    };
  }
  if (api !== undefined) {
    return { format: 'openapi', document: await readOpenApi(projectDir, api) };
  }
  throw new OpsError('container-not-found', `No interface or REST API is named "${name}"`, { container: name });
}

async function fromSource(
  source: string,
  fetchDocument: FetchDocument,
  warn: (message: string) => void,
): Promise<LoadedContract> {
  const read = await readSource(source, fetchDocument);
  const detected = detectImportFormat({ text: read.text, filename: read.filename, url: read.url });
  if (detected.kind === 'wsdl') {
    const wsdl = await importWsdl({ kind: 'text', text: read.text, location: read.location }, { fetchDocument });
    for (const problem of wsdl.problems) warn(`${source}: ${problem.message}`);
    return { format: 'wsdl', wsdl };
  }
  if (detected.kind === 'openapi') {
    const parsed = await parseOpenApi({ kind: 'text', text: read.text, location: read.location }, { fetchDocument });
    for (const problem of parsed.refProblems) warn(`${source}: ${problem.ref} at ${problem.at}: ${problem.reason}`);
    return { format: 'openapi', document: parsed.document };
  }
  throw new OpsError(
    'unsupported-format',
    `${source} reads as ${detected.label}; diff-contract compares WSDLs or OpenAPI documents`,
    { format: detected.kind },
  );
}

function changeLine(change: ContractChange): string {
  const where = [change.operation, change.location].filter((part) => part !== undefined).join(' ');
  const mark = change.severity === 'breaking' ? 'BREAKING  ' : 'compatible';
  return where.length > 0 ? `${mark}  ${where}  ${change.message}` : `${mark}  ${change.message}`;
}

function render(reporter: DiffContractReporter, diff: ContractDiff): string {
  switch (reporter.kind) {
    case 'markdown':
      return renderContractDiffMarkdown(diff);
    case 'html':
      return renderContractDiffHtml(diff, { name: 'wirebench', version: cliVersion() });
    case 'json':
      return `${JSON.stringify(contractDiffJson(diff), null, 2)}\n`;
  }
}

function gate(args: DiffContractArgs, diff: ContractDiff): ExitCode {
  switch (args.failOn) {
    case 'breaking':
      return summarize(diff.changes).breaking > 0 ? ExitCode.AssertionFailed : ExitCode.Ok;
    case 'any':
      return diff.changes.length > 0 ? ExitCode.AssertionFailed : ExitCode.Ok;
    case 'none':
      return ExitCode.Ok;
  }
}

export async function diffContractCommand(args: DiffContractArgs, io: CliIo): Promise<ExitCode> {
  const warn = (message: string): void => {
    io.stderr.write(`warning: ${message}\n`);
  };
  const fetchDocument = fetcherFor(io.env);
  const load = (source: string): Promise<LoadedContract> =>
    source.startsWith(PROJECT_PREFIX)
      ? fromProject(source.slice(PROJECT_PREFIX.length), resolve(args.project), warn)
      : fromSource(source, fetchDocument, warn);

  let before: LoadedContract;
  let after: LoadedContract;
  try {
    before = await load(args.old);
    after = await load(args.new);
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
  if (before.format !== after.format) {
    const name = (format: LoadedContract['format']): string => (format === 'wsdl' ? 'a WSDL' : 'an OpenAPI document');
    io.stderr.write(
      `contract-formats-differ: ${args.old} is ${name(before.format)} and ${args.new} ${name(after.format)}; both must be the same format\n`,
    );
    return ExitCode.Usage;
  }

  const sides = { old: { label: args.old }, new: { label: args.new } };
  const diff =
    before.format === 'wsdl' && after.format === 'wsdl'
      ? diffWsdlContracts(before.wsdl, after.wsdl, sides)
      : before.format === 'openapi' && after.format === 'openapi'
        ? diffOpenApiContracts(before.document, after.document, sides)
        : undefined;
  if (diff === undefined) {
    return ExitCode.Usage;
  }
  for (const note of diff.notes) warn(note);

  if (!args.quiet) {
    for (const change of diff.changes) io.stdout.write(`${changeLine(change)}\n`);
  }
  io.stdout.write(`${summaryLine(diff)}\n`);
  for (const reporter of args.reporters) {
    await writeReport(resolve(reporter.file), render(reporter, diff));
  }
  return gate(args, diff);
}
