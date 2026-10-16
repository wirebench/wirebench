/**
 * `import` (spec §2): adds a WSDL or an OpenAPI document to the project, placed the way the desktop
 * places one (R4): a unique slug, the definition cached under the new folder, the endpoints the
 * WSDL's ports name, and a `Request 1` per operation; or the mapped API with its documents cached.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
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
  IMPORTED_SCRIPTS_DIR,
  importCollectionV3Folder,
  importInsomnia,
  importOpenApi,
  importWsdl,
  nextApiOrder,
  qnameToString,
  restApisOf,
  saveProject,
  soapInterfacesOf,
  takenContainerSlugs,
  uniqueSlug,
  writeApiDefinitionCache,
  withContainersOf,
  writeDefinitionCache,
} from '@wirebench/engine';
import type {
  Endpoint,
  FetchDocument,
  WsdlImportResult,
  Interface,
  MappedClientImport,
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
      'A WSDL or OpenAPI file (an absolute path is safest), an http(s) URL, an Insomnia export (v4 JSON or v5 YAML), or a folder collection (v3): its folder, its .resources/definition.yaml, or a workspace folder holding collections/',
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

/** What the placement needs of any importer's result; scripts and protos only the client formats have. */
type MappedCollections = Pick<MappedClientImport, 'collections' | 'variables' | 'report'> &
  Partial<Pick<MappedClientImport, 'scripts' | 'protos'>>;

/**
 * Saves an importer's scripts as text under `imported-scripts/`, never overwriting a file and never
 * leaving that folder. Returns what could not be written, for the report.
 */
async function writeScripts(
  projectDir: string,
  scripts: readonly { readonly path: string; readonly source: string }[],
): Promise<ImportProblemView[]> {
  const problems: ImportProblemView[] = [];
  const root = resolve(projectDir, IMPORTED_SCRIPTS_DIR);
  for (const script of scripts) {
    const target = resolve(projectDir, script.path);
    if (!target.startsWith(root + sep)) {
      problems.push({
        code: 'script-not-saved',
        message: `The script ${script.path} would have been saved outside ${IMPORTED_SCRIPTS_DIR}/ and was not written.`,
      });
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, script.source, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
      problems.push({
        code: 'script-not-saved',
        message: exists
          ? `A script already exists at ${script.path}; it was not overwritten.`
          : `The script ${script.path} could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return problems;
}

/**
 * An importer's collections (a v3 folder, or a client's export): each collection's REST, gRPC and
 * WebSocket APIs under free slugs, and its plain variables as project properties; a name the project
 * already has keeps its value. The command line has no secret store and no workspace, so secret
 * variables, environments and globals are reported, not imported; scripts are saved as text, and
 * gRPC APIs are placed without their `.proto` definitions.
 */
async function addMappedCollections(
  context: OpsContext,
  project: Project,
  mapped: MappedCollections,
  format: ImportOutput['format'],
): Promise<ImportOutput> {
  const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);
  const added: ImportedItem[] = [];
  let next = project;
  for (const collection of mapped.collections) {
    for (const api of [collection.rest, collection.grpc, collection.websocket]) {
      if (api === undefined) continue;
      const slug = uniqueSlug(api.name, taken);
      taken.add(slug);
      next = withContainersOf(next, api.kind, [...containersOf(next, api.kind), { ...api, slug }]);
      added.push({ kind: api.kind, name: api.name, slug, requests: requestCount(api) });
    }
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
      message: `${String(environments)} environment and globals file(s) were not imported: the command line has no workspace. Import the folder in the desktop to bring them across.`,
    });
  }
  const warnings = [...mapped.report.warnings, ...mapped.variables.report.warnings];
  const notes = [...mapped.report.notes, ...mapped.variables.report.notes];
  problems.push(
    ...warnings.map((message) => ({ code: 'import-warning', message: redactUrlsInText(message) })),
    ...notes.map((message) => ({ code: 'import-note', message: redactUrlsInText(message) })),
  );
  if ((mapped.protos?.length ?? 0) > 0) {
    problems.push({
      code: 'proto-not-imported',
      message: `The command line does not place .proto definitions: ${(mapped.protos ?? []).map((proto) => proto.name).join(', ')}. The gRPC APIs were added without them; import the file in the desktop to bring them across.`,
    });
  }
  problems.push(...(await writeScripts(context.projectDir, mapped.scripts ?? [])));
  return { format, added, problems };
}

async function addCollectionV3(
  context: OpsContext,
  project: Project,
  path: string,
  name: string | undefined,
): Promise<ImportOutput> {
  const mapped = await importCollectionV3Folder(path, {
    firstOrder: nextApiOrder(project),
    ...(name !== undefined ? { name } : {}),
  });
  return addMappedCollections(context, project, mapped, 'postman-v3');
}

async function addInsomnia(
  context: OpsContext,
  project: Project,
  read: ReadSource,
  name: string | undefined,
): Promise<ImportOutput> {
  const mapped = await importInsomnia(
    { kind: 'text', text: read.text },
    { firstOrder: nextApiOrder(project), ...(name !== undefined ? { name } : {}) },
  );
  return addMappedCollections(context, project, mapped, 'insomnia');
}

export const importOp = defineOp({
  name: 'import',
  title: 'Import a definition',
  description:
    'Imports a WSDL or OpenAPI definition (a file path or an http(s) URL) into the project as a new SOAP ' +
    'interface or REST API, with its definition cached and one sample request per operation; or a folder ' +
    'collection (v3) or an Insomnia export (v4 JSON, v5 YAML) as its REST, gRPC and WebSocket APIs with its plain variables as project properties and its scripts saved as text. ' +
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
    if (await isCollectionFolder(value.source)) {
      return addCollectionV3(context, project, resolve(value.source), value.name);
    }
    const fetchDocument = fetcherFor(context.env);
    const read = await readSource(value.source, fetchDocument);
    const detected = detectImportFormat({ text: read.text, filename: read.filename, url: read.url });
    if (detected.kind === 'wsdl') {
      return addWsdl(context, project, read, fetchDocument, value.name);
    }
    if (detected.kind === 'openapi') {
      return addOpenApi(context, project, read, fetchDocument, value.name);
    }
    if (detected.kind === 'insomnia') {
      return addInsomnia(context, project, read, value.name);
    }
    if (detected.kind.endsWith('-environment')) {
      throw new OpsError(
        'environments-not-imported',
        `${value.source} reads as ${detected.label}; the command line has no workspace for environments. Import it in the desktop.`,
        { format: detected.kind },
      );
    }
    throw new OpsError(
      'unsupported-format',
      detected.kind === 'postman-v3'
        ? `${value.source} is one file of a folder collection; import its folder or its .resources/definition.yaml`
        : `${value.source} reads as ${detected.label}; import takes a WSDL or an OpenAPI document, or an Insomnia export, or a folder collection`,
      { format: detected.kind },
    );
  },
});
