/**
 * Reads a project folder back into a {@link Project}.
 *
 * The folder is the source of truth for names and ordering: an interface is a
 * directory containing `interface.yaml`, a request is a `*.request.yaml` plus
 * its sibling `.xml`, and each entity's `slug` comes from its file name. Every
 * recoverable inconsistency (an orphaned envelope, an operation folder no
 * interface declares) becomes a {@link ProjectProblem} rather than an error, so
 * a slightly damaged project still opens.
 */

import { join } from 'node:path';
import type { Assertion } from '../assert/model.js';
import { ProjectError } from '../errors.js';
import type {
  Attachment,
  AuthConfig,
  Endpoint,
  Environment,
  Interface,
  OperationDef,
  Project,
  ProjectSettings,
  RequestProperties,
  SoapRequestDef,
  WssRef,
} from './model.js';
import type { KeyValueEntry, RestApi, RestBody, RestRequestDef, RestRequestSettings } from '../rest/model.js';
import type { GrpcApi, GrpcRequestDef, GrpcRequestSettings } from '../grpc/model.js';
import type { WsApi, WsRequestDef, WsRequestSettings, WsSavedMessage } from '../ws/model.js';
import { FORMAT_VERSION } from './model.js';
import type { FsLike } from './fs.js';
import { nodeFs, readFileIfExists, readdirIfExists } from './fs.js';
import { migrate } from './migrate.js';
import { normalizeWsa } from '../wsa/model.js';
import {
  API_FILE,
  APIS_DIR,
  assertPathSegment,
  ENVIRONMENTS_DIR,
  FOLDER_FILE,
  INTERFACES_DIR,
  MAX_FOLDER_DEPTH,
  OPERATIONS_DIR,
  REQUEST_SUFFIX,
  REQUESTS_DIR,
  WSS_DIR,
} from './paths.js';
import type { KeyValueEntryFile } from './schema.js';
import {
  apiFileSchema,
  apiKindOf,
  assertSupportedKind,
  grpcApiFileSchema,
  grpcRequestFileSchema,
  environmentFileSchema,
  interfaceFileSchema,
  keystoresFileSchema,
  manifestSchema,
  parseFile,
  requestFileSchema,
  restFolderFileSchema,
  restRequestFileSchema,
  wsApiFileSchema,
  wsRequestFileSchema,
  wssIncomingFileSchema,
  wssOutgoingFileSchema,
} from './schema.js';
import { KEYSTORES_PATH, MANIFEST_PATH } from './serialize.js';
import { parseYaml } from './yaml.js';

/** A recoverable inconsistency found while loading a project. */
export interface ProjectProblem {
  readonly code:
    | 'missing-envelope'
    | 'orphan-operation-folder'
    | 'orphan-request-file'
    | 'missing-interface-file'
    /** An `apis/<slug>/` directory with no `api.yaml`; the API is skipped. */
    | 'missing-api-file'
    /** A raw body whose sibling file is gone; the request loads with an empty body. */
    | 'missing-body'
    /** A folder nested deeper than {@link MAX_FOLDER_DEPTH}; it and everything below it is skipped. */
    | 'folder-too-deep'
    /** An API and an interface sharing a slug, which would make an endpoint override ambiguous. */
    | 'api-slug-conflict';
  readonly message: string;
  /** Path relative to the project root. */
  readonly file: string;
}

/** The result of {@link loadProject}: the model plus anything odd about the folder. */
export interface LoadResult {
  readonly project: Project;
  readonly problems: readonly ProjectProblem[];
}

/** Options for {@link loadProject}. */
export interface LoadProjectOptions {
  readonly fs?: FsLike;
}

function abs(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

async function readYaml(fs: FsLike, root: string, relative: string): Promise<unknown> {
  const buffer = await readFileIfExists(fs, abs(root, relative));
  return buffer === undefined ? undefined : parseYaml(buffer.toString('utf8'), relative);
}

/** Orders entities by their persisted `order`, falling back to a stable name comparison. */
function byOrder<T extends { readonly order: number; readonly name: string }>(a: T, b: T): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Drops `undefined`-valued keys from a zod result, so an absent optional field
 * is truly absent rather than present-and-undefined (`exactOptionalPropertyTypes`).
 */
function exact<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out as T;
}

async function loadRequests(
  fs: FsLike,
  root: string,
  dir: string,
  problems: ProjectProblem[],
): Promise<SoapRequestDef[]> {
  const requests: SoapRequestDef[] = [];
  const entries = await readdirIfExists(fs, abs(root, dir));
  const names = new Set(entries.filter((e) => e.isFile).map((e) => e.name));
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile || !entry.name.endsWith(REQUEST_SUFFIX)) {
      continue;
    }
    const slug = entry.name.slice(0, -REQUEST_SUFFIX.length);
    const relative = `${dir}/${entry.name}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(requestFileSchema, document, relative);
    const xmlRelative = `${dir}/${slug}.xml`;
    const envelope = await readFileIfExists(fs, abs(root, xmlRelative));
    if (envelope === undefined) {
      problems.push({
        code: 'missing-envelope',
        message: `Request "${parsed.name}" has no envelope file; loaded with an empty body`,
        file: xmlRelative,
      });
    }
    names.delete(entry.name);
    names.delete(`${slug}.xml`);
    requests.push({
      kind: 'soap',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      ...optional('endpointId', parsed.endpointId),
      ...optional('endpointUrl', parsed.endpointUrl),
      soapVersion: parsed.soapVersion,
      ...optional('soapAction', parsed.soapAction),
      headers: parsed.headers,
      attachments: parsed.attachments.map((a) => exact<Attachment>(a)),
      ...optional('auth', parsed.auth),
      ...(parsed.wsa !== undefined ? { wsa: normalizeWsa(parsed.wsa) } : {}),
      ...optional('wssOutgoingRef', parsed.wssOutgoingRef),
      ...optional('wssIncomingRef', parsed.wssIncomingRef),
      properties: exact<RequestProperties>(parsed.properties),
      assertions: parsed.assertions.map((a) => exact<Assertion>(a)),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
      envelopeXml: envelope === undefined ? '' : envelope.toString('utf8'),
    });
  }
  for (const orphan of [...names].sort()) {
    problems.push({
      code: 'orphan-request-file',
      message: `"${orphan}" does not belong to any request`,
      file: `${dir}/${orphan}`,
    });
  }
  return requests.sort(byOrder);
}

async function loadInterface(
  fs: FsLike,
  root: string,
  slug: string,
  problems: ProjectProblem[],
): Promise<Interface | undefined> {
  const relative = `${INTERFACES_DIR}/${slug}/interface.yaml`;
  const document = await readYaml(fs, root, relative);
  if (document === undefined) {
    problems.push({
      code: 'missing-interface-file',
      message: `Folder "${slug}" has no interface.yaml and was skipped`,
      file: relative,
    });
    return undefined;
  }
  assertSupportedKind(document, relative);
  const parsed = parseFile(interfaceFileSchema, document, relative);
  const operationsDir = `${INTERFACES_DIR}/${slug}/${OPERATIONS_DIR}`;
  const folders = new Set(
    (await readdirIfExists(fs, abs(root, operationsDir))).filter((e) => e.isDirectory).map((e) => e.name),
  );
  const operations: OperationDef[] = [];
  for (const entry of parsed.operations) {
    folders.delete(entry.slug);
    operations.push({
      name: entry.name,
      bindingName: entry.bindingName,
      slug: entry.slug,
      order: entry.order,
      requests: await loadRequests(fs, root, `${operationsDir}/${entry.slug}`, problems),
    });
  }
  for (const orphan of [...folders].sort()) {
    problems.push({
      code: 'orphan-operation-folder',
      message: `Operation folder "${orphan}" is not listed in interface.yaml`,
      file: `${operationsDir}/${orphan}`,
    });
  }
  const endpoints: readonly Endpoint[] = parsed.endpoints.map((e) => ({
    id: e.id,
    name: e.name,
    url: e.url,
    ...optional('auth', e.auth),
    authMode: e.authMode,
  }));
  return {
    kind: 'soap',
    id: parsed.id,
    name: parsed.name,
    slug,
    order: parsed.order,
    definitionUrl: parsed.definitionUrl,
    cacheDefinition: parsed.cacheDefinition,
    ...optional('targetNamespace', parsed.targetNamespace),
    endpoints,
    ...optional('defaultEndpointId', parsed.defaultEndpointId),
    wsa: normalizeWsa(parsed.wsa),
    ...optional('auth', parsed.auth),
    operations: operations.sort(byOrder),
  };
}

/**
 * Authentication as loaded: the same `undefined`-key drop {@link exact} performs, expressed
 * separately because `AuthConfig` is a union and so has no single mapped shape to hand `exact`.
 * The cast is safe for the same reason `exact`'s is: the schema has already established the
 * arm's own fields, and this only removes keys whose value is absent.
 */
function authConfig(parsed: Record<string, unknown>): AuthConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as unknown as AuthConfig;
}

/** A table row as loaded: `enabled` defaults to true, an absent description stays absent. */
function keyValueEntries(rows: readonly KeyValueEntryFile[]): KeyValueEntry[] {
  return rows.map((row) =>
    exact<KeyValueEntry>({ name: row.name, value: row.value, enabled: row.enabled, description: row.description }),
  );
}

/**
 * One request body as loaded. A raw body's text lives in a sibling file, so it is read here and
 * the file name is dropped: the model holds the text, the layout holds the name
 * (`project/paths.ts` rebuilds it on save from the language).
 */
async function loadBody(
  fs: FsLike,
  root: string,
  dir: string,
  document: RestRequestFileBody,
  requestName: string,
  problems: ProjectProblem[],
): Promise<RestBody> {
  switch (document.kind) {
    case 'raw': {
      const relative = `${dir}/${document.file}`;
      const text = await readFileIfExists(fs, abs(root, relative));
      if (text === undefined) {
        problems.push({
          code: 'missing-body',
          message: `Request "${requestName}" has no body file; loaded with an empty body`,
          file: relative,
        });
      }
      return {
        kind: 'raw',
        language: document.language,
        ...optional('contentType', document.contentType),
        text: text === undefined ? '' : text.toString('utf8'),
      };
    }
    case 'form':
      return { kind: 'form', fields: keyValueEntries(document.fields) };
    case 'multipart':
      return {
        kind: 'multipart',
        parts: document.parts.map((part) =>
          part.kind === 'text'
            ? exact<Extract<RestBody, { kind: 'multipart' }>['parts'][number]>({ ...part, kind: 'text' })
            : exact<Extract<RestBody, { kind: 'multipart' }>['parts'][number]>({ ...part, kind: 'file' }),
        ),
      };
    case 'binary':
      return { kind: 'binary', source: document.source, contentType: document.contentType };
    default:
      return { kind: 'none' };
  }
}

/** The `body` field of a parsed REST request document. */
type RestRequestFileBody = ReturnType<typeof restRequestFileSchema.parse>['body'];

/** A folder of either protocol's tree: the same node, holding one kind of request. */
interface FolderNode<R> {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly folders: readonly FolderNode<R>[];
  readonly requests: readonly R[];
}

/** What one directory of an API's request tree holds. */
interface FolderContents<R> {
  readonly folders: FolderNode<R>[];
  readonly requests: R[];
}

/**
 * Reads one `*.request.yaml` of a tree into a request of the API's protocol, claiming the files it
 * owns (its own, and its body file) out of `unclaimed` so they are not reported as orphans.
 */
type RequestReader<R> = (dir: string, fileName: string, unclaimed: Set<string>) => Promise<R>;

/** Reads a REST request and its raw body file. */
function restRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<RestRequestDef> {
  return async (dir, fileName, unclaimed) => {
    const relative = `${dir}/${fileName}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(restRequestFileSchema, document, relative);
    unclaimed.delete(fileName);
    if (parsed.body.kind === 'raw') {
      unclaimed.delete(parsed.body.file);
    }
    return {
      kind: 'rest',
      id: parsed.id,
      name: parsed.name,
      slug: fileName.slice(0, -REQUEST_SUFFIX.length),
      order: parsed.order,
      ...optional('description', parsed.description),
      method: parsed.method,
      url: parsed.url,
      pathParams: keyValueEntries(parsed.pathParams),
      query: keyValueEntries(parsed.query),
      headers: keyValueEntries(parsed.headers),
      body: await loadBody(fs, root, dir, parsed.body, parsed.name, problems),
      auth: authConfig(parsed.auth),
      settings: exact<RestRequestSettings>(parsed.settings),
      assertions: parsed.assertions.map((a) => exact<Assertion>(a)),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
    };
  };
}

/**
 * Reads a gRPC request and its message file. A request whose message file is gone loads with an
 * empty message and a `missing-body` problem, exactly as a REST raw body does.
 */
function grpcRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<GrpcRequestDef> {
  return async (dir, fileName, unclaimed) => {
    const relative = `${dir}/${fileName}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(grpcRequestFileSchema, document, relative);
    unclaimed.delete(fileName);
    let message = '';
    if (parsed.message !== undefined) {
      unclaimed.delete(parsed.message);
      const messageRelative = `${dir}/${parsed.message}`;
      const text = await readFileIfExists(fs, abs(root, messageRelative));
      if (text === undefined) {
        problems.push({
          code: 'missing-body',
          message: `Request "${parsed.name}" has no message file; loaded with an empty message`,
          file: messageRelative,
        });
      } else {
        message = text.toString('utf8');
      }
    }
    return {
      kind: 'grpc',
      id: parsed.id,
      name: parsed.name,
      slug: fileName.slice(0, -REQUEST_SUFFIX.length),
      order: parsed.order,
      ...optional('description', parsed.description),
      service: parsed.service,
      method: parsed.method,
      methodKind: parsed.methodKind,
      metadata: keyValueEntries(parsed.metadata),
      message,
      auth: authConfig(parsed.auth),
      settings: exact<GrpcRequestSettings>(parsed.settings),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
    };
  };
}

/**
 * Reads a WebSocket request and its saved messages, each in its own sibling file. A message whose
 * file is gone loads with empty content and a `missing-body` problem, exactly as a gRPC message
 * does; its slug is recovered from the file name between the `.msg-` marker and the extension.
 */
function wsRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<WsRequestDef> {
  return async (dir, fileName, unclaimed) => {
    const relative = `${dir}/${fileName}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(wsRequestFileSchema, document, relative);
    unclaimed.delete(fileName);
    const requestSlug = fileName.slice(0, -REQUEST_SUFFIX.length);
    const messages: WsSavedMessage[] = [];
    for (const entry of parsed.messages) {
      assertPathSegment(entry.file);
      unclaimed.delete(entry.file);
      const messageRelative = `${dir}/${entry.file}`;
      const text = await readFileIfExists(fs, abs(root, messageRelative));
      if (text === undefined) {
        problems.push({
          code: 'missing-body',
          message: `Request "${parsed.name}" has no message file; loaded with an empty message`,
          file: messageRelative,
        });
      }
      const slug = entry.file.slice(`${requestSlug}.msg-`.length, entry.file.lastIndexOf('.'));
      messages.push({
        id: entry.id,
        name: entry.name,
        slug,
        format: entry.format,
        content: text === undefined ? '' : text.toString('utf8'),
        ...(entry.contract !== undefined
          ? { contract: { message: entry.contract.message, generated: entry.contract.generated } }
          : {}),
      });
    }
    return {
      kind: 'websocket',
      id: parsed.id,
      name: parsed.name,
      slug: requestSlug,
      order: parsed.order,
      ...optional('description', parsed.description),
      url: parsed.url,
      query: keyValueEntries(parsed.query),
      headers: keyValueEntries(parsed.headers),
      subprotocols: parsed.subprotocols,
      auth: authConfig(parsed.auth),
      settings: exact<WsRequestSettings>(parsed.settings),
      messages,
      ...(parsed.contract !== undefined ? { contract: { channel: parsed.contract.channel } } : {}),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
    };
  };
}

/**
 * Loads one directory of an API's request tree: its `*.request.yaml` files as requests (through
 * the protocol's reader), its subdirectories as folders, recursively.
 *
 * A directory with no `folder.yaml` is still a folder — named after the directory, ordered after
 * the ones that do have a file, and given a file of its own on the next save — because a folder
 * someone created with `mkdir` in a checked-out project is a folder, not a fault. A directory
 * deeper than {@link MAX_FOLDER_DEPTH} becomes a problem and is skipped whole, so nothing is ever
 * written to a path that might not open on Windows.
 */
async function loadFolderContents<R extends { readonly order: number; readonly name: string }>(
  fs: FsLike,
  root: string,
  dir: string,
  depth: number,
  problems: ProjectProblem[],
  readRequest: RequestReader<R>,
): Promise<FolderContents<R>> {
  const entries = await readdirIfExists(fs, abs(root, dir));
  const unclaimed = new Set(entries.filter((e) => e.isFile && e.name !== FOLDER_FILE).map((e) => e.name));
  const requests: R[] = [];
  const folders: FolderNode<R>[] = [];

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile && entry.name.endsWith(REQUEST_SUFFIX)) {
      requests.push(await readRequest(dir, entry.name, unclaimed));
      continue;
    }
    if (!entry.isDirectory) {
      continue;
    }
    const childDir = `${dir}/${entry.name}`;
    if (depth + 1 > MAX_FOLDER_DEPTH) {
      problems.push({
        code: 'folder-too-deep',
        message: `Folder "${entry.name}" is nested more than ${String(MAX_FOLDER_DEPTH)} deep and was skipped`,
        file: childDir,
      });
      continue;
    }
    const contents = await loadFolderContents(fs, root, childDir, depth + 1, problems, readRequest);
    const relative = `${childDir}/${FOLDER_FILE}`;
    const document = await readYaml(fs, root, relative);
    const parsed = document === undefined ? undefined : parseFile(restFolderFileSchema, document, relative);
    folders.push({
      id: parsed?.id ?? `folder:${entry.name}`,
      name: parsed?.name ?? entry.name,
      slug: entry.name,
      order: parsed?.order ?? Number.MAX_SAFE_INTEGER,
      ...optional('description', parsed?.description),
      ...(parsed?.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      folders: contents.folders,
      requests: contents.requests,
    });
  }

  for (const orphan of [...unclaimed].sort()) {
    problems.push({
      code: 'orphan-request-file',
      message: `"${orphan}" does not belong to any request`,
      file: `${dir}/${orphan}`,
    });
  }
  return { folders: folders.sort(byOrder), requests: requests.sort(byOrder) };
}

/** One `apis/<slug>/` directory as loaded: whichever protocol its `api.yaml` says. */
type LoadedApi =
  | { readonly kind: 'rest'; readonly api: RestApi }
  | { readonly kind: 'grpc'; readonly api: GrpcApi }
  | { readonly kind: 'websocket'; readonly api: WsApi };

/** Loads one `apis/<slug>/` directory, or records a problem and returns nothing. */
async function loadApi(
  fs: FsLike,
  root: string,
  slug: string,
  problems: ProjectProblem[],
): Promise<LoadedApi | undefined> {
  const relative = `${APIS_DIR}/${slug}/${API_FILE}`;
  const document = await readYaml(fs, root, relative);
  if (document === undefined) {
    problems.push({
      code: 'missing-api-file',
      message: `Folder "${slug}" has no ${API_FILE} and was skipped`,
      file: relative,
    });
    return undefined;
  }
  assertSupportedKind(document, relative);
  const requestsDir = `${APIS_DIR}/${slug}/${REQUESTS_DIR}`;
  switch (apiKindOf(document)) {
    case 'grpc': {
      const parsed = parseFile(grpcApiFileSchema, document, relative);
      const contents = await loadFolderContents(
        fs,
        root,
        requestsDir,
        0,
        problems,
        grpcRequestReader(fs, root, problems),
      );
      return {
        kind: 'grpc',
        api: {
          kind: 'grpc',
          id: parsed.id,
          name: parsed.name,
          slug,
          order: parsed.order,
          ...optional('description', parsed.description),
          target: parsed.target,
          tls: parsed.tls,
          metadata: keyValueEntries(parsed.metadata),
          ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
          ...(parsed.definition !== undefined
            ? {
                definition: {
                  kind: parsed.definition.kind,
                  source: parsed.definition.source,
                  cache: parsed.definition.cache,
                  roots: parsed.definition.roots,
                  ...optional('reflectionVersion', parsed.definition.reflectionVersion),
                  ...optional('trustInvalid', parsed.definition.trustInvalid),
                },
              }
            : {}),
          folders: contents.folders,
          requests: contents.requests,
        },
      };
    }
    case 'websocket': {
      const parsed = parseFile(wsApiFileSchema, document, relative);
      const contents = await loadFolderContents(
        fs,
        root,
        requestsDir,
        0,
        problems,
        wsRequestReader(fs, root, problems),
      );
      return {
        kind: 'websocket',
        api: {
          kind: 'websocket',
          id: parsed.id,
          name: parsed.name,
          slug,
          order: parsed.order,
          ...optional('description', parsed.description),
          url: parsed.url,
          headers: keyValueEntries(parsed.headers),
          ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
          ...(parsed.definition !== undefined
            ? {
                definition: {
                  kind: parsed.definition.kind,
                  source: parsed.definition.source,
                  cache: parsed.definition.cache,
                  ...optional('server', parsed.definition.server),
                },
              }
            : {}),
          folders: contents.folders,
          requests: contents.requests,
        },
      };
    }
    default: {
      const parsed = parseFile(apiFileSchema, document, relative);
      const contents = await loadFolderContents(
        fs,
        root,
        requestsDir,
        0,
        problems,
        restRequestReader(fs, root, problems),
      );
      return {
        kind: 'rest',
        api: {
          kind: 'rest',
          id: parsed.id,
          name: parsed.name,
          slug,
          order: parsed.order,
          ...optional('description', parsed.description),
          baseUrl: parsed.baseUrl,
          servers: parsed.servers.map((server) => exact<{ url: string; description?: string }>(server)),
          ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
          ...(parsed.definition !== undefined
            ? {
                definition: {
                  source: parsed.definition.source,
                  cache: parsed.definition.cache,
                  version: parsed.definition.version,
                },
              }
            : {}),
          folders: contents.folders,
          requests: contents.requests,
        },
      };
    }
  }
}

async function loadEnvironments(fs: FsLike, root: string): Promise<Environment[]> {
  const environments: Environment[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, ENVIRONMENTS_DIR))) {
    if (!entry.isFile || !entry.name.endsWith('.yaml')) {
      continue;
    }
    const relative = `${ENVIRONMENTS_DIR}/${entry.name}`;
    const parsed = parseFile(environmentFileSchema, await readYaml(fs, root, relative), relative);
    environments.push({
      id: parsed.id,
      name: parsed.name,
      slug: entry.name.slice(0, -'.yaml'.length),
      order: parsed.order,
      endpoints: parsed.endpoints,
      properties: parsed.properties,
      disabledProperties: parsed.disabled ?? [],
    });
  }
  return environments.sort(byOrder);
}

async function loadWssRefs(fs: FsLike, root: string, direction: 'outgoing' | 'incoming'): Promise<WssRef[]> {
  const dir = `${WSS_DIR}/${direction}`;
  const schema = direction === 'outgoing' ? wssOutgoingFileSchema : wssIncomingFileSchema;
  const refs: WssRef[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, dir))) {
    if (!entry.isFile || !entry.name.endsWith('.yaml')) {
      continue;
    }
    const relative = `${dir}/${entry.name}`;
    const parsed = parseFile(schema, await readYaml(fs, root, relative), relative);
    refs.push({ id: parsed.id, name: parsed.name, file: relative, document: parsed });
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Loads the project stored in the directory `root`.
 *
 * @throws ProjectError `project-not-found` when there is no `wirebench.yaml`,
 * `project-format-too-new` for a newer format version, `project-file-invalid`
 * for malformed or schema-violating YAML (with the offending file in `details`).
 */
export async function loadProject(root: string, options?: LoadProjectOptions): Promise<LoadResult> {
  const fs = options?.fs ?? nodeFs;
  const manifestDocument = await readYaml(fs, root, MANIFEST_PATH);
  if (manifestDocument === undefined) {
    throw new ProjectError('project-not-found', `No ${MANIFEST_PATH} in ${root}`, {
      details: { file: MANIFEST_PATH, root },
    });
  }
  const manifest = parseFile(manifestSchema, migrate(manifestDocument, MANIFEST_PATH), MANIFEST_PATH);

  const problems: ProjectProblem[] = [];
  const interfaces: Interface[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, INTERFACES_DIR))) {
    if (!entry.isDirectory) {
      continue;
    }
    const iface = await loadInterface(fs, root, entry.name, problems);
    if (iface !== undefined) {
      interfaces.push(iface);
    }
  }

  const interfaceSlugs = new Set(interfaces.map((iface) => iface.slug.toLowerCase()));
  const apis: RestApi[] = [];
  const grpcApis: GrpcApi[] = [];
  const wsApis: WsApi[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, APIS_DIR))) {
    if (!entry.isDirectory) {
      continue;
    }
    const loaded = await loadApi(fs, root, entry.name, problems);
    if (loaded === undefined) {
      continue;
    }
    // An environment's endpoint overrides are keyed by slug, so two entities sharing one would
    // make the override ambiguous. The folders never collide; the override key would. REST and
    // gRPC APIs share one directory, so their slugs cannot collide with each other.
    if (interfaceSlugs.has(loaded.api.slug.toLowerCase())) {
      problems.push({
        code: 'api-slug-conflict',
        message: `API "${loaded.api.name}" and an interface share the slug "${loaded.api.slug}"; the API was skipped`,
        file: `${APIS_DIR}/${loaded.api.slug}/${API_FILE}`,
      });
      continue;
    }
    if (loaded.kind === 'grpc') {
      grpcApis.push(loaded.api);
    } else if (loaded.kind === 'websocket') {
      wsApis.push(loaded.api);
    } else {
      apis.push(loaded.api);
    }
  }

  const keystoresDocument = await readYaml(fs, root, KEYSTORES_PATH);
  const keystores =
    keystoresDocument === undefined
      ? []
      : parseFile(keystoresFileSchema, keystoresDocument, KEYSTORES_PATH).keystores.map((k) => ({
          id: k.id,
          name: k.name,
          document: k,
        }));

  const project: Project = {
    formatVersion: FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    ...optional('description', manifest.description),
    settings: exact<ProjectSettings>(manifest.settings),
    properties: manifest.properties,
    disabledProperties: manifest.disabled ?? [],
    ...optional('activeEnvironmentId', manifest.activeEnvironmentId),
    interfaces: interfaces.sort(byOrder),
    apis: apis.sort(byOrder),
    grpcApis: grpcApis.sort(byOrder),
    wsApis: wsApis.sort(byOrder),
    environments: await loadEnvironments(fs, root),
    wss: {
      outgoing: await loadWssRefs(fs, root, 'outgoing'),
      incoming: await loadWssRefs(fs, root, 'incoming'),
      keystores,
    },
  };
  return { project, problems };
}
