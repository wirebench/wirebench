/**
 * A project, or one of its containers, as a neutral tree both exporters write (spec §3.1): every
 * text already rewritten to `{{name}}`, every URL absolute, every SOAP request an HTTP POST, and
 * every credential dropped. What the tree cannot hold is reported here, once; what only one format
 * cannot hold is reported by that format.
 */

import type { Assertion, StatusAssertion } from '../assert/model.js';
import { ExportError } from '../errors.js';
import { isCredentialName } from '../import/credentials.js';
import { blankIfLiteral, blankUrlCredentials } from '../import/credential-values.js';
import { referencesOnly } from '../import/values.js';
import type { GrpcApi, GrpcFolder, GrpcMethodKind, GrpcRequestDef } from '../grpc/model.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { AuthConfig, Project, PropertyMap, SoapOwnerAuth } from '../project/model.js';
import type { Interface, SoapRequestDef } from '../soap/model.js';
import type {
  MultipartFormPart,
  RestApi,
  RestBody,
  RestFolder,
  RestRequestDef,
  RestResponseExample,
} from '../rest/model.js';
import { exampleBodyExtension, restApisOf } from '../rest/model.js';
import { joinBase, splitQueryKeepingReferences } from '../rest/url.js';
import type { RequestScripts } from '../script/model.js';
import type { WsApi, WsFolder, WsRequestDef } from '../ws/model.js';
import type { CollectionExportEnvironment, CollectionExportInput } from './model.js';
import { colonPath, ExportContext, isSecretOnly } from './shared.js';
import { soapInterfacesOf } from '../soap/model.js';
import { grpcApisOf } from '../grpc/model.js';
import { wsApisOf } from '../ws/model.js';

export interface XVariable {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly secret: boolean;
}

export interface XEnvironment {
  readonly name: string;
  readonly variables: readonly XVariable[];
}

/** A body as a request carries it; the writers read it through this name so they import no protocol folder. */
export type XBody = RestBody;

/** A recorded response, with the kind its body is by its content type. */
export type XExample = RestResponseExample & { readonly bodyKind: 'json' | 'xml' | 'html' | 'text' };

export interface XScripts {
  readonly pre?: string;
  readonly post?: string;
}

/** What an HTTP request keeps of its settings: the four both formats know. */
export interface XHttpSettings {
  readonly timeoutMs?: number;
  readonly followRedirects?: boolean;
  readonly maxRedirects?: number;
  readonly encodeUrl?: boolean;
}

export interface XFolder {
  readonly kind: 'folder';
  readonly name: string;
  readonly description?: string;
  /** Absent: inherit. */
  readonly auth?: AuthConfig;
  readonly items: readonly XItem[];
}

export interface XHttp {
  readonly kind: 'http';
  readonly name: string;
  /** Where it is, for the report: `Orders / Submit / Request 1`. */
  readonly label: string;
  readonly description?: string;
  readonly method: string;
  /** Absolute, without its query, path parameters as `:name`. */
  readonly url: string;
  readonly pathParams: readonly KeyValueEntry[];
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly body: XBody;
  readonly auth: AuthConfig;
  readonly settings: XHttpSettings;
  readonly assertions: readonly Assertion[];
  readonly scripts: XScripts;
  readonly examples: readonly XExample[];
}

export interface XGrpc {
  readonly kind: 'grpc';
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  /** `grpc://` or `grpcs://` and the API's target. */
  readonly url: string;
  readonly service: string;
  readonly method: string;
  readonly methodKind: GrpcMethodKind;
  readonly message: string;
  readonly metadata: readonly KeyValueEntry[];
  readonly auth: AuthConfig;
  readonly timeoutMs?: number;
  readonly assertions: readonly Assertion[];
  readonly scripts: XScripts;
}

export interface XWebSocket {
  readonly kind: 'websocket';
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  /** Absolute, without its query. */
  readonly url: string;
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly auth: AuthConfig;
  readonly messages: readonly string[];
  readonly timeoutMs?: number;
  readonly assertions: readonly Assertion[];
}

export type XItem = XFolder | XHttp | XGrpc | XWebSocket;

export interface XCollection {
  readonly name: string;
  readonly description?: string;
  /** The exported API's own auth; absent for a whole project. */
  readonly auth?: AuthConfig;
  readonly items: readonly XItem[];
  readonly variables: readonly XVariable[];
  readonly environments: readonly XEnvironment[];
  readonly counts: { readonly requests: number; readonly folders: number };
}

type Container = Interface | RestApi | GrpcApi | WsApi;

const byOrder = <T extends { readonly order: number }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => a.order - b.order);

const hasName = (rows: readonly { readonly name: string }[], name: string): boolean =>
  rows.some((row) => row.name.toLowerCase() === name.toLowerCase());

/** Builds the tree; the report lines go to `ctx`. */
export function buildTree(input: CollectionExportInput, ctx: ExportContext): XCollection {
  return new TreeBuilder(ctx).build(input);
}

class TreeBuilder {
  private requests = 0;
  private folders = 0;

  constructor(private readonly ctx: ExportContext) {}

  build(input: CollectionExportInput): XCollection {
    const { project, target } = input;
    let collection: Omit<XCollection, 'variables' | 'environments' | 'counts'>;
    if (target.kind === 'container') {
      const container = containersOf(project).find((c) => c.id === target.id);
      if (container === undefined) {
        throw new ExportError('export-target-not-found', `No API or interface with id "${target.id}" in the project.`);
      }
      const folder = this.container(container);
      collection = {
        name: container.name,
        ...(folder.description !== undefined ? { description: folder.description } : {}),
        ...(folder.auth !== undefined ? { auth: folder.auth } : {}),
        items: folder.items,
      };
      this.folders -= 1; // the container itself is the collection, not a folder in it
    } else {
      this.noteLeftOut(project);
      collection = {
        name: project.name,
        ...(project.description !== undefined ? { description: project.description } : {}),
        items: containersOf(project).map((c) => this.container(c)),
      };
    }
    if (this.requests === 0) {
      throw new ExportError('export-nothing', 'There is no request to export.');
    }
    const environments = (input.environments ?? project.environments).map((env) => this.environment(env));
    for (const env of input.environments ?? project.environments) {
      if (Object.keys(env.endpoints ?? {}).length > 0) {
        this.ctx.report.note(`${env.name}: its endpoint overrides were not exported.`);
      }
    }
    const variables = this.variables(
      { ...(input.workspaceProperties ?? {}), ...project.properties },
      [
        ...(input.workspaceDisabledProperties ?? []).filter((name) => !Object.hasOwn(project.properties, name)),
        ...project.disabledProperties,
      ],
      'Project properties',
    );
    // A secret named by a reference anywhere is declared once, with no value, unless a property already is it.
    const declared = new Set([...variables, ...environments.flatMap((e) => e.variables)].map((v) => v.name));
    for (const name of this.ctx.secrets) {
      if (!declared.has(name)) variables.push({ name, value: '', enabled: true, secret: true });
    }
    return { ...collection, variables, environments, counts: { requests: this.requests, folders: this.folders } };
  }

  private noteLeftOut(project: Project): void {
    const left: string[] = [];
    if (project.webhooks !== undefined) left.push('the webhook collection');
    if (project.sequences.length > 0) left.push(`${project.sequences.length} sequence(s)`);
    for (const c of project.unsupported ?? []) left.push(c.name ?? c.slug);
    for (const [kind, list] of Object.entries(project.containers)) {
      if (!EXPORTED_KINDS.has(kind)) for (const c of list) left.push(c.name);
    }
    if (left.length > 0) this.ctx.report.warn(`Not exported: ${left.join(', ')}.`);
  }

  private environment(env: CollectionExportEnvironment): XEnvironment {
    return { name: env.name, variables: this.variables(env.properties, env.disabledProperties, env.name) };
  }

  private variables(map: PropertyMap, disabled: readonly string[], owner: string): XVariable[] {
    const off = new Set(disabled);
    return Object.entries(map).map(([name, value]) => {
      const enabled = !off.has(name);
      if (isSecretOnly(value)) {
        this.ctx.report.note(`${owner}: ${name} holds a secret and is written as a secret variable with no value.`);
        return { name, value: '', enabled, secret: true };
      }
      if (value !== '' && isCredentialName(name) && !referencesOnly(value)) {
        this.ctx.report.warn(
          `${owner}: the plain-text value of ${name} was not exported; it is written as a secret variable with no value.`,
        );
        return { name, value: '', enabled, secret: true };
      }
      return { name, value: this.ctx.mustache(value), enabled, secret: false };
    });
  }

  private container(container: Container): XFolder {
    this.folders += 1;
    const description = 'description' in container ? container.description : undefined;
    const base = {
      kind: 'folder' as const,
      name: container.name,
      ...(description !== undefined ? { description } : {}),
    };
    switch (container.kind) {
      case 'soap':
        return this.withAuth(base, container.auth, container.name, this.soapItems(container));
      case 'rest':
        return this.withAuth(
          base,
          container.auth,
          container.name,
          this.restItems(container, container, [container.name]),
        );
      case 'grpc':
        return this.withAuth(
          base,
          container.auth,
          container.name,
          this.grpcItems(container, container, [container.name]),
        );
      case 'websocket':
        return this.withAuth(
          base,
          container.auth,
          container.name,
          this.wsItems(container, container, [container.name]),
        );
    }
  }

  private withAuth(
    base: Omit<XFolder, 'items' | 'auth'>,
    auth: AuthConfig | undefined,
    label: string,
    items: XItem[],
  ): XFolder {
    const mapped = auth === undefined || auth.type === 'inherit' ? undefined : this.auth(auth, label);
    return { ...base, ...(mapped !== undefined ? { auth: mapped } : {}), items };
  }

  // --- REST ---

  private restItems(api: RestApi, node: RestApi | RestFolder, trail: readonly string[]): XItem[] {
    const folders = byOrder(node.folders).map((folder): XFolder => {
      this.folders += 1;
      const path = [...trail, folder.name];
      return this.withAuth(
        {
          kind: 'folder',
          name: folder.name,
          ...(folder.description !== undefined ? { description: folder.description } : {}),
        },
        folder.auth,
        path.join(' / '),
        this.restItems(api, folder, path),
      );
    });
    return [...folders, ...byOrder(node.requests).map((r) => this.restRequest(api, r, [...trail, r.name].join(' / ')))];
  }

  private restRequest(api: RestApi, request: RestRequestDef, label: string): XHttp {
    this.requests += 1;
    const { path, query } = splitQueryKeepingReferences(this.url(joinBase(api.baseUrl, request.url), label));
    // The URL usually repeats the table's query (composeUrl): a URL row the table holds is that row.
    const rows = [...request.query];
    const extra = query.filter((q) => {
      const index = rows.findIndex((row) => row.enabled && row.name === q.name && row.value === q.value);
      if (index === -1) return true;
      rows.splice(index, 1);
      return false;
    });
    this.lostSettings(label, request.settings, [
      'trustInvalid',
      'sslKeystoreRef',
      'bindAddress',
      'maxSizeBytes',
      'sendCookies',
      'escapeProperties',
      'keepBodyOnRedirect',
    ]);
    const { timeoutMs, followRedirects, maxRedirects, encodeUrl } = request.settings;
    return {
      kind: 'http',
      name: request.name,
      label,
      ...(request.description !== undefined ? { description: request.description } : {}),
      method: request.method,
      url: this.ctx.mustache(colonPath(path)),
      pathParams: this.rows(request.pathParams, label),
      query: this.rows([...extra, ...request.query], label),
      headers: this.rows(request.headers, label),
      body: this.body(request.body, label),
      auth: this.auth(request.auth, label),
      settings: {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(followRedirects !== undefined ? { followRedirects } : {}),
        ...(maxRedirects !== undefined ? { maxRedirects } : {}),
        ...(encodeUrl !== undefined ? { encodeUrl } : {}),
      },
      assertions: this.assertions(request.assertions),
      scripts: this.scripts(request.scripts, label),
      examples: (request.examples ?? []).map((e) => {
        const ext = exampleBodyExtension(e.contentType);
        return { ...e, bodyKind: ext === 'txt' ? 'text' : ext };
      }),
    };
  }

  private body(body: RestBody, label: string): RestBody {
    switch (body.kind) {
      case 'none':
        return body;
      case 'raw':
        return { ...body, text: this.ctx.mustache(body.text) };
      case 'form':
        return { kind: 'form', fields: this.rows(body.fields, label) };
      case 'multipart':
        return { kind: 'multipart', parts: body.parts.map((part) => this.part(part, label)) };
      case 'binary':
        return { ...body, source: this.source(body.source, label) };
    }
  }

  private part(part: MultipartFormPart, label: string): MultipartFormPart {
    if (part.kind === 'text') {
      const blanked = new Set<string>();
      const value = this.ctx.mustache(blankIfLiteral(part.name, part.value, blanked));
      this.reportBlanked(label, blanked);
      return { ...part, name: this.ctx.mustache(part.name), value };
    }
    return { ...part, name: this.ctx.mustache(part.name), source: this.source(part.source, label) };
  }

  private source(
    source: { kind: 'cache'; sha256: string } | { kind: 'path'; path: string },
    label: string,
  ): { kind: 'path'; path: string } {
    if (source.kind === 'path') return { kind: 'path', path: this.ctx.mustache(source.path) };
    this.ctx.report.warn(
      `${label}: a file kept inside the project was not exported; pick the file in the target tool.`,
    );
    return { kind: 'path', path: '' };
  }

  // --- SOAP ---

  private soapItems(iface: Interface): XItem[] {
    if (iface.endpoints.length > 1) {
      this.ctx.report.note(
        `${iface.name}: only the endpoint each request sends to was exported, not the other endpoints.`,
      );
    }
    return byOrder(iface.operations).map((operation): XFolder => {
      this.folders += 1;
      return {
        kind: 'folder',
        name: operation.name,
        items: byOrder(operation.requests).map((r) =>
          this.soapRequest(iface, r, [iface.name, operation.name, r.name].join(' / ')),
        ),
      };
    });
  }

  private soapRequest(iface: Interface, request: SoapRequestDef, label: string): XHttp {
    this.requests += 1;
    const endpoint =
      iface.endpoints.find((e) => e.id === request.endpointId) ??
      iface.endpoints.find((e) => e.id === iface.defaultEndpointId) ??
      iface.endpoints[0];
    const url = request.endpointUrl ?? endpoint?.url ?? '';
    if (url === '') this.ctx.report.warn(`${label}: the interface has no endpoint, so the request has no URL.`);

    const headers: KeyValueEntry[] = request.headers.map((h) => ({ name: h.name, value: h.value, enabled: true }));
    const action = request.properties.skipSoapAction ? undefined : request.soapAction;
    if (!hasName(headers, 'content-type')) {
      const value =
        request.soapVersion === '1.2'
          ? `application/soap+xml; charset=utf-8${action !== undefined ? `; action="${action}"` : ''}`
          : 'text/xml; charset=utf-8';
      headers.push({ name: 'Content-Type', value, enabled: true });
    }
    if (request.soapVersion === '1.1' && action !== undefined && !hasName(headers, 'soapaction')) {
      headers.push({ name: 'SOAPAction', value: `"${action}"`, enabled: true });
    }

    const lost: string[] = [];
    if (request.wsa?.enabled ?? iface.wsa.enabled) lost.push('WS-Addressing');
    if (request.wssOutgoingRef !== undefined || request.wssIncomingRef !== undefined) lost.push('WS-Security');
    if (request.attachments.length > 0) lost.push('attachments');
    if (request.properties.enableMtom || request.properties.forceMtom) lost.push('MTOM');
    if (endpoint?.trustInvalid === true) lost.push('trusting an invalid certificate');
    if (request.properties.sslKeystoreRef !== undefined) lost.push('the client keystore');
    if (lost.length > 0)
      this.ctx.report.warn(`${label}: ${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} not represented.`);

    const auth: SoapOwnerAuth | undefined = request.auth ?? endpoint?.auth;
    return {
      kind: 'http',
      name: request.name,
      label,
      ...(request.description !== undefined ? { description: request.description } : {}),
      method: 'POST',
      url: this.ctx.mustache(this.url(url, label)),
      pathParams: [],
      query: [],
      headers: this.rows(headers, label),
      body: { kind: 'raw', language: 'xml', text: this.ctx.mustache(request.envelopeXml) },
      auth: auth === undefined ? { type: 'inherit' } : this.auth(auth, label),
      settings: {
        ...(request.properties.timeoutMs !== undefined ? { timeoutMs: request.properties.timeoutMs } : {}),
        followRedirects: request.properties.followRedirects,
      },
      assertions: this.assertions(request.assertions),
      scripts: this.scripts(request.scripts, label),
      examples: [],
    };
  }

  // --- gRPC ---

  private grpcItems(api: GrpcApi, node: GrpcApi | GrpcFolder, trail: readonly string[]): XItem[] {
    const folders = byOrder(node.folders).map((folder): XFolder => {
      this.folders += 1;
      const path = [...trail, folder.name];
      return this.withAuth(
        {
          kind: 'folder',
          name: folder.name,
          ...(folder.description !== undefined ? { description: folder.description } : {}),
        },
        folder.auth,
        path.join(' / '),
        this.grpcItems(api, folder, path),
      );
    });
    return [...folders, ...byOrder(node.requests).map((r) => this.grpcRequest(api, r, [...trail, r.name].join(' / ')))];
  }

  private grpcRequest(api: GrpcApi, request: GrpcRequestDef, label: string): XGrpc {
    this.requests += 1;
    this.lostSettings(label, request.settings, [
      'trustInvalid',
      'sslKeystoreRef',
      'bindAddress',
      'maxSizeBytes',
      'escapeProperties',
    ]);
    const inherited = api.metadata.filter((row) => !hasName(request.metadata, row.name));
    if (inherited.length > 0) this.ctx.report.note(`${label}: the API's metadata was added to the request.`);
    return {
      kind: 'grpc',
      name: request.name,
      label,
      ...(request.description !== undefined ? { description: request.description } : {}),
      url: `${api.tls ? 'grpcs' : 'grpc'}://${this.ctx.mustache(api.target)}`,
      service: request.service,
      method: request.method,
      methodKind: request.methodKind,
      message: this.ctx.mustache(request.message),
      metadata: this.rows([...request.metadata, ...inherited], label),
      auth: this.auth(request.auth, label),
      ...(request.settings.timeoutMs !== undefined ? { timeoutMs: request.settings.timeoutMs } : {}),
      assertions: this.assertions(request.assertions ?? []),
      scripts: this.scripts(request.scripts, label),
    };
  }

  // --- WebSocket ---

  private wsItems(api: WsApi, node: WsApi | WsFolder, trail: readonly string[]): XItem[] {
    const folders = byOrder(node.folders).map((folder): XFolder => {
      this.folders += 1;
      const path = [...trail, folder.name];
      return this.withAuth(
        {
          kind: 'folder',
          name: folder.name,
          ...(folder.description !== undefined ? { description: folder.description } : {}),
        },
        folder.auth,
        path.join(' / '),
        this.wsItems(api, folder, path),
      );
    });
    return [...folders, ...byOrder(node.requests).map((r) => this.wsRequest(api, r, [...trail, r.name].join(' / ')))];
  }

  private wsRequest(api: WsApi, request: WsRequestDef, label: string): XWebSocket {
    this.requests += 1;
    this.lostSettings(label, request.settings, [
      'trustInvalid',
      'sslKeystoreRef',
      'bindAddress',
      'maxMessageBytes',
      'escapeProperties',
    ]);
    if (request.subprotocols.length > 0) this.ctx.report.warn(`${label}: its subprotocols are not represented.`);
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(request.url);
    const joined = absolute ? request.url : request.url === '' ? api.url : joinBase(api.url, request.url);
    const { path, query } = splitQueryKeepingReferences(this.url(joined, label));
    const inherited = api.headers.filter((row) => !hasName(request.headers, row.name));
    if (inherited.length > 0) this.ctx.report.note(`${label}: the API's headers were added to the request.`);
    const text = request.messages.filter((m) => m.format === 'text');
    if (text.length < request.messages.length) {
      this.ctx.report.warn(`${label}: binary saved messages are not represented.`);
    }
    return {
      kind: 'websocket',
      name: request.name,
      label,
      ...(request.description !== undefined ? { description: request.description } : {}),
      url: this.ctx.mustache(path),
      query: this.rows([...query, ...request.query], label),
      headers: this.rows([...request.headers, ...inherited], label),
      auth: this.auth(request.auth, label),
      messages: text.map((m) => this.ctx.mustache(m.content)),
      ...(request.settings.handshakeTimeoutMs !== undefined ? { timeoutMs: request.settings.handshakeTimeoutMs } : {}),
      assertions: this.assertions(request.assertions),
    };
  }

  // --- shared ---

  /** The assertions with the references in their expected values rewritten. */
  private assertions(list: readonly Assertion[]): Assertion[] {
    const m = (text: string): string => this.ctx.mustache(text);
    return list.map((a) => {
      if (a.type === 'status') {
        const each = (v: number | string): number | string => (typeof v === 'string' ? m(v) : v);
        const equals: StatusAssertion['equals'] = Array.isArray(a.equals)
          ? (a.equals as readonly (number | string)[]).map(each)
          : typeof a.equals === 'string'
            ? m(a.equals)
            : a.equals;
        return { ...a, equals };
      }
      if (a.type === 'match') {
        return {
          ...a,
          ...(typeof a.equals === 'string' ? { equals: m(a.equals) } : {}),
          ...(a.matches !== undefined ? { matches: m(a.matches) } : {}),
        };
      }
      return a;
    });
  }

  /**
   * The rows with their text rewritten, and the plain-text value of each one whose name looks
   * like a credential blanked, by the rule the importers apply (`blankIfLiteral`).
   */
  private rows(rows: readonly KeyValueEntry[], label: string): KeyValueEntry[] {
    const blanked = new Set<string>();
    const out = rows.map((row) => ({
      ...row,
      name: this.ctx.mustache(row.name),
      value: this.ctx.mustache(blankIfLiteral(row.name, row.value, blanked)),
    }));
    this.reportBlanked(label, blanked);
    return out;
  }

  /** `url` without literal user info and with the plain-text credentials of its query blanked. */
  private url(url: string, label: string): string {
    const blanked = new Set<string>();
    const cleaned = blankUrlCredentials(url, blanked);
    if (cleaned.stripped) {
      this.ctx.report.warn(
        `${label}: the user name and password in the URL were not exported; set them in the target tool.`,
      );
    }
    this.reportBlanked(label, blanked);
    return cleaned.url;
  }

  private reportBlanked(label: string, blanked: ReadonlySet<string>): void {
    if (blanked.size > 0) {
      const names = [...blanked].join(', ');
      this.ctx.report.warn(
        blanked.size === 1
          ? `${label}: the plain-text value of ${names} was not exported; set it in the target tool.`
          : `${label}: the plain-text values of ${names} were not exported; set them in the target tool.`,
      );
    }
  }

  private lostSettings(label: string, settings: object, keys: readonly string[]): void {
    const set = keys.filter((key) => {
      const value = (settings as Record<string, unknown>)[key];
      return value !== undefined && value !== false;
    });
    if (set.length > 0) this.ctx.report.warn(`${label}: the settings ${set.join(', ')} are not represented.`);
  }

  private scripts(scripts: RequestScripts | undefined, label: string): XScripts {
    if (scripts === undefined) return {};
    const out: { pre?: string; post?: string } = {};
    for (const phase of ['pre', 'post'] as const) {
      const source = scripts[phase];
      if (source === undefined) continue;
      if (source.problem !== undefined) {
        this.ctx.report.warn(
          `${label}: its ${phase === 'pre' ? 'pre-request' : 'post-response'} script file is missing and was not exported.`,
        );
        continue;
      }
      out[phase] = source.text;
    }
    if (out.pre === undefined && out.post === undefined) return out;
    if (scripts.api === 'wirebench') {
      this.ctx.report.warn(`${label}: its scripts use Wirebench's script API; the target tool will not run them.`);
    }
    if (!scripts.enabled) {
      this.ctx.report.note(`${label}: its scripts were switched off in Wirebench; the target tool runs them.`);
    }
    return out;
  }

  /** `auth` with every credential field dropped and its text rewritten; Kerberos becomes no auth. */
  private auth(auth: AuthConfig, label: string): AuthConfig {
    const m = (text: string): string => this.ctx.mustache(text);
    const opt = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
      value !== undefined ? ({ [key]: m(value) } as Record<K, string>) : {};
    const credential = (...refs: (string | undefined)[]): void => {
      if (refs.some((ref) => ref !== undefined && ref !== '')) {
        this.ctx.report.warn(`${label}: the ${auth.type} credential was not exported; re-enter it in the target tool.`);
      }
    };
    switch (auth.type) {
      case 'inherit':
      case 'none':
        return { type: auth.type };
      case 'basic':
      case 'ntlm':
        credential(auth.passwordRef, auth.passwordEnv);
        return {
          type: auth.type,
          ...opt('username', auth.username),
          ...opt('domain', auth.domain),
          ...(auth.type === 'ntlm' ? opt('workstation', auth.workstation) : {}),
          ...(auth.preemptive !== undefined ? { preemptive: auth.preemptive } : {}),
        };
      case 'bearer':
        credential(auth.tokenRef, auth.tokenEnv);
        if (auth.scheme !== undefined && auth.scheme !== '' && auth.scheme.toLowerCase() !== 'bearer') {
          this.ctx.report.warn(`${label}: the token scheme "${auth.scheme}" is not represented; Bearer is written.`);
        }
        return { type: 'bearer' };
      case 'api-key':
        credential(auth.valueRef, auth.valueEnv);
        return { type: 'api-key', name: m(auth.name), in: auth.in };
      case 'oauth2':
        credential(auth.clientSecretRef, auth.clientSecretEnv, auth.refreshTokenRef);
        if (auth.audience !== undefined && auth.audience !== '') {
          this.ctx.report.warn(`${label}: the OAuth 2 audience is not represented.`);
        }
        return {
          type: 'oauth2',
          grant: auth.grant,
          tokenUrl: m(this.url(auth.tokenUrl, label)),
          ...opt(
            'authorizationUrl',
            auth.authorizationUrl !== undefined ? this.url(auth.authorizationUrl, label) : undefined,
          ),
          clientId: m(auth.clientId),
          scopes: auth.scopes,
          clientAuth: auth.clientAuth,
          pkce: auth.pkce,
        };
      case 'kerberos':
        this.ctx.report.warn(`${label}: Kerberos authentication is not represented and was written as no auth.`);
        return { type: 'none' };
    }
  }
}

/** The kinds the export writes; any other kind's containers are reported as left out. */
const EXPORTED_KINDS: ReadonlySet<string> = new Set(['soap', 'rest', 'grpc', 'websocket']);

/** Every container of the project, in the order the explorer shows them. */
function containersOf(project: Project): Container[] {
  return byOrder<Container>([
    ...soapInterfacesOf(project),
    ...restApisOf(project),
    ...grpcApisOf(project),
    ...wsApisOf(project),
  ]);
}
