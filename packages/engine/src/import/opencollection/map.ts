/**
 * Turns a read OpenCollection into Wirebench APIs (spec §7.2): HTTP and GraphQL items go to one
 * REST API, its folders rebuilt only where REST items live under them.
 *
 * In core, not `rest/`, because one collection becomes several protocols' APIs and a protocol
 * folder never imports another (protocol modules spec §7.2). Every protocol import of this
 * importer is in this file, each a listed exception. Pure, but it creates ids, so format detection
 * never imports it.
 */

import { blankIfLiteral, blankJsonText, blankText, headersAndAuth, resolvePath } from '../credential-values.js';
import { MAX_EXAMPLE_BODY_CHARS, maskRecordedResponse } from '../examples.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import type { ImportedScriptFile } from '../scripts.js';
import { colonPathParams, rewriteMustache } from '../templates.js';
import type { ImportedVariables } from '../variables.js';
import { warnCredentialLookingNames } from '../variables.js';
import { referencesOnly, stripUserinfo } from '../values.js';
import { isCredentialName } from '../credentials.js';
import type { KeyValueEntry } from '../../http/entries.js';
import { entry } from '../../http/entries.js';
import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { uniqueSlug } from '../../project/paths.js';
import type { GrpcApi, GrpcFolder, GrpcMethodKind, GrpcRequestDef } from '../../grpc/model.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest, defaultTlsFor } from '../../grpc/model.js';
import type { WsApi, WsFolder, WsRequestDef } from '../../ws/model.js';
import { createWsApi, createWsFolder, createWsRequest, createWsSavedMessage } from '../../ws/model.js';
import type {
  MultipartFormPart,
  RestApi,
  RestBody,
  RestFolder,
  RestRequestDef,
  RestRequestSettings,
  RestResponseExample,
} from '../../rest/model.js';
import { NO_BODY, createApi, createFolder, createRestRequest } from '../../rest/model.js';
import { splitQueryKeepingReferences } from '../../rest/url.js';
import type { Assertion } from '../../assert/model.js';
import { mapOcAssertion } from './assertions.js';
import type { MappedOcAuth } from './auth.js';
import { mapOcAuth } from './auth.js';
import type { OcCollection, OcItem, OcKeyValue } from './model.js';
import {
  mapOcEnvironments,
  mapOcProjectVariables,
  mapOcScripts,
  reportOcConfigExtras,
  reportOcRequestVariables,
} from './variables.js';

export interface MappedOpenCollection {
  /** Absent when the collection has no HTTP or GraphQL item. */
  readonly rest?: RestApi;
  readonly grpc?: GrpcApi;
  readonly websocket?: WsApi;
  /** The `.proto` files the gRPC items name, root-relative. */
  readonly protoFiles: readonly string[];
  /** The variable plan; its report holds the variable lines only. */
  readonly variables: ImportedVariables;
  /** Scripts, to be written under `imported-scripts/` and never run. */
  readonly scripts: readonly ImportedScriptFile[];
  readonly counts: {
    readonly requests: number;
    readonly folders: number;
    readonly assertions: number;
    readonly assertionsSkipped: number;
  };
  /** What the mapping of items did not bring across, and what it did on the user's behalf. */
  readonly report: ImportReport;
}

export interface MapOpenCollectionOptions {
  readonly newId?: IdGenerator;
  /** The `order` of the first API. 0 by default. */
  readonly firstOrder?: number;
  /** The collection's folder, which relative body file paths are resolved against. */
  readonly rootDir?: string;
}

type Rec = Readonly<Record<string, unknown>>;

const SETTINGS = new Set(['timeout', 'followRedirects', 'maxRedirects', 'encodeUrl']);
const ABSOLUTE_PATH = /^(?:[A-Za-z]:)?[\\/]/;
/** A content type for an example body that names none in its headers, by the body's declared type. */
const EXAMPLE_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  text: 'text/plain',
};

/** gRPC method kinds as OpenCollection and its neighbours spell them. */
const METHOD_KINDS: Readonly<Record<string, GrpcMethodKind>> = {
  unary: 'unary',
  'server-streaming': 'server-streaming',
  server_streaming: 'server-streaming',
  serverStreaming: 'server-streaming',
  'client-streaming': 'client-streaming',
  client_streaming: 'client-streaming',
  clientStreaming: 'client-streaming',
  'bidi-streaming': 'bidi-streaming',
  bidi_streaming: 'bidi-streaming',
  bidiStreaming: 'bidi-streaming',
  bidirectional: 'bidi-streaming',
};
const GRPC_METHOD = /^\/?([\w.]+)\/(\w+)$/;
const ITEM_TYPES = new Set(['http', 'graphql', 'grpc', 'websocket']);

/** The name an assertion checks: the last step of `res.body.a.token` or `res.headers.authorization`, any `[n]` dropped. */
function assertionTarget(expression: string): string {
  let end = expression.length;
  // Walked by hand: a `$`-anchored regex would rescan the tail from every `[`.
  while (end > 0 && expression[end - 1] === ']') {
    const open = expression.lastIndexOf('[', end - 1);
    if (open === -1 || !/^\d+$/.test(expression.slice(open + 1, end - 1))) break;
    end = open;
  }
  const path = expression.slice(0, end);
  return path.slice(path.lastIndexOf('.') + 1);
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A scalar as text; anything else (an object, a list) is empty. */
function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function records(value: unknown): readonly Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The `{name, value, disabled, type}` rows of a list, those without a string name left out. */
function rows(value: unknown): readonly OcKeyValue[] {
  return records(value)
    .filter((r) => typeof r['name'] === 'string')
    .map((r) => ({
      name: r['name'] as string,
      value: r['value'],
      ...(r['disabled'] === true ? { disabled: true } : {}),
      ...(typeof r['type'] === 'string' ? { type: r['type'] } : {}),
    }));
}

function named(list: readonly { readonly name: string }[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some((r) => r.name.toLowerCase() === lower);
}

/** The selected variant of a variant list (else the first), and the titles of the others. */
function pickVariant(raw: unknown): { body: unknown; others: string[]; title?: string } {
  if (!Array.isArray(raw)) return { body: raw, others: [] };
  const variants = records(raw);
  const chosen = variants.find((v) => v['selected'] === true) ?? variants[0];
  if (chosen === undefined) return { body: undefined, others: [] };
  const others = variants.filter((v) => v !== chosen).map((v, i) => str(v['title']) || `variant ${i + 1}`);
  return { body: chosen['body'], others, title: str(chosen['title']) };
}

const isHttp = (item: OcItem): boolean => item.info.type === 'http' && item.http !== undefined;
const isGraphql = (item: OcItem): boolean => item.info.type === 'graphql' && item.graphql !== undefined;
const isRest = (item: OcItem): boolean => isHttp(item) || isGraphql(item);

const isGrpc = (item: OcItem): boolean => item.info.type === 'grpc' && item.grpc !== undefined;
const isWebsocket = (item: OcItem): boolean => item.info.type === 'websocket' && item.websocket !== undefined;

/** True when `item` is a folder that holds an item `kind` accepts somewhere below it. */
function holds(item: OcItem, kind: (item: OcItem) => boolean): boolean {
  return item.items?.some((child) => kind(child) || holds(child, kind)) ?? false;
}
const holdsRest = (item: OcItem): boolean => holds(item, isRest);

/** The target of a gRPC item's URL: `host:port`, and whether it is TLS. Absent when the URL names no host. */
function grpcTarget(url: string): { target: string; tls: boolean } | undefined {
  const match = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?([^/?#]*)/.exec(url.trim());
  const authority = match?.[2] ?? '';
  if (authority === '') return undefined;
  const scheme = match?.[1]?.toLowerCase();
  const tls = scheme === undefined ? defaultTlsFor(authority) : scheme === 'grpcs' || scheme === 'https';
  const hasPort = /:(?:\d+|\$\{[^}]*\})$/.test(authority);
  return { target: hasPort ? authority : `${authority}:${tls ? 443 : 80}`, tls };
}

/** What a request inherits from the folders and collection above it. */
interface Scope {
  /** Enabled default headers, the nearest owner's first. */
  readonly headers: readonly KeyValueEntry[];
  /** The rows a references-only credential of the nearest owner with auth sends. */
  readonly auth: Pick<MappedOcAuth, 'header' | 'query'>;
}

/** The mapping's running state: one report, one id source, one set of dynamic names, the counts. */
class Mapper {
  readonly report = new ReportBuilder();
  readonly dynamic = new Set<string>();
  requests = 0;
  folders = 0;
  grpcRequests = 0;
  grpcFolders = 0;
  wsRequests = 0;
  wsFolders = 0;
  assertions = 0;
  assertionsSkipped = 0;
  /** The `.proto` files the gRPC items name. */
  readonly protoFiles = new Set<string>();
  /** The first gRPC item's target, which the API takes. */
  grpcApiTarget: { target: string; tls: boolean } | undefined;
  /** The first WebSocket item's URL, which the API takes. */
  wsApiUrl: string | undefined;

  constructor(
    private readonly newId: IdGenerator,
    private readonly rootDir: string | undefined,
  ) {}

  rewrite(text: string): string {
    return rewriteMustache(text, this.dynamic);
  }

  auth(raw: unknown, where: string): MappedOcAuth {
    return mapOcAuth(raw, where, this.report, this.dynamic);
  }

  /** `scope` below an owner with these default headers and this auth; a note for each credential row added. */
  scopeBelow(scope: Scope, headers: unknown, auth: MappedOcAuth, where: string): Scope {
    const own = rows(headers)
      .filter((h) => h.disabled !== true)
      .map((h) => entry(h.name, this.rewrite(scalar(h.value))));
    this.noteAuthRows(auth, where, ' on each request below it');
    return {
      headers: [...own, ...scope.headers.filter((h) => !named(own, h.name))],
      auth: auth.auth.type === 'inherit' ? scope.auth : auth,
    };
  }

  private noteAuthRows(auth: MappedOcAuth, where: string, tail: string): void {
    for (const row of [auth.header, auth.query]) {
      if (row !== undefined) this.report.note(`${where}: the credential reference was added as ${row.name}${tail}.`);
    }
  }

  /** The folders and requests of one level, a folder kept only when REST items live under it. */
  walk(items: readonly OcItem[], scope: Scope): { folders: RestFolder[]; requests: RestRequestDef[] } {
    const folders: RestFolder[] = [];
    const requests: RestRequestDef[] = [];
    const folderSlugs = new Set<string>();
    const requestSlugs = new Set<string>();
    for (const item of items) {
      const name = item.info.name;
      if (item.items !== undefined) {
        if (!holdsRest(item)) continue;
        const auth = this.auth(item.request?.auth, name);
        const inner = this.walk(item.items, this.scopeBelow(scope, item.request?.headers, auth, name));
        const slug = uniqueSlug(name, folderSlugs);
        folderSlugs.add(slug);
        folders.push(
          createFolder(name, {
            newId: this.newId,
            order: folders.length,
            slug,
            ...(auth.auth.type !== 'inherit' ? { auth: auth.auth } : {}),
            folders: inner.folders,
            requests: inner.requests,
          }),
        );
        this.folders += 1;
        continue;
      }
      if (!isRest(item)) continue;
      const slug = uniqueSlug(name, requestSlugs);
      requestSlugs.add(slug);
      requests.push(this.request(item, scope, slug, requests.length));
      this.requests += 1;
    }
    return { folders, requests };
  }

  /** A warning for each item that is none of the four request types, a folder or a script file. */
  skipUnsupported(items: readonly OcItem[]): void {
    for (const item of items) {
      if (item.items !== undefined) {
        this.skipUnsupported(item.items);
      } else if (item.script === undefined && !ITEM_TYPES.has(item.info.type ?? '')) {
        const type = item.info.type ?? 'unknown';
        this.report.warn(`${item.info.name}: ${type} items are not supported and were skipped.`);
      }
    }
  }

  /** The folders and requests of one level for a protocol, a folder kept only when an item of it lives below. */
  private walkProtocol<F, R>(
    items: readonly OcItem[],
    kind: (item: OcItem) => boolean,
    build: {
      folder: (
        name: string,
        input: { slug: string; order: number; auth?: AuthConfig; folders: F[]; requests: R[] },
      ) => F;
      request: (item: OcItem, slug: string, order: number) => R | undefined;
      counted: (folders: number, requests: number) => void;
    },
  ): { folders: F[]; requests: R[] } {
    const folders: F[] = [];
    const requests: R[] = [];
    const folderSlugs = new Set<string>();
    const requestSlugs = new Set<string>();
    for (const item of items) {
      const name = item.info.name;
      if (item.items !== undefined) {
        if (!holds(item, kind)) continue;
        const auth = this.auth(item.request?.auth, name);
        const inner = this.walkProtocol(item.items, kind, build);
        const slug = uniqueSlug(name, folderSlugs);
        folderSlugs.add(slug);
        folders.push(
          build.folder(name, {
            slug,
            order: folders.length,
            ...(auth.auth.type !== 'inherit' ? { auth: auth.auth } : {}),
            folders: inner.folders,
            requests: inner.requests,
          }),
        );
        build.counted(1, 0);
        continue;
      }
      if (!kind(item)) continue;
      const slug = uniqueSlug(name, requestSlugs);
      const request = build.request(item, slug, requests.length);
      if (request === undefined) continue;
      requestSlugs.add(slug);
      requests.push(request);
      build.counted(0, 1);
    }
    return { folders, requests };
  }

  walkGrpc(items: readonly OcItem[]): { folders: GrpcFolder[]; requests: GrpcRequestDef[] } {
    return this.walkProtocol<GrpcFolder, GrpcRequestDef>(items, isGrpc, {
      folder: (name, input) => createGrpcFolder(name, { newId: this.newId, ...input }),
      request: (item, slug, order) => this.grpcRequest(item, slug, order),
      counted: (folders, requests) => {
        this.grpcFolders += folders;
        this.grpcRequests += requests;
      },
    });
  }

  walkWebsocket(items: readonly OcItem[]): { folders: WsFolder[]; requests: WsRequestDef[] } {
    return this.walkProtocol<WsFolder, WsRequestDef>(items, isWebsocket, {
      folder: (name, input) => createWsFolder(name, { newId: this.newId, ...input }),
      request: (item, slug, order) => this.wsRequest(item, slug, order),
      counted: (folders, requests) => {
        this.wsFolders += folders;
        this.wsRequests += requests;
      },
    });
  }

  /** A message or frame body as text: a string as written, an object as indented JSON. */
  private messageText(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data === undefined || data === null) return '';
    if (typeof data === 'object') return JSON.stringify(data, null, 2);
    return scalar(data);
  }

  /** An item's own metadata or headers with its auth row, through the credential rule. */
  private protocolRows(
    raw: unknown,
    auth: MappedOcAuth,
    label: string,
    blanked: Set<string>,
  ): { rows: KeyValueEntry[]; auth: AuthConfig } {
    const own = rows(raw).map((h) => ({
      name: h.name,
      value: this.rewrite(scalar(h.value)),
      enabled: h.disabled !== true,
    }));
    this.noteAuthRows(auth, label, '');
    if (auth.header !== undefined && !named(own, auth.header.name)) own.push(auth.header);
    const mapped = headersAndAuth(own, label, this.report, blanked);
    return { rows: mapped.headers, auth: auth.auth.type === 'inherit' ? mapped.auth : auth.auth };
  }

  private blankedWarning(label: string, blanked: Set<string>): void {
    if (blanked.size > 0) {
      this.report.warn(
        `${label}: the recorded value of ${[...blanked].join(', ')} was not imported; set it on the request.`,
      );
    }
  }

  private grpcRequest(item: OcItem, slug: string, order: number): GrpcRequestDef | undefined {
    const label = item.info.name;
    this.noteProtocolAssertions(item, label);
    const details = item.grpc ?? {};
    const method = GRPC_METHOD.exec(str(details['method']));
    const service = method?.[1];
    const rpc = method?.[2];
    if (service === undefined || rpc === undefined) {
      this.report.warn(`${label}: the gRPC method is not service/method and the item was skipped.`);
      return undefined;
    }
    const blanked = new Set<string>();
    const rewritten = this.rewrite(str(details['url']));
    const { url, stripped } = stripUserinfo(rewritten);
    if (stripped) this.report.warn(`${label}: the credential in the URL was not imported; set it on the request.`);
    const target = grpcTarget(url);
    if (target !== undefined) {
      if (this.grpcApiTarget === undefined) this.grpcApiTarget = target;
      else if (target.target !== this.grpcApiTarget.target || target.tls !== this.grpcApiTarget.tls) {
        this.report.note(
          `${label}: its target ${target.target} differs from the API's ${this.grpcApiTarget.target}; the API's is used.`,
        );
      }
    }
    const protoFile = str(details['protoFilePath']);
    if (protoFile !== '') this.protoFiles.add(protoFile);

    const rawKind = str(details['methodType']) || str(details['methodKind']);
    let methodKind: GrpcMethodKind = 'unary';
    if (rawKind !== '') {
      const known = Object.hasOwn(METHOD_KINDS, rawKind) ? METHOD_KINDS[rawKind] : undefined;
      if (known === undefined) {
        this.report.note(`${label}: the method type "${rawKind}" is unknown and was imported as unary.`);
      } else {
        methodKind = known;
      }
    }

    const mapped = this.protocolRows(details['metadata'], this.auth(details['auth'], label), label, blanked);
    const rawMessage = details['message'];
    const message = blankJsonText(this.rewrite(this.messageText(rawMessage)), blanked);
    this.blankedWarning(label, blanked);
    const timeout = item.settings?.['timeout'];
    return createGrpcRequest(label, {
      newId: this.newId,
      order,
      slug,
      service,
      method: rpc,
      methodKind,
      metadata: mapped.rows,
      ...(rawMessage !== undefined ? { message } : {}),
      auth: mapped.auth,
      settings: typeof timeout === 'number' && Number.isFinite(timeout) ? { timeoutMs: timeout } : {},
    });
  }

  private wsRequest(item: OcItem, slug: string, order: number): WsRequestDef {
    const label = item.info.name;
    this.noteProtocolAssertions(item, label);
    const details = item.websocket ?? {};
    const blanked = new Set<string>();
    const { url: withoutUser, stripped } = stripUserinfo(this.rewrite(str(details['url'])));
    if (stripped) this.report.warn(`${label}: the credential in the URL was not imported; set it on the request.`);
    const split = splitQueryKeepingReferences(withoutUser);
    const query = split.query.map((q) => entry(q.name, blankIfLiteral(q.name, q.value, blanked)));
    if (this.wsApiUrl === undefined) this.wsApiUrl = split.path;

    const mapped = this.protocolRows(details['headers'], this.auth(details['auth'], label), label, blanked);
    const raw = isRecord(details['message']) ? details['message'] : undefined;
    const messages =
      raw?.['data'] !== undefined
        ? [
            createWsSavedMessage('Message', {
              newId: this.newId,
              content: blankText(this.rewrite(this.messageText(raw['data'])), undefined, blanked),
              format: 'text',
            }),
          ]
        : [];
    this.blankedWarning(label, blanked);

    const settings = item.settings ?? {};
    const timeout = settings['timeout'];
    if (settings['keepAliveInterval'] !== undefined) {
      this.report.note(`${label}: keepAliveInterval has no Wirebench equivalent and was ignored.`);
    }
    return createWsRequest(label, {
      newId: this.newId,
      order,
      slug,
      url: split.path,
      query,
      headers: mapped.rows,
      auth: mapped.auth,
      messages,
      settings: typeof timeout === 'number' && Number.isFinite(timeout) ? { handshakeTimeoutMs: timeout } : {},
    });
  }

  private request(item: OcItem, scope: Scope, slug: string, order: number): RestRequestDef {
    const label = item.info.name;
    const graphql = isGraphql(item);
    const details = (graphql ? item.graphql : item.http) ?? {};
    const blanked = new Set<string>();

    const method = graphql ? 'POST' : (str(details['method']) || 'GET').toUpperCase();
    const { url: withoutUser, stripped, username } = stripUserinfo(this.rewrite(str(details['url'])));
    const split = splitQueryKeepingReferences(withoutUser);
    const url = colonPathParams(split.path);

    const params = rows(details['params']);
    const param = (p: OcKeyValue): KeyValueEntry =>
      entry(p.name, blankIfLiteral(p.name, this.rewrite(scalar(p.value)), blanked), { enabled: p.disabled !== true });
    const pathParams = params.filter((p) => p.type === 'path').map(param);
    const query = params.filter((p) => p.type !== 'path').map(param);
    // The URL may repeat the query the params list: a param of the same name wins.
    const listed = new Set(query.map((p) => p.name));
    for (const q of split.query) {
      if (listed.has(q.name)) continue;
      listed.add(q.name);
      query.push(entry(q.name, blankIfLiteral(q.name, q.value, blanked)));
    }

    const own = rows(details['headers']).map((h) => ({
      name: h.name,
      value: this.rewrite(scalar(h.value)),
      enabled: h.disabled !== true,
    }));
    const defaults = scope.headers.filter((h) => !named(own, h.name));
    if (defaults.length > 0) this.report.note(`${label}: folder and collection default headers were added.`);
    const ownAuth = this.auth(details['auth'], label);
    this.noteAuthRows(ownAuth, label, '');
    const rowsFrom = ownAuth.auth.type === 'inherit' ? scope.auth : ownAuth;
    const merged = [...own, ...defaults];
    if (rowsFrom.header !== undefined && !named(merged, rowsFrom.header.name)) merged.push(rowsFrom.header);
    if (rowsFrom.query !== undefined && !named(query, rowsFrom.query.name)) query.push(rowsFrom.query);

    const fromHeaders = headersAndAuth(merged, label, this.report, blanked);
    let auth = ownAuth.auth.type === 'inherit' ? fromHeaders.auth : ownAuth.auth;
    if (stripped) {
      this.report.warn(`${label}: the credential in the URL was not imported; set it on the request.`);
      if (auth.type === 'inherit' && !named(merged, 'authorization')) {
        auth = { type: 'basic', ...(username !== undefined ? { username } : {}) };
      }
    }

    const body = graphql
      ? this.graphqlBody(details['body'], label, blanked)
      : this.body(details['body'], label, blanked);
    if (graphql) this.report.note(`${label}: GraphQL was imported as an HTTP POST; GraphQL support is tracked in #77.`);
    if (blanked.size > 0) {
      this.report.warn(
        `${label}: the recorded value of ${[...blanked].join(', ')} was not imported; set it on the request.`,
      );
    }
    const examples = this.examples(item.examples ?? [], label);
    const assertions = this.assertionsOf(item, label);
    return {
      ...createRestRequest(label, {
        newId: this.newId,
        order,
        slug,
        method,
        url,
        pathParams,
        query,
        headers: fromHeaders.headers,
        body,
        auth,
        settings: this.settings(item.settings, label),
      }),
      assertions,
      ...(examples.length > 0 ? { examples } : {}),
    };
  }

  /** The request's assertions that have a Wirebench equivalent; each one left out is counted and reported. */
  private assertionsOf(item: OcItem, label: string): Assertion[] {
    const out: Assertion[] = [];
    for (const raw of item.runtime?.assertions ?? []) {
      // The expected value is rewritten once, here, so `{{name}}` reads as `${name}` and a dynamic
      // name joins the collection's one report of them.
      const a = raw.value !== undefined ? { ...raw, value: this.rewrite(raw.value) } : raw;
      const credential = isCredentialName(assertionTarget(a.expression));
      // Checked before anything else, so an assertion comparing a recorded credential is reported
      // as such whether or not it is enabled; mapOcAssertion leaves out every disabled one.
      if (credential && a.value !== undefined && a.value !== '') {
        if (!referencesOnly(a.value)) {
          this.assertionsSkipped += 1;
          this.report.warn(
            `${label}: the assertion on ${a.expression} compares a recorded credential and was not imported.`,
          );
          continue;
        }
      }
      const mapped = mapOcAssertion(a);
      if (mapped !== undefined) {
        out.push(mapped);
        this.assertions += 1;
      } else if (a.disabled === true) {
        this.report.note(`${label}: a disabled assertion was skipped.`);
      } else {
        this.assertionsSkipped += 1;
        this.report.warn(
          `${label}: the assertion "${a.expression} ${a.operator} ${credential ? '<value not shown>' : (raw.value ?? '')}" has no Wirebench equivalent and was not imported.`,
        );
      }
    }
    return out;
  }

  /** A note for a gRPC or WebSocket item's assertions, which only HTTP requests carry (spec §7.4). */
  private noteProtocolAssertions(item: OcItem, label: string): void {
    if ((item.runtime?.assertions ?? []).length > 0) {
      this.report.note(
        `${label}: its assertions were not imported; Wirebench imports assertions on HTTP requests only.`,
      );
    }
  }

  /** A body file path, rewritten and resolved against the collection folder when there is one. */
  private filePath(raw: string, label: string): string {
    const rel = this.rewrite(raw);
    if (ABSOLUTE_PATH.test(rel)) return rel;
    if (this.rootDir === undefined) {
      this.report.warn(`${label}: the body file ${rel} is relative to the collection; check its path on the request.`);
      return rel;
    }
    return resolvePath(this.rootDir, rel);
  }

  private body(raw: unknown, label: string, blanked: Set<string>): RestBody {
    const { body, others, title } = pickVariant(raw);
    if (others.length > 0) {
      this.report.note(
        `${label}: the body "${title ?? ''}" was imported; the other variants were left out: ${others.join(', ')}.`,
      );
    }
    if (!isRecord(body)) return NO_BODY;
    const type = str(body['type']);
    const data = body['data'];
    switch (type) {
      case 'json':
        return { kind: 'raw', language: 'json', text: blankJsonText(this.rewrite(str(data)), blanked) };
      case 'xml':
        return { kind: 'raw', language: 'xml', text: blankText(this.rewrite(str(data)), 'application/xml', blanked) };
      case 'text':
        return { kind: 'raw', language: 'text', text: blankText(this.rewrite(str(data)), undefined, blanked) };
      case 'sparql':
        return {
          kind: 'raw',
          language: 'text',
          contentType: 'application/sparql-query',
          text: this.rewrite(str(data)),
        };
      case 'form-urlencoded':
        return {
          kind: 'form',
          fields: rows(data).map((f) =>
            entry(f.name, blankIfLiteral(f.name, this.rewrite(scalar(f.value)), blanked), {
              enabled: f.disabled !== true,
            }),
          ),
        };
      case 'multipart-form':
        return { kind: 'multipart', parts: records(data).flatMap((p) => this.part(p, label, blanked)) };
      case 'file': {
        const files = records(data);
        const chosen = files.find((f) => f['selected'] === true) ?? files[0];
        if (chosen === undefined || str(chosen['filePath']) === '') return NO_BODY;
        return {
          kind: 'binary',
          source: { kind: 'path', path: this.filePath(str(chosen['filePath']), label) },
          contentType: str(chosen['contentType']) || 'application/octet-stream',
        };
      }
      default:
        this.report.note(`${label}: a ${type === '' ? 'body without a type' : `${type} body`} was left out.`);
        return NO_BODY;
    }
  }

  private part(raw: Rec, label: string, blanked: Set<string>): MultipartFormPart[] {
    if (typeof raw['name'] !== 'string') return [];
    const name = raw['name'];
    const enabled = raw['disabled'] !== true;
    const contentType = str(raw['contentType']);
    const typed = contentType !== '' ? { contentType } : {};
    if (raw['type'] === 'file') {
      const paths = (Array.isArray(raw['value']) ? raw['value'] : [raw['value']]).filter(
        (v): v is string => typeof v === 'string' && v !== '',
      );
      if (paths.length > 1) {
        this.report.note(`${label}: the file part "${name}" lists ${paths.length} files; only the first was imported.`);
      }
      const first = paths[0];
      if (first === undefined) return [];
      return [{ kind: 'file', name, source: { kind: 'path', path: this.filePath(first, label) }, enabled, ...typed }];
    }
    const value = blankIfLiteral(name, this.rewrite(scalar(raw['value'])), blanked);
    return [{ kind: 'text', name, value, enabled, ...typed }];
  }

  private graphqlBody(raw: unknown, label: string, blanked: Set<string>): RestBody {
    const { body, others, title } = pickVariant(raw);
    if (others.length > 0) {
      this.report.note(
        `${label}: the body "${title ?? ''}" was imported; the other variants were left out: ${others.join(', ')}.`,
      );
    }
    const graph = isRecord(body) ? body : {};
    const query = this.rewrite(str(graph['query']));
    let variables: unknown;
    const rawVariables = graph['variables'];
    if (typeof rawVariables === 'string' && rawVariables.trim() !== '') {
      // Blanked before it is parsed: text that does not parse (an unquoted reference) would
      // otherwise be embedded as one JSON string, which the blanking of the body never looks into.
      const rewritten = blankJsonText(this.rewrite(rawVariables), blanked);
      try {
        variables = JSON.parse(rewritten) as unknown;
      } catch {
        variables = rewritten;
      }
    } else if (isRecord(rawVariables)) {
      variables = this.rewriteLeaves(rawVariables);
    }
    const text = JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) });
    return { kind: 'raw', language: 'json', contentType: 'application/json', text: blankJsonText(text, blanked) };
  }

  /** A copy of a parsed value with every string in it rewritten. */
  private rewriteLeaves(value: unknown): unknown {
    if (typeof value === 'string') return this.rewrite(value);
    if (Array.isArray(value)) return value.map((item) => this.rewriteLeaves(item));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.rewriteLeaves(v)]));
    return value;
  }

  /** The REST settings the item names; any other setting is noted once. */
  private settings(raw: Rec | undefined, label: string): RestRequestSettings {
    if (raw === undefined) return {};
    const { timeout, followRedirects, maxRedirects, encodeUrl } = raw;
    const others = Object.keys(raw).filter((key) => !SETTINGS.has(key));
    if (others.length > 0) {
      this.report.note(`${label}: the settings ${others.join(', ')} have no Wirebench equivalent and were ignored.`);
    }
    return {
      ...(typeof timeout === 'number' && Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
      ...(typeof followRedirects === 'boolean' ? { followRedirects } : {}),
      ...(typeof maxRedirects === 'number' && Number.isFinite(maxRedirects) ? { maxRedirects } : {}),
      ...(typeof encodeUrl === 'boolean' ? { encodeUrl } : {}),
    };
  }

  /** The examples with a numeric status, masked as every importer masks a recorded response. */
  private examples(raw: readonly unknown[], label: string): RestResponseExample[] {
    const out: RestResponseExample[] = [];
    let skipped = 0;
    for (const example of raw) {
      const response = isRecord(example) && isRecord(example['response']) ? example['response'] : undefined;
      const status = response?.['status'];
      if (response === undefined || typeof status !== 'number' || !Number.isFinite(status)) {
        skipped += 1;
        continue;
      }
      const recorded = rows(response['headers']).map((h) => ({ name: h.name, value: scalar(h.value) }));
      const bodyRec = isRecord(response['body']) ? response['body'] : undefined;
      const bodyType = str(bodyRec?.['type']);
      let body = typeof bodyRec?.['data'] === 'string' ? bodyRec['data'] : undefined;
      if (bodyType === 'binary' && body !== undefined) {
        this.report.note(`${label}: a binary response body was left out of the example.`);
        body = undefined;
      }
      const contentType =
        recorded.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? EXAMPLE_TYPES[bodyType];
      const masked = maskRecordedResponse(recorded, body, contentType);
      if (masked.masked) this.report.note(`${label}: credentials in a recorded response were masked in its example.`);
      let kept = masked.body;
      if (kept !== undefined && kept.length > MAX_EXAMPLE_BODY_CHARS) {
        kept = kept.slice(0, MAX_EXAMPLE_BODY_CHARS);
        this.report.note(`${label}: a ${status} example body was larger than 256 KB and was cut.`);
      }
      const name = isRecord(example) ? str(example['name']) : '';
      out.push({
        id: this.newId(),
        name: name !== '' ? name : `${status}`,
        status,
        statusText: str(response['statusText']),
        headers: masked.headers,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(kept !== undefined ? { body: kept } : {}),
      });
    }
    if (skipped > 0) {
      this.report.note(`${label}: ${skipped} example(s) without a response status were skipped.`);
    }
    return out;
  }
}

/** Maps a read OpenCollection to Wirebench APIs. */
export function mapOpenCollection(
  collection: OcCollection,
  options: MapOpenCollectionOptions = {},
): MappedOpenCollection {
  const mapper = new Mapper(options.newId ?? generateId, options.rootDir);
  const name = collection.info.name !== '' ? collection.info.name : 'Collection';
  const rootAuth = mapper.auth(collection.request?.auth, name);
  const root = mapper.scopeBelow({ headers: [], auth: {} }, collection.request?.headers, rootAuth, name);
  mapper.skipUnsupported(collection.items);
  const { folders, requests } = mapper.walk(collection.items, root);
  const grpcWalk = mapper.walkGrpc(collection.items);
  const wsWalk = mapper.walkWebsocket(collection.items);
  const kinds = [mapper.requests, mapper.grpcRequests, mapper.wsRequests].filter((n) => n > 0).length;
  const apiName = (suffix: string): string => (kinds > 1 ? `${name} (${suffix})` : name);
  const newId = options.newId ?? generateId;
  let order = options.firstOrder ?? 0;
  const inherited = rootAuth.auth.type !== 'inherit' ? { auth: rootAuth.auth } : {};
  const rest =
    mapper.requests === 0
      ? undefined
      : createApi(name, {
          newId,
          order: order++,
          baseUrl: '',
          servers: [],
          ...inherited,
          folders,
          requests,
        });
  const grpc =
    mapper.grpcRequests === 0
      ? undefined
      : createGrpcApi(apiName('gRPC'), {
          newId,
          order: order++,
          target: mapper.grpcApiTarget?.target ?? '',
          tls: mapper.grpcApiTarget?.tls ?? false,
          ...inherited,
          folders: grpcWalk.folders,
          requests: grpcWalk.requests,
        });
  const websocket =
    mapper.wsRequests === 0
      ? undefined
      : createWsApi(apiName('WebSocket'), {
          newId,
          order: order++,
          url: mapper.wsApiUrl ?? '',
          ...inherited,
          folders: wsWalk.folders,
          requests: wsWalk.requests,
        });
  // Variable lines go to the variable plan's own report, which the desktop repeats when it applies
  // the plan; every other line goes to the mapping report, so none appears twice.
  const variableReport = new ReportBuilder();
  const environments = mapOcEnvironments(collection.environments, variableReport, mapper.dynamic);
  const projectProperties = mapOcProjectVariables(collection, variableReport, mapper.dynamic);
  warnCredentialLookingNames(variableReport, [...environments, ...(projectProperties ? [projectProperties] : [])]);
  reportOcRequestVariables(collection.items, mapper.report);
  reportOcConfigExtras(collection, mapper.report);
  const apiSlug = (rest ?? grpc ?? websocket)?.slug.toLowerCase() ?? 'collection';
  const scripts = mapOcScripts(collection, apiSlug, name, mapper.report);
  if (grpc !== undefined && mapper.protoFiles.size === 0) {
    mapper.report.note(`${grpc.name}: needs a definition: import its .proto or use server reflection.`);
  }
  if (mapper.dynamic.size > 0) {
    mapper.report.warn(
      `Dynamic variables are kept as written and not expanded: ${[...mapper.dynamic].sort().join(', ')}`,
    );
  }
  return {
    ...(rest !== undefined ? { rest } : {}),
    ...(grpc !== undefined ? { grpc } : {}),
    ...(websocket !== undefined ? { websocket } : {}),
    protoFiles: [...mapper.protoFiles],
    variables: {
      environments,
      ...(projectProperties !== undefined ? { projectProperties } : {}),
      report: variableReport.build(),
    },
    scripts,
    counts: {
      requests: mapper.requests + mapper.grpcRequests + mapper.wsRequests,
      folders: mapper.folders + mapper.grpcFolders + mapper.wsFolders,
      assertions: mapper.assertions,
      assertionsSkipped: mapper.assertionsSkipped,
    },
    report: mapper.report.build(),
  };
}
