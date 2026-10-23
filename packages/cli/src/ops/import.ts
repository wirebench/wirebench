/**
 * `import` (spec §2): adds a WSDL or an OpenAPI document to the project, placed the way the desktop
 * places one (R4): a unique slug, the definition cached under the new folder, the endpoints the
 * WSDL's ports name, and a `Request 1` per operation; or the mapped API with its documents cached.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  apiDefinitionDir,
  containersOf,
  contractPorts,
  createHttpFetchDocument,
  createInterface,
  createRequest,
  DEFAULT_WSA_CONFIG,
  definitionCacheDir,
  detectImportFormat,
  endpointsFromContract,
  generateId,
  generateSoapRequest,
  importBruno,
  importCollectionV3Folder,
  importHoppscotch,
  importInsomnia,
  importOpenApi,
  importThunderClient,
  importWsdl,
  nextApiOrder,
  qnameToString,
  restApisOf,
  saveProject,
  soapInterfacesOf,
  takenContainerSlugs,
  uniqueSlug,
  VAULT_SECRETS_LINE,
  writeApiDefinitionCache,
  withContainersOf,
  writeDefinitionCache,
} from '@wirebench/engine';
import type {
  BuiltinImportFormatKind,
  Endpoint,
  FetchDocument,
  ImportedScriptFile,
  ImportedVariables,
  ImportReport,
  MappedClientEntry,
  WsdlImportResult,
  Interface,
  OperationDef,
  Project,
  RestApi,
} from '@wirebench/engine';
import { z } from 'zod';
import { proxyFromEnv } from '../proxy-env.js';
import { defineOp } from './context.js';
import type { OpsContext } from './context.js';
import { OpsError } from './errors.js';
import { openProject } from './project.js';
import { redactUrlsInText } from './redact.js';

export interface ImportedItem {
  readonly kind: 'soap' | 'rest' | 'grpc' | 'websocket';
  readonly name: string;
  readonly slug: string;
  /** The definition's operations; absent for a collection, which has requests only. */
  readonly operations?: number;
  readonly requests: number;
}

export interface ImportProblemView {
  readonly code: string;
  readonly message: string;
  readonly where?: string;
}

export interface ImportOutput {
  readonly format: 'wsdl' | 'openapi' | 'postman-v3' | 'insomnia' | 'bruno' | 'hoppscotch' | 'thunder-client';
  readonly added: readonly ImportedItem[];
  /** What the importer reported it could not map. */
  readonly problems: readonly ImportProblemView[];
}

export interface ReadSource {
  readonly text: string;
  /** The absolute location relative references resolve against: a `file:` URL or the fetched URL. */
  readonly location: string;
  /** What the new API records as its definition's source. */
  readonly source: string;
  readonly filename?: string;
  readonly url?: string;
}

const input = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'A WSDL or OpenAPI file (an absolute path is safest), an http(s) URL, an Insomnia, Hoppscotch or Thunder Client export, a Bruno collection (its folder, its bruno.json or a JSON export), a thunder-tests folder, or a folder collection (v3): its folder, its .resources/definition.yaml, or a workspace folder holding collections/',
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('The name of the new interface or API; by default the definition names it'),
});

/** The fetcher for URLs and for the documents a definition references, through the proxy the environment names. */
export function fetcherFor(env: NodeJS.ProcessEnv): FetchDocument {
  // Read on the first network fetch: a malformed proxy variable must not fail an import from a file.
  let proxyFor: ReturnType<typeof proxyFromEnv> | undefined;
  return createHttpFetchDocument({
    network: (url) => {
      proxyFor ??= proxyFromEnv(env);
      const proxy = proxyFor(url);
      return Promise.resolve(proxy !== undefined ? { proxy } : {});
    },
  });
}

export async function readSource(source: string, fetchDocument: FetchDocument): Promise<ReadSource> {
  if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchDocument(source);
    return { text: fetched.text, location: fetched.location, source, url: source };
  }
  const path = resolve(source);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new OpsError('file-not-found', `Cannot read ${path}`, { path });
  }
  return { text, location: pathToFileURL(path).href, source: path, filename: basename(path) };
}

/** Every distinct port address of the definition, as the interface's endpoints (`${` escaped, #223). */
function endpointsOf(result: WsdlImportResult): Endpoint[] {
  return endpointsFromContract(contractPorts(result.definition), generateId);
}

/** One operation per binding operation, each with a generated `Request 1`, as the desktop's import makes them. */
function operationsOf(result: WsdlImportResult, endpointId: string | undefined): OperationDef[] {
  const taken = new Set<string>();
  return result.operations.map((summary, index) => {
    const slug = uniqueSlug(summary.operationName, taken);
    taken.add(slug);
    const generated = generateSoapRequest(result, {
      bindingName: summary.bindingName,
      operationName: summary.operationName,
    });
    const request = createRequest('Request 1', {
      envelopeXml: generated.envelopeXml,
      soapVersion: generated.soapVersion,
      order: 0,
      ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
      ...(endpointId !== undefined ? { endpointId } : {}),
    });
    return {
      name: summary.operationName,
      bindingName: qnameToString(summary.bindingName),
      slug,
      order: index,
      requests: [request],
    };
  });
}

/**
 * Writes a definition cache after the project is saved, so a failed save leaves no orphan folder. A
 * failed write does not undo the import (the definition is already in the project, as on the
 * desktop): it is reported as a problem.
 */
async function cacheWrite(write: () => Promise<unknown>): Promise<ImportProblemView[]> {
  try {
    await write();
    return [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      {
        code: 'definition-cache-write-failed',
        message: redactUrlsInText(
          `The definition was imported but not cached: ${reason}; import it again once the folder is writable`,
        ),
      },
    ];
  }
}

async function addWsdl(
  context: OpsContext,
  project: Project,
  read: ReadSource,
  fetchDocument: FetchDocument,
  name: string | undefined,
): Promise<ImportOutput> {
  const result = await importWsdl({ kind: 'text', text: read.text, location: read.location }, { fetchDocument });
  const interfaceName =
    name ?? result.definition.services[0]?.name.localName ?? read.filename ?? basename(new URL(read.location).pathname);
  // Every top-level slug, APIs' too: an interface sharing an API's slug makes the next load skip that
  // API (`api-slug-conflict`), and the save after it would delete its folder.
  const taken = new Set([...takenContainerSlugs(project, 'interfaces'), ...takenContainerSlugs(project, 'apis')]);
  const slug = uniqueSlug(interfaceName, taken);
  const cache = project.settings.cacheDefinitions;
  const endpoints = endpointsOf(result);
  const iface: Interface = {
    ...createInterface(interfaceName, {
      id: generateId(),
      slug,
      definitionUrl: result.bundle.root.location,
      targetNamespace: result.definition.targetNamespace,
      order: soapInterfacesOf(project).length,
      cacheDefinition: cache,
      endpoints,
      operations: operationsOf(result, endpoints[0]?.id),
    }),
    // A WSDL that declares WS-Addressing turns it on straight away, as the desktop's import does.
    wsa: { ...DEFAULT_WSA_CONFIG, enabled: result.wsa.enabled, version: result.wsa.version },
  };
  await saveProject(
    { ...project, containers: { ...project.containers, soap: [...soapInterfacesOf(project), iface] } },
    context.projectDir,
  );
  const cacheProblems = cache
    ? await cacheWrite(() => writeDefinitionCache(result.bundle, definitionCacheDir(context.projectDir, slug)))
    : [];
  return {
    format: 'wsdl',
    added: [
      {
        kind: 'soap',
        name: interfaceName,
        slug,
        operations: iface.operations.length,
        requests: iface.operations.length,
      },
    ],
    problems: [
      ...result.problems.map((problem) => ({
        code: problem.code,
        message: redactUrlsInText(problem.message),
        ...(problem.location !== undefined
          ? {
              where: redactUrlsInText(
                problem.line !== undefined ? `${problem.location}:${String(problem.line)}` : problem.location,
              ),
            }
          : {}),
      })),
      ...cacheProblems,
    ],
  };
}

async function addOpenApi(
  context: OpsContext,
  project: Project,
  read: ReadSource,
  fetchDocument: FetchDocument,
  name: string | undefined,
): Promise<ImportOutput> {
  const imported = await importOpenApi(
    { kind: 'text', text: read.text, location: read.location },
    {
      fetchDocument,
      webhooks: false,
      order: nextApiOrder(project),
      ...(name !== undefined ? { name } : {}),
    },
  );
  const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);
  const slug = uniqueSlug(imported.api.name, taken);
  const cache = project.settings.cacheDefinitions;
  const version = imported.summary.declaredVersion;
  const api: RestApi = { ...imported.api, slug, definition: { source: read.source, cache, version } };
  await saveProject(
    { ...project, containers: { ...project.containers, rest: [...restApisOf(project), api] } },
    context.projectDir,
  );
  const cacheProblems = cache
    ? await cacheWrite(() =>
        writeApiDefinitionCache(imported.documents, apiDefinitionDir(context.projectDir, slug), {
          declaredVersion: version,
        }),
      )
    : [];
  return {
    format: 'openapi',
    added: [
      {
        kind: 'rest',
        name: api.name,
        slug,
        operations: imported.document.operations.length,
        requests: imported.summary.requests,
      },
    ],
    problems: [
      ...imported.summary.skipped.map((skipped) => ({
        code: `skipped-${skipped.kind}`,
        message: redactUrlsInText(skipped.reason),
        where: redactUrlsInText(skipped.where),
      })),
      ...cacheProblems,
    ],
  };
}

/** A collection's `.resources/definition.yaml`, which stands for the collection's folder. */
const COLLECTION_DEFINITION = /(?:^|[\\/])\.resources[\\/]definition\.ya?ml$/i;

/** Whether `source` names a folder collection: a folder, or a collection's definition file. */
async function isCollectionFolder(source: string): Promise<boolean> {
  if (/^https?:\/\//i.test(source)) return false;
  if (COLLECTION_DEFINITION.test(source)) return true;
  try {
    return (await stat(resolve(source))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether `source` is a Bruno collection's folder: a folder holding a `bruno.json`, and no
 * `opencollection.yml`, which would make it an OpenCollection folder instead.
 */
async function isBrunoFolder(source: string): Promise<boolean> {
  if (/^https?:\/\//i.test(source)) return false;
  try {
    const names = new Set((await readdir(resolve(source))).map((name) => name.toLowerCase()));
    return names.has('bruno.json') && !names.has('opencollection.yml') && !names.has('opencollection.yaml');
  } catch {
    return false;
  }
}

/** The files only a legacy Thunder Client folder holds. */
const THUNDER_LEGACY_FILES = ['thunderclient.json', 'thundercollection.json', 'thunderenvironment.json'];

/**
 * Whether `source` is a Thunder Client `thunder-tests` folder: named so, holding the legacy files,
 * or with `tc_col_*.json` files in its `collections/`, which a folder collection's workspace never has.
 */
async function isThunderFolder(source: string): Promise<boolean> {
  if (/^https?:\/\//i.test(source)) return false;
  const path = resolve(source);
  try {
    if (!(await stat(path)).isDirectory()) return false;
    if (basename(path).toLowerCase() === 'thunder-tests') return true;
    const names = (await readdir(path)).map((name) => name.toLowerCase());
    if (names.some((name) => THUNDER_LEGACY_FILES.includes(name))) return true;
    if (!names.includes('collections')) return false;
    const inner = await readdir(resolve(path, 'collections')).catch(() => [] as string[]);
    return inner.some((name) => /^tc_col_.*\.json$/i.test(name));
  } catch {
    return false;
  }
}

/** Requests in a container of any kind, its folders' included. */
function requestCount(container: {
  readonly folders: readonly unknown[];
  readonly requests: readonly unknown[];
}): number {
  return (
    container.requests.length +
    container.folders.reduce<number>(
      (sum, folder) =>
        sum + requestCount(folder as { readonly folders: readonly unknown[]; readonly requests: readonly unknown[] }),
      0,
    )
  );
}

/** A collection export, mapped: what {@link addMappedCollections} places. */
interface MappedCollections {
  readonly collections: readonly MappedClientEntry[];
  readonly variables: ImportedVariables;
  readonly scripts?: readonly ImportedScriptFile[];
  readonly report: ImportReport;
}

/** Why the command line leaves environments out, for a file of them or a collection that has some. */
const NO_WORKSPACE = 'the command line has no workspace. Import the file in the desktop to bring them across.';

/**
 * A mapped collection export (a folder (v3) collection or another client's export): each
 * collection's REST, gRPC and WebSocket APIs under free slugs, and its plain variables as project
 * properties a name the project already has keeps its value. The command line has no secret store,
 * no workspace and no script folder, so secret variables, environments, globals and scripts are
 * reported, not imported; so is a `.proto` definition, which only the desktop loads.
 */
async function addMappedCollections(
  context: OpsContext,
  project: Project,
  mapped: MappedCollections,
  format: 'postman-v3' | 'insomnia' | 'bruno' | 'hoppscotch' | 'thunder-client',
): Promise<ImportOutput> {
  const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);
  const added: ImportedItem[] = [];
  const noDefinition: string[] = [];
  let next = project;
  for (const collection of mapped.collections) {
    for (const api of [collection.rest, collection.grpc, collection.websocket]) {
      if (api === undefined) continue;
      const slug = uniqueSlug(api.name, taken);
      taken.add(slug);
      next = withContainersOf(next, api.kind, [...containersOf(next, api.kind), { ...api, slug }]);
      added.push({ kind: api.kind, name: api.name, slug, requests: requestCount(api) });
    }
    if (collection.grpc !== undefined && collection.grpcProtos !== undefined) noDefinition.push(collection.grpc.name);
  }
  // A Map, then fromEntries: a variable named like an Object.prototype member stays an own entry.
  const properties = new Map(Object.entries(next.properties));
  const disabled = new Set(next.disabledProperties);
  const secrets: string[] = [];
  const kept: string[] = [];
  for (const variable of mapped.variables.projectProperties?.variables ?? []) {
    if (variable.secret) secrets.push(variable.name);
    else if (properties.has(variable.name)) kept.push(variable.name);
    else {
      properties.set(variable.name, variable.value);
      if (!variable.enabled) disabled.add(variable.name);
    }
  }
  next = { ...next, properties: Object.fromEntries(properties), disabledProperties: [...disabled] };
  await saveProject(next, context.projectDir);

  const problems: ImportProblemView[] = [];
  if (kept.length > 0) {
    problems.push({
      code: 'property-kept',
      message: `The project already has ${kept.join(', ')}; its values were kept.`,
    });
  }
  if (secrets.length > 0) {
    problems.push({
      code: 'secret-not-imported',
      message: `Secret variables are not imported from the command line: ${secrets.join(', ')}. Set them in the desktop or a secret source.`,
    });
  }
  const environments = mapped.variables.environments.length + (mapped.variables.globals !== undefined ? 1 : 0);
  if (environments > 0) {
    problems.push({
      code: 'environments-not-imported',
      message: `${String(environments)} environment and globals file(s) were not imported: ${NO_WORKSPACE}`,
    });
  }
  const scripts = mapped.scripts?.length ?? 0;
  if (scripts > 0) {
    problems.push({
      code: 'scripts-not-saved',
      message: `${String(scripts)} script(s) were not saved: the command line keeps no imported scripts. Import the file in the desktop to keep them as text.`,
    });
  }
  if (noDefinition.length > 0) {
    problems.push({
      code: 'definition-not-imported',
      message: `${noDefinition.join(', ')}: the export's .proto files were not imported from the command line; import them with the API, or use server reflection.`,
    });
  }
  // The variable plan's own report (a credential cut from a URL, credential-looking names) joins
  // the import's: the properties it speaks of were written above. Its vault line asks for values
  // in a secret store this command does not write; secret-not-imported already names those.
  const variableWarnings = mapped.variables.report.warnings.filter((line) => !line.includes(VAULT_SECRETS_LINE));
  const warnings = [...mapped.report.warnings, ...variableWarnings];
  const notes = [...mapped.report.notes, ...mapped.variables.report.notes];
  problems.push(
    ...warnings.map((message) => ({ code: 'import-warning', message: redactUrlsInText(message) })),
    ...notes.map((message) => ({ code: 'import-note', message: redactUrlsInText(message) })),
  );
  return { format, added, problems };
}

/** An Insomnia export's text, mapped; a file of environments alone is refused, as the command line has no workspace. */
async function addInsomnia(
  context: OpsContext,
  project: Project,
  text: string,
  name: string | undefined,
): Promise<ImportOutput> {
  const mapped = await importInsomnia(
    { kind: 'text', text },
    { firstOrder: nextApiOrder(project), ...(name !== undefined ? { name } : {}) },
  );
  if (mapped.collections.length === 0 && mapped.variables.projectProperties === undefined) {
    throw new OpsError(
      'environments-not-imported',
      `The file holds only environments, which are not imported: ${NO_WORKSPACE}`,
    );
  }
  return addMappedCollections(context, project, mapped, 'insomnia');
}

/** A Bruno collection, from its folder or a JSON export's text. */
async function addBruno(
  context: OpsContext,
  project: Project,
  source: { readonly kind: 'folder'; readonly path: string } | { readonly kind: 'text'; readonly text: string },
  name: string | undefined,
): Promise<ImportOutput> {
  const mapped = await importBruno(source, {
    firstOrder: nextApiOrder(project),
    ...(name !== undefined ? { name } : {}),
  });
  return addMappedCollections(context, project, mapped, 'bruno');
}

/**
 * Through the registry's importer for `format` (phase 7 spec §4): a format that lands in a kind that
 * is off is refused, as the desktop's Import dialog does not offer it.
 *
 * @throws WirebenchError `feature-disabled` when the kind the source would add is off
 */
function refuseOffFormat(context: OpsContext, format: BuiltinImportFormatKind): void {
  context.registry.extensions.importer(format);
}

/** The formats this op imports; any other is refused below with its own message. */
const IMPORTED_FORMATS: ReadonlySet<BuiltinImportFormatKind> = new Set<BuiltinImportFormatKind>([
  'wsdl',
  'openapi',
  'insomnia',
  'hoppscotch',
  'thunder-client',
  'bruno',
]);

export const importOp = defineOp({
  name: 'import',
  title: 'Import a definition',
  description:
    'Imports a WSDL or OpenAPI definition (a file path or an http(s) URL) into the project as a new SOAP ' +
    'interface or REST API, with its definition cached and one sample request per operation; or a folder ' +
    'collection (v3), an Insomnia, Hoppscotch or Thunder Client export or a Bruno collection as its REST, gRPC and WebSocket APIs with its plain variables as ' +
    'project properties. ' +
    'Writes the project folder. Needs the server started with --allow-write.',
  input,
  async run(value, context): Promise<ImportOutput> {
    if (!context.gates.write) {
      throw new OpsError(
        'write-not-allowed',
        'import writes to the project; start wirebench mcp with --allow-write to allow it',
      );
    }
    const { project } = await openProject(context);
    if (await isBrunoFolder(value.source)) {
      refuseOffFormat(context, 'bruno');
      return addBruno(context, project, { kind: 'folder', path: resolve(value.source) }, value.name);
    }
    if (await isThunderFolder(value.source)) {
      refuseOffFormat(context, 'thunder-client');
      const mapped = await importThunderClient(
        { kind: 'folder', path: resolve(value.source) },
        { firstOrder: nextApiOrder(project), ...(value.name !== undefined ? { name: value.name } : {}) },
      );
      return addMappedCollections(context, project, mapped, 'thunder-client');
    }
    if (await isCollectionFolder(value.source)) {
      refuseOffFormat(context, 'postman-v3');
      const path = resolve(value.source);
      const mapped = await importCollectionV3Folder(path, {
        firstOrder: nextApiOrder(project),
        ...(value.name !== undefined ? { name: value.name } : {}),
      });
      return addMappedCollections(context, project, mapped, 'postman-v3');
    }
    const fetchDocument = fetcherFor(context.env);
    const read = await readSource(value.source, fetchDocument);
    const detected = detectImportFormat({ text: read.text, filename: read.filename, url: read.url });
    // Per format (feature switches spec §5.2): a WSDL needs SOAP on, every other format here REST.
    if (detected.kind !== 'unknown' && IMPORTED_FORMATS.has(detected.kind)) {
      refuseOffFormat(context, detected.kind);
    }
    if (detected.kind === 'wsdl') {
      return addWsdl(context, project, read, fetchDocument, value.name);
    }
    if (detected.kind === 'openapi') {
      return addOpenApi(context, project, read, fetchDocument, value.name);
    }
    if (detected.kind === 'insomnia') {
      return addInsomnia(context, project, read.text, value.name);
    }
    if (detected.kind === 'hoppscotch') {
      const mapped = await importHoppscotch(
        { kind: 'text', text: read.text },
        { firstOrder: nextApiOrder(project), ...(value.name !== undefined ? { name: value.name } : {}) },
      );
      return addMappedCollections(context, project, mapped, 'hoppscotch');
    }
    if (detected.kind === 'thunder-client') {
      const mapped = await importThunderClient(
        { kind: 'text', text: read.text },
        { firstOrder: nextApiOrder(project), ...(value.name !== undefined ? { name: value.name } : {}) },
      );
      return addMappedCollections(context, project, mapped, 'thunder-client');
    }
    if (detected.kind === 'bruno') {
      // A collection's bruno.json stands for its folder; any other file is a JSON export.
      const folder = read.url === undefined && read.filename?.toLowerCase() === 'bruno.json';
      return addBruno(
        context,
        project,
        folder ? { kind: 'folder', path: dirname(read.source) } : { kind: 'text', text: read.text },
        value.name,
      );
    }
    if (detected.kind.endsWith('-environment')) {
      throw new OpsError(
        'environments-not-imported',
        `${value.source} reads as ${detected.label}, which is not imported: ${NO_WORKSPACE}`,
        { format: detected.kind },
      );
    }
    throw new OpsError(
      'unsupported-format',
      detected.kind === 'postman-v3'
        ? `${value.source} is one file of a folder collection; import its folder or its .resources/definition.yaml`
        : `${value.source} reads as ${detected.label}; import takes a WSDL or an OpenAPI document, an Insomnia, Hoppscotch, Thunder Client or Bruno export, or a folder collection`,
      { format: detected.kind },
    );
  },
});
