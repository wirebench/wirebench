/**
 * An Insomnia workspace's HTTP requests written as the v2.1 collection document they mean (spec
 * 2026-10-15 §4.2), so they go through the same parser and mapper as an exported v2.1 collection.
 * Templates are rewritten to `{{name}}` here, by the Insomnia dialect. The one `event` this document
 * carries is Insomnia's own scripts, which the mapper attaches switched off. What the v2.1 document
 * cannot say is reported.
 */

import { V21_SCHEMA } from '../collection-v3/convert.js';
import type { ReportBuilder } from '../report.js';
import type {
  InsBody,
  InsFolder,
  InsHttp,
  InsNode,
  InsOtherSetting,
  InsRec,
  InsRow,
  InsScripts,
  InsWorkspace,
} from './model.js';

type Json = Record<string, unknown>;

/** A script pair as v2.1 `event` entries: `prerequest` first, then `test` (the after-response script). */
function eventsOf(scripts: InsScripts | undefined): { event: Json[] } | Record<string, never> {
  if (scripts === undefined) return {};
  const event: Json[] = [];
  if (scripts.pre.trim() !== '')
    event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: scripts.pre } });
  if (scripts.post.trim() !== '')
    event.push({ listen: 'test', script: { type: 'text/javascript', exec: scripts.post } });
  return event.length > 0 ? { event } : {};
}

/** Rewrites one value's templates, adding each construct it keeps as written to `kept`. */
export type InsomniaDialect = (text: string, kept: Set<string>) => string;

export interface InsomniaConvertContext {
  readonly report: ReportBuilder;
  readonly dialect: InsomniaDialect;
  /** Each construct kept as written, with the labels of the items using it. */
  readonly kept: Map<string, string[]>;
  /** Prefixes every label, so two workspaces' items stay apart in the report. */
  readonly labelPrefix: string;
}

const OTHER_SETTINGS: Readonly<Record<InsOtherSetting, string>> = {
  'send-cookies-off': 'not sending cookies',
  'store-cookies-off': 'not storing cookies',
  'render-off': 'sending the body without rendering its templates',
  'rebuild-path-off': 'not normalising the URL path',
};

/** The v2.1 language a raw body of this content type is written as. */
function rawLanguage(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('xml')) return 'xml';
  if (type.includes('html')) return 'html';
  if (type.includes('javascript')) return 'javascript';
  return 'text';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** One item's template rewriting, recording what it kept under the item's label. */
export class ItemTemplates {
  private readonly seen = new Set<string>();

  constructor(
    private readonly context: Pick<InsomniaConvertContext, 'dialect' | 'kept'>,
    private readonly label: string,
  ) {}

  readonly t = (value: string): string => this.context.dialect(value, this.seen);

  done(): void {
    for (const construct of this.seen) {
      const users = this.context.kept.get(construct) ?? [];
      if (!users.includes(this.label)) users.push(this.label);
      this.context.kept.set(construct, users);
    }
  }
}

function keyValues(rows: readonly InsRow[], t: (value: string) => string): Json[] {
  return rows.map((row) => ({
    key: t(row.name),
    value: t(row.value),
    ...(row.description !== undefined ? { description: row.description } : {}),
    ...(row.disabled ? { disabled: true } : {}),
  }));
}

/** A URL split at its query: the query string's pairs as rows, values as written. */
export function inlineQuery(url: string): { base: string; rows: InsRow[] } {
  const at = url.indexOf('?');
  if (at < 0) return { base: url, rows: [] };
  const hash = url.indexOf('#', at);
  const query = url.slice(at + 1, hash < 0 ? undefined : hash);
  const rows = query
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair): InsRow => {
      const eq = pair.indexOf('=');
      return eq < 0
        ? { name: pair, value: '', disabled: false }
        : { name: pair.slice(0, eq), value: pair.slice(eq + 1), disabled: false };
    });
  return { base: url.slice(0, at) + (hash < 0 ? '' : url.slice(hash)), rows };
}

/**
 * An Insomnia auth as the v2.1 `{type, <type>: [{key, value}]}`, or `undefined` to inherit. Values
 * go through untouched (templates aside), so the shared mapper drops and warns about literal
 * credentials as it does for any collection.
 */
export function v21AuthOf(
  auth: InsRec | undefined,
  t: (value: string) => string,
  label: string,
  report: ReportBuilder,
): Json | undefined {
  if (auth === undefined) return undefined;
  const type = str(auth['type']);
  const attrs = (pairs: Record<string, unknown>): Json[] =>
    Object.entries(pairs)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => ({ key, value: typeof value === 'string' ? t(value) : value }));
  switch (type) {
    case 'none':
      return { type: 'noauth' };
    case 'basic':
      return { type: 'basic', basic: attrs({ username: auth['username'], password: auth['password'] }) };
    case 'bearer': {
      const prefix = str(auth['prefix']);
      if (prefix === 'NO_PREFIX') {
        // The token is the whole header value: an API key named Authorization sends just that.
        report.note(
          `${label}: its token is sent with no prefix, so it was imported as an API key named Authorization.`,
        );
        return { type: 'apikey', apikey: attrs({ key: 'Authorization', value: auth['token'], in: 'header' }) };
      }
      return {
        type: 'bearer',
        bearer: attrs({
          token: auth['token'],
          ...(prefix !== '' && prefix.toLowerCase() !== 'bearer' ? { scheme: prefix } : {}),
        }),
      };
    }
    case 'digest':
    case 'ntlm':
      return { type, [type]: attrs({ username: auth['username'], password: auth['password'] }) };
    case 'apikey': {
      const addTo = str(auth['addTo']);
      if (addTo === 'cookie') {
        report.warn(`${label}: its API key goes in a cookie, which Wirebench API-key auth does not do; set to "none".`);
        return { type: 'noauth' };
      }
      return {
        type: 'apikey',
        apikey: attrs({ key: auth['key'], value: auth['value'], in: addTo === 'queryParams' ? 'query' : 'header' }),
      };
    }
    case 'oauth2': {
      const grant = str(auth['grantType']);
      const v21Grant =
        grant === 'authorization_code' || grant === ''
          ? auth['usePkce'] === true
            ? 'authorization_code_with_pkce'
            : 'authorization_code'
          : grant === 'password'
            ? 'password_credentials'
            : grant;
      return {
        type: 'oauth2',
        oauth2: attrs({
          grant_type: v21Grant,
          accessTokenUrl: auth['accessTokenUrl'],
          authUrl: auth['authorizationUrl'],
          clientId: auth['clientId'],
          clientSecret: auth['clientSecret'],
          scope: auth['scope'],
          username: auth['username'],
          password: auth['password'],
          client_authentication: auth['credentialsInBody'] === true ? 'body' : 'header',
        }),
      };
    }
    case 'iam':
      return {
        type: 'awsv4',
        awsv4: attrs({
          accessKey: auth['accessKeyId'],
          secretKey: auth['secretAccessKey'],
          sessionToken: auth['sessionToken'],
          region: auth['region'],
          service: auth['service'],
        }),
      };
    default:
      // oauth1, hawk, asap, netrc, singleToken and any other: the shared mapper names the type.
      return { type };
  }
}

/** The headers folders hand down: their enabled ones, by lower-cased name, an inner folder's winning. */
export type InheritedHeaders = ReadonlyMap<string, InsRow>;

export function handDown(inherited: InheritedHeaders, folder: InsFolder): InheritedHeaders {
  const out = new Map(inherited);
  for (const row of folder.headers) if (!row.disabled) out.set(row.name.toLowerCase(), row);
  return out;
}

/** A request's own headers, then each inherited one it does not set itself. */
export function withInherited(own: readonly InsRow[], inherited: InheritedHeaders): InsRow[] {
  const names = new Set(own.map((row) => row.name.toLowerCase()));
  return [...own, ...[...inherited.entries()].filter(([name]) => !names.has(name)).map(([, row]) => row)];
}

/** The v2.1 body and, for a raw one, the content type it implies. */
function v21Body(
  body: InsBody,
  t: (value: string) => string,
  label: string,
  report: ReportBuilder,
): { body?: Json; contentType?: string } {
  const mimeType = body.mimeType;
  const content = body.text ?? '';
  if (mimeType === undefined) return content !== '' ? { body: { mode: 'raw', raw: t(content) } } : {};
  if (mimeType === 'application/x-www-form-urlencoded') {
    return { body: { mode: 'urlencoded', urlencoded: keyValues(body.params ?? [], t) } };
  }
  if (mimeType === 'multipart/form-data') {
    const parts = (body.params ?? []).map((part) => {
      const file = part.type === 'file' && part.fileName !== undefined;
      if (file) {
        report.note(
          `${label}: the file part "${part.name}" points at ${part.fileName ?? ''}, which is not in the export.`,
        );
      }
      return {
        key: t(part.name),
        type: file ? 'file' : 'text',
        ...(file ? { src: part.fileName } : { value: t(part.value) }),
        ...(typeof part.multiline === 'string' && part.multiline !== '' ? { contentType: part.multiline } : {}),
        ...(part.description !== undefined ? { description: part.description } : {}),
        ...(part.disabled ? { disabled: true } : {}),
      };
    });
    return { body: { mode: 'formdata', formdata: parts } };
  }
  if (mimeType === 'application/octet-stream') {
    if (body.fileName === undefined) return {};
    report.note(`${label}: its body is the file ${body.fileName}, which is not in the export.`);
    return { body: { mode: 'file', file: { src: body.fileName } } };
  }
  if (mimeType === 'application/graphql') return graphqlBody(content, t, label, report);
  return {
    body: { mode: 'raw', raw: t(content), options: { raw: { language: rawLanguage(mimeType) } } },
    contentType: mimeType,
  };
}

/** `{query, variables, operationName}` as a GraphQL body; text that is not that stays raw JSON. */
function graphqlBody(
  content: string,
  t: (value: string) => string,
  label: string,
  report: ReportBuilder,
): { body: Json; contentType: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || typeof parsed['query'] !== 'string') {
    report.note(`${label}: its GraphQL body is not a query document, so it was imported as JSON text.`);
    return {
      body: { mode: 'raw', raw: t(content), options: { raw: { language: 'json' } } },
      contentType: 'application/json',
    };
  }
  let variables: unknown = parsed['variables'];
  if (typeof variables === 'string') {
    // A string of JSON is the usual form; one that does not parse (a template in a value) stays text.
    try {
      const inner: unknown = JSON.parse(variables);
      if (isRecord(inner)) variables = inner;
    } catch {
      // kept as text
    }
  }
  const variablesText =
    variables === undefined || variables === null
      ? ''
      : typeof variables === 'string'
        ? variables
        : JSON.stringify(variables, null, 2);
  const operation = parsed['operationName'];
  return {
    body: {
      mode: 'graphql',
      graphql: {
        query: t(parsed['query']),
        variables: t(variablesText),
        ...(typeof operation === 'string' && operation !== '' ? { operationName: operation } : {}),
      },
    },
    contentType: 'application/json',
  };
}

function settingsBehaviour(request: InsHttp, label: string, report: ReportBuilder): Json | undefined {
  const { followRedirects, encodeUrl, other } = request.settings;
  if (other.length > 0) {
    report.note(
      `${label}: Wirebench does not keep its settings for ${other.map((s) => OTHER_SETTINGS[s]).join(', ')}.`,
    );
  }
  const behaviour: Json = {
    ...(followRedirects !== 'global' ? { followRedirects: followRedirects === 'on' } : {}),
    ...(!encodeUrl ? { disableUrlEncoding: true } : {}),
  };
  return Object.keys(behaviour).length > 0 ? behaviour : undefined;
}

function httpItem(
  request: InsHttp,
  trail: readonly string[],
  inherited: InheritedHeaders,
  context: InsomniaConvertContext,
): Json {
  const path = [...trail, request.name];
  const label = `${context.labelPrefix}${path.join(' / ')}`;
  const templates = new ItemTemplates(context, label);
  const { t } = templates;
  const { report } = context;
  const { base, rows: inline } = inlineQuery(request.url);
  const query = [...inline, ...request.parameters];
  const headers = withInherited(request.headers, inherited);
  const { body, contentType } = v21Body(request.body, t, label, report);
  if (contentType !== undefined && !headers.some((row) => row.name.toLowerCase() === 'content-type')) {
    headers.push({ name: 'Content-Type', value: contentType, disabled: false });
  }
  const auth = v21AuthOf(request.auth, t, label, report);
  const behaviour = settingsBehaviour(request, label, report);
  const item: Json = {
    name: request.name,
    ...(request.description !== undefined ? { description: request.description } : {}),
    request: {
      method: request.method.toUpperCase(),
      url: {
        raw: t(query.length > 0 ? base : request.url),
        ...(query.length > 0 ? { query: keyValues(query, t) } : {}),
        ...(request.pathParameters.length > 0 ? { variable: keyValues(request.pathParameters, t) } : {}),
      },
      header: keyValues(headers, t),
      ...(body !== undefined ? { body } : {}),
      ...(auth !== undefined ? { auth } : {}),
    },
    ...eventsOf(request.scripts),
    ...(behaviour !== undefined ? { protocolProfileBehavior: behaviour } : {}),
  };
  templates.done();
  return item;
}

function items(
  nodes: readonly InsNode[],
  trail: readonly string[],
  inherited: InheritedHeaders,
  context: InsomniaConvertContext,
): Json[] {
  const out: Json[] = [];
  for (const node of nodes) {
    if (node.kind === 'http') {
      out.push(httpItem(node, trail, inherited, context));
      continue;
    }
    if (node.kind !== 'folder') continue;
    const path = [...trail, node.name];
    const label = `${context.labelPrefix}${path.join(' / ')}`;
    const inner = items(node.children, path, handDown(inherited, node), context);
    // A folder with no HTTP request below it is no folder of the REST API.
    if (inner.length === 0) continue;
    if (node.headers.some((row) => !row.disabled)) {
      context.report.note(`${label}: its headers were copied onto the requests below it that do not set them.`);
    }
    const templates = new ItemTemplates(context, label);
    const auth = v21AuthOf(node.auth, templates.t, label, context.report);
    templates.done();
    out.push({
      name: node.name,
      ...(node.description !== undefined ? { description: node.description } : {}),
      item: inner,
      ...(auth !== undefined ? { auth } : {}),
      ...eventsOf(node.scripts),
    });
  }
  return out;
}

/** The workspace's HTTP requests and their folders as a v2.1 collection document named `name`. */
export function v21OfInsomnia(workspace: InsWorkspace, name: string, context: InsomniaConvertContext): Json {
  return {
    info: {
      name,
      schema: V21_SCHEMA,
      ...(workspace.description !== undefined ? { description: workspace.description } : {}),
    },
    item: items(workspace.items, [], new Map(), context),
  };
}
