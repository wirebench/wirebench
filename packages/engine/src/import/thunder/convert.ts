/**
 * A read Thunder Client export mapped to Wirebench (spec 2026-10-15 §7.2–7.5). Each collection's
 * flat folders and requests become a tree, written as the v2.1 collection document it means and
 * mapped by the shared parser and mapper; its declarative tests become assertions where they fit,
 * attached afterwards in the same walk order. Environments become workspace environments, a global
 * one merged into Globals; scripts are saved as text. Pure.
 */

import type { Assertion } from '../../assert/model.js';
import { ThunderError } from '../../errors.js';
import type { IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { slugify } from '../../project/paths.js';
import type { RestApi, RestFolder, RestRequestDef } from '../../rest/model.js';
import { folderRequests } from '../../rest/model.js';
import { apiFromPostmanCollection } from '../../rest/postman/map.js';
import { parsePostmanCollection } from '../../rest/postman/parse.js';
import type { MappedClientEntry, MappedClientImport } from '../client-import.js';
import { ScriptCollector } from '../client-import.js';
import { V21_SCHEMA } from '../collection-v3/convert.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import type { ImportedScriptFile } from '../scripts.js';
import { thunderTemplates, unshieldTemplates } from '../template-dialects.js';
import { rewriteMustache } from '../templates.js';
import type { ImportedVariable, ImportedVariableSet } from '../variables.js';
import { credentialSafeVariable, VariableSetBuilder, warnCredentialLookingNames } from '../variables.js';
import { lines, tests as readTests } from './parse.js';
import type { TcCollection, TcEnvironment, TcExport, TcFolder, TcRec, TcRequest, TcRow, TcTest } from './model.js';
import { assertionOfThunderTest, describeThunderTest } from './tests.js';

type Json = Record<string, unknown>;

export interface MapThunderOptions {
  readonly newId?: IdGenerator;
  /** The `order` of the first API. 0 by default. */
  readonly firstOrder?: number;
  /** A name for the API of an export holding one collection; ignored when there are several. */
  readonly name?: string;
}

/** `reqType` values that are plain HTTP: the lower-case methods older files wrote, and SSE. */
const HTTP_REQ_TYPES = new Set(['get', 'post', 'put', 'patch', 'del', 'delete', 'head', 'options', 'sse']);
/** A URL that names its own origin: a scheme, or a leading variable that stands for one. */
const ABSOLUTE_URL = /^(?:[a-z][a-z\d+.-]*:\/\/|\{\{)/i;
const RAW_CONTENT_TYPES: Readonly<Record<string, { language: string; contentType: string }>> = {
  json: { language: 'json', contentType: 'application/json' },
  xml: { language: 'xml', contentType: 'application/xml' },
  text: { language: 'text', contentType: 'text/plain' },
};

function isRecord(value: unknown): value is TcRec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function rowsOf(value: unknown): TcRow[] {
  return (Array.isArray(value) ? value : [])
    .filter(isRecord)
    .map((row) => ({ name: str(row['name']), value: str(row['value']), disabled: row['isDisabled'] === true }));
}

/** `base` and a relative `url` joined with exactly one slash; an absolute URL is left as it is. */
export function joinBaseUrl(base: string, url: string): string {
  if (base === '' || ABSOLUTE_URL.test(url)) return url;
  let end = base.length;
  while (end > 0 && base[end - 1] === '/') end -= 1;
  let start = 0;
  while (start < url.length && url[start] === '/') start += 1;
  const rest = url.slice(start);
  return rest === '' ? base.slice(0, end) : `${base.slice(0, end)}/${rest}`;
}

/** Siblings by `sortNum`, one with none last, ties in file order. */
function bySortNum<T extends { readonly sortNum: number | null }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const x = a.item.sortNum;
      const y = b.item.sortNum;
      if (x === null || y === null) return x === y ? a.index - b.index : x === null ? 1 : -1;
      return x - y || a.index - b.index;
    })
    .map(({ item }) => item);
}

/** The running state of one export's mapping. */
class Mapper {
  readonly report = new ReportBuilder();
  readonly variableReport = new ReportBuilder();
  /** Each construct kept as written, with the labels of the items using it. */
  readonly kept = new Map<string, string[]>();
  readonly dynamic = new Set<string>();

  /** `value`'s templates rewritten to `{{…}}`, what it keeps recorded under `label`. */
  t(value: string, label: string): string {
    const seen = new Set<string>();
    const out = thunderTemplates(value, seen);
    for (const construct of seen) {
      const users = this.kept.get(construct) ?? [];
      if (!users.includes(label)) users.push(label);
      this.kept.set(construct, users);
    }
    return out;
  }

  keyValues(rows: readonly TcRow[], label: string): Json[] {
    return rows.map((row) => ({
      key: this.t(row.name, label),
      value: this.t(row.value, label),
      ...(row.disabled ? { disabled: true } : {}),
    }));
  }

  auth(auth: TcRec | undefined, label: string): Json | undefined {
    if (auth === undefined) return undefined;
    const type = str(auth['type']);
    const inner = isRecord(auth[type]) ? auth[type] : {};
    const attrs = (pairs: Record<string, unknown>): Json[] =>
      Object.entries(pairs)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => ({ key, value: typeof value === 'string' ? this.t(value, label) : value }));
    switch (type) {
      case 'inherit':
        return undefined;
      case 'none':
        return { type: 'noauth' };
      case 'basic':
        return { type: 'basic', basic: attrs({ username: inner['username'], password: inner['password'] }) };
      case 'bearer': {
        // The token is flat on `bearer`; a custom prefix is the scheme.
        const prefix = str(auth['bearerPrefix']).trim();
        return {
          type: 'bearer',
          bearer: attrs({
            token: auth['bearer'],
            ...(prefix !== '' && prefix.toLowerCase() !== 'bearer' ? { scheme: prefix } : {}),
          }),
        };
      }
      case 'oauth2': {
        const grant = str(inner['grantType']);
        return {
          type: 'oauth2',
          oauth2: attrs({
            grant_type: grant === 'password' ? 'password_credentials' : grant === '' ? 'authorization_code' : grant,
            accessTokenUrl: inner['tokenUrl'],
            authUrl: inner['authUrl'],
            clientId: inner['clientId'],
            clientSecret: inner['clientSecret'],
            scope: inner['scope'],
            username: inner['username'],
            password: inner['password'],
            client_authentication: str(inner['clientAuth']) === 'in-body' ? 'body' : 'header',
          }),
        };
      }
      case 'aws':
        return {
          type: 'awsv4',
          awsv4: attrs({
            accessKey: inner['accessKeyId'],
            secretKey: inner['secretKey'],
            sessionToken: inner['sessionToken'],
            region: inner['region'],
            service: inner['service'],
          }),
        };
      case 'ntlm':
        return {
          type: 'ntlm',
          ntlm: attrs({
            username: inner['username'],
            password: inner['password'],
            domain: inner['domain'],
            workstation: inner['workstation'],
          }),
        };
      default:
        this.report.warn(
          `${label}: its ${type === '' ? 'unnamed' : `"${type}"`} auth has no Wirebench equivalent, so it was set to "none".`,
        );
        return { type: 'noauth' };
    }
  }

  body(body: TcRec | undefined, label: string): { body?: Json; contentType?: string } {
    if (body === undefined) return {};
    const type = str(body['type']);
    const raw = RAW_CONTENT_TYPES[type];
    if (raw !== undefined) {
      return {
        body: { mode: 'raw', raw: this.t(lines(body['raw']), label), options: { raw: { language: raw.language } } },
        contentType: raw.contentType,
      };
    }
    if (type === 'formencoded') {
      return { body: { mode: 'urlencoded', urlencoded: this.keyValues(rowsOf(body['form']), label) } };
    }
    if (type === 'formdata') {
      const text = rowsOf(body['form']).map((row) => ({
        key: this.t(row.name, label),
        type: 'text',
        value: this.t(row.value, label),
        ...(row.disabled ? { disabled: true } : {}),
      }));
      const files = rowsOf(body['files']).map((row) => {
        if (row.value === '') {
          this.report.note(
            `${label}: the file part "${row.name}" names no file, so it was kept switched off as a text part.`,
          );
          return { key: this.t(row.name, label), type: 'text', value: '', disabled: true };
        }
        this.report.note(
          `${label}: the file part "${row.name}" points at ${row.value}, a path on the machine it was exported from.`,
        );
        return {
          key: this.t(row.name, label),
          type: 'file',
          src: row.value,
          ...(row.disabled ? { disabled: true } : {}),
        };
      });
      return { body: { mode: 'formdata', formdata: [...text, ...files] } };
    }
    if (type === 'graphql') {
      const gql = isRecord(body['graphql']) ? body['graphql'] : {};
      return {
        body: {
          mode: 'graphql',
          graphql: { query: this.t(str(gql['query']), label), variables: this.t(str(gql['variables']), label) },
        },
        contentType: 'application/json',
      };
    }
    if (type === 'binary') {
      const path = str(body['binary']);
      if (path === '') return {};
      this.report.note(`${label}: its body is the file ${path}, a path on the machine it was exported from.`);
      return { body: { mode: 'file', file: { src: path } } };
    }
    return {};
  }

  /** Each variable as an imported one: a secret's value travels only to the secret store. */
  variables(env: TcEnvironment, owner: string): ImportedVariable[] {
    const encrypted = env.variables.filter((v) => v.encrypted).map((v) => v.name);
    if (encrypted.length > 0) {
      this.variableReport.warn(
        `${owner}: ${encrypted.join(', ')} ${encrypted.length === 1 ? 'is' : 'are'} encrypted and cannot be read, so ${encrypted.length === 1 ? 'it was' : 'they were'} imported with no value.`,
      );
    }
    return env.variables.map((v): ImportedVariable => {
      const value = rewriteMustache(this.t(v.value, owner), this.dynamic);
      if (v.secret || v.encrypted) {
        return {
          name: v.name,
          value: '',
          enabled: true,
          secret: true,
          ...(value !== '' ? { secretValue: value } : {}),
        };
      }
      const { variable, madeSecret, userinfoCut } = credentialSafeVariable(v.name, value);
      if (madeSecret) {
        this.variableReport.note(
          `${owner}: "${v.name}" looks like a credential, so its value was imported as a secret rather than plain text.`,
        );
      }
      if (userinfoCut) this.variableReport.warn(`${owner}: the credential in the URL of "${v.name}" was not imported.`);
      return variable;
    });
  }

  /** `tests` as assertions; each one with no equivalent is reported once, under `label`. */
  assertions(tests: readonly TcTest[], label: string): Assertion[] {
    const out: Assertion[] = [];
    for (const test of tests) {
      const assertion = assertionOfThunderTest(test);
      if (assertion !== undefined) out.push(assertion);
      else if (test.type === 'set-env-var') {
        this.report.warn(
          `${label}: the test "${describeThunderTest(test)}" sets a variable from the response, which was not imported; use a capture or a script.`,
        );
      } else {
        this.report.warn(
          `${label}: the test "${describeThunderTest(test)}" has no Wirebench equivalent and was not imported.`,
        );
      }
    }
    return out;
  }

  reportKept(): void {
    for (const [construct, users] of this.kept) {
      this.report.warn(`${construct} was kept as written in ${users.join(', ')}; Wirebench does not run it.`);
    }
  }
}

/** One collection's tree and its mapping: folders first, then requests, each by `sortNum`. */
class CollectionMapper {
  private readonly folderIds: ReadonlySet<string>;
  /** Each request's assertions, in the order its v2.1 item is written. */
  readonly order: Assertion[][] = [];

  constructor(
    private readonly collection: TcCollection,
    private readonly mapper: Mapper,
    private readonly prefix: string,
    private readonly baseUrl: string,
    private readonly scripts: ScriptCollector,
  ) {
    this.folderIds = new Set(collection.folders.map((folder) => folder.id));
  }

  /** A parent id that names no folder of the collection is the root. */
  private parentOf(id: string): string {
    return this.folderIds.has(id) ? id : '';
  }

  reportSettings(settings: TcRec, label: string): void {
    const preReq = isRecord(settings['preReq']) ? settings['preReq'] : undefined;
    if (Array.isArray(preReq?.['runRequests']) && preReq['runRequests'].length > 0) {
      this.mapper.report.warn(
        `${label}: it runs other requests first (request chaining), which was not imported; build the chain as a sequence.`,
      );
    }
    if (isRecord(settings['runOptions'])) {
      this.mapper.report.note(`${label}: its run options (delay, iterations, data file) were not imported.`);
    }
  }

  items(
    parentId: string,
    trail: readonly string[],
    inherited: ReadonlyMap<string, TcRow>,
    tests: readonly Assertion[],
  ): Json[] {
    const out: Json[] = [];
    const folders = bySortNum(
      this.collection.folders.filter((f) => f.id !== parentId && this.parentOf(f.parentId) === parentId),
    );
    for (const folder of folders) out.push(this.folderItem(folder, trail, inherited, tests));
    const requests = bySortNum(this.collection.requests.filter((r) => this.parentOf(r.folderId) === parentId));
    for (const request of requests) {
      const item = this.requestItem(request, trail, inherited, tests);
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  private folderItem(
    folder: TcFolder,
    trail: readonly string[],
    inherited: ReadonlyMap<string, TcRow>,
    tests: readonly Assertion[],
  ): Json {
    const path = [...trail, folder.name];
    const label = `${this.prefix}${path.join(' / ')}`;
    const headers = rowsOf(folder.settings['headers']);
    if (headers.some((row) => !row.disabled)) {
      this.mapper.report.note(`${label}: its headers were copied onto the requests below it that do not set them.`);
    }
    this.reportSettings(folder.settings, label);
    const auth = this.mapper.auth(isRecord(folder.settings['auth']) ? folder.settings['auth'] : undefined, label);
    const docs = lines(folder.settings['docs']);
    return {
      name: folder.name,
      ...(docs !== '' ? { description: docs } : {}),
      item: this.items(folder.id, path, handDown(inherited, headers), [
        ...tests,
        ...this.mapper.assertions(readTests(folder.settings['tests']), label),
      ]),
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  private requestItem(
    request: TcRequest,
    trail: readonly string[],
    inherited: ReadonlyMap<string, TcRow>,
    tests: readonly Assertion[],
  ): Json | undefined {
    const label = `${this.prefix}${[...trail, request.name].join(' / ')}`;
    const { mapper } = this;
    if (request.reqType !== undefined && !HTTP_REQ_TYPES.has(request.reqType.toLowerCase())) {
      mapper.report.warn(
        `${label}: its request type "${request.reqType}" has no published file shape, so it was not imported.`,
      );
      return undefined;
    }
    this.reportSettings({ preReq: request.preReq }, label);
    const at = request.url.indexOf('?');
    const url = joinBaseUrl(this.baseUrl, at < 0 ? request.url : request.url.slice(0, at));
    const query = request.params.filter((p) => !p.isPath);
    const pathParams = request.params.filter((p) => p.isPath);
    const own = new Set(request.headers.map((row) => row.name.toLowerCase()));
    const headers = [
      ...request.headers,
      ...[...inherited.entries()].filter(([name]) => !own.has(name)).map(([, row]) => row),
    ];
    const { body, contentType } = mapper.body(request.body, label);
    if (contentType !== undefined && !headers.some((row) => row.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: contentType, disabled: false });
    }
    const auth = mapper.auth(request.auth, label);
    this.order.push([...tests, ...mapper.assertions(request.tests, label)]);
    const slug = slugify([...trail, request.name].join('-')).toLowerCase();
    this.scripts.add(slug, 'pre', inlineScripts(request.preReq), label);
    this.scripts.add(slug, 'post', inlineScripts(request.postReq), label);
    return {
      name: request.name,
      ...(request.docs !== undefined ? { description: request.docs } : {}),
      request: {
        method: request.method,
        url: {
          raw: mapper.t(url, label),
          ...(query.length > 0 ? { query: mapper.keyValues(query, label) } : {}),
          ...(pathParams.length > 0 ? { variable: mapper.keyValues(pathParams, label) } : {}),
        },
        header: mapper.keyValues(headers, label),
        ...(body !== undefined ? { body } : {}),
        ...(auth !== undefined ? { auth } : {}),
      },
    };
  }
}

function handDown(inherited: ReadonlyMap<string, TcRow>, headers: readonly TcRow[]): ReadonlyMap<string, TcRow> {
  const out = new Map(inherited);
  for (const row of headers) if (!row.disabled) out.set(row.name.toLowerCase(), row);
  return out;
}

/** Every request of `container`, depth first, folders before requests: the order the items were written in. */
function walk(container: RestApi | RestFolder): RestRequestDef[] {
  return [...container.folders.flatMap(walk), ...container.requests];
}

/** `container` with each request replaced by `replace`'s answer for it. */
function replaceRequests<C extends RestApi | RestFolder>(
  container: C,
  replace: (r: RestRequestDef) => RestRequestDef,
): C {
  return {
    ...container,
    folders: container.folders.map((folder) => replaceRequests(folder, replace)),
    requests: container.requests.map(replace),
  };
}

/** The `inlineScripts` of a `preReq` or `postReq`, joined. */
function inlineScripts(holder: unknown): string {
  return (isRecord(holder) && Array.isArray(holder['inlineScripts']) ? holder['inlineScripts'] : [])
    .filter(isRecord)
    .map((entry) => lines(entry['script']))
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

/** `url` without the slashes it ends in. */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

/**
 * Maps a read export or folder: each collection one REST API, the environments the variable plan.
 *
 * @throws ThunderError `thunder-nothing-to-import` when it holds no request and no environment
 */
export function mapThunderClient(
  parsed: TcExport & { readonly report: ImportReport },
  options: MapThunderOptions = {},
): MappedClientImport {
  const newId = options.newId ?? generateId;
  const mapper = new Mapper();
  for (const line of parsed.report.warnings) mapper.report.warn(line);
  for (const line of parsed.report.notes) mapper.report.note(line);
  const single = parsed.collections.length === 1;
  const entries: MappedClientEntry[] = [];
  const scripts: ImportedScriptFile[] = [];
  let order = options.firstOrder ?? 0;
  let requests = 0;
  let folders = 0;
  let examples = 0;
  let assertionCount = 0;

  for (const collection of parsed.collections) {
    const name =
      single && options.name !== undefined && options.name.trim() !== '' ? options.name.trim() : collection.name;
    const prefix = single ? '' : `${collection.name}: `;
    const settings = collection.settings;
    const options_ = isRecord(settings['options']) ? settings['options'] : {};
    const baseUrl = str(options_['baseUrl']);
    if (str(settings['envId']) !== '') {
      mapper.report.note(
        `${prefix}The environment attached to the collection was not imported with it; import it on its own.`,
      );
    }
    const collector = new ScriptCollector(slugify(name).toLowerCase(), mapper.report);
    const collectionMapper = new CollectionMapper(collection, mapper, prefix, baseUrl, collector);
    const headers = rowsOf(settings['headers']);
    if (headers.some((row) => !row.disabled)) {
      mapper.report.note(`${prefix}The collection's headers were copied onto each request that does not set them.`);
    }
    const label = `${prefix}${collection.name}`;
    const auth = mapper.auth(isRecord(settings['auth']) ? settings['auth'] : undefined, label);
    collectionMapper.reportSettings(settings, label);
    const docs = lines(settings['docs']);
    collector.add(slugify(collection.name).toLowerCase(), 'pre', inlineScripts(settings['preReq']), label);
    const items = collectionMapper.items(
      '',
      [],
      handDown(new Map(), headers),
      mapper.assertions(readTests(settings['tests']), label),
    );
    collector.reportDialects();
    scripts.push(...collector.files());

    const doc = parsePostmanCollection({
      info: { name, schema: V21_SCHEMA, ...(docs !== '' ? { description: docs } : {}) },
      item: items,
      ...(auth !== undefined ? { auth } : {}),
    });
    // Without its trailing slash, so the mapper finds it at the start of each joined URL.
    const base =
      baseUrl !== '' ? trimTrailingSlashes(rewriteMustache(mapper.t(baseUrl, label), mapper.dynamic)) : undefined;
    const http = apiFromPostmanCollection(doc, { newId, name, ...(base !== undefined ? { baseUrl: base } : {}) });
    for (const warning of http.summary.warnings ?? []) mapper.report.warn(`${prefix}${warning}`);
    if (http.summary.requests === 0) continue;

    // The mapper keeps the items' order, so the n-th request walked is the n-th item written.
    const mapped = walk(http.api);
    let rest: RestApi = http.api;
    if (mapped.length === collectionMapper.order.length) {
      const byId = new Map<string, Assertion[]>();
      mapped.forEach((def, index) => {
        const assertions = collectionMapper.order[index] ?? [];
        if (assertions.length > 0) byId.set(def.id, assertions);
        assertionCount += assertions.length;
      });
      rest = replaceRequests(rest, (def) => {
        const assertions = byId.get(def.id);
        return assertions !== undefined ? { ...def, assertions: [...def.assertions, ...assertions] } : def;
      });
    } else {
      mapper.report.warn(`${prefix}The tests could not be matched to their requests, so none was imported.`);
    }
    rest = { ...rest, order: order++ };
    requests += http.summary.requests;
    folders += http.summary.folders;
    examples += folderRequests(rest).reduce((sum, r) => sum + (r.examples?.length ?? 0), 0);
    entries.push({ name, rest });
  }

  const globals = new VariableSetBuilder('Globals', mapper.variableReport);
  const environments: ImportedVariableSet[] = [];
  for (const env of parsed.environments) {
    const owner = env.global ? 'Globals' : `Environment "${env.name}"`;
    if (env.envFile !== undefined) {
      mapper.variableReport.warn(
        `${owner}: its values come from the file ${env.envFile}, which is not read; set them in Environments.`,
      );
    }
    if (env.flags.length > 0) {
      mapper.variableReport.note(
        `${owner}: it was marked ${env.flags.join(' and ')} in Thunder Client; an import never makes an environment active.`,
      );
    }
    const variables = mapper.variables(env, owner);
    if (env.global) for (const variable of variables) globals.add(variable);
    else environments.push({ name: env.name, variables });
  }
  mapper.reportKept();

  const globalSet = globals.build();
  warnCredentialLookingNames(mapper.variableReport, [...environments, globalSet]);
  if (requests === 0 && environments.length === 0 && globalSet.variables.length === 0) {
    throw new ThunderError(
      'thunder-nothing-to-import',
      'The Thunder Client export holds nothing Wirebench can bring across: no HTTP request, and no environment.',
    );
  }
  return unshieldTemplates({
    collections: entries,
    variables: {
      environments,
      ...(globalSet.variables.length > 0 ? { globals: globalSet } : {}),
      report: mapper.variableReport.build(),
    },
    scripts,
    counts: {
      collections: entries.length,
      requests,
      folders,
      examples,
      assertions: assertionCount,
      scripts: scripts.length,
    },
    report: mapper.report.build(),
  });
}
