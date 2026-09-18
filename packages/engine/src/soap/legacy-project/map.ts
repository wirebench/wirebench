/**
 * Maps a parsed legacy SOAP project onto Wirebench project entities.
 *
 * Pure: resolving each interface's definition (which needs the network or the definition cache) is
 * the caller's job, and it hands the result in as a {@link ResolvedLegacyInterface}. What comes back
 * is ready to be added to a project, plus the report of everything that did not come across.
 */

import type {
  EndpointAuth,
  Endpoint,
  Environment,
  IdGenerator,
  Interface,
  OperationDef,
  SoapRequestDef,
} from '../../project/model.js';
import { createInterface, createRequest, generateId } from '../../project/model.js';
import { slugify, uniqueSlug } from '../../project/paths.js';
import type { OperationSummary } from '../../types.js';
import { DEFAULT_WSA_CONFIG } from '../../wsa/model.js';
import { qnameToString } from '../../wsdl/qname.js';
import type { LegacyCall, LegacyInterface, LegacyOperation, LegacyProject, LegacyScript } from './model.js';

/** One operation of a resolved definition, as the mapper needs it. */
export interface ResolvedOperation {
  /** The owning binding as `{namespace}localName`. */
  readonly bindingName: string;
  readonly name: string;
  readonly soapVersion: '1.1' | '1.2' | 'none';
  readonly soapAction?: string;
}

/** The engine's operation summaries, as {@link ResolvedOperation}s. */
export function resolvedOperationsOf(summaries: readonly OperationSummary[]): ResolvedOperation[] {
  return summaries.map((summary) => ({
    bindingName: qnameToString(summary.bindingName),
    name: summary.operationName,
    soapVersion: summary.soapVersion,
    ...(summary.soapAction !== undefined ? { soapAction: summary.soapAction } : {}),
  }));
}

/** A legacy interface after the caller tried to resolve its definition. */
export type ResolvedLegacyInterface = {
  readonly legacy: LegacyInterface;
  /** The id and slug the caller chose (the slug names the definition-cache folder it wrote). */
  readonly id: string;
  readonly slug: string;
} & (
  | {
      readonly resolved: true;
      readonly definitionUrl: string;
      readonly targetNamespace?: string;
      readonly operations: readonly ResolvedOperation[];
      /** Locations that were not in the file's cache and came from the network. */
      readonly fetchedFromNetwork: readonly string[];
    }
  | { readonly resolved: false; readonly problem: string }
);

/** What the target project already holds, so nothing imported collides with it. */
export interface LegacyMapContext {
  readonly environmentNames: ReadonlySet<string>;
  readonly environmentSlugs: ReadonlySet<string>;
  readonly propertyNames: ReadonlySet<string>;
  /** The `order` the first imported interface gets; interfaces and APIs share one sequence. */
  readonly firstInterfaceOrder: number;
  readonly firstEnvironmentOrder: number;
  readonly newId?: IdGenerator;
}

/** One line of the import report. */
export interface LegacyImportReportItem {
  readonly severity: 'info' | 'warning';
  /** Owner names from the project down, joined with ` › `; empty for the project itself. */
  readonly path: string;
  readonly message: string;
}

/** What came across, and what did not. */
export interface LegacyImportReport {
  readonly projectName: string;
  readonly counts: {
    readonly interfaces: number;
    readonly operations: number;
    readonly requests: number;
    readonly environments: number;
    readonly properties: number;
    readonly scripts: number;
  };
  readonly items: readonly LegacyImportReportItem[];
}

/** A script to write, as is, under the project folder. */
export interface LegacyScriptFile {
  /** Relative to the project root, `/`-separated, always under {@link IMPORTED_SCRIPTS_DIR}. */
  readonly path: string;
  readonly source: string;
}

/** The mapped entities, ready to add to a project. */
export interface MappedLegacyProject {
  readonly interfaces: readonly Interface[];
  readonly environments: readonly Environment[];
  /** Only the properties the project did not already have. */
  readonly properties: Readonly<Record<string, string>>;
  readonly scripts: readonly LegacyScriptFile[];
  readonly report: LegacyImportReport;
}

/** The folder imported scripts are written to. Nothing in Wirebench reads it. */
export const IMPORTED_SCRIPTS_DIR = 'imported-scripts';

const PATH_SEPARATOR = ' › ';

/** Auth types the file can name that a username alone cannot stand in for. */
const UNSUPPORTED_AUTH = new Set(['SPNEGO/Kerberos', 'OAuth 2.0', 'OAuth 1.0']);

function joinPath(...segments: readonly string[]): string {
  return segments.filter((segment) => segment !== '').join(PATH_SEPARATOR);
}

/** A name not in `taken`, numbered from 2 when it is: `Staging`, `Staging 2`, ... */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((entry) => entry.toLowerCase()));
  if (!lower.has(name.toLowerCase())) {
    return name;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${String(n)}`;
    if (!lower.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/** The credentials a call carried, as Wirebench auth: a username kept, the password never. */
function authOf(call: LegacyCall): EndpointAuth | undefined {
  const { username, domain, authType } = call.credentials;
  if (username === undefined || (authType !== undefined && UNSUPPORTED_AUTH.has(authType))) {
    return undefined;
  }
  if (domain !== undefined || authType === 'NTLM') {
    return { type: 'ntlm', username, ...(domain !== undefined ? { domain } : {}) };
  }
  return { type: 'basic', username, ...(authType === 'Preemptive' ? { preemptive: true } : {}) };
}

class ReportBuilder {
  readonly items: LegacyImportReportItem[] = [];

  info(path: string, message: string): void {
    this.items.push({ severity: 'info', path, message });
  }

  warning(path: string, message: string): void {
    this.items.push({ severity: 'warning', path, message });
  }
}

/** Everything a call carried that the request cannot, reported against `path`. */
function reportCallLosses(call: LegacyCall, path: string, report: ReportBuilder): void {
  if (call.credentials.hadPassword) {
    report.warning(path, 'The password was not imported. Enter it again under Auth.');
  }
  const { authType, username } = call.credentials;
  if (username !== undefined && authType !== undefined && UNSUPPORTED_AUTH.has(authType)) {
    report.warning(path, `${authType} authentication is not imported. Set up auth for this request again.`);
  }
  if (call.assertions > 0) {
    report.warning(
      path,
      `${String(call.assertions)} assertion${call.assertions === 1 ? ' was' : 's were'} not imported.`,
    );
  }
  if (call.attachments > 0) {
    report.warning(
      path,
      `${String(call.attachments)} attachment${call.attachments === 1 ? ' was' : 's were'} not imported. Add the files again.`,
    );
  }
  for (const ref of call.wssRefs) {
    report.warning(path, `The WS-Security configuration "${ref}" was not imported.`);
  }
}

interface MappedOperations {
  readonly operations: OperationDef[];
  readonly requests: number;
}

/**
 * The interface's operations: every operation of the legacy binding in definition order, then any
 * legacy operation the definition no longer has (its requests marked orphaned).
 */
function mapOperations(
  entry: Extract<ResolvedLegacyInterface, { resolved: true }>,
  endpoints: readonly Endpoint[],
  newId: IdGenerator,
  report: ReportBuilder,
): MappedOperations {
  const { legacy } = entry;
  const ownBinding = entry.operations.filter(
    (operation) => legacy.bindingName === undefined || operation.bindingName === legacy.bindingName,
  );
  const byName = new Map<string, LegacyOperation>();
  for (const operation of legacy.operations) {
    byName.set(operation.bindingOperationName, operation);
  }

  const taken = new Set<string>();
  const operations: OperationDef[] = [];
  let requests = 0;

  const build = (
    name: string,
    bindingName: string,
    source: LegacyOperation | undefined,
    resolved: ResolvedOperation | undefined,
  ): void => {
    const slug = uniqueSlug(name, taken);
    taken.add(slug);
    const requestSlugs = new Set<string>();
    const defs: SoapRequestDef[] = [];
    for (const call of source?.calls ?? []) {
      const path = joinPath(legacy.name, name, call.name);
      if (call.envelope === undefined) {
        report.warning(path, `The request was skipped: ${call.envelopeProblem ?? 'its body could not be read'}.`);
        continue;
      }
      const requestSlug = uniqueSlug(call.name, requestSlugs);
      requestSlugs.add(requestSlug);
      const endpoint =
        call.endpoint === undefined ? undefined : endpoints.find((candidate) => candidate.url === call.endpoint);
      const soapVersion =
        resolved !== undefined && resolved.soapVersion !== 'none' ? resolved.soapVersion : legacy.soapVersion;
      const soapAction = resolved?.soapAction ?? source?.action;
      const auth = authOf(call);
      const request = createRequest(call.name, {
        newId,
        slug: requestSlug,
        order: defs.length,
        envelopeXml: call.envelope,
        soapVersion,
        ...(soapAction !== undefined ? { soapAction } : {}),
        ...(endpoint !== undefined ? { endpointId: endpoint.id } : {}),
        properties: {
          ...(call.encoding !== undefined ? { encoding: call.encoding } : {}),
          ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
        },
      });
      defs.push({
        ...request,
        ...(endpoint === undefined && call.endpoint !== undefined ? { endpointUrl: call.endpoint } : {}),
        ...(auth !== undefined ? { auth } : {}),
        ...(call.useWsAddressing ? { wsa: { ...DEFAULT_WSA_CONFIG, enabled: true } } : {}),
        ...(resolved === undefined ? { orphaned: true } : {}),
      });
      reportCallLosses(call, path, report);
    }
    requests += defs.length;
    operations.push({ name, bindingName, slug, order: operations.length, requests: defs });
  };

  const matched = new Set<LegacyOperation>();
  for (const resolved of ownBinding) {
    const source = byName.get(resolved.name);
    if (source !== undefined) {
      matched.add(source);
    }
    build(resolved.name, resolved.bindingName, source, resolved);
  }
  const fallbackBinding = legacy.bindingName ?? ownBinding[0]?.bindingName ?? '';
  for (const source of legacy.operations) {
    if (matched.has(source)) {
      continue;
    }
    if (source.calls.length > 0) {
      report.info(
        joinPath(legacy.name, source.name),
        'The definition no longer has this operation; its requests were kept and marked as orphaned.',
      );
    }
    build(source.bindingOperationName, fallbackBinding, source, undefined);
  }
  return { operations, requests };
}

/** Where a script lands: `imported-scripts/<owners...>/<element>.<ext>`, unique within `taken`. */
function scriptPath(script: LegacyScript, taken: Set<string>): string {
  const extension = script.language?.toLowerCase() === 'javascript' ? 'js' : 'groovy';
  const folder = [IMPORTED_SCRIPTS_DIR, ...script.ownerPath.map(slugify)].join('/');
  let candidate = `${folder}/${script.element}.${extension}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    candidate = `${folder}/${script.element}-${String(n)}.${extension}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Maps `project` onto Wirebench entities. `resolved` holds one entry per `project.interfaces`
 * element, in the same order.
 */
export function mapLegacyProject(
  project: LegacyProject,
  resolved: readonly ResolvedLegacyInterface[],
  context: LegacyMapContext,
): MappedLegacyProject {
  const newId = context.newId ?? generateId;
  const report = new ReportBuilder();

  const interfaces: Interface[] = [];
  const slugByLegacyName = new Map<string, string>();
  let operationCount = 0;
  let requestCount = 0;
  for (const entry of resolved) {
    const { legacy } = entry;
    if (!entry.resolved) {
      report.warning(legacy.name, `The interface was not imported: ${entry.problem}`);
      continue;
    }
    for (const location of entry.fetchedFromNetwork) {
      report.info(legacy.name, `The project file held no copy of ${location}, so it was fetched from the network.`);
    }
    const endpoints: Endpoint[] = legacy.endpoints.map((url) => ({
      id: newId(),
      name: url,
      url,
      authMode: 'complement',
    }));
    const { operations, requests } = mapOperations(entry, endpoints, newId, report);
    operationCount += operations.length;
    requestCount += requests;
    interfaces.push(
      createInterface(legacy.name, {
        id: entry.id,
        slug: entry.slug,
        order: context.firstInterfaceOrder + interfaces.length,
        definitionUrl: entry.definitionUrl,
        ...(entry.targetNamespace !== undefined ? { targetNamespace: entry.targetNamespace } : {}),
        endpoints,
        operations,
      }),
    );
    slugByLegacyName.set(legacy.name, entry.slug);
  }

  const properties: Record<string, string> = {};
  for (const property of project.properties) {
    if (context.propertyNames.has(property.name) || property.name in properties) {
      report.info('', `The project property "${property.name}" already exists and kept its current value.`);
      continue;
    }
    properties[property.name] = property.value;
  }

  const environmentNames = new Set(context.environmentNames);
  const environmentSlugs = new Set(context.environmentSlugs);
  const environments: Environment[] = [];
  for (const legacy of project.environments) {
    const name = uniqueName(legacy.name, environmentNames);
    environmentNames.add(name);
    if (name !== legacy.name) {
      report.info(legacy.name, `An environment with this name already exists, so it was imported as "${name}".`);
    }
    const slug = uniqueSlug(name, environmentSlugs);
    environmentSlugs.add(slug);
    const endpoints: Record<string, string> = {};
    for (const override of legacy.endpoints) {
      const interfaceSlug = slugByLegacyName.get(override.interfaceName);
      if (interfaceSlug === undefined) {
        report.warning(
          joinPath(name, override.interfaceName),
          'The endpoint override was not imported: its interface was not imported.',
        );
        continue;
      }
      endpoints[interfaceSlug] = override.url;
    }
    const values: Record<string, string> = {};
    for (const property of legacy.properties) {
      values[property.name] = property.value;
    }
    environments.push({
      id: newId(),
      name,
      slug,
      order: context.firstEnvironmentOrder + environments.length,
      endpoints,
      properties: values,
      disabledProperties: [],
    });
  }

  const scriptPaths = new Set<string>();
  const scripts: LegacyScriptFile[] = project.scripts.map((script) => {
    const path = scriptPath(script, scriptPaths);
    report.info(joinPath(...script.ownerPath), `A script (${script.element}) was saved to ${path}. It is not run.`);
    return { path, source: script.source };
  });

  for (const unmapped of project.unmapped) {
    report.warning(joinPath(...unmapped.ownerPath), unmapped.message);
  }

  return {
    interfaces,
    environments,
    properties,
    scripts,
    report: {
      projectName: project.name,
      counts: {
        interfaces: interfaces.length,
        operations: operationCount,
        requests: requestCount,
        environments: environments.length,
        properties: Object.keys(properties).length,
        scripts: scripts.length,
      },
      items: report.items,
    },
  };
}

/** The report as plain text, one line per item, for copying out of the dialog. */
export function formatLegacyImportReport(report: LegacyImportReport): string {
  const { counts } = report;
  const lines = [
    `Imported "${report.projectName}": ${String(counts.interfaces)} interfaces, ${String(counts.operations)} operations, ` +
      `${String(counts.requests)} requests, ${String(counts.environments)} environments, ` +
      `${String(counts.properties)} properties, ${String(counts.scripts)} scripts.`,
  ];
  for (const item of report.items) {
    lines.push(
      `${item.severity === 'warning' ? 'Warning' : 'Note'}: ${item.path === '' ? '' : `${item.path}: `}${item.message}`,
    );
  }
  return lines.join('\n');
}
