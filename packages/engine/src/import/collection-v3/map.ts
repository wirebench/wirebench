/**
 * A folder (v3) collection mapped to Wirebench APIs: per collection a REST API for its HTTP requests
 * (through the v2.1 parser and mapper, see `convert.ts`), a gRPC API and a WebSocket API for theirs;
 * the collections' variables as project properties, a workspace folder's environments and globals
 * as the variable plan. Pure.
 */

import { PostmanError } from '../../errors.js';
import { entry } from '../../http/entries.js';
import type { KeyValueEntry } from '../../http/entries.js';
import type { GrpcApi, GrpcFolder, GrpcMethodKind, GrpcRequestDef } from '../../grpc/model.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest, defaultTlsFor } from '../../grpc/model.js';
import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { uniqueSlug } from '../../project/paths.js';
import type { RestApi } from '../../rest/model.js';
import { folderRequests } from '../../rest/model.js';
import { hasCredentials, mapPostmanAuth, apiFromPostmanCollection } from '../../rest/postman/map.js';
import { parsePostmanAuth, parsePostmanCollection } from '../../rest/postman/parse.js';
import { postmanVariablesOf } from '../../rest/postman/variables.js';
import { splitQueryKeepingReferences } from '../../rest/url.js';
import type { WsApi, WsFolder, WsRequestDef, WsRequestSettings } from '../../ws/model.js';
import { createWsApi, createWsFolder, createWsRequest, createWsSavedMessage } from '../../ws/model.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import { rewriteMustache } from '../templates.js';
import { stripUserinfo } from '../values.js';
import type { ImportedVariable, ImportedVariables, ImportedVariableSet } from '../variables.js';
import { VariableSetBuilder } from '../variables.js';
import { reportDefinitionFields, reportUnread, rowsOf, unknownFields, v21Auth, v21DocumentOf } from './convert.js';
import type { V3Folder, V3Request, V3Workspace } from './model.js';
import { MAPPED_V3_KINDS, UNMAPPED_V3_KINDS } from './model.js';

type Rec = Readonly<Record<string, unknown>>;

const GRPC_FIELDS = new Set([
  '$kind',
  'name',
  'description',
  'order',
  'url',
  'methodPath',
  'methodDescriptor',
  'message',
  'metadata',
  'auth',
  'settings',
  'scripts',
]);
const WS_FIELDS = new Set([
  '$kind',
  'name',
  'description',
  'order',
  'url',
  'headers',
  'queryParams',
  'auth',
  'settings',
  'messages',
]);
/** `/package.Service/Method`, the leading slash optional. Each part is one character class: linear. */
export const GRPC_METHOD = /^\/?([\w.]+)\/(\w+)$/;

export interface MapCollectionV3Options {
  readonly newId?: IdGenerator;
  /** The `order` of the first API. 0 by default. */
  readonly firstOrder?: number;
  /** A name for the API(s) of a folder holding one collection; ignored when there are several. */
  readonly name?: string;
}

/** One collection's APIs: each present only when the collection has requests of its kind. */
export interface MappedCollectionV3Entry {
  readonly name: string;
  readonly rest?: RestApi;
  readonly grpc?: GrpcApi;
  readonly websocket?: WsApi;
}

export interface MappedCollectionV3 {
  readonly collections: readonly MappedCollectionV3Entry[];
  /** Project properties from the collections' variables; environments and globals from a workspace folder. */
  readonly variables: ImportedVariables;
  readonly counts: {
    readonly collections: number;
    readonly requests: number;
    readonly folders: number;
    readonly examples: number;
  };
  /** What the mapping did not bring across; the variable lines of environments and globals are in `variables.report`. */
  readonly report: ImportReport;
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

/** `grpcs://host:port` as a target and whether it speaks TLS; a literal host without a port gets the default one. */
export function grpcTarget(url: string): { target: string; tls: boolean } | undefined {
  const match = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?([^/?#]*)/.exec(url.trim());
  const authority = match?.[2] ?? '';
  if (authority === '') return undefined;
  const scheme = match?.[1]?.toLowerCase();
  const tls = scheme === undefined ? defaultTlsFor(authority) : scheme === 'grpcs' || scheme === 'https';
  // A reference may hold the port already, so only a literal host gets the default one.
  const keepsAsIs = /:\d+$/.test(authority) || authority.endsWith('}');
  return { target: keepsAsIs ? authority : `${authority}:${tls ? 443 : 80}`, tls };
}

/** The method kind a descriptor names, when it is JSON saying which side streams. */
function methodKindOf(descriptor: unknown): GrpcMethodKind | undefined {
  let parsed: unknown = descriptor;
  if (typeof descriptor === 'string') {
    try {
      parsed = JSON.parse(descriptor);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) return undefined;
  const client = parsed['requestStream'] ?? parsed['clientStreaming'];
  const server = parsed['responseStream'] ?? parsed['serverStreaming'];
  if (typeof client !== 'boolean' && typeof server !== 'boolean') return undefined;
  if (client === true && server === true) return 'bidi-streaming';
  if (client === true) return 'client-streaming';
  if (server === true) return 'server-streaming';
  return 'unary';
}

/** The running state of one collection's gRPC and WebSocket mapping. */
class ProtocolMapper {
  readonly dynamic = new Set<string>();
  grpcRequests = 0;
  grpcFolders = 0;
  wsRequests = 0;
  wsFolders = 0;
  credentials = 0;
  grpcApiTarget: { target: string; tls: boolean } | undefined;
  wsApiUrl: string | undefined;

  constructor(
    private readonly newId: IdGenerator,
    private readonly report: ReportBuilder,
  ) {}

  rewrite(value: string): string {
    return rewriteMustache(value, this.dynamic);
  }

  auth(raw: unknown, path: string, isRequest: boolean): AuthConfig | undefined {
    const parsed = parsePostmanAuth(v21Auth(raw, path, this.report), this.dynamic);
    if (hasCredentials(parsed)) this.credentials += 1;
    const warnings: string[] = [];
    const mapped = mapPostmanAuth(parsed, isRequest, warnings);
    for (const warning of warnings) this.report.warn(`${path}: ${warning}`);
    return mapped;
  }

  private rows(raw: unknown): KeyValueEntry[] {
    return rowsOf(raw).map((row) =>
      entry(this.rewrite(row.key), this.rewrite(row.value), {
        enabled: row.disabled !== true,
        ...(row.description !== undefined ? { description: row.description } : {}),
      }),
    );
  }

  private url(raw: unknown, path: string): string {
    const { url, stripped } = stripUserinfo(this.rewrite(text(raw)));
    if (stripped) this.report.warn(`${path}: the credential in its URL was not imported; set it on the request.`);
    return url;
  }

  private settingsLeftOut(settings: unknown, read: ReadonlySet<string>, unread: string[]): Rec {
    if (!isRecord(settings)) return {};
    for (const [key, value] of Object.entries(settings)) {
      if (!read.has(key) && !(key === 'strictSSL' && value === true)) unread.push(`settings.${key}`);
    }
    return settings;
  }

  private scriptsLeftOut(request: V3Request, what: string): void {
    if (request.scripts.length > 0) {
      this.report.warn(`${request.path}: ${what} requests have no scripts in Wirebench, so its scripts were left out.`);
    }
  }

  grpcRequest(request: V3Request, slug: string, order: number): GrpcRequestDef | undefined {
    const doc = request.doc;
    const method = GRPC_METHOD.exec(text(doc['methodPath']).trim());
    if (method === null) {
      this.report.warn(`${request.path}: its methodPath is not /service/method, so it was not imported.`);
      return undefined;
    }
    const unread = unknownFields(doc, GRPC_FIELDS);
    this.settingsLeftOut(doc['settings'], new Set(), unread);
    reportUnread(this.report, request.path, unread);
    this.scriptsLeftOut(request, 'gRPC');
    const target = grpcTarget(this.url(doc['url'], request.path));
    if (target !== undefined) {
      if (this.grpcApiTarget === undefined) this.grpcApiTarget = target;
      else if (target.target !== this.grpcApiTarget.target || target.tls !== this.grpcApiTarget.tls) {
        this.report.note(
          `${request.path}: its target ${target.target} differs from the API's ${this.grpcApiTarget.target}; the API's is used.`,
        );
      }
    }
    let methodKind = methodKindOf(doc['methodDescriptor']);
    if (methodKind === undefined) {
      if (doc['methodDescriptor'] !== undefined) {
        this.report.note(
          `${request.path}: its method descriptor does not say how the method streams, so it was imported as unary.`,
        );
      }
      methodKind = 'unary';
    }
    const message = isRecord(doc['message']) ? doc['message']['content'] : doc['message'];
    const description = str(doc['description']);
    this.grpcRequests += 1;
    return createGrpcRequest(request.name, {
      newId: this.newId,
      slug,
      order,
      ...(description !== undefined && description !== '' ? { description } : {}),
      service: method[1]!,
      method: method[2]!,
      methodKind,
      metadata: this.rows(doc['metadata']),
      ...(message !== undefined ? { message: this.rewrite(text(message)) } : {}),
      auth: this.auth(doc['auth'], request.path, true) ?? { type: 'inherit' },
    });
  }

  wsRequest(request: V3Request, slug: string, order: number): WsRequestDef {
    const doc = request.doc;
    const unread = unknownFields(doc, WS_FIELDS);
    const settings = this.settingsLeftOut(doc['settings'], new Set(['handshakeTimeout', 'maxPayload']), unread);
    reportUnread(this.report, request.path, unread);
    this.scriptsLeftOut(request, 'WebSocket');
    const split = splitQueryKeepingReferences(this.url(doc['url'], request.path));
    const query = doc['queryParams'] !== undefined ? this.rows(doc['queryParams']) : split.query;
    if (this.wsApiUrl === undefined) this.wsApiUrl = split.path;
    const handshake = settings['handshakeTimeout'];
    const maxPayload = settings['maxPayload'];
    const wsSettings: WsRequestSettings = {
      ...(typeof handshake === 'number' && Number.isFinite(handshake) && handshake > 0
        ? { handshakeTimeoutMs: handshake }
        : {}),
      ...(typeof maxPayload === 'number' && Number.isInteger(maxPayload) && maxPayload > 0
        ? { maxMessageBytes: maxPayload }
        : {}),
    };
    const messages = request.messages.map((message, index) =>
      createWsSavedMessage(str(message.doc['name']) ?? `Message ${String(index + 1)}`, {
        newId: this.newId,
        content: this.rewrite(text(message.doc['content'])),
        format: 'text',
      }),
    );
    const description = str(doc['description']);
    this.wsRequests += 1;
    return createWsRequest(request.name, {
      newId: this.newId,
      slug,
      order,
      ...(description !== undefined && description !== '' ? { description } : {}),
      url: split.path,
      query,
      headers: this.rows(doc['headers']),
      auth: this.auth(doc['auth'], request.path, true) ?? { type: 'inherit' },
      settings: wsSettings,
      messages,
    });
  }

  /** The folders and requests of `kind` under `folder`; a folder with none below it is left out. */
  walk<F, R>(
    folder: V3Folder,
    kind: string,
    make: {
      readonly folder: (child: V3Folder, input: { slug: string; order: number; folders: F[]; requests: R[] }) => F;
      readonly request: (request: V3Request, slug: string, order: number) => R | undefined;
    },
  ): { folders: F[]; requests: R[]; count: number } {
    const folders: F[] = [];
    const requests: R[] = [];
    const folderSlugs = new Set<string>();
    const requestSlugs = new Set<string>();
    let count = 0;
    for (const child of folder.children) {
      if (child.type === 'request') {
        if (child.kind !== kind) continue;
        const slug = uniqueSlug(child.name, requestSlugs);
        const made = make.request(child, slug, requests.length);
        if (made === undefined) continue;
        requestSlugs.add(slug);
        requests.push(made);
        count += 1;
        continue;
      }
      const inner = this.walk(child, kind, make);
      if (inner.count === 0) continue;
      const slug = uniqueSlug(child.name, folderSlugs);
      folderSlugs.add(slug);
      folders.push(
        make.folder(child, { slug, order: folders.length, folders: inner.folders, requests: inner.requests }),
      );
      count += inner.count;
    }
    return { folders, requests, count };
  }

  folderInput(child: V3Folder, kindFolders: 'grpc' | 'ws'): { description?: string; auth?: AuthConfig } {
    if (kindFolders === 'grpc') this.grpcFolders += 1;
    else this.wsFolders += 1;
    const description = str(child.definition?.['description']);
    const auth =
      child.definition !== undefined
        ? this.auth(child.definition['auth'], `${child.path}/.resources/definition.yaml`, false)
        : undefined;
    return {
      ...(description !== undefined ? { description } : {}),
      ...(auth !== undefined ? { auth } : {}),
    };
  }
}

/** Reports every definition's unread fields and every request of a kind Wirebench does not map. */
function reportLayout(folder: V3Folder, report: ReportBuilder): void {
  reportDefinitionFields(folder, report);
  for (const child of folder.children) {
    if (child.type === 'folder') {
      reportLayout(child, report);
      continue;
    }
    if (MAPPED_V3_KINDS.has(child.kind)) continue;
    const label = Object.hasOwn(UNMAPPED_V3_KINDS, child.kind) ? UNMAPPED_V3_KINDS[child.kind] : undefined;
    report.warn(
      label !== undefined
        ? `${child.path}: ${label} requests have no Wirebench equivalent, so it was not imported.`
        : `${child.path}: the request kind "${child.kind}" is unknown, so it was not imported.`,
    );
  }
}

/**
 * Maps a read folder collection. Throws `postman-v3-no-collection` when the folder held none, and
 * `postman-v3-nothing-to-import` when its collections hold no request Wirebench maps and there is
 * no environment or globals file.
 */
export function mapCollectionV3(workspace: V3Workspace, options: MapCollectionV3Options = {}): MappedCollectionV3 {
  if (workspace.collections.length === 0) {
    throw new PostmanError(
      'postman-v3-no-collection',
      'No collection was found in this folder. Pick a collection folder (one holding *.request.yaml files or .resources/definition.yaml), or a workspace folder holding collections/.',
    );
  }
  const newId = options.newId ?? generateId;
  const report = new ReportBuilder();
  for (const line of workspace.report.warnings) report.warn(line);
  for (const line of workspace.report.notes) report.note(line);
  const several = workspace.collections.length > 1;
  const properties = new VariableSetBuilder('Project properties', report);
  let order = options.firstOrder ?? 0;
  let requests = 0;
  let folders = 0;
  let examples = 0;
  const collections: MappedCollectionV3Entry[] = [];

  for (const collection of workspace.collections) {
    const name =
      !several && options.name !== undefined && options.name.trim() !== '' ? options.name.trim() : collection.name;
    reportLayout(collection, report);
    const protocols = new ProtocolMapper(newId, report);
    const collectionAuth = protocols.auth(
      collection.definition?.['auth'],
      `${collection.path === '' ? '' : `${collection.path}/`}.resources/definition.yaml`,
      false,
    );
    const grpcWalk = protocols.walk<GrpcFolder, GrpcRequestDef>(collection, 'grpc-request', {
      folder: (child, input) =>
        createGrpcFolder(child.name, { newId, ...input, ...protocols.folderInput(child, 'grpc') }),
      request: (request, slug, at) => protocols.grpcRequest(request, slug, at),
    });
    const wsWalk = protocols.walk<WsFolder, WsRequestDef>(collection, 'websocket-request', {
      folder: (child, input) => createWsFolder(child.name, { newId, ...input, ...protocols.folderInput(child, 'ws') }),
      request: (request, slug, at) => protocols.wsRequest(request, slug, at),
    });

    // HTTP: the v2.1 document, parsed and mapped as an exported one is. The gRPC and WebSocket
    // dynamic names join its own, so the report names them once.
    const parsed = parsePostmanCollection(v21DocumentOf(collection, name, report));
    const dynamic = [...new Set([...(parsed.dynamicVariables ?? []), ...protocols.dynamic])];
    const http = apiFromPostmanCollection(
      { ...parsed, ...(dynamic.length > 0 ? { dynamicVariables: dynamic } : {}) },
      { newId, name },
    );
    const prefix = several ? `${collection.name}: ` : '';
    for (const warning of http.summary.warnings ?? []) report.warn(`${prefix}${warning}`);
    if (protocols.credentials > 0) {
      // With REST requests, the REST mapper's line counts only theirs: this one counts the rest.
      const from = http.summary.requests === 0 ? 'the collection' : 'gRPC and WebSocket requests';
      report.warn(
        `${prefix}Credentials are not copied from ${from}; re-enter them for ${String(protocols.credentials)} auth ${protocols.credentials === 1 ? 'configuration' : 'configurations'}`,
      );
    }
    for (const variable of http.projectProperties.variables)
      properties.add(variable, several ? `collection "${collection.name}"` : undefined);

    const kinds = [http.summary.requests, grpcWalk.count, wsWalk.count].filter((n) => n > 0).length;
    const apiName = (suffix: string): string => (kinds > 1 ? `${name} (${suffix})` : name);
    const inherited = collectionAuth !== undefined ? { auth: collectionAuth } : {};
    const rest = http.summary.requests > 0 ? { ...http.api, order: order++ } : undefined;
    const grpc =
      grpcWalk.count > 0
        ? createGrpcApi(apiName('gRPC'), {
            newId,
            order: order++,
            target: protocols.grpcApiTarget?.target ?? '',
            tls: protocols.grpcApiTarget?.tls ?? false,
            ...inherited,
            folders: grpcWalk.folders,
            requests: grpcWalk.requests,
          })
        : undefined;
    const websocket =
      wsWalk.count > 0
        ? createWsApi(apiName('WebSocket'), {
            newId,
            order: order++,
            url: protocols.wsApiUrl ?? '',
            ...inherited,
            folders: wsWalk.folders,
            requests: wsWalk.requests,
          })
        : undefined;
    if (grpc !== undefined) {
      report.note(`${grpc.name}: needs a definition: import its .proto or use server reflection.`);
    }
    requests += http.summary.requests + grpcWalk.count + wsWalk.count;
    folders += http.summary.folders + protocols.grpcFolders + protocols.wsFolders;
    if (rest !== undefined) examples += folderRequests(rest).reduce((sum, r) => sum + (r.examples?.length ?? 0), 0);
    collections.push({
      name,
      ...(rest !== undefined ? { rest } : {}),
      ...(grpc !== undefined ? { grpc } : {}),
      ...(websocket !== undefined ? { websocket } : {}),
    });
  }

  const variableReport = new ReportBuilder();
  const environments: ImportedVariableSet[] = [];
  const globals: ImportedVariable[] = [];
  const globalNames = new Set<string>();
  for (const [files, scope] of [
    [workspace.environments, 'environment'],
    [workspace.globals, 'globals'],
  ] as const) {
    for (const file of files) {
      let plan: ImportedVariables;
      try {
        plan = postmanVariablesOf(file.doc, scope);
      } catch {
        variableReport.warn(`${file.path}: it is not an environment (no values list), so it was skipped.`);
        continue;
      }
      environments.push(...plan.environments);
      for (const variable of plan.globals?.variables ?? []) {
        if (globalNames.has(variable.name)) {
          variableReport.note(
            `Globals: "${variable.name}" is defined in more than one file; the first value was kept.`,
          );
          continue;
        }
        globalNames.add(variable.name);
        globals.push(variable);
      }
      for (const line of plan.report.warnings) variableReport.warn(line);
      for (const line of plan.report.notes) variableReport.note(line);
    }
  }
  const projectProperties = properties.build();
  if (requests === 0 && environments.length === 0 && globals.length === 0) {
    throw new PostmanError(
      'postman-v3-nothing-to-import',
      'The folder holds nothing Wirebench can bring across: no HTTP, gRPC or WebSocket request, and no environment.',
    );
  }
  return {
    collections,
    variables: {
      environments,
      ...(globals.length > 0 ? { globals: { name: 'Globals', variables: globals } } : {}),
      ...(projectProperties.variables.length > 0 ? { projectProperties } : {}),
      report: variableReport.build(),
    },
    counts: { collections: collections.length, requests, folders, examples },
    report: report.build(),
  };
}
