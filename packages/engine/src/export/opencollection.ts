/**
 * The tree as one OpenCollection 1.0 YAML document (spec §3.3): the collection, its variables and
 * its environments together. Written to be read back by this build's own importer.
 */

import { stringify } from 'yaml';
import type { Assertion } from '../assert/model.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { AuthConfig } from '../project/model.js';
import type { CollectionExportFile } from './model.js';
import type { WrittenFiles } from './postman.js';
import type { ExportContext } from './shared.js';
import { uniqueFileStem } from './shared.js';
import type { XBody, XCollection, XFolder, XGrpc, XHttp, XItem, XScripts, XVariable, XWebSocket } from './tree.js';

type Json = Record<string, unknown>;

const optional = (key: string, value: unknown): Json =>
  value === undefined || value === '' || (Array.isArray(value) && value.length === 0) ? {} : { [key]: value };

/** `$.a.b[0]`: a JSON path the importer reads back as `res.body.a.b[0]`. */
const JSON_PATH = /^\$((?:\.[\w$]+)(?:\.[\w$]+|\[\d+\])*)$/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;
/** Text the importer reads back as a number or a boolean rather than as the text it is. */
const READS_AS_SCALAR = /^(?:true|false|-?\d+(?:\.\d+)?)$/;

export function writeOpenCollection(tree: XCollection, ctx: ExportContext): WrittenFiles {
  const writer = new OcWriter(ctx);
  const items = writer.items(tree.items);
  writer.reportProtos();
  const rootRequest: Json = {
    ...optional('auth', tree.auth !== undefined ? writer.auth(tree.auth, tree.name) : undefined),
    ...optional('variables', tree.variables.map(variable)),
  };
  const doc: Json = {
    opencollection: '1.0.0',
    info: { name: tree.name, ...optional('description', tree.description) },
    ...(tree.environments.length > 0
      ? {
          config: {
            environments: tree.environments.map((e) => ({ name: e.name, variables: e.variables.map(variable) })),
          },
        }
      : {}),
    ...(Object.keys(rootRequest).length > 0 ? { request: rootRequest } : {}),
    items,
  };
  const file: CollectionExportFile = {
    name: `${uniqueFileStem(tree.name, new Set())}.opencollection.yml`,
    text: stringify(doc, { lineWidth: 0 }),
  };
  return { files: [file], requests: writer.requests, folders: writer.folders };
}

function variable(v: XVariable): Json {
  return {
    name: v.name,
    ...(v.secret ? { secret: true } : { value: v.value }),
    ...(v.enabled ? {} : { disabled: true }),
  };
}

function rows(list: readonly KeyValueEntry[], extra: Json = {}): Json[] {
  return list.map((row) => ({
    name: row.name,
    value: row.value,
    ...extra,
    ...(row.enabled ? {} : { disabled: true }),
  }));
}

/** The text a regular expression matches literally, when it is nothing but an escaped literal. */
function literalOf(pattern: string): string | undefined {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[i + 1];
      if (next === undefined || !REGEX_SPECIAL.test(next)) return undefined;
      out += next;
      i += 1;
    } else if (REGEX_SPECIAL.test(c)) {
      return undefined;
    } else {
      out += c;
    }
  }
  return out;
}

/** The OpenCollection assertion for `a`, or undefined when it has none. */
export function ocAssertion(a: Assertion): Json | undefined {
  switch (a.type) {
    case 'status':
      return typeof a.equals === 'number'
        ? { expression: 'res.status', operator: 'eq', value: String(a.equals) }
        : undefined;
    case 'sla':
      return { expression: 'res.responseTime', operator: 'lt', value: String(a.maxMs) };
    case 'match': {
      if (a.language !== 'jsonpath') return undefined;
      const path = JSON_PATH.exec(a.expression)?.[1];
      if (path === undefined) return undefined;
      const expression = `res.body${path}`;
      // One OpenCollection assertion checks one thing: a match asking for more is not represented.
      if ([a.equals, a.exists, a.matches].filter((v) => v !== undefined).length > 1) return undefined;
      if (typeof a.equals === 'string' && READS_AS_SCALAR.test(a.equals)) return undefined;
      if (a.equals !== undefined) return { expression, operator: 'eq', value: String(a.equals) };
      if (a.exists !== undefined) return { expression, operator: a.exists ? 'isNotNull' : 'isNull' };
      if (a.matches !== undefined) {
        const literal = literalOf(a.matches);
        return literal !== undefined ? { expression, operator: 'contains', value: literal } : undefined;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

class OcWriter {
  requests = 0;
  folders = 0;
  /** The containers whose gRPC requests need a `.proto` the export does not carry. */
  private readonly protos = new Set<string>();

  constructor(private readonly ctx: ExportContext) {}

  items(items: readonly XItem[]): Json[] {
    return items.map((item, index) => {
      const seq = index + 1;
      switch (item.kind) {
        case 'folder':
          return this.folder(item, seq);
        case 'http':
          return this.http(item, seq);
        case 'grpc':
          return this.grpc(item, seq);
        case 'websocket':
          return this.websocket(item, seq);
      }
    });
  }

  reportProtos(): void {
    for (const owner of this.protos) {
      this.ctx.report.note(`${owner}: the .proto definition is not exported; import it beside the collection.`);
    }
  }

  private folder(folder: XFolder, seq: number): Json {
    this.folders += 1;
    const auth = folder.auth !== undefined ? this.auth(folder.auth, folder.name) : undefined;
    return {
      info: { name: folder.name, type: 'folder', seq, ...optional('description', folder.description) },
      ...(auth !== undefined ? { request: { auth } } : {}),
      items: this.items(folder.items),
    };
  }

  private runtime(label: string, assertions: readonly Assertion[], scripts: XScripts, mapAssertions: boolean): Json {
    const mapped: Json[] = [];
    let lost = 0;
    for (const a of assertions) {
      const oc = mapAssertions ? ocAssertion(a) : undefined;
      if (oc !== undefined) mapped.push(oc);
      else lost += 1;
    }
    if (lost > 0) this.ctx.report.warn(`${label}: ${lost} assertion(s) are not represented.`);
    const code = [
      ...(scripts.pre !== undefined ? [{ type: 'before-request', code: scripts.pre }] : []),
      ...(scripts.post !== undefined ? [{ type: 'after-response', code: scripts.post }] : []),
    ];
    const runtime = { ...optional('assertions', mapped), ...optional('scripts', code) };
    return Object.keys(runtime).length > 0 ? { runtime } : {};
  }

  private http(http: XHttp, seq: number): Json {
    this.requests += 1;
    const headers = [...http.headers];
    const body = this.body(http.body, headers, http.label);
    const auth = this.auth(http.auth, http.label);
    const { timeoutMs, followRedirects, maxRedirects, encodeUrl } = http.settings;
    const settings: Json = {
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      ...(followRedirects !== undefined ? { followRedirects } : {}),
      ...(maxRedirects !== undefined ? { maxRedirects } : {}),
      ...(encodeUrl !== undefined ? { encodeUrl } : {}),
    };
    return {
      info: { name: http.name, type: 'http', seq, ...optional('description', http.description) },
      http: {
        method: http.method,
        url: http.url,
        ...optional('params', [...rows(http.query, { type: 'query' }), ...rows(http.pathParams, { type: 'path' })]),
        ...optional('headers', rows(headers)),
        ...optional('body', body),
        ...optional('auth', auth),
      },
      ...this.runtime(http.label, http.assertions, http.scripts, true),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...optional(
        'examples',
        http.examples.map((e) => ({
          name: e.name,
          response: {
            status: e.status,
            statusText: e.statusText,
            ...optional(
              'headers',
              e.headers.map((h) => ({ name: h.name, value: h.value })),
            ),
            ...(e.body !== undefined ? { body: { type: e.bodyKind, data: e.body } } : {}),
          },
        })),
      ),
    };
  }

  private grpc(grpc: XGrpc, seq: number): Json {
    this.requests += 1;
    this.protos.add(grpc.label.split(' / ')[0]!);
    return {
      info: { name: grpc.name, type: 'grpc', seq, ...optional('description', grpc.description) },
      grpc: {
        url: grpc.url,
        method: `/${grpc.service}/${grpc.method}`,
        methodType: grpc.methodKind,
        message: grpc.message,
        ...optional('metadata', rows(grpc.metadata)),
        ...optional('auth', this.auth(grpc.auth, grpc.label)),
      },
      ...this.runtime(grpc.label, grpc.assertions, grpc.scripts, false),
      ...(grpc.timeoutMs !== undefined ? { settings: { timeout: grpc.timeoutMs } } : {}),
    };
  }

  private websocket(ws: XWebSocket, seq: number): Json {
    this.requests += 1;
    if (ws.query.some((q) => !q.enabled))
      this.ctx.report.warn(`${ws.label}: switched-off query rows are not represented.`);
    if (ws.messages.length > 1) this.ctx.report.warn(`${ws.label}: only the first saved message was exported.`);
    const search = ws.query
      .filter((q) => q.enabled)
      .map((q) => (q.value === '' ? q.name : `${q.name}=${q.value}`))
      .join('&');
    const first = ws.messages[0];
    return {
      info: { name: ws.name, type: 'websocket', seq, ...optional('description', ws.description) },
      websocket: {
        url: search === '' ? ws.url : `${ws.url}?${search}`,
        ...optional('headers', rows(ws.headers)),
        ...optional('auth', this.auth(ws.auth, ws.label)),
        ...(first !== undefined ? { message: { type: 'text', data: first } } : {}),
      },
      ...this.runtime(ws.label, ws.assertions, {}, false),
      ...(ws.timeoutMs !== undefined ? { settings: { timeout: ws.timeoutMs } } : {}),
    };
  }

  private body(body: XBody, headers: KeyValueEntry[], label: string): Json | undefined {
    const ensureType = (type: string | undefined): void => {
      if (type === undefined || headers.some((h) => h.name.toLowerCase() === 'content-type')) return;
      headers.push({ name: 'Content-Type', value: type, enabled: true });
      this.ctx.report.note(`${label}: its body's content type was written as a Content-Type header.`);
    };
    switch (body.kind) {
      case 'none':
        return undefined;
      case 'raw': {
        ensureType(body.contentType);
        if (body.language === 'html' || body.language === 'javascript') {
          this.ctx.report.note(`${label}: its ${body.language} body was written as text.`);
          ensureType(body.language === 'html' ? 'text/html' : 'application/javascript');
          return { type: 'text', data: body.text };
        }
        return { type: body.language, data: body.text };
      }
      case 'form':
        return { type: 'form-urlencoded', data: rows(body.fields) };
      case 'multipart':
        return {
          type: 'multipart-form',
          data: body.parts.map((part) => {
            if (part.kind === 'file' && part.fileName !== undefined) {
              this.ctx.report.warn(`${label}: the file name of part "${part.name}" is not represented.`);
            }
            return {
              name: part.name,
              type: part.kind,
              value: part.kind === 'text' ? part.value : part.source.kind === 'path' ? part.source.path : '',
              ...optional('contentType', part.contentType),
              ...(part.enabled ? {} : { disabled: true }),
            };
          }),
        };
      case 'binary':
        return {
          type: 'file',
          data: [
            {
              filePath: body.source.kind === 'path' ? body.source.path : '',
              contentType: body.contentType,
              selected: true,
            },
          ],
        };
    }
  }

  /** Undefined for `inherit`, which is what an absent `auth` means. */
  auth(auth: AuthConfig, label: string): Json | string | undefined {
    switch (auth.type) {
      case 'inherit':
        return undefined;
      case 'none':
      case 'kerberos':
        return 'none';
      case 'basic':
        return { type: 'basic', ...optional('username', auth.username) };
      case 'ntlm':
        if (auth.workstation !== undefined && auth.workstation !== '') {
          this.ctx.report.warn(`${label}: the NTLM workstation is not represented.`);
        }
        return { type: 'ntlm', ...optional('username', auth.username), ...optional('domain', auth.domain) };
      case 'bearer':
        return { type: 'bearer' };
      case 'api-key':
        return { type: 'apikey', key: auth.name, placement: auth.in };
      case 'oauth2':
        return {
          type: 'oauth2',
          flow: auth.grant === 'client-credentials' ? 'client_credentials' : 'authorization_code',
          accessTokenUrl: auth.tokenUrl,
          ...(auth.grant === 'authorization-code' ? optional('authorizationUrl', auth.authorizationUrl) : {}),
          credentials: {
            clientId: auth.clientId,
            placement: auth.clientAuth === 'body' ? 'body' : 'basic_auth_header',
          },
          ...optional('scope', auth.scopes.join(' ')),
          ...(auth.grant === 'authorization-code' ? { pkce: { disabled: !auth.pkce } } : {}),
        };
    }
  }
}
