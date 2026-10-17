/**
 * A read Insomnia export mapped to Wirebench APIs (spec 2026-10-15 §4): per workspace a REST API
 * for its HTTP requests (through the v2.1 parser and mapper, see `convert.ts`), a gRPC API and a
 * WebSocket API for theirs; the base and folder environments as project properties, the
 * sub-environments as workspace environments, every script attached to its request or folder
 * switched off. Pure.
 */

import { InsomniaError } from '../../errors.js';
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from '../../grpc/model.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../grpc/model.js';
import { entry } from '../../http/entries.js';
import type { KeyValueEntry } from '../../http/entries.js';
import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { slugify, SlugSet, uniqueSlug } from '../../project/paths.js';
import { folderRequests } from '../../rest/model.js';
import { apiFromPostmanCollection, hasCredentials, mapPostmanAuth } from '../../rest/postman/map.js';
import { parsePostmanAuth, parsePostmanCollection } from '../../rest/postman/parse.js';
import { splitQueryKeepingReferences } from '../../rest/url.js';
import type { WsApi, WsFolder, WsRequestDef } from '../../ws/model.js';
import { createWsApi, createWsFolder, createWsRequest, createWsSavedMessage } from '../../ws/model.js';
import type { MappedClientEntry, MappedClientImport, MappedProtoSet } from '../client-import.js';
import { flattenValue } from '../client-import.js';
import type { DroppedLevel, ImportedScriptFile } from '../scripts.js';
import { droppedApiScriptFiles } from '../scripts.js';
import { GRPC_METHOD, grpcTarget } from '../collection-v3/map.js';
import { blankIfLiteral, blankUrlCredentials } from '../credential-values.js';
import { isCredentialName } from '../credentials.js';
import { ReportBuilder } from '../report.js';
import { stripUserinfo } from '../values.js';
import { insomniaTemplates, unshieldTemplates } from '../template-dialects.js';
import { rewriteMustache } from '../templates.js';
import type { ImportedVariable, ImportedVariableSet } from '../variables.js';
import { credentialSafeVariable, VariableSetBuilder, warnCredentialLookingNames } from '../variables.js';
import type { InheritedHeaders, InsomniaConvertContext } from './convert.js';
import { handDown, inlineQuery, ItemTemplates, v21AuthOf, v21OfInsomnia, withInherited } from './convert.js';
import type {
  InsDocument,
  InsEnv,
  InsFolder,
  InsGrpc,
  InsNode,
  InsRec,
  InsRow,
  InsWebSocket,
  InsWorkspace,
} from './model.js';

export interface MapInsomniaOptions {
  readonly newId?: IdGenerator;
  /** The `order` of the first API. 0 by default. */
  readonly firstOrder?: number;
  /** A name for the API(s) of an export holding one workspace; ignored when there are several. */
  readonly name?: string;
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
/** The vault line of the variable report, which a caller with no secret store may leave out. */
export const VAULT_SECRETS_LINE = 'Vault secrets are not in the export; set a value for:';
/** Auth scheme words a credential header may hold beside its references (lower case). */
const AUTH_SCHEMES = new Set(['bearer', 'basic', 'digest', 'token', 'negotiate', 'apikey']);

/** True when `value` holds no literal credential: only references, optionally beside one scheme word. */
function credentialSafe(value: string): boolean {
  const rest = value.replace(/\$\{[^{}]*\}/g, '').trim();
  return rest === '' || AUTH_SCHEMES.has(rest.toLowerCase());
}
/** Deeper nesting is kept as JSON text under its name rather than flattened further. */
const MAX_FLATTEN_DEPTH = 32;

function isRecord(value: unknown): value is InsRec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `obj`'s entries, the keys a `dataPropertyOrder` list names first, in its order. */
function entriesInOrder(obj: InsRec, keys: unknown): [string, unknown][] {
  const listed = Array.isArray(keys)
    ? keys.filter((key): key is string => typeof key === 'string' && Object.hasOwn(obj, key))
    : [];
  const rest = Object.keys(obj).filter((key) => !listed.includes(key));
  return [...new Set([...listed, ...rest])].map((key) => [key, obj[key]]);
}

/**
 * An environment's data as dotted names and text, in `dataPropertyOrder` when it has one: its root
 * keys under `&`, a nested object's under `&~|<path>` with `~|` between the path's keys.
 */
export function flattenEnvironment(data: InsRec, order?: InsRec): [string, string][] {
  const out: [string, string][] = [];
  const walk = (name: string, value: unknown, path: readonly string[]): void => {
    if (isRecord(value) && Object.keys(value).length > 0 && path.length <= MAX_FLATTEN_DEPTH) {
      for (const [key, inner] of entriesInOrder(value, order?.[`&~|${path.join('~|')}`])) {
        walk(`${name}.${key}`, inner, [...path, key]);
      }
      return;
    }
    out.push(...flattenValue(name, value));
  };
  try {
    for (const [key, value] of entriesInOrder(data, order?.['&'])) walk(key, value, [key]);
  } catch (cause) {
    // A YAML anchor that holds itself makes a circular value, which no text form can hold.
    if (cause instanceof TypeError) {
      throw new InsomniaError('insomnia-malformed', 'An Insomnia environment refers to itself (a YAML alias loop).', {
        cause,
      });
    }
    throw cause;
  }
  return out;
}

/** The running state of one workspace's variable, gRPC and WebSocket mapping. */
class WorkspaceMapper {
  readonly dynamic = new Set<string>();
  readonly kept = new Map<string, string[]>();
  readonly vault: ReadonlySet<string>;
  /** The vault secrets made so far, as `name (environment)`, listed once in the variable report. */
  readonly vaultNames: string[] = [];
  grpcRequests = 0;
  grpcFolders = 0;
  wsRequests = 0;
  wsFolders = 0;
  credentials = 0;
  grpcApiTarget: { target: string; tls: boolean } | undefined;
  wsApiUrl: string | undefined;
  readonly protoIds = new Set<string>();
  /** Request paths by id, for naming unit tests. */
  readonly requestNames = new Map<string, string>();

  constructor(
    readonly workspace: InsWorkspace,
    private readonly newId: IdGenerator,
    readonly report: ReportBuilder,
    readonly prefix: string,
  ) {
    this.vault = new Set([...(workspace.baseEnv?.vault ?? []), ...workspace.subEnvs.flatMap((env) => env.vault)]);
  }

  readonly dialect = (text: string, seen: Set<string>): string => insomniaTemplates(text, seen, this.vault);

  convertContext(): InsomniaConvertContext {
    return { report: this.report, dialect: this.dialect, kept: this.kept, labelPrefix: this.prefix };
  }

  label(trail: readonly string[]): string {
    return `${this.prefix}${trail.join(' / ')}`;
  }

  /** One value through the dialect and the shared rewrite; what it keeps is recorded under `label`. */
  value(raw: string, label: string): string {
    const templates = new ItemTemplates(this, label);
    const out = rewriteMustache(templates.t(raw), this.dynamic);
    templates.done();
    return out;
  }

  auth(raw: InsRec | undefined, label: string, isRequest: boolean): AuthConfig | undefined {
    const templates = new ItemTemplates(this, label);
    const parsed = parsePostmanAuth(v21AuthOf(raw, templates.t, label, this.report), this.dynamic);
    templates.done();
    if (hasCredentials(parsed)) this.credentials += 1;
    const warnings: string[] = [];
    const mapped = mapPostmanAuth(parsed, isRequest, warnings);
    for (const warning of warnings) this.report.warn(`${label}: ${warning}`);
    return mapped;
  }

  /**
   * Rows as entries. With `dropCredentials` (headers, gRPC metadata), a credential-named row whose
   * value holds a literal credential (more than references, or one scheme word and references) is
   * left out and counted for the credential warning (ruling R8).
   */
  private rows(rows: readonly InsRow[], label: string, dropCredentials = false): KeyValueEntry[] {
    return rows.flatMap((row) => {
      const name = this.value(row.name, label);
      const value = this.value(row.value, label);
      if (dropCredentials && isCredentialName(name.trim()) && !credentialSafe(value)) {
        this.credentials += 1;
        this.report.note(`${label}: the value of "${name}" is a credential and was not imported.`);
        return [];
      }
      return [
        entry(name, value, {
          enabled: !row.disabled,
          ...(row.description !== undefined ? { description: row.description } : {}),
        }),
      ];
    });
  }

  /** `url` without literal user info, with or without a scheme; a cut is noted and counted. */
  private withoutUserinfo(url: string, label: string): string {
    const schemed = stripUserinfo(url);
    const cut = schemed.stripped || url.includes('://') ? schemed : stripUserinfo(url, true);
    if (cut.stripped) this.credentialNote(label, 'the credential in the URL was not imported.');
    return cut.url;
  }

  private credentialNote(label: string, what: string): void {
    this.credentials += 1;
    this.report.note(`${label}: ${what}`);
  }

  /** Query rows with each literal credential value blanked (the rule every importer applies), noted and counted. */
  private blankQuery(rows: readonly KeyValueEntry[], label: string): KeyValueEntry[] {
    return rows.map((row) => {
      const blanked = new Set<string>();
      const value = blankIfLiteral(row.name, row.value, blanked);
      if (blanked.size === 0) return row;
      this.credentialNote(label, `the value of "${row.name}" is a credential and was not imported.`);
      return { ...row, value };
    });
  }

  grpcRequest(node: InsGrpc, trail: readonly string[], slug: string, order: number): GrpcRequestDef | undefined {
    const label = this.label([...trail, node.name]);
    const method = GRPC_METHOD.exec(node.protoMethodName.trim());
    if (method === null) {
      this.report.warn(`${label}: it names no /service/method, so it was not imported.`);
      return undefined;
    }
    if (node.reflection) {
      this.report.note(
        `${label}: it used server reflection; turn reflection on in the gRPC API if the server offers it.`,
      );
    }
    if (node.protoFileId !== undefined) this.protoIds.add(node.protoFileId);
    const target = grpcTarget(this.withoutUserinfo(this.value(node.url, label), label));
    if (target !== undefined) {
      if (this.grpcApiTarget === undefined) this.grpcApiTarget = target;
      else if (target.target !== this.grpcApiTarget.target || target.tls !== this.grpcApiTarget.tls) {
        this.report.note(
          `${label}: its target ${target.target} differs from the API's ${this.grpcApiTarget.target}; the API's is used.`,
        );
      }
    }
    this.grpcRequests += 1;
    return createGrpcRequest(node.name, {
      newId: this.newId,
      slug,
      order,
      ...(node.description !== undefined ? { description: node.description } : {}),
      service: method[1]!,
      method: method[2]!,
      methodKind: 'unary',
      metadata: this.rows(node.metadata, label, true),
      ...(node.message !== '' ? { message: this.value(node.message, label) } : {}),
      auth: { type: 'inherit' },
    });
  }

  wsRequest(
    node: InsWebSocket,
    trail: readonly string[],
    inherited: InheritedHeaders,
    slug: string,
    order: number,
  ): WsRequestDef {
    const label = this.label([...trail, node.name]);
    const { base, rows: inline } = inlineQuery(node.url);
    // The base has no query left (inlineQuery took it), so this cuts only the user info.
    const { url: safeBase, stripped } = blankUrlCredentials(this.value(base, label), new Set());
    if (stripped) this.credentialNote(label, 'the credential in the URL was not imported.');
    const split = splitQueryKeepingReferences(safeBase);
    if (this.wsApiUrl === undefined) this.wsApiUrl = split.path;
    const messages =
      node.payload !== undefined && node.payload.text !== ''
        ? [
            createWsSavedMessage('Payload', {
              newId: this.newId,
              content: this.value(node.payload.text, label),
              format: 'text',
            }),
          ]
        : [];
    this.wsRequests += 1;
    return createWsRequest(node.name, {
      newId: this.newId,
      slug,
      order,
      ...(node.description !== undefined ? { description: node.description } : {}),
      url: split.path,
      query: this.blankQuery([...split.query, ...this.rows([...inline, ...node.parameters], label)], label),
      headers: this.rows(withInherited(node.headers, inherited), label, true),
      auth: this.auth(node.auth, label, true) ?? { type: 'inherit' },
      settings: {},
      messages,
    });
  }

  folderInput(folder: InsFolder, trail: readonly string[]): { description?: string; auth?: AuthConfig } {
    const auth = this.auth(folder.auth, this.label(trail), false);
    return {
      ...(folder.description !== undefined ? { description: folder.description } : {}),
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  /** The folders and requests of one kind under `nodes`; a folder with none below it is left out. */
  walk<F, R>(
    nodes: readonly InsNode[],
    trail: readonly string[],
    inherited: InheritedHeaders,
    make: {
      readonly folder: (
        folder: InsFolder,
        trail: readonly string[],
        input: { slug: string; order: number; folders: F[]; requests: R[] },
      ) => F;
      readonly request: (
        node: InsNode,
        trail: readonly string[],
        inherited: InheritedHeaders,
        slug: string,
        order: number,
      ) => R | undefined;
    },
  ): { folders: F[]; requests: R[]; count: number } {
    const folders: F[] = [];
    const requests: R[] = [];
    const folderSlugs = new SlugSet();
    const requestSlugs = new SlugSet();
    let count = 0;
    for (const node of nodes) {
      if (node.kind !== 'folder') {
        const slug = uniqueSlug(node.name, requestSlugs);
        const made = make.request(node, trail, inherited, slug, requests.length);
        if (made === undefined) continue;
        requestSlugs.add(slug);
        requests.push(made);
        count += 1;
        continue;
      }
      const path = [...trail, node.name];
      const inner = this.walk(node.children, path, handDown(inherited, node), make);
      if (inner.count === 0) continue;
      const slug = uniqueSlug(node.name, folderSlugs);
      folderSlugs.add(slug);
      folders.push(
        make.folder(node, path, { slug, order: folders.length, folders: inner.folders, requests: inner.requests }),
      );
      count += inner.count;
    }
    return { folders, requests, count };
  }

  /** Each variable of `env` as an imported one; its vault names become secrets with no value. */
  variables(env: InsEnv, owner: string, report: ReportBuilder): ImportedVariable[] {
    const out: ImportedVariable[] = [];
    for (const [name, raw] of flattenEnvironment(env.data, env.order)) {
      const { variable, madeSecret, userinfoCut } = credentialSafeVariable(
        name,
        this.value(raw, `${owner}: "${name}"`),
      );
      if (madeSecret) {
        report.note(
          `${owner}: "${name}" looks like a credential, so its value was imported as a secret rather than plain text.`,
        );
      }
      if (userinfoCut) report.warn(`${owner}: the credential in the URL of "${name}" was not imported.`);
      out.push(variable);
    }
    for (const name of env.vault) {
      out.push({ name, value: '', enabled: true, secret: true, awaitsValue: true });
      this.vaultNames.push(`${name} (${env.name})`);
    }
    return out;
  }

  /**
   * The proto texts by path, rooted at the files the gRPC requests point at. Two files at one path
   * (`svc` and `svc.proto`, or one name twice in a directory) keep the first, with a warning on `api`.
   */
  protos(api: string): MappedProtoSet | undefined {
    const { protos, protoDirs } = this.workspace;
    if (protos.length === 0 || this.protoIds.size === 0) return undefined;
    const dirs = new Map(protoDirs.map((dir) => [dir.id, dir]));
    const pathOf = (dirId: string | undefined, name: string): string => {
      const parts = [name.endsWith('.proto') ? name : `${name}.proto`];
      const seen = new Set<string>();
      for (let id = dirId; id !== undefined && !seen.has(id); id = dirs.get(id)?.parentId) {
        seen.add(id);
        const dir = dirs.get(id);
        if (dir === undefined) break;
        parts.unshift(dir.name);
      }
      return parts.join('/');
    };
    const sources = new Map<string, string>();
    const usedAt = new Set<string>();
    const warned = new Map<string, string>();
    const roots: string[] = [];
    for (const proto of protos) {
      const path = pathOf(proto.dirId, proto.name);
      const used = this.protoIds.has(proto.id);
      if (!sources.has(path)) {
        sources.set(path, proto.text);
        if (used) usedAt.add(path);
      } else {
        // The file a request points at wins the path over one only beside it; else the first stays.
        const replace = used && !usedAt.has(path);
        if (replace) {
          sources.set(path, proto.text);
          usedAt.add(path);
        }
        warned.set(path, replace || usedAt.has(path) ? 'the one a request uses' : 'the first');
      }
      if (this.protoIds.has(proto.id) && !roots.includes(path)) roots.push(path);
    }
    for (const [path, kept] of warned) {
      this.report.warn(`${api}: two .proto files share the path ${path}; ${kept} was kept.`);
    }
    return roots.length > 0 ? { sources, roots } : undefined;
  }
}

/** Reports skipped items and records each request's path by id. */
function surveyNodes(nodes: readonly InsNode[], trail: readonly string[], mapper: WorkspaceMapper): void {
  for (const node of nodes) {
    const path = [...trail, node.name];
    if (node.kind === 'folder') {
      surveyNodes(node.children, path, mapper);
      continue;
    }
    if (node.kind === 'skipped') {
      mapper.report.warn(`${mapper.label(path)}: ${node.what}s have no Wirebench equivalent, so it was not imported.`);
      continue;
    }
    mapper.requestNames.set(node.id, path.join(' / '));
  }
}

/** Folder environments as project properties, outermost first. */
function addFolderEnvironments(
  nodes: readonly InsNode[],
  trail: readonly string[],
  mapper: WorkspaceMapper,
  properties: VariableSetBuilder,
  report: ReportBuilder,
): void {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    const path = [...trail, node.name];
    if (node.environment !== undefined) {
      const env: InsEnv = {
        name: node.name,
        data: node.environment,
        ...(node.environmentOrder !== undefined ? { order: node.environmentOrder } : {}),
        private: false,
        vault: [],
      };
      const label = mapper.label(path);
      for (const variable of mapper.variables(env, `Folder "${label}"`, report)) {
        properties.add(variable, `folder "${label}"`);
      }
    }
    addFolderEnvironments(node.children, path, mapper, properties, report);
  }
}

/** The workspace-level lines: what the export holds that Wirebench does not import. */
function reportWorkspace(mapper: WorkspaceMapper, format: 4 | 5): void {
  const { workspace, report, prefix } = mapper;
  if (workspace.cookies > 0) {
    report.note(
      `${prefix}The cookie jar's ${String(workspace.cookies)} ${workspace.cookies === 1 ? 'cookie was' : 'cookies were'} not imported: cookies are session state, and the jar fills on the first send.`,
    );
  }
  for (const suite of workspace.testSuites) {
    const tests = suite.tests.map((test) => {
      const request = test.requestId !== undefined ? mapper.requestNames.get(test.requestId) : undefined;
      return request !== undefined ? `"${test.name}" on ${request}` : `"${test.name}"`;
    });
    report.warn(
      `${prefix}The unit test suite "${suite.name}" was not imported${tests.length > 0 ? ` (${tests.join(', ')})` : ''}; write its checks as assertions or scripts.`,
    );
  }
  if (workspace.spec) {
    report.note(`${prefix}The API spec in this workspace was not imported; import it on its own as OpenAPI.`);
  }
  if (workspace.extras.length > 0) {
    report.warn(`${prefix}These were not imported: ${[...new Set(workspace.extras)].join(', ')}.`);
  }
  if (format === 5 && mapper.wsRequests > 0) {
    report.note(`${prefix}Insomnia does not export WebSocket messages, so the WebSocket requests have none.`);
  }
  for (const [construct, users] of mapper.kept) {
    const shown = construct.startsWith('{') ? construct : `{% ${construct} %}`;
    const chaining =
      construct === 'response'
        ? ' To pass a value from one response to the next request, use a sequence transfer.'
        : '';
    report.warn(`${shown} was kept as written in ${users.join(', ')}; Wirebench does not run it.${chaining}`);
  }
}

/**
 * Maps a read Insomnia export. Throws `insomnia-nothing-to-import` when it holds no request
 * Wirebench maps and no environment.
 */
export function mapInsomnia(doc: InsDocument, options: MapInsomniaOptions = {}): MappedClientImport {
  const newId = options.newId ?? generateId;
  const report = new ReportBuilder();
  for (const line of doc.report.warnings) report.warn(line);
  for (const line of doc.report.notes) report.note(line);
  const variableReport = new ReportBuilder();
  const several = doc.workspaces.length > 1;
  const properties = new VariableSetBuilder('Project properties', variableReport);
  const globals = new VariableSetBuilder('Globals', variableReport);
  const environments: ImportedVariableSet[] = [];
  const collections: MappedClientEntry[] = [];
  const scriptFiles: ImportedScriptFile[] = [];
  let order = options.firstOrder ?? 0;
  let requests = 0;
  let folders = 0;
  let examples = 0;

  for (const workspace of doc.workspaces) {
    const name =
      !several && options.name !== undefined && options.name.trim() !== '' ? options.name.trim() : workspace.name;
    const mapper = new WorkspaceMapper(workspace, newId, report, several ? `${workspace.name}: ` : '');
    surveyNodes(workspace.items, [], mapper);

    // Variables: an environment workspace's base merges into Globals, a collection's is its project properties.
    const toGlobals = doc.kind === 'environment' || workspace.scope === 'environment';
    if (workspace.baseEnv !== undefined) {
      const target = toGlobals ? globals : properties;
      const owner = toGlobals ? 'Globals' : 'Project properties';
      for (const variable of mapper.variables(workspace.baseEnv, owner, variableReport)) {
        target.add(variable, several ? `workspace "${workspace.name}"` : undefined);
      }
    }
    addFolderEnvironments(workspace.items, [], mapper, properties, variableReport);
    for (const env of workspace.subEnvs) {
      const envName = several ? `${workspace.name}: ${env.name}` : env.name;
      const colour = env.color !== undefined && HEX_COLOUR.test(env.color) ? env.color.toLowerCase() : undefined;
      if (env.color !== undefined && colour === undefined) {
        variableReport.note(
          `Environment "${envName}": its colour "${env.color}" is not a #rrggbb value, so it was left out.`,
        );
      }
      environments.push({
        name: envName,
        variables: mapper.variables(env, `Environment "${envName}"`, variableReport),
        ...(colour !== undefined ? { color: colour } : {}),
      });
    }
    if (mapper.vaultNames.length > 0) {
      variableReport.warn(`${mapper.prefix}${VAULT_SECRETS_LINE} ${mapper.vaultNames.join(', ')}`);
    }

    const grpcWalk = mapper.walk<GrpcFolder, GrpcRequestDef>(workspace.items, [], new Map(), {
      folder: (folder, trail, input) => {
        mapper.grpcFolders += 1;
        return createGrpcFolder(folder.name, { newId, ...input, ...mapper.folderInput(folder, trail) });
      },
      request: (node, trail, _inherited, slug, at) =>
        node.kind === 'grpc' ? mapper.grpcRequest(node, trail, slug, at) : undefined,
    });
    const wsWalk = mapper.walk<WsFolder, WsRequestDef>(workspace.items, [], new Map(), {
      folder: (folder, trail, input) => {
        mapper.wsFolders += 1;
        return createWsFolder(folder.name, { newId, ...input, ...mapper.folderInput(folder, trail) });
      },
      request: (node, trail, inherited, slug, at) =>
        node.kind === 'websocket' ? mapper.wsRequest(node, trail, inherited, slug, at) : undefined,
    });

    // HTTP: the v2.1 document, parsed and mapped as an exported one is. The other protocols' and
    // the variables' dynamic names join its own, so the report names them once.
    const dropped: DroppedLevel[] = [];
    const parsed = parsePostmanCollection(v21OfInsomnia(workspace, name, { ...mapper.convertContext(), dropped }));
    const dynamic = [...new Set([...(parsed.dynamicVariables ?? []), ...mapper.dynamic])];
    const http = apiFromPostmanCollection(
      { ...parsed, ...(dynamic.length > 0 ? { dynamicVariables: dynamic } : {}) },
      { newId, name, scriptApi: 'insomnia' },
    );
    for (const warning of http.summary.warnings ?? []) report.warn(`${mapper.prefix}${warning}`);
    if (mapper.credentials > 0) {
      // With REST requests, the REST mapper's line counts only theirs: this one counts the rest.
      const from = http.summary.requests === 0 ? 'the export' : 'gRPC and WebSocket requests';
      report.warn(
        `${mapper.prefix}Credentials are not copied from ${from}; re-enter them for ${String(mapper.credentials)} auth ${mapper.credentials === 1 ? 'configuration' : 'configurations'}`,
      );
    }

    const kinds = [http.summary.requests, grpcWalk.count, wsWalk.count].filter((n) => n > 0).length;
    const apiName = (suffix: string): string => (kinds > 1 ? `${name} (${suffix})` : name);
    const rest = http.summary.requests > 0 ? { ...http.api, order: order++ } : undefined;
    // A folder with no HTTP request below it is no folder of the REST API, or there is no REST API
    // at all: either way its scripts have nowhere to attach, so they are kept as text.
    scriptFiles.push(...droppedApiScriptFiles(slugify(name).toLowerCase(), dropped, report));
    const grpc: GrpcApi | undefined =
      grpcWalk.count > 0
        ? createGrpcApi(apiName('gRPC'), {
            newId,
            order: order++,
            target: mapper.grpcApiTarget?.target ?? '',
            tls: mapper.grpcApiTarget?.tls ?? false,
            folders: grpcWalk.folders,
            requests: grpcWalk.requests,
          })
        : undefined;
    const websocket: WsApi | undefined =
      wsWalk.count > 0
        ? createWsApi(apiName('WebSocket'), {
            newId,
            order: order++,
            url: mapper.wsApiUrl ?? '',
            folders: wsWalk.folders,
            requests: wsWalk.requests,
          })
        : undefined;
    const grpcProtos = grpc !== undefined ? mapper.protos(grpc.name) : undefined;
    if (grpc !== undefined && grpcProtos === undefined) {
      report.note(
        `${grpc.name}: needs a definition: ${doc.format === 5 ? 'Insomnia does not export .proto files, so ' : ''}import its .proto or use server reflection.`,
      );
    }
    reportWorkspace(mapper, doc.format);

    requests += http.summary.requests + grpcWalk.count + wsWalk.count;
    folders += http.summary.folders + mapper.grpcFolders + mapper.wsFolders;
    if (rest !== undefined) examples += folderRequests(rest).reduce((sum, r) => sum + (r.examples?.length ?? 0), 0);
    if (rest !== undefined || grpc !== undefined || websocket !== undefined) {
      collections.push({
        name,
        ...(rest !== undefined ? { rest } : {}),
        ...(grpc !== undefined ? { grpc } : {}),
        ...(grpcProtos !== undefined ? { grpcProtos } : {}),
        ...(websocket !== undefined ? { websocket } : {}),
      });
    }
  }

  const projectProperties = properties.build();
  const globalSet = globals.build();
  warnCredentialLookingNames(variableReport, [...environments, projectProperties, globalSet]);
  const variableCount = environments.length + globalSet.variables.length + projectProperties.variables.length;
  if (requests === 0 && variableCount === 0) {
    throw new InsomniaError(
      'insomnia-nothing-to-import',
      'The Insomnia export holds nothing Wirebench can bring across: no HTTP, gRPC or WebSocket request, and no environment.',
    );
  }
  // Constructs the dialect kept as written were shielded from the shared rewrite: restore them.
  return unshieldTemplates({
    collections,
    variables: {
      environments,
      ...(globalSet.variables.length > 0 ? { globals: globalSet } : {}),
      ...(projectProperties.variables.length > 0 ? { projectProperties } : {}),
      report: variableReport.build(),
    },
    // Scripts are attached to the requests, folders and API, switched off; only those of a workspace
    // with no HTTP request are saved, as text.
    scripts: scriptFiles,
    counts: {
      collections: collections.length,
      requests,
      folders,
      examples,
      assertions: 0,
      scripts: scriptFiles.length,
    },
    report: report.build(),
  });
}
