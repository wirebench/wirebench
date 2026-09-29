/**
 * `import` (spec §2): adds a WSDL or an OpenAPI document to the project, placed the way the desktop
 * places one (R4): a unique slug, the definition cached under the new folder, the endpoints the
 * WSDL's ports name, and a `Request 1` per operation; or the mapped API with its documents cached.
 */
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  apiDefinitionDir,
  createHttpFetchDocument,
  createInterface,
  createRequest,
  DEFAULT_WSA_CONFIG,
  definitionCacheDir,
  detectImportFormat,
  generateId,
  generateRequest,
  importDefinition,
  importOpenApi,
  qnameToString,
  saveProject,
  uniqueSlug,
  writeApiDefinitionCache,
  writeDefinitionCache,
} from '@wirebench/engine';
import type {
  Endpoint,
  FetchDocument,
  ImportResult,
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

export interface ImportedItem {
  readonly kind: 'soap' | 'rest';
  readonly name: string;
  readonly slug: string;
  readonly operations: number;
  readonly requests: number;
}

export interface ImportProblemView {
  readonly code: string;
  readonly message: string;
  readonly where?: string;
}

export interface ImportOutput {
  readonly format: 'wsdl' | 'openapi';
  readonly added: readonly ImportedItem[];
  /** What the importer reported it could not map. */
  readonly problems: readonly ImportProblemView[];
}

interface ReadSource {
  readonly text: string;
  /** The absolute location relative references resolve against: a `file:` URL or the fetched URL. */
  readonly location: string;
  /** What the new API records as its definition's source. */
  readonly source: string;
  readonly filename?: string;
  readonly url?: string;
}

const input = z.object({
  source: z.string().min(1).describe('A WSDL or OpenAPI file (an absolute path is safest) or an http(s) URL'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('The name of the new interface or API; by default the definition names it'),
});

/** The fetcher for URLs and for the documents a definition references, through the proxy the environment names. */
function fetcherFor(env: NodeJS.ProcessEnv): FetchDocument {
  const proxyFor = proxyFromEnv(env);
  return createHttpFetchDocument({
    network: (url) => {
      const proxy = proxyFor(url);
      return Promise.resolve(proxy !== undefined ? { proxy } : {});
    },
  });
}

async function readSource(source: string, fetchDocument: FetchDocument): Promise<ReadSource> {
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

/** Every distinct port address of the definition, as the interface's endpoints. */
function endpointsOf(result: ImportResult): Endpoint[] {
  const seen = new Set<string>();
  const endpoints: Endpoint[] = [];
  for (const service of result.definition.services) {
    for (const port of service.ports) {
      if (port.address === undefined || seen.has(port.address)) {
        continue;
      }
      seen.add(port.address);
      endpoints.push({
        id: generateId(),
        name: `${service.name.localName} ${port.name}`,
        url: port.address,
        authMode: 'complement',
      });
    }
  }
  return endpoints;
}

/** One operation per binding operation, each with a generated `Request 1`, as the desktop's import makes them. */
function operationsOf(result: ImportResult, endpointId: string | undefined): OperationDef[] {
  const taken = new Set<string>();
  return result.operations.map((summary, index) => {
    const slug = uniqueSlug(summary.operationName, taken);
    taken.add(slug);
    const generated = generateRequest(result, {
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

async function addWsdl(
  context: OpsContext,
  project: Project,
  read: ReadSource,
  fetchDocument: FetchDocument,
  name: string | undefined,
): Promise<ImportOutput> {
  const result = await importDefinition({ kind: 'text', text: read.text, location: read.location }, { fetchDocument });
  const interfaceName =
    name ?? result.definition.services[0]?.name.localName ?? read.filename ?? basename(new URL(read.location).pathname);
  const slug = uniqueSlug(interfaceName, new Set(project.interfaces.map((iface) => iface.slug)));
  const cache = project.settings.cacheDefinitions;
  if (cache) {
    await writeDefinitionCache(result.bundle, definitionCacheDir(context.projectDir, slug));
  }
  const endpoints = endpointsOf(result);
  const iface: Interface = {
    ...createInterface(interfaceName, {
      id: generateId(),
      slug,
      definitionUrl: result.bundle.root.location,
      targetNamespace: result.definition.targetNamespace,
      order: project.interfaces.length,
      cacheDefinition: cache,
      endpoints,
      operations: operationsOf(result, endpoints[0]?.id),
    }),
    // A WSDL that declares WS-Addressing turns it on straight away, as the desktop's import does.
    wsa: { ...DEFAULT_WSA_CONFIG, enabled: result.wsa.enabled, version: result.wsa.version },
  };
  await saveProject({ ...project, interfaces: [...project.interfaces, iface] }, context.projectDir);
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
    problems: result.problems.map((problem) => ({
      code: problem.code,
      message: problem.message,
      ...(problem.location !== undefined
        ? { where: problem.line !== undefined ? `${problem.location}:${String(problem.line)}` : problem.location }
        : {}),
    })),
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
      order: project.interfaces.length + project.apis.length,
      ...(name !== undefined ? { name } : {}),
    },
  );
  const taken = new Set([...project.apis.map((api) => api.slug), ...project.interfaces.map((iface) => iface.slug)]);
  const slug = uniqueSlug(imported.api.name, taken);
  const cache = project.settings.cacheDefinitions;
  const version = imported.summary.declaredVersion;
  if (cache) {
    await writeApiDefinitionCache(imported.documents, apiDefinitionDir(context.projectDir, slug), {
      declaredVersion: version,
    });
  }
  const api: RestApi = { ...imported.api, slug, definition: { source: read.source, cache, version } };
  await saveProject({ ...project, apis: [...project.apis, api] }, context.projectDir);
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
    problems: imported.summary.skipped.map((skipped) => ({
      code: `skipped-${skipped.kind}`,
      message: skipped.reason,
      where: skipped.where,
    })),
  };
}

export const importOp = defineOp({
  name: 'import',
  title: 'Import a definition',
  description:
    'Imports a WSDL or OpenAPI definition (a file path or an http(s) URL) into the project as a new SOAP ' +
    'interface or REST API, with its definition cached and one sample request per operation. Writes the ' +
    'project folder. Needs the server started with --allow-write.',
  input,
  async run(value, context): Promise<ImportOutput> {
    if (!context.gates.write) {
      throw new OpsError(
        'write-not-allowed',
        'import writes to the project; start wirebench mcp with --allow-write to allow it',
      );
    }
    const { project } = await openProject(context);
    const fetchDocument = fetcherFor(context.env);
    const read = await readSource(value.source, fetchDocument);
    const detected = detectImportFormat({ text: read.text, filename: read.filename, url: read.url });
    if (detected.kind === 'wsdl') {
      return addWsdl(context, project, read, fetchDocument, value.name);
    }
    if (detected.kind === 'openapi') {
      return addOpenApi(context, project, read, fetchDocument, value.name);
    }
    throw new OpsError(
      'unsupported-format',
      `${value.source} reads as ${detected.label}; import takes a WSDL or an OpenAPI document`,
      { format: detected.kind },
    );
  },
});
