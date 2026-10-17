/**
 * A read Hoppscotch export mapped to Wirebench (spec 2026-10-15 §6.2–6.3). Each top-level
 * collection's REST and GraphQL requests are written as the v2.1 collection document they mean and
 * go through the same parser and mapper as an exported v2.1 collection; `<<name>>` becomes
 * `{{name}}` on the way. Collection and folder variables become project properties, environments
 * workspace environments (one named `Global` merges into Globals), every script rides on the document as
 * a v2.1 `event` and is attached switched off by the mapper.
 * Pure.
 */

import { HoppscotchError } from '../../errors.js';
import type { IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { folderRequests } from '../../rest/model.js';
import { apiFromPostmanCollection } from '../../rest/postman/map.js';
import { parsePostmanCollection } from '../../rest/postman/parse.js';
import type { MappedClientEntry, MappedClientImport } from '../client-import.js';
import { V21_SCHEMA } from '../collection-v3/convert.js';
import { inlineQuery } from '../insomnia/convert.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import { hoppscotchTemplates } from '../template-dialects.js';
import { rewriteMustache } from '../templates.js';
import type { ImportedVariable, ImportedVariables, ImportedVariableSet } from '../variables.js';
import { credentialSafeVariable, VariableSetBuilder, warnCredentialLookingNames } from '../variables.js';
import type { HopBody, HopCollection, HopEnvironment, HopRec, HopRequest, HopRow, HopVariable } from './model.js';

type Json = Record<string, unknown>;

/** A script pair as v2.1 `event` entries: `prerequest` first, then `test` (the after-response script). */
function eventsOf(scripts: { readonly pre: string; readonly test: string }): { event: Json[] } | Record<string, never> {
  const event: Json[] = [];
  if (scripts.pre.trim() !== '')
    event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: scripts.pre } });
  if (scripts.test.trim() !== '')
    event.push({ listen: 'test', script: { type: 'text/javascript', exec: scripts.test } });
  return event.length > 0 ? { event } : {};
}

export interface MapHoppscotchOptions {
  readonly newId?: IdGenerator;
  /** The `order` of the first API. 0 by default. */
  readonly firstOrder?: number;
  /** A name for the API of an export holding one collection; ignored when there are several. */
  readonly name?: string;
}

const t = hoppscotchTemplates;

function isRecord(value: unknown): value is HopRec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function keyValues(rows: readonly HopRow[]): Json[] {
  return rows.map((row) => ({
    key: t(row.key),
    value: t(row.value),
    ...(row.description !== undefined ? { description: row.description } : {}),
    ...(row.active ? {} : { disabled: true }),
  }));
}

/** The v2.1 language a raw body of this content type is written as. */
function rawLanguage(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('xml')) return 'xml';
  if (type.includes('html')) return 'html';
  return 'text';
}

/** A url-encoded body's `key: value` lines as rows; a line starting with `#` is switched off. */
export function urlencodedRows(text: string): HopRow[] {
  const rows: HopRow[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (line === '') continue;
    const active = !line.startsWith('#');
    if (!active) line = line.slice(1).trim();
    const colon = line.indexOf(':');
    rows.push(
      colon < 0
        ? { key: line, value: '', active }
        : { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim(), active },
    );
  }
  return rows;
}

/**
 * A Hoppscotch auth as the v2.1 `{type, <type>: [{key, value}]}`, or `undefined` to inherit.
 * Values go through untouched (templates aside), so the shared mapper drops and warns about
 * literal credentials as it does for any collection. Keys left from another auth type are ignored.
 */
export function v21AuthOfHoppscotch(auth: HopRec, label: string, report: ReportBuilder): Json | undefined {
  const type = str(auth['authType']);
  if (type === 'inherit') return undefined;
  if (auth['authActive'] === false || type === 'none') return { type: 'noauth' };
  const attrs = (pairs: Record<string, unknown>): Json[] =>
    Object.entries(pairs)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => ({ key, value: typeof value === 'string' ? t(value) : value }));
  switch (type) {
    case 'basic':
      return { type: 'basic', basic: attrs({ username: auth['username'], password: auth['password'] }) };
    case 'bearer':
      return { type: 'bearer', bearer: attrs({ token: auth['token'] }) };
    case 'digest':
      return { type: 'digest', digest: attrs({ username: auth['username'], password: auth['password'] }) };
    case 'api-key':
      return {
        type: 'apikey',
        apikey: attrs({
          key: auth['key'],
          value: auth['value'],
          in: auth['addTo'] === 'QUERY_PARAMS' ? 'query' : 'header',
        }),
      };
    case 'aws-signature':
      return {
        type: 'awsv4',
        awsv4: attrs({
          accessKey: auth['accessKey'],
          secretKey: auth['secretKey'],
          sessionToken: auth['serviceToken'],
          region: auth['region'],
          service: auth['serviceName'],
        }),
      };
    case 'jwt': {
      const toQuery = auth['addTo'] === 'QUERY_PARAMS';
      return {
        type: 'jwt',
        jwt: attrs({
          algorithm: auth['algorithm'],
          secret: auth['secret'],
          privateKey: auth['privateKey'],
          payload: auth['payload'],
          header: auth['jwtHeaders'],
          addTokenTo: toQuery ? 'queryParam' : 'header',
          ...(toQuery
            ? { queryParamKey: auth['paramName'] }
            : { headerPrefix: str(auth['headerPrefix'] ?? 'Bearer ').trim() }),
        }),
      };
    }
    case 'oauth-2': {
      const info = isRecord(auth['grantTypeInfo']) ? auth['grantTypeInfo'] : {};
      const grant = str(info['grantType']);
      const authCode = grant === 'AUTHORIZATION_CODE';
      const extra = ['authRequestParams', 'tokenRequestParams', 'refreshRequestParams'].some(
        (key) => Array.isArray(info[key]) && (info[key] as unknown[]).length > 0,
      );
      if (extra) report.note(`${label}: its OAuth 2 extra request parameters were not imported.`);
      return {
        type: 'oauth2',
        oauth2: attrs({
          grant_type: authCode
            ? info['isPKCE'] === true
              ? 'authorization_code_with_pkce'
              : 'authorization_code'
            : grant === 'CLIENT_CREDENTIALS'
              ? 'client_credentials'
              : grant === 'PASSWORD'
                ? 'password_credentials'
                : grant.toLowerCase(),
          // Every grant but the authorization code one names its token URL `authEndpoint`.
          accessTokenUrl: authCode ? info['tokenEndpoint'] : info['authEndpoint'],
          ...(authCode ? { authUrl: info['authEndpoint'] } : {}),
          clientId: info['clientID'],
          clientSecret: info['clientSecret'],
          scope: info['scopes'],
          username: info['username'],
          password: info['password'],
          client_authentication: info['clientAuthentication'] === 'AS_BASIC_AUTH_HEADERS' ? 'header' : 'body',
        }),
      };
    }
    case 'hawk':
    case 'akamai-eg':
      report.warn(
        `${label}: ${type === 'hawk' ? 'Hawk' : 'Akamai EdgeGrid'} auth has no Wirebench equivalent, so it was set to "none".`,
      );
      return { type: 'noauth' };
    default:
      // Any other: the shared mapper names the type and imports none.
      return { type };
  }
}

/** The v2.1 body and, for a raw one, the content type it implies. */
function v21Body(body: HopBody, label: string, report: ReportBuilder): { body?: Json; contentType?: string } {
  const type = body.contentType;
  if (type === null) return {};
  if (type === 'application/x-www-form-urlencoded') {
    const rows = Array.isArray(body.body)
      ? body.body
          .filter(isRecord)
          .map((row) => ({ key: str(row['key']), value: str(row['value']), active: row['active'] !== false }))
      : urlencodedRows(str(body.body));
    return { body: { mode: 'urlencoded', urlencoded: keyValues(rows) } };
  }
  if (type === 'multipart/form-data') {
    const parts = (Array.isArray(body.body) ? body.body : []).filter(isRecord).map((part) => {
      const key = str(part['key']);
      const disabled = part['active'] === false ? { disabled: true } : {};
      const contentType = str(part['contentType']);
      if (part['isFile'] === true) {
        // No file travels in the export, and a file part needs one: the row stays, switched off.
        report.note(
          `${label}: the file part "${key}" has no file in the export, so it was kept switched off as a text part; pick its file on the Body tab.`,
        );
        return { key: t(key), type: 'text', value: '', disabled: true };
      }
      return {
        key: t(key),
        type: 'text',
        value: t(str(part['value'])),
        ...(contentType !== '' ? { contentType } : {}),
        ...disabled,
      };
    });
    return { body: { mode: 'formdata', formdata: parts } };
  }
  if (type === 'application/octet-stream' || type === 'binary') {
    report.note(
      `${label}: its body is a file, which is not in the export, so it has no body; pick the file on the Body tab.`,
    );
    return {};
  }
  return {
    body: { mode: 'raw', raw: t(str(body.body)), options: { raw: { language: rawLanguage(type) } } },
    contentType: type,
  };
}

/** The headers collections and folders hand down: their active ones, by lower-cased name, an inner one's winning. */
type Inherited = ReadonlyMap<string, HopRow>;

function handDown(inherited: Inherited, collection: HopCollection): Inherited {
  const out = new Map(inherited);
  for (const row of collection.headers) if (row.active) out.set(row.key.toLowerCase(), row);
  return out;
}

function withInherited(own: readonly HopRow[], inherited: Inherited): HopRow[] {
  const names = new Set(own.map((row) => row.key.toLowerCase()));
  return [...own, ...[...inherited.entries()].filter(([name]) => !names.has(name)).map(([, row]) => row)];
}

function responses(request: HopRequest): Json[] {
  return request.responses.map((response) => ({
    name: response.name,
    ...(response.code !== undefined ? { code: response.code } : {}),
    ...(response.status !== undefined ? { status: response.status } : {}),
    header: response.headers.map((h) => ({ key: h.key, value: h.value })),
    body: response.body,
  }));
}

function restItem(
  request: HopRequest & { kind: 'rest' },
  label: string,
  inherited: Inherited,
  report: ReportBuilder,
): Json {
  const { base, rows: inline } = inlineQuery(request.endpoint);
  const inlineNames = new Set(inline.map((row) => row.name));
  const query: HopRow[] = [
    ...inline.map((row) => ({ key: row.name, value: row.value, active: true })),
    ...request.params.filter((row) => !inlineNames.has(row.key)),
  ];
  const headers = withInherited(request.headers, inherited);
  const { body, contentType } = v21Body(request.body, label, report);
  if (contentType !== undefined && !headers.some((row) => row.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: contentType, active: true });
  }
  const variables = request.requestVariables.filter((row) => row.key !== '').map((row) => row.key);
  if (variables.length > 0) {
    report.warn(
      `${label}: request-level variables (${variables.join(', ')}) were not imported; Wirebench has no request scope.`,
    );
  }
  const auth = v21AuthOfHoppscotch(request.auth, label, report);
  return {
    name: request.name,
    ...(request.description !== undefined ? { description: request.description } : {}),
    request: {
      method: request.method.toUpperCase(),
      url: {
        raw: t(query.length > 0 ? base : request.endpoint),
        ...(query.length > 0 ? { query: keyValues(query) } : {}),
      },
      header: keyValues(headers),
      ...(body !== undefined ? { body } : {}),
      ...(auth !== undefined ? { auth } : {}),
    },
    response: responses(request),
  };
}

function graphqlItem(
  request: HopRequest & { kind: 'graphql' },
  label: string,
  inherited: Inherited,
  report: ReportBuilder,
): Json {
  const headers = withInherited(request.headers, inherited);
  if (!headers.some((row) => row.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: 'application/json', active: true });
  }
  const auth = v21AuthOfHoppscotch(request.auth, label, report);
  return {
    name: request.name,
    ...(request.description !== undefined ? { description: request.description } : {}),
    request: {
      method: 'POST',
      url: { raw: t(request.url) },
      header: keyValues(headers),
      body: { mode: 'graphql', graphql: { query: t(request.query), variables: t(request.variables) } },
      ...(auth !== undefined ? { auth } : {}),
    },
    response: responses(request),
  };
}

/** The running state of one export's mapping: its report and variables. */
class Mapper {
  readonly report = new ReportBuilder();
  readonly variableReport = new ReportBuilder();
  readonly properties = new VariableSetBuilder('Project properties', this.variableReport);
  readonly dynamic = new Set<string>();

  value(raw: string): string {
    return rewriteMustache(t(raw), this.dynamic);
  }

  variable(v: HopVariable, owner: string): ImportedVariable {
    if (v.secret) return { name: v.key, value: '', enabled: true, secret: true };
    const { variable, madeSecret, userinfoCut } = credentialSafeVariable(v.key, this.value(v.value));
    if (madeSecret) {
      this.variableReport.note(
        `${owner}: "${v.key}" looks like a credential, so its value was imported as a secret rather than plain text.`,
      );
    }
    if (userinfoCut) this.variableReport.warn(`${owner}: the credential in the URL of "${v.key}" was not imported.`);
    return variable;
  }

  /** A collection's or folder's variables as project properties, outermost first. */
  addVariables(collection: HopCollection, path: readonly string[]): void {
    const label = path.join(' / ');
    for (const v of collection.variables) this.properties.add(this.variable(v, `Project properties`), label);
    for (const folder of collection.folders) this.addVariables(folder, [...path, folder.name]);
  }

  items(collection: HopCollection, path: readonly string[], inherited: Inherited): Json[] {
    const out: Json[] = [];
    for (const folder of collection.folders) {
      const folderPath = [...path, folder.name];
      const label = folderPath.join(' / ');
      const inner = this.items(folder, folderPath, handDown(inherited, folder));
      if (folder.headers.some((row) => row.active)) {
        this.report.note(`${label}: its headers were copied onto the requests below it that do not set them.`);
      }
      const auth = v21AuthOfHoppscotch(folder.auth, label, this.report);
      out.push({
        name: folder.name,
        ...(folder.description !== undefined ? { description: folder.description } : {}),
        item: inner,
        ...(auth !== undefined ? { auth } : {}),
        ...eventsOf(folder),
      });
    }
    for (const request of collection.requests) {
      const label = [...path, request.name].join(' / ');
      const item =
        request.kind === 'rest'
          ? restItem(request, label, inherited, this.report)
          : graphqlItem(request, label, inherited, this.report);
      out.push({ ...item, ...eventsOf(request) });
    }
    return out;
  }
}

/**
 * Maps a read collections export: each top-level collection one API.
 *
 * @throws HoppscotchError `hoppscotch-nothing-to-import` when it holds no request and no variable
 */
export function mapHoppscotch(
  collections: readonly HopCollection[],
  report: ImportReport,
  options: MapHoppscotchOptions = {},
): MappedClientImport {
  const newId = options.newId ?? generateId;
  const mapper = new Mapper();
  for (const line of report.warnings) mapper.report.warn(line);
  for (const line of report.notes) mapper.report.note(line);
  const single = collections.length === 1;
  const entries: MappedClientEntry[] = [];
  let order = options.firstOrder ?? 0;
  let requests = 0;
  let folders = 0;
  let examples = 0;

  for (const collection of collections) {
    const name =
      single && options.name !== undefined && options.name.trim() !== '' ? options.name.trim() : collection.name;
    const prefix = single ? '' : `${collection.name}: `;
    mapper.addVariables(collection, [collection.name]);

    if (collection.headers.some((row) => row.active)) {
      mapper.report.note(`${prefix}The collection's headers were copied onto each request that does not set them.`);
    }
    const auth = v21AuthOfHoppscotch(collection.auth, collection.name, mapper.report);
    const parsed = parsePostmanCollection({
      info: {
        name,
        schema: V21_SCHEMA,
        ...(collection.description !== undefined ? { description: collection.description } : {}),
      },
      item: mapper.items(collection, [collection.name], handDown(new Map(), collection)),
      ...(auth !== undefined ? { auth } : {}),
      ...eventsOf(collection),
    });
    const http = apiFromPostmanCollection(parsed, { newId, name, scriptApi: 'hoppscotch' });
    for (const warning of http.summary.warnings ?? []) mapper.report.warn(`${prefix}${warning}`);
    if (http.summary.requests === 0) continue;
    const rest = { ...http.api, order: order++ };
    requests += http.summary.requests;
    folders += http.summary.folders;
    examples += folderRequests(rest).reduce((sum, r) => sum + (r.examples?.length ?? 0), 0);
    entries.push({ name, rest });
  }

  const projectProperties = mapper.properties.build();
  warnCredentialLookingNames(mapper.variableReport, [projectProperties]);
  if (requests === 0 && projectProperties.variables.length === 0) {
    throw new HoppscotchError(
      'hoppscotch-nothing-to-import',
      'The Hoppscotch export holds nothing Wirebench can bring across: no REST or GraphQL request, and no variable.',
    );
  }
  return {
    collections: entries,
    variables: {
      environments: [],
      ...(projectProperties.variables.length > 0 ? { projectProperties } : {}),
      report: mapper.variableReport.build(),
    },
    // Scripts are attached to the requests, folders and API, switched off: no file is saved.
    scripts: [],
    counts: { collections: entries.length, requests, folders, examples, assertions: 0, scripts: 0 },
    report: mapper.report.build(),
  };
}

/** Whether `env` is Hoppscotch's global environment, which merges into Globals. */
function isGlobal(env: HopEnvironment): boolean {
  return env.id === 'Global' || env.name === 'Global';
}

/**
 * An environments export as a variable plan: each environment a workspace environment, never
 * activated; the global one merged into Globals. A secret comes with no value, listed.
 *
 * @throws HoppscotchError `hoppscotch-nothing-to-import` when no environment holds a variable
 */
export function hoppscotchEnvironmentPlan(envs: readonly HopEnvironment[], report: ImportReport): ImportedVariables {
  const mapper = new Mapper();
  for (const line of report.warnings) mapper.variableReport.warn(line);
  for (const line of report.notes) mapper.variableReport.note(line);
  const globals = new VariableSetBuilder('Globals', mapper.variableReport);
  const environments: ImportedVariableSet[] = [];
  for (const env of envs) {
    if (isGlobal(env)) {
      for (const v of env.variables) globals.add(mapper.variable(v, 'Globals'));
      continue;
    }
    const owner = `Environment "${env.name}"`;
    environments.push({ name: env.name, variables: env.variables.map((v) => mapper.variable(v, owner)) });
  }
  const globalSet = globals.build();
  if (environments.length === 0 && globalSet.variables.length === 0) {
    throw new HoppscotchError('hoppscotch-nothing-to-import', 'The Hoppscotch environments file holds no environment.');
  }
  warnCredentialLookingNames(mapper.variableReport, [...environments, globalSet]);
  return {
    environments,
    ...(globalSet.variables.length > 0 ? { globals: globalSet } : {}),
    report: mapper.variableReport.build(),
  };
}
