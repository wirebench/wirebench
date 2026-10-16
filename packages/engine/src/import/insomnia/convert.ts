/**
 * The HTTP side of an Insomnia workspace written as the Postman v2.1 document it means, so it goes
 * through the same parser and mapper as an exported v2.1 collection (spec §3.1, §4.2). Templates are
 * rewritten to `{{name}}` here and to Wirebench references by that mapper. What the v2.1 document
 * cannot say is reported. No `event` is ever written: scripts are kept as text by the caller.
 */

import { splitQuery } from '../../rest/url.js';
import { V21_SCHEMA } from '../collection-v3/convert.js';
import type { ReportBuilder } from '../report.js';
import { insomniaTemplates } from '../template-dialects.js';
import { colonPathParams } from '../templates.js';
import type { InsNode, InsRow, InsSettings, InsWorkspace, Rec } from './model.js';

type Json = Record<string, unknown>;

/** Template tags kept as written, each with the labels (request trails) of the places using it. */
export type KeptTags = Map<string, Set<string>>;

/** `text` with Insomnia templates rewritten to `{{name}}`; a tag it cannot convert is filed under `label`. */
export function insomniaText(text: string, label: string, kept: KeptTags): string {
  if (!text.includes('{')) return text;
  const tags = new Set<string>();
  const out = insomniaTemplates(text, tags);
  for (const tag of tags) {
    const users = kept.get(tag);
    if (users === undefined) kept.set(tag, new Set([label]));
    else users.add(label);
  }
  return out;
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function keyValue(key: string, value: string, disabled = false, description?: string): Json {
  return {
    key,
    value,
    ...(description !== undefined ? { description } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

/** The Insomnia auth types the v2.1 document has no field for. */
const UNSUPPORTED_AUTH = new Set(['oauth1', 'hawk', 'asap', 'netrc', 'singleToken']);

const OAUTH2_GRANTS: Readonly<Record<string, string>> = {
  authorization_code: 'authorization_code',
  client_credentials: 'client_credentials',
  password: 'password_credentials',
};

/**
 * An Insomnia auth as the v2.1 `{type, <type>: [{key, value}]}`; `undefined` (inherit) for `{}` or a
 * disabled auth, `noauth` for `none`. Credentials pass through so the shared mapper drops and warns.
 */
export function v21AuthOfInsomnia(
  auth: Rec | undefined,
  label: string,
  report: ReportBuilder,
  kept: KeptTags,
): Json | undefined {
  if (auth === undefined || auth['disabled'] === true) return undefined;
  const type = auth['type'];
  if (typeof type !== 'string' || type === '') return undefined;
  const field = (key: string): string => insomniaText(scalar(auth[key]), label, kept);
  const attrs = (pairs: readonly (readonly [string, string])[]): Json[] =>
    pairs.filter(([, value]) => value !== '').map(([key, value]) => ({ key, value }));
  switch (type) {
    case 'none':
      return { type: 'noauth' };
    case 'basic':
    case 'digest':
    case 'ntlm':
      return {
        type,
        [type]: attrs([
          ['username', field('username')],
          ['password', field('password')],
        ]),
      };
    case 'bearer': {
      const prefix = scalar(auth['prefix']);
      if (prefix === 'NO_PREFIX') {
        report.note(
          `${label}: its bearer token is sent with no prefix, so it was imported as an API key in the Authorization header.`,
        );
        return {
          type: 'apikey',
          apikey: [
            { key: 'key', value: 'Authorization' },
            { key: 'value', value: field('token') },
            { key: 'in', value: 'header' },
          ],
        };
      }
      return {
        type: 'bearer',
        bearer: attrs([
          ['token', field('token')],
          ['scheme', prefix],
        ]),
      };
    }
    case 'apikey': {
      const addTo = scalar(auth['addTo']);
      if (addTo === 'cookie') {
        report.warn(
          `${label}: its API key is sent as a cookie, which Wirebench API-key auth cannot do; set to "none".`,
        );
        return { type: 'noauth' };
      }
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: field('key') },
          { key: 'value', value: field('value') },
          { key: 'in', value: addTo === 'queryParams' ? 'query' : 'header' },
        ],
      };
    }
    case 'oauth2': {
      const grant = scalar(auth['grantType']);
      return {
        type: 'oauth2',
        oauth2: attrs([
          ['grant_type', Object.hasOwn(OAUTH2_GRANTS, grant) ? OAUTH2_GRANTS[grant]! : grant],
          ['accessTokenUrl', field('accessTokenUrl')],
          ['authUrl', field('authorizationUrl')],
          ['clientId', field('clientId')],
          ['clientSecret', field('clientSecret')],
          ['scope', field('scope')],
          ['username', field('username')],
          ['password', field('password')],
          ['accessToken', field('accessToken')],
          ['refreshToken', field('refreshToken')],
          ['client_authentication', auth['credentialsInBody'] === true ? 'body' : ''],
        ]),
      };
    }
    case 'iam':
      return {
        type: 'awsv4',
        awsv4: attrs([
          ['accessKey', field('accessKeyId')],
          ['secretKey', field('secretAccessKey')],
          ['sessionToken', field('sessionToken')],
          ['region', field('region')],
          ['service', field('service')],
        ]),
      };
    default:
      report.warn(
        UNSUPPORTED_AUTH.has(type)
          ? `${label}: Insomnia auth type "${type}" is not supported; set to "none".`
          : `${label}: the auth type "${type}" is unknown; set to "none".`,
      );
      return { type: 'noauth' };
  }
}

function rows(list: readonly InsRow[], label: string, kept: KeptTags): Json[] {
  return list
    .filter((row) => row.name !== '')
    .map((row) =>
      keyValue(
        insomniaText(row.name, label, kept),
        insomniaText(row.value, label, kept),
        row.disabled,
        row.description,
      ),
    );
}

/** A content type for a raw body's language, by the type Insomnia names. */
function rawLanguage(mime: string): string {
  if (mime.includes('json')) return 'json';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('html')) return 'html';
  if (mime.includes('javascript')) return 'javascript';
  return 'text';
}

/** A GraphQL `body.text`, `{query, variables, operationName}`, as the v2.1 `graphql` body. */
function graphqlBody(text: string, label: string, report: ReportBuilder, kept: KeptTags): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRec(parsed)) {
    report.note(`${label}: its GraphQL body is not JSON, so all of it was kept as the query.`);
    return { mode: 'graphql', graphql: { query: insomniaText(text, label, kept), variables: '' } };
  }
  const raw = parsed['variables'];
  let variables = '';
  if (typeof raw === 'string') {
    let inner: unknown;
    try {
      inner = JSON.parse(raw);
    } catch {
      inner = undefined;
    }
    if (inner === undefined && raw.trim() !== '') {
      report.note(`${label}: its GraphQL variables are not JSON, so they were kept as text.`);
      variables = raw;
    } else if (inner !== undefined) {
      variables = JSON.stringify(inner, null, 2);
    }
  } else if (raw !== undefined && raw !== null) {
    variables = JSON.stringify(raw, null, 2);
  }
  const operationName = scalar(parsed['operationName']);
  return {
    mode: 'graphql',
    graphql: {
      query: insomniaText(scalar(parsed['query']), label, kept),
      variables: insomniaText(variables, label, kept),
      ...(operationName !== '' ? { operationName } : {}),
    },
  };
}

/** The v2.1 body for an Insomnia `body`, and the content type its `mimeType` stands for. */
function body(raw: Rec, label: string, report: ReportBuilder, kept: KeptTags): { body?: Json; contentType?: string } {
  const mimeType = scalar(raw['mimeType']);
  const mime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  const text = scalar(raw['text']);
  const params = Array.isArray(raw['params']) ? raw['params'].filter(isRec) : [];
  if (mime === '') {
    // No type, but text: kept as raw text rather than dropped.
    return text === '' ? {} : { body: { mode: 'raw', raw: insomniaText(text, label, kept) } };
  }
  if (mime === 'application/x-www-form-urlencoded') {
    return {
      body: {
        mode: 'urlencoded',
        urlencoded: params
          .filter((p) => scalar(p['name']) !== '')
          .map((p) =>
            keyValue(
              insomniaText(scalar(p['name']), label, kept),
              insomniaText(scalar(p['value']), label, kept),
              p['disabled'] === true,
            ),
          ),
      },
      contentType: mimeType,
    };
  }
  if (mime === 'multipart/form-data') {
    const parts = params
      .filter((p) => scalar(p['name']) !== '')
      .map((p) => {
        const name = insomniaText(scalar(p['name']), label, kept);
        const fileName = scalar(p['fileName']);
        const disabled = p['disabled'] === true ? { disabled: true } : {};
        if (p['type'] === 'file' && fileName !== '') {
          report.note(
            `${label}: the file part "${name}" points at ${fileName}, which is not in the export; check the path before sending.`,
          );
          return { key: name, type: 'file', src: fileName, ...disabled };
        }
        const multiline = p['multiline'];
        return {
          key: name,
          type: 'text',
          value: insomniaText(scalar(p['value']), label, kept),
          ...(typeof multiline === 'string' && multiline !== '' ? { contentType: multiline } : {}),
          ...disabled,
        };
      });
    // The boundary is chosen at send, so a fixed multipart Content-Type is not added.
    return { body: { mode: 'formdata', formdata: parts } };
  }
  if (mime === 'application/graphql') {
    return { body: graphqlBody(text, label, report, kept), contentType: 'application/json' };
  }
  if (mime === 'application/octet-stream') {
    return { body: { mode: 'file', file: { src: scalar(raw['fileName']) } }, contentType: mimeType };
  }
  return {
    body: { mode: 'raw', raw: insomniaText(text, label, kept), options: { raw: { language: rawLanguage(mime) } } },
    contentType: mimeType,
  };
}

const OTHER_SETTINGS: Readonly<Record<string, string>> = {
  storeCookies: 'store cookies',
  sendCookies: 'send cookies',
  renderRequestBody: 'render request body',
  rebuildPath: 'rebuild path',
};

/** The settings as v2.1 `protocolProfileBehavior`; the ones with no place are noted. */
function behaviour(settings: InsSettings, label: string, report: ReportBuilder): Json | undefined {
  if (settings.other.length > 0) {
    const names = settings.other.map((name) => `"${OTHER_SETTINGS[name] ?? name}"`).join(', ');
    const one = settings.other.length === 1;
    report.note(
      `${label}: the ${names} ${one ? 'setting has' : 'settings have'} no Wirebench equivalent and ${one ? 'was' : 'were'} not imported.`,
    );
  }
  const out: Json = {
    ...(settings.followRedirects !== 'global' ? { followRedirects: settings.followRedirects === 'on' } : {}),
    ...(!settings.encodeUrl ? { disableUrlEncoding: true } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A folder header handed down to the requests below it. */
interface Inherited {
  readonly row: InsRow;
  readonly label: string;
}

function trailOf(trail: readonly string[], name: string): string {
  return [...trail, name].join(' / ');
}

function httpItem(
  node: Extract<InsNode, { kind: 'http' }>,
  label: string,
  inherited: readonly Inherited[],
  report: ReportBuilder,
  kept: KeptTags,
): Json {
  const t = (text: string): string => insomniaText(text, label, kept);
  const split = splitQuery(t(node.url));
  const query = [...split.query.map((q) => keyValue(q.name, q.value)), ...rows(node.parameters, label, kept)];
  const variable = node.pathParameters
    .filter((p) => p.name !== '')
    .map((p) => keyValue(p.name, t(p.value), false, p.description));
  const header = rows(node.headers, label, kept);
  const names = new Set(header.map((h) => String(h['key']).toLowerCase()));
  // Innermost folder first: the nearest folder's header is the one a request below it means.
  for (const { row, label: folderLabel } of inherited) {
    if (names.has(row.name.toLowerCase())) continue;
    names.add(row.name.toLowerCase());
    header.push(...rows([row], folderLabel, kept));
  }
  const mapped = body(node.body, label, report, kept);
  if (mapped.contentType !== undefined && !names.has('content-type')) {
    header.push(keyValue('Content-Type', mapped.contentType));
  }
  const auth = v21AuthOfInsomnia(node.auth, label, report, kept);
  const protocolProfileBehavior = behaviour(node.settings, label, report);
  return {
    name: node.name,
    ...(node.description !== undefined ? { description: node.description } : {}),
    request: {
      method: node.method.toUpperCase(),
      url: {
        raw: colonPathParams(split.path),
        ...(query.length > 0 ? { query } : {}),
        ...(variable.length > 0 ? { variable } : {}),
      },
      header,
      ...(mapped.body !== undefined ? { body: mapped.body } : {}),
      ...(auth !== undefined ? { auth } : {}),
    },
    ...(protocolProfileBehavior !== undefined ? { protocolProfileBehavior } : {}),
  };
}

function items(
  nodes: readonly InsNode[],
  trail: readonly string[],
  inherited: readonly Inherited[],
  report: ReportBuilder,
  kept: KeptTags,
): Json[] {
  const out: Json[] = [];
  for (const node of nodes) {
    if (node.kind === 'http') {
      out.push(httpItem(node, trailOf(trail, node.name), inherited, report, kept));
      continue;
    }
    if (node.kind !== 'folder') continue;
    const label = trailOf(trail, node.name);
    const own = node.headers.filter((row) => row.name !== '').map((row) => ({ row, label }));
    const inner = items(node.children, [...trail, node.name], [...own, ...inherited], report, kept);
    // A folder with no HTTP request below it is no folder of the REST API.
    if (inner.length === 0) continue;
    if (own.length > 0) {
      report.note(
        `${label}: its headers (${own.map((h) => h.row.name).join(', ')}) were copied onto each request below it that does not set them.`,
      );
    }
    const auth = v21AuthOfInsomnia(node.auth, label, report, kept);
    out.push({
      name: node.name,
      item: inner,
      ...(node.description !== undefined ? { description: node.description } : {}),
      ...(auth !== undefined ? { auth } : {}),
    });
  }
  return out;
}

/** The v2.1 document for one workspace's HTTP requests and folders. */
export function v21OfInsomnia(ws: InsWorkspace, name: string, report: ReportBuilder, kept: KeptTags): Json {
  return { info: { name, schema: V21_SCHEMA }, item: items(ws.items, [], [], report, kept) };
}
