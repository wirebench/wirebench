/**
 * An Insomnia export mapped to Wirebench (spec §4): per workspace a REST API for its HTTP requests
 * (through the v2.1 document of `convert.ts` and the shared Postman mapper), a gRPC API and a
 * WebSocket API built directly, as the folder (v3) importer builds them. Base and folder
 * environments become project properties, sub-environments workspace environments; an environment
 * file's base merges into Globals. Scripts are kept as text. Pure.
 */

import { entry } from '../../http/entries.js';
import type { KeyValueEntry } from '../../http/entries.js';
import type { GrpcFolder, GrpcRequestDef } from '../../grpc/model.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../grpc/model.js';
import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { slugify, uniqueSlug } from '../../project/paths.js';
import { folderRequests } from '../../rest/model.js';
import { apiFromPostmanCollection, hasCredentials, mapPostmanAuth } from '../../rest/postman/map.js';
import { parsePostmanAuth, parsePostmanCollection } from '../../rest/postman/parse.js';
import { splitQueryKeepingReferences } from '../../rest/url.js';
import type { WsFolder, WsRequestDef } from '../../ws/model.js';
import { createWsApi, createWsFolder, createWsRequest, createWsSavedMessage } from '../../ws/model.js';
import type { MappedClientImport } from '../client-import.js';
import { flattenValue, ScriptCollector } from '../client-import.js';
import type { MappedCollectionV3Entry } from '../collection-v3/map.js';
import { GRPC_METHOD, grpcTarget } from '../collection-v3/map.js';
import { importedVariable } from '../opencollection/variables.js';
import { ReportBuilder, uniqueName } from '../report.js';
import type { ImportedScriptFile } from '../scripts.js';
import { rewriteMustache } from '../templates.js';
import { stripUserinfo } from '../values.js';
import type { ImportedVariable, ImportedVariableSet } from '../variables.js';
import { VariableSetBuilder, warnCredentialLookingNames } from '../variables.js';
import type { KeptTags, Trail } from './convert.js';
import { below, insomniaText, labelOf, v21AuthOfInsomnia, v21OfInsomnia } from './convert.js';
import type { InsDocument, InsEnv, InsNode, InsRow, InsWorkspace, Rec } from './model.js';

export interface MapInsomniaOptions {
  readonly newId?: IdGenerator;
  /** The `order` of the first API. 0 by default. */
  readonly firstOrder?: number;
  /** A name for the API(s) of a file holding one workspace; ignored when there are several. */
  readonly name?: string;
}

const VAULT_KEY = '__insomnia_vault';
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Header and metadata names whose literal value is a credential, never copied (lower case). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key']);
/** Auth scheme words a credential header may hold beside its references (lower case). */
const AUTH_SCHEMES = new Set(['bearer', 'basic', 'digest', 'token', 'negotiate', 'apikey']);

/** True when `value` holds no literal credential: only references, optionally after one scheme word. */
function credentialSafe(value: string): boolean {
  const rest = value.replace(/\$\{[^{}]*\}/g, '').trim();
  return rest === '' || AUTH_SCHEMES.has(rest.toLowerCase());
}

/**
 * `data` with its keys in `dataPropertyOrder` order (`"&"` for the root, `"&~|key"` below it); keys
 * the order does not name follow in their own order. Null-prototype objects keep a `__proto__` key.
 */
function ordered(value: unknown, order: Rec | undefined, path: string): unknown {
  if (Array.isArray(value)) return value.map((item, i) => ordered(item, order, `${path}~|${String(i)}`));
  if (!isRec(value)) return value;
  const listed = order?.[path];
  const first = Array.isArray(listed)
    ? listed.filter((k): k is string => typeof k === 'string' && Object.hasOwn(value, k))
    : [];
  const keys = [...new Set([...first, ...Object.keys(value)])];
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys) out[key] = ordered(value[key], order, `${path}~|${key}`);
  return out;
}

/** The running state of one export's mapping. */
class Mapper {
  readonly report = new ReportBuilder();
  readonly variableReport = new ReportBuilder();
  readonly kept: KeptTags = new Map();
  /** Dynamic names met by the gRPC and WebSocket rewrite; joined with the REST mapper's. */
  readonly dynamic = new Set<string>();
  /** Dynamic names met in variable values. */
  readonly variableDynamic = new Set<string>();
  readonly vault: string[] = [];
  credentials = 0;

  constructor(readonly newId: IdGenerator) {}

  text(value: string, label: string): string {
    return rewriteMustache(insomniaText(value, label, this.kept), this.dynamic);
  }

  auth(raw: Rec | undefined, label: string, isRequest: boolean): AuthConfig | undefined {
    const parsed = parsePostmanAuth(v21AuthOfInsomnia(raw, label, this.report, this.kept), this.dynamic);
    if (hasCredentials(parsed)) this.credentials += 1;
    const warnings: string[] = [];
    const mapped = mapPostmanAuth(parsed, isRequest, warnings);
    for (const warning of warnings) this.report.warn(`${label}: ${warning}`);
    return mapped;
  }

  /**
   * Rows as entries. With `dropCredentials` (headers, gRPC metadata), a credential-named row whose
   * value holds a literal credential (more than references after one scheme word) is left out and
   * counted for the credential warning.
   */
  rows(list: readonly InsRow[], label: string, dropCredentials = false): KeyValueEntry[] {
    const out: KeyValueEntry[] = [];
    for (const row of list) {
      if (row.name === '') continue;
      const name = this.text(row.name, label);
      const value = this.text(row.value, label);
      if (dropCredentials && CREDENTIAL_HEADERS.has(name.toLowerCase()) && !credentialSafe(value)) {
        this.credentials += 1;
        this.report.note(`${label}: the value of "${name}" is a credential and was not imported.`);
        continue;
      }
      out.push(
        entry(name, value, {
          enabled: !row.disabled,
          ...(row.description !== undefined ? { description: row.description } : {}),
        }),
      );
    }
    return out;
  }

  url(raw: string, label: string): string {
    const { url, stripped } = stripUserinfo(this.text(raw, label));
    if (stripped) this.report.warn(`${label}: the credential in its URL was not imported; set it on the request.`);
    return url;
  }

  /** One environment's values as variables: flattened, ordered, vault names as secrets with no value. */
  addEnvironment(
    env: Pick<InsEnv, 'name' | 'data' | 'order'>,
    label: string,
    add: (v: ImportedVariable) => void,
  ): void {
    const data = ordered(env.data, env.order, '&') as Record<string, unknown>;
    const keep = (v: ImportedVariable | undefined): void => {
      if (v !== undefined) add(v);
    };
    for (const [key, value] of Object.entries(data)) {
      if (key === VAULT_KEY) {
        if (!isRec(value)) continue;
        for (const name of Object.keys(value)) {
          this.vault.push(`${name} (${env.name})`);
          const named = importedVariable(
            { name, value: '', secret: true },
            label,
            this.variableReport,
            this.variableDynamic,
          );
          keep(named === undefined ? undefined : { ...named, awaitsValue: true });
        }
        continue;
      }
      for (const [name, text] of flattenValue(key, value)) {
        keep(
          importedVariable(
            { name, value: insomniaText(text, env.name, this.kept) },
            label,
            this.variableReport,
            this.variableDynamic,
          ),
        );
      }
    }
  }
}

interface Walked<F, R> {
  folders: F[];
  requests: R[];
  count: number;
  folderCount: number;
}

/** The folders and requests of `kind` under `nodes`; a folder with none below it is left out. */
function walk<F, R>(
  nodes: readonly InsNode[],
  kind: 'grpc' | 'websocket',
  trail: Trail,
  make: {
    readonly folder: (
      node: Extract<InsNode, { kind: 'folder' }>,
      label: string,
      input: { slug: string; order: number; folders: F[]; requests: R[] },
    ) => F;
    readonly request: (node: InsNode, label: string, slug: string, order: number) => R | undefined;
  },
): Walked<F, R> {
  const out: Walked<F, R> = { folders: [], requests: [], count: 0, folderCount: 0 };
  const folderSlugs = new Set<string>();
  const requestSlugs = new Set<string>();
  for (const node of nodes) {
    if (node.kind === kind) {
      const slug = uniqueSlug(node.name, requestSlugs);
      const made = make.request(node, labelOf(trail, node.name), slug, out.requests.length);
      if (made === undefined) continue;
      requestSlugs.add(slug);
      out.requests.push(made);
      out.count += 1;
      continue;
    }
    if (node.kind !== 'folder') continue;
    const inner = walk(node.children, kind, below(trail, node.name), make);
    if (inner.count === 0) continue;
    const slug = uniqueSlug(node.name, folderSlugs);
    folderSlugs.add(slug);
    out.folders.push(
      make.folder(node, labelOf(trail, node.name), {
        slug,
        order: out.folders.length,
        folders: inner.folders,
        requests: inner.requests,
      }),
    );
    out.count += inner.count;
    out.folderCount += inner.folderCount + 1;
  }
  return out;
}

function folderInput(
  mapper: Mapper,
  node: Extract<InsNode, { kind: 'folder' }>,
  label: string,
): { description?: string; auth?: AuthConfig } {
  const auth = mapper.auth(node.auth, label, false);
  return {
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(auth !== undefined ? { auth } : {}),
  };
}

function grpcRequest(
  mapper: Mapper,
  ws: InsWorkspace,
  node: Extract<InsNode, { kind: 'grpc' }>,
  label: string,
  slug: string,
  order: number,
  state: { target?: { target: string; tls: boolean }; protos: Set<string> },
): GrpcRequestDef | undefined {
  const method = GRPC_METHOD.exec(node.protoMethodName.trim());
  if (method === null) {
    mapper.report.warn(
      `${label}: its method "${node.protoMethodName}" is not /package.Service/Method, so it was not imported.`,
    );
    return undefined;
  }
  const target = grpcTarget(mapper.url(node.url, label));
  if (target !== undefined) {
    if (state.target === undefined) state.target = target;
    else if (target.target !== state.target.target || target.tls !== state.target.tls) {
      mapper.report.note(
        `${label}: its target ${target.target} differs from the API's ${state.target.target}; the API's is used.`,
      );
    }
  }
  if (node.reflection) {
    mapper.report.note(
      `${label}: it read its definition by server reflection; turn reflection on for the API or import its .proto.`,
    );
  }
  const proto = node.protoFileId === undefined ? undefined : ws.protos.find((p) => p.id === node.protoFileId);
  if (proto !== undefined) {
    // The file and its directory's other files, which its `import` lines may name.
    for (const p of ws.protos) {
      if (p.id === proto.id || (proto.dirId !== undefined && p.dirId === proto.dirId)) state.protos.add(p.id);
    }
  }
  return createGrpcRequest(node.name, {
    newId: mapper.newId,
    slug,
    order,
    service: method[1]!,
    method: method[2]!,
    methodKind: 'unary',
    metadata: mapper.rows(node.metadata, label, true),
    message: mapper.text(node.message, label),
    auth: { type: 'inherit' },
  });
}

function wsRequest(
  mapper: Mapper,
  node: Extract<InsNode, { kind: 'websocket' }>,
  label: string,
  slug: string,
  order: number,
  state: { url?: string },
): WsRequestDef {
  const split = splitQueryKeepingReferences(mapper.url(node.url, label));
  if (state.url === undefined) state.url = split.path;
  const messages =
    node.payload === undefined
      ? []
      : [
          createWsSavedMessage('Message 1', {
            newId: mapper.newId,
            content: mapper.text(node.payload, label),
            format: 'text',
          }),
        ];
  return createWsRequest(node.name, {
    newId: mapper.newId,
    slug,
    order,
    url: split.path,
    query: [...split.query, ...mapper.rows(node.parameters, label)],
    headers: mapper.rows(node.headers, label, true),
    auth: mapper.auth(node.auth, label, true) ?? { type: 'inherit' },
    messages,
  });
}

/** Saves every request and folder script as text, depth first. */
function collectScripts(nodes: readonly InsNode[], trail: Trail, collector: ScriptCollector): void {
  for (const node of nodes) {
    if (node.kind !== 'http' && node.kind !== 'folder') continue;
    const label = labelOf(trail, node.name);
    collector.add(node.name, 'pre', node.scripts.pre, label);
    collector.add(node.name, 'post', node.scripts.post, label);
    if (node.kind === 'folder') collectScripts(node.children, below(trail, node.name), collector);
  }
}

/** Each folder's environment, outermost first, depth first. */
function* folderEnvironments(nodes: readonly InsNode[]): Generator<{ name: string; data: Rec }> {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    if (node.environment !== undefined) yield { name: node.name, data: node.environment };
    yield* folderEnvironments(node.children);
  }
}

function requestNames(nodes: readonly InsNode[], into = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    if (node.kind === 'folder') requestNames(node.children, into);
    else if (node.kind !== 'skipped' && node.id !== '') into.set(node.id, node.name);
  }
  return into;
}

function reportExtras(ws: InsWorkspace, report: ReportBuilder): void {
  if (ws.extras.includes('cookie jar')) {
    report.note(`${ws.name}: its cookie jar was not imported; the jar fills on the first send.`);
  }
  const names = requestNames(ws.items);
  for (const suite of ws.unitTests) {
    const checked = [
      ...new Set(
        suite.tests.flatMap((t) => (t.requestId !== undefined ? [names.get(t.requestId) ?? t.requestId] : [])),
      ),
    ];
    report.warn(
      checked.length > 0
        ? `${ws.name}: the unit test suite "${suite.suite}" was not imported; its tests check: ${checked.join(', ')}.`
        : `${ws.name}: the unit test suite "${suite.suite}" was not imported.`,
    );
  }
}

/** Maps a read Insomnia export. */
export function mapInsomnia(doc: InsDocument, options: MapInsomniaOptions = {}): MappedClientImport {
  const newId = options.newId ?? generateId;
  const mapper = new Mapper(newId);
  const { report, variableReport } = mapper;
  for (const line of doc.report.warnings) report.warn(line);
  for (const line of doc.report.notes) report.note(line);
  const several = doc.workspaces.length > 1;
  const isEnvironmentFile = doc.kind === 'environment';
  const sharedName = isEnvironmentFile ? 'Globals' : 'Project properties';
  const properties = new VariableSetBuilder(sharedName, variableReport);
  const environments: ImportedVariableSet[] = [];
  const environmentNames: string[] = [];
  const collections: MappedCollectionV3Entry[] = [];
  const scripts: ImportedScriptFile[] = [];
  const protoIds = new Set<string>();
  const protos: { name: string; text: string; path: string; collection: number }[] = [];
  let order = options.firstOrder ?? 0;
  let requests = 0;
  let folders = 0;

  for (const ws of doc.workspaces) {
    const name = !several && options.name !== undefined && options.name.trim() !== '' ? options.name.trim() : ws.name;
    const prefix = several ? `${ws.name}: ` : '';
    const where = several ? `workspace "${ws.name}"` : undefined;
    const root: Trail = { prefix, path: [] };

    // Variables: the base environment first, then each folder's, outermost first.
    if (ws.baseEnv !== undefined) mapper.addEnvironment(ws.baseEnv, sharedName, (v) => properties.add(v, where));
    if (!isEnvironmentFile) {
      for (const folder of folderEnvironments(ws.items)) {
        mapper.addEnvironment(folder, sharedName, (v) => properties.add(v, `folder "${folder.name}"`));
      }
    }
    for (const env of ws.subEnvs) {
      const envName = uniqueName(env.name, environmentNames);
      environmentNames.push(envName);
      if (envName !== env.name) {
        variableReport.note(
          `An environment named "${env.name}" appears more than once, so this one was imported as "${envName}".`,
        );
      }
      const builder = new VariableSetBuilder(envName, variableReport);
      mapper.addEnvironment(env, envName, (v) => builder.add(v));
      let color: string | undefined;
      if (env.color !== undefined) {
        if (HEX_COLOUR.test(env.color)) color = env.color;
        else variableReport.note(`${envName}: its colour "${env.color}" is not a #rrggbb value and was not kept.`);
      }
      environments.push({
        name: envName,
        ...(color !== undefined ? { color } : {}),
        variables: builder.build().variables,
      });
    }
    if (isEnvironmentFile) continue;

    reportExtras(ws, report);
    const collector = new ScriptCollector(slugify(name).toLowerCase(), report);
    collectScripts(ws.items, root, collector);
    collector.reportDialects();
    scripts.push(...collector.files());

    const credentialsBefore = mapper.credentials;
    const grpcState: { target?: { target: string; tls: boolean }; protos: Set<string> } = { protos: new Set() };
    const grpcWalk = walk<GrpcFolder, GrpcRequestDef>(ws.items, 'grpc', root, {
      folder: (node, label, input) =>
        // Insomnia gRPC requests take no auth, a folder's included: their metadata carries it.
        createGrpcFolder(node.name, {
          newId,
          ...input,
          ...(node.description !== undefined ? { description: node.description } : {}),
        }),
      request: (node, label, slug, at) =>
        node.kind === 'grpc' ? grpcRequest(mapper, ws, node, label, slug, at, grpcState) : undefined,
    });
    const wsState: { url?: string } = {};
    const wsWalk = walk<WsFolder, WsRequestDef>(ws.items, 'websocket', root, {
      folder: (node, label, input) =>
        createWsFolder(node.name, { newId, ...input, ...folderInput(mapper, node, label) }),
      request: (node, label, slug, at) =>
        node.kind === 'websocket' ? wsRequest(mapper, node, label, slug, at, wsState) : undefined,
    });

    const parsed = parsePostmanCollection(v21OfInsomnia(ws, name, report, mapper.kept, prefix));
    const dynamic = [...new Set([...(parsed.dynamicVariables ?? []), ...mapper.dynamic])];
    const http = apiFromPostmanCollection(
      { ...parsed, ...(dynamic.length > 0 ? { dynamicVariables: dynamic } : {}) },
      { newId, name },
    );
    mapper.dynamic.clear();
    for (const warning of http.summary.warnings ?? []) report.warn(`${prefix}${warning}`);
    const protocolCredentials = mapper.credentials - credentialsBefore;
    if (protocolCredentials > 0) {
      // With REST requests, the REST mapper's line counts only theirs: this one counts the rest.
      const from = http.summary.requests === 0 ? 'the collection' : 'gRPC and WebSocket requests';
      report.warn(
        `${prefix}Credentials are not copied from ${from}; re-enter them for ${String(protocolCredentials)} auth ${protocolCredentials === 1 ? 'configuration' : 'configurations'}`,
      );
    }

    const kinds = [http.summary.requests, grpcWalk.count, wsWalk.count].filter((n) => n > 0).length;
    const apiName = (suffix: string): string => (kinds > 1 ? `${name} (${suffix})` : name);
    const rest = http.summary.requests > 0 ? { ...http.api, order: order++ } : undefined;
    const grpc =
      grpcWalk.count > 0
        ? createGrpcApi(apiName('gRPC'), {
            newId,
            order: order++,
            target: grpcState.target?.target ?? '',
            tls: grpcState.target?.tls ?? false,
            folders: grpcWalk.folders,
            requests: grpcWalk.requests,
          })
        : undefined;
    const websocket =
      wsWalk.count > 0
        ? createWsApi(apiName('WebSocket'), {
            newId,
            order: order++,
            url: wsState.url ?? '',
            folders: wsWalk.folders,
            requests: wsWalk.requests,
          })
        : undefined;
    if (grpc !== undefined) {
      if (doc.version === 5) {
        report.note(
          `${grpc.name}: Insomnia v5 exports hold no .proto files, so the API has no definition: import its .proto or use server reflection.`,
        );
      } else if (grpcState.protos.size === 0) {
        report.note(`${grpc.name}: needs a definition: import its .proto or use server reflection.`);
      }
    }
    if (websocket !== undefined && doc.version === 5) {
      report.note(`${websocket.name}: Insomnia v5 exports hold no WebSocket messages, so none were imported.`);
    }
    for (const p of ws.protos) {
      if (grpcState.protos.has(p.id) && !protoIds.has(p.id)) {
        protoIds.add(p.id);
        protos.push({ name: p.name, text: p.text, path: p.path, collection: collections.length });
      }
    }
    requests += http.summary.requests + grpcWalk.count + wsWalk.count;
    folders += http.summary.folders + grpcWalk.folderCount + wsWalk.folderCount;
    collections.push({
      name,
      ...(rest !== undefined ? { rest } : {}),
      ...(grpc !== undefined ? { grpc } : {}),
      ...(websocket !== undefined ? { websocket } : {}),
    });
  }

  for (const [tag, users] of mapper.kept) {
    report.warn(
      `Kept as written, with no Wirebench equivalent: the template tag "${tag}" in ${[...users].join(', ')}.`,
    );
  }
  if (mapper.vault.length > 0) {
    variableReport.warn(`Vault secrets are not in the export; set a value for: ${mapper.vault.join(', ')}`);
  }
  if (mapper.variableDynamic.size > 0) {
    variableReport.warn(
      `Dynamic variables are kept as written and not expanded: ${[...mapper.variableDynamic].sort().join(', ')}`,
    );
  }
  const shared = properties.build();
  warnCredentialLookingNames(variableReport, [shared, ...environments]);
  const examples = collections.reduce(
    (sum, c) =>
      sum + (c.rest === undefined ? 0 : folderRequests(c.rest).reduce((n, r) => n + (r.examples?.length ?? 0), 0)),
    0,
  );
  return {
    collections,
    variables: {
      environments,
      ...(shared.variables.length > 0 ? (isEnvironmentFile ? { globals: shared } : { projectProperties: shared }) : {}),
      report: variableReport.build(),
    },
    scripts,
    protos,
    counts: {
      collections: collections.length,
      requests,
      folders,
      examples,
      assertions: 0,
      scripts: scripts.length,
    },
    report: report.build(),
  };
}
