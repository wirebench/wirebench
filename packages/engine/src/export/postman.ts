/**
 * The tree as a Postman Collection v2.1 and one environment file per environment (spec §3.2).
 * gRPC and WebSocket requests have no place in v2.1 and are left out; so are declarative
 * assertions, which the format has no field for.
 */

import { ExportError } from '../errors.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { AuthConfig } from '../project/model.js';
import type { CollectionExportFile } from './model.js';
import type { ExportContext } from './shared.js';
import { uniqueFileStem } from './shared.js';
import type { XBody, XCollection, XFolder, XHttp, XItem, XScripts, XVariable } from './tree.js';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

type Json = Record<string, unknown>;

const optional = (key: string, value: unknown): Json => (value === undefined || value === '' ? {} : { [key]: value });

export interface WrittenFiles {
  readonly files: CollectionExportFile[];
  readonly requests: number;
  readonly folders: number;
}

export function writePostman(tree: XCollection, ctx: ExportContext, newId: () => string): WrittenFiles {
  const writer = new PostmanWriter(ctx);
  const items = writer.items(tree.items);
  writer.reportLeftOut();
  if (writer.requests === 0) {
    throw new ExportError('export-nothing', 'Nothing in it can be written as a Postman collection.');
  }
  const collection: Json = {
    info: { _postman_id: newId(), name: tree.name, ...optional('description', tree.description), schema: SCHEMA },
    item: items,
    ...optional('auth', tree.auth !== undefined ? writer.auth(tree.auth) : undefined),
    ...optional('variable', tree.variables.length > 0 ? tree.variables.map(variable) : undefined),
  };
  const taken = new Set<string>();
  const files: CollectionExportFile[] = [
    { name: `${uniqueFileStem(tree.name, taken)}.postman_collection.json`, text: json(collection) },
  ];
  for (const env of tree.environments) {
    files.push({
      name: `${uniqueFileStem(env.name, taken)}.postman_environment.json`,
      text: json({
        id: newId(),
        name: env.name,
        values: env.variables.map((v) => ({
          key: v.name,
          value: v.value,
          type: v.secret ? 'secret' : 'default',
          enabled: v.enabled,
        })),
        _postman_variable_scope: 'environment',
      }),
    });
  }
  return { files, requests: writer.requests, folders: writer.folders };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function variable(v: XVariable): Json {
  return {
    key: v.name,
    value: v.value,
    type: v.secret ? 'secret' : 'string',
    ...(v.enabled ? {} : { disabled: true }),
  };
}

function pairs(rows: readonly KeyValueEntry[]): Json[] {
  return rows.map((row) => ({
    key: row.name,
    value: row.value,
    ...optional('description', row.description),
    ...(row.enabled ? {} : { disabled: true }),
  }));
}

/** Postman's split of a URL: `protocol`, `host` by dots, `port` and `path` by slashes. */
function urlParts(url: string): Json {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  const rest = scheme !== null ? url.slice(scheme[0].length) : url;
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);
  const port = /:(\d+)$/.exec(authority);
  const host = port !== null ? authority.slice(0, port.index) : authority;
  return {
    ...(scheme !== null ? { protocol: scheme[1] } : {}),
    ...(host !== '' ? { host: host.includes('{{') ? [host] : host.split('.') } : {}),
    ...(port !== null ? { port: port[1] } : {}),
    ...(path !== '' ? { path: path.split('/') } : {}),
  };
}

class PostmanWriter {
  requests = 0;
  folders = 0;
  /** Containers with gRPC or WebSocket requests, by the first segment of their labels. */
  private readonly leftOut = new Map<string, Set<string>>();

  constructor(private readonly ctx: ExportContext) {}

  items(items: readonly XItem[]): Json[] {
    const out: Json[] = [];
    for (const item of items) {
      if (item.kind === 'folder') {
        const folder = this.folder(item);
        if (folder !== undefined) out.push(folder);
      } else if (item.kind === 'http') {
        out.push(this.request(item));
      } else {
        const owner = item.label.split(' / ')[0]!;
        const kinds = this.leftOut.get(owner) ?? new Set<string>();
        kinds.add(item.kind === 'grpc' ? 'gRPC' : 'WebSocket');
        this.leftOut.set(owner, kinds);
      }
    }
    return out;
  }

  reportLeftOut(): void {
    for (const [owner, kinds] of this.leftOut) {
      this.ctx.report.warn(
        `${owner}: ${[...kinds].join(' and ')} requests are not represented by Postman Collection v2.1 and were left out.`,
      );
    }
  }

  private folder(folder: XFolder): Json | undefined {
    const item = this.items(folder.items);
    // A folder that only held what v2.1 cannot carry is left out with it.
    if (item.length === 0 && folder.items.length > 0) return undefined;
    this.folders += 1;
    return {
      name: folder.name,
      ...optional('description', folder.description),
      item,
      ...optional('auth', folder.auth !== undefined ? this.auth(folder.auth) : undefined),
    };
  }

  private request(http: XHttp): Json {
    this.requests += 1;
    const headers = [...http.headers];
    const body = this.body(http.body, headers, http.label);
    const enabledQuery = http.query.filter((q) => q.enabled);
    const search = enabledQuery.map((q) => (q.value === '' ? q.name : `${q.name}=${q.value}`)).join('&');
    if (http.assertions.length > 0) {
      this.ctx.report.warn(`${http.label}: ${http.assertions.length} assertion(s) are not represented.`);
    }
    if (http.settings.timeoutMs !== undefined) {
      this.ctx.report.warn(`${http.label}: the timeout is not represented.`);
    }
    const behavior: Json = {
      ...(http.settings.followRedirects !== undefined ? { followRedirects: http.settings.followRedirects } : {}),
      ...(http.settings.maxRedirects !== undefined ? { maxRedirects: http.settings.maxRedirects } : {}),
      ...(http.settings.encodeUrl !== undefined ? { disableUrlEncoding: !http.settings.encodeUrl } : {}),
    };
    const auth = http.auth.type === 'inherit' ? undefined : this.auth(http.auth);
    return {
      name: http.name,
      ...optional('event', events(http.scripts)),
      ...(Object.keys(behavior).length > 0 ? { protocolProfileBehavior: behavior } : {}),
      request: {
        method: http.method,
        header: pairs(headers),
        ...optional('body', body),
        url: {
          raw: search === '' ? http.url : `${http.url}?${search}`,
          ...urlParts(http.url),
          ...(http.query.length > 0 ? { query: pairs(http.query) } : {}),
          ...(http.pathParams.length > 0 ? { variable: pairs(http.pathParams) } : {}),
        },
        ...optional('auth', auth),
        ...optional('description', http.description),
      },
      ...(http.examples.length > 0
        ? {
            response: http.examples.map((e) => ({
              name: e.name,
              status: e.statusText,
              code: e.status,
              header: e.headers.map((h) => ({ key: h.name, value: h.value })),
              ...optional('body', e.body),
            })),
          }
        : {}),
    };
  }

  /** The body; a content type the body names but no header sets is added as a header (`headers` grows). */
  private body(body: XBody, headers: KeyValueEntry[], label: string): Json | undefined {
    const ensureType = (type: string | undefined): void => {
      if (type === undefined || headers.some((h) => h.name.toLowerCase() === 'content-type')) return;
      headers.push({ name: 'Content-Type', value: type, enabled: true });
      this.ctx.report.note(`${label}: its body's content type was written as a Content-Type header.`);
    };
    switch (body.kind) {
      case 'none':
        return undefined;
      case 'raw':
        ensureType(body.contentType);
        return { mode: 'raw', raw: body.text, options: { raw: { language: body.language } } };
      case 'form':
        return { mode: 'urlencoded', urlencoded: pairs(body.fields) };
      case 'multipart':
        return {
          mode: 'formdata',
          formdata: body.parts.map((part) => {
            const common = {
              key: part.name,
              ...optional('contentType', part.contentType),
              ...(part.enabled ? {} : { disabled: true }),
            };
            if (part.kind === 'text') return { ...common, type: 'text', value: part.value };
            if (part.fileName !== undefined)
              this.ctx.report.warn(`${label}: the file name of part "${part.name}" is not represented.`);
            return { ...common, type: 'file', src: part.source.kind === 'path' ? part.source.path : '' };
          }),
        };
      case 'binary':
        ensureType(body.contentType);
        return { mode: 'file', file: { src: body.source.kind === 'path' ? body.source.path : '' } };
    }
  }

  auth(auth: AuthConfig): Json {
    const attrs = (entries: Record<string, unknown>): Json[] =>
      Object.entries(entries)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({ key, value, type: typeof value === 'boolean' ? 'boolean' : 'string' }));
    switch (auth.type) {
      case 'inherit':
      case 'none':
      case 'kerberos':
        return { type: 'noauth' };
      case 'basic':
        return { type: 'basic', basic: attrs({ username: auth.username ?? '', password: '' }) };
      case 'ntlm':
        return {
          type: 'ntlm',
          ntlm: attrs({
            username: auth.username ?? '',
            password: '',
            domain: auth.domain,
            workstation: auth.workstation,
          }),
        };
      case 'bearer':
        return { type: 'bearer', bearer: attrs({ token: '' }) };
      case 'api-key':
        return { type: 'apikey', apikey: attrs({ key: auth.name, value: '', in: auth.in }) };
      case 'oauth2': {
        const grant =
          auth.grant === 'client-credentials'
            ? 'client_credentials'
            : auth.pkce
              ? 'authorization_code_with_pkce'
              : 'authorization_code';
        return {
          type: 'oauth2',
          oauth2: attrs({
            grant_type: grant,
            accessTokenUrl: auth.tokenUrl,
            authUrl: auth.authorizationUrl,
            clientId: auth.clientId,
            clientSecret: '',
            scope: auth.scopes.join(' '),
            client_authentication: auth.clientAuth === 'body' ? 'body' : 'header',
            addTokenTo: 'header',
          }),
        };
      }
    }
  }
}

function events(scripts: XScripts): Json[] | undefined {
  const out: Json[] = [];
  const add = (listen: string, text: string | undefined): void => {
    if (text !== undefined) out.push({ listen, script: { type: 'text/javascript', exec: text.split('\n') } });
  };
  add('prerequest', scripts.pre);
  add('test', scripts.post);
  return out.length > 0 ? out : undefined;
}
