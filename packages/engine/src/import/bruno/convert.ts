/**
 * A Bruno collection folder as an OpenCollection (spec §5.2–5.4), so the OpenCollection mapper
 * does the rest: `bruno.json` names it, `collection.bru` and each `folder.bru` give their level's
 * headers, auth, variables and scripts, every other `.bru` file is one request, and the files
 * under `environments/` are its environments.
 *
 * Each request keeps only what Bruno would send: the body mode its verb block names, the query from
 * `params:query`, the auth its mode names. Bruno's own template forms are rewritten here; what the
 * OpenCollection mapper cannot express it reports. A file that does not parse is reported with its
 * line, and the rest of the collection still converts.
 */

import { BrunoError } from '../../errors.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import { brunoTemplates } from '../template-dialects.js';
import type {
  OcAssertion,
  OcCollection,
  OcEnvironment,
  OcItem,
  OcKeyValue,
  OcRequestDefaults,
  OcScript,
  OcVariable,
} from '../opencollection/model.js';
import type { BruBlock, BruFile, BruGrammar, BruPair } from './model.js';
import { block, blocks, parseBru } from './parse.js';

type Rec = Record<string, unknown>;

const VERBS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace'];

/** Bruno's assertion operators; any other first word means the whole value is compared with `eq`. */
const OPERATORS = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'notContains',
  'length',
  'matches',
  'notMatches',
  'startsWith',
  'endsWith',
  'between',
  'isEmpty',
  'isNotEmpty',
  'isNull',
  'isUndefined',
  'isDefined',
  'isTruthy',
  'isFalsy',
  'isJson',
  'isNumber',
  'isString',
  'isBoolean',
  'isArray',
]);

/** Each body mode and the block that holds it. */
const BODY_BLOCKS: Readonly<Record<string, string>> = {
  json: 'body:json',
  text: 'body:text',
  xml: 'body:xml',
  sparql: 'body:sparql',
  graphql: 'body:graphql',
  formUrlEncoded: 'body:form-urlencoded',
  multipartForm: 'body:multipart-form',
  file: 'body:file',
};

/** A request's or level's script blocks and the OpenCollection script type each becomes. */
const SCRIPT_TYPES: readonly (readonly [string, string])[] = [
  ['script:pre-request', 'before-request'],
  ['script:post-response', 'after-response'],
  ['tests', 'tests'],
];

/** Bruno's item types and OpenCollection's. */
const ITEM_TYPES: Readonly<Record<string, string>> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  ws: 'websocket',
  app: 'app',
};

const OAUTH2_FLOWS: Readonly<Record<string, string>> = {
  password: 'resource_owner_password_credentials',
  authorization_code: 'authorization_code',
  client_credentials: 'client_credentials',
  implicit: 'implicit',
};

const CONTENT_TYPE = '@contentType(';
const FILE = '@file(';

function pairsOf(b: BruBlock | undefined): readonly BruPair[] {
  return b?.kind === 'dict' ? b.pairs : [];
}

function textOf(b: BruBlock | undefined): string | undefined {
  return b?.kind === 'text' ? b.text : undefined;
}

/** A dictionary as an object, the last of a repeated key winning, as Bruno reads its object-style blocks. */
function fields(b: BruBlock | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const pair of pairsOf(b)) out[pair.key] = pair.value;
  return out;
}

function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.bru') ? name.slice(0, -4) : name;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A value's trailing `@contentType(x)`, split off. */
function splitContentType(raw: string): { value: string; contentType?: string } {
  const at = raw.lastIndexOf(CONTENT_TYPE);
  if (at === -1 || !raw.endsWith(')')) return { value: raw };
  const inner = raw.slice(at + CONTENT_TYPE.length, -1);
  if (inner.includes(')')) return { value: raw };
  return { value: raw.slice(0, at).trim(), contentType: inner.trim() };
}

/** The paths of an `@file(a|b)` value, or undefined when it is not one. */
function filePaths(value: string): string[] | undefined {
  if (!value.startsWith(FILE) || !value.endsWith(')')) return undefined;
  return value
    .slice(FILE.length, -1)
    .split('|')
    .filter((path) => path !== '');
}

function numberOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

function booleanOf(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** A URL without its query string, which Bruno also keeps in `params:query`. */
function withoutQuery(url: string): string {
  const query = url.indexOf('?');
  if (query === -1) return url;
  const hash = url.indexOf('#', query);
  return url.slice(0, query) + (hash === -1 ? '' : url.slice(hash));
}

/** An expected value without one pair of double quotes, as Bruno reads `eq "abc"`. */
function unquoted(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

interface Folder {
  readonly dir: string;
  file?: BruFile;
  readonly items: OcItem[];
}

class Converter {
  readonly report = new ReportBuilder();
  private readonly kept = new Set<string>();

  t(text: string): string {
    return brunoTemplates(text, this.kept);
  }

  parse(text: string, grammar: BruGrammar, path: string): BruFile | undefined {
    try {
      return parseBru(text, grammar, path);
    } catch (error) {
      if (!(error instanceof BrunoError)) throw error;
      this.report.warn(`${error.message}. The file was skipped.`);
      return undefined;
    }
  }

  /** The `{name, value, disabled}` rows of a dictionary, values rewritten. */
  rows(b: BruBlock | undefined, type?: string): OcKeyValue[] {
    return pairsOf(b).map((pair) => ({
      name: pair.key,
      value: this.t(pair.value),
      ...(pair.enabled ? {} : { disabled: true }),
      ...(type !== undefined ? { type } : {}),
    }));
  }

  /** A level's or request's auth for `mode`, from its `auth:<mode>` block. */
  auth(file: BruFile, mode: string): unknown {
    const f = fields(block(file, `auth:${mode}`));
    const t = (key: string): string => this.t(f[key] ?? '');
    switch (mode) {
      case '':
      case 'none':
        return 'none';
      case 'inherit':
        return 'inherit';
      case 'basic':
        return { type: 'basic', username: t('username'), password: t('password') };
      case 'bearer':
        return { type: 'bearer', token: t('token') };
      case 'digest':
        return { type: 'digest', username: t('username'), password: t('password') };
      case 'ntlm':
        return { type: 'ntlm', username: t('username'), password: t('password'), domain: t('domain') };
      case 'apikey':
        return {
          type: 'apikey',
          key: t('key'),
          value: t('value'),
          placement: f['placement'] === 'queryparams' ? 'query' : 'header',
        };
      case 'awsv4':
        return {
          type: 'awsv4',
          accessKeyId: t('accessKeyId'),
          secretAccessKey: t('secretAccessKey'),
          sessionToken: t('sessionToken'),
          service: t('service'),
          region: t('region'),
        };
      case 'oauth2': {
        const grant = f['grant_type'] ?? '';
        return {
          type: 'oauth2',
          flow: Object.hasOwn(OAUTH2_FLOWS, grant) ? OAUTH2_FLOWS[grant] : grant,
          accessTokenUrl: t('access_token_url'),
          authorizationUrl: t('authorization_url'),
          credentials: {
            clientId: t('client_id'),
            clientSecret: t('client_secret'),
            placement: f['credentials_placement'] === 'body' ? 'body' : 'basic_auth_header',
          },
          resourceOwner: { username: t('username'), password: t('password') },
          scope: t('scope'),
          pkce: { disabled: f['pkce'] !== 'true' },
        };
      }
      default:
        // wsse, oauth1, akamai-edgegrid: the mapper names the type and imports none.
        return { type: mode };
    }
  }

  scripts(file: BruFile): OcScript[] {
    const out: OcScript[] = [];
    for (const [name, type] of SCRIPT_TYPES) {
      const code = textOf(block(file, name));
      if (code !== undefined && code.trim() !== '') out.push({ type, code });
    }
    for (const b of file.blocks) {
      const code = textOf(b);
      if (b.name.startsWith('script:grpc:') && code !== undefined && code.trim() !== '') {
        out.push({ type: `grpc-${b.name.slice('script:grpc:'.length)}`, code });
      }
    }
    return out;
  }

  variables(b: BruBlock | undefined): OcVariable[] {
    return pairsOf(b).map((pair) => ({
      name: pair.key.startsWith('@') ? pair.key.slice(1) : pair.key,
      value: this.t(pair.value),
      ...(pair.enabled ? {} : { disabled: true }),
    }));
  }

  /** A report line for `vars:post-response`, which are read from the response, not set. */
  postResponse(file: BruFile, owner: string): void {
    const names = pairsOf(block(file, 'vars:post-response')).map((pair) =>
      pair.key.startsWith('@') ? pair.key.slice(1) : pair.key,
    );
    if (names.length > 0) {
      this.report.warn(
        `${owner}: the post-response variables ${names.join(', ')} were not imported; they are read from the response, so set them with a script or a capture.`,
      );
    }
  }

  /** `collection.bru`'s or a `folder.bru`'s defaults; its `auth { mode }` block selects the auth. */
  defaults(file: BruFile, owner: string): OcRequestDefaults {
    const headers = this.rows(block(file, 'headers'));
    const authBlock = block(file, 'auth');
    const variables = this.variables(block(file, 'vars:pre-request'));
    const scripts = this.scripts(file);
    this.postResponse(file, owner);
    return {
      ...(headers.length > 0 ? { headers } : {}),
      ...(authBlock !== undefined ? { auth: this.auth(file, fields(authBlock)['mode'] ?? 'none') } : {}),
      ...(variables.length > 0 ? { variables } : {}),
      ...(scripts.length > 0 ? { scripts } : {}),
    };
  }

  assertions(file: BruFile): OcAssertion[] {
    return pairsOf(block(file, 'assert')).map((pair) => {
      const raw = pair.value;
      const space = raw.indexOf(' ');
      const first = space === -1 ? raw : raw.slice(0, space);
      const known = OPERATORS.has(first);
      const value = known ? (space === -1 ? undefined : raw.slice(space + 1).trim()) : raw;
      return {
        expression: pair.key,
        operator: known ? first : 'eq',
        ...(value !== undefined && value !== '' ? { value: unquoted(this.t(value)) } : {}),
        ...(pair.enabled ? {} : { disabled: true }),
      };
    });
  }

  settings(file: BruFile): Rec | undefined {
    const pairs = pairsOf(block(file, 'settings'));
    if (pairs.length === 0) return undefined;
    const out: Rec = {};
    for (const pair of pairs) {
      switch (pair.key) {
        case 'timeout':
        case 'maxRedirects':
        case 'keepAliveInterval': {
          const n = numberOf(pair.value);
          if (n !== undefined) out[pair.key] = n;
          break;
        }
        case 'followRedirects':
        case 'encodeUrl': {
          const b = booleanOf(pair.value);
          if (b !== undefined) out[pair.key] = b;
          break;
        }
        case 'omitHeaders':
          if ((pair.list ?? []).length > 0) out[pair.key] = [...(pair.list ?? [])];
          break;
        default:
          out[pair.key] = pair.value;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private body(file: BruFile, mode: string, label: string): unknown {
    const blockName = BODY_BLOCKS[mode];
    const b = mode === 'json' && block(file, 'body:json') === undefined ? block(file, 'body') : undefined;
    switch (mode) {
      case 'none':
        return undefined;
      case 'json':
      case 'text':
      case 'xml':
      case 'sparql': {
        const data = textOf(b ?? block(file, blockName ?? ''));
        return data === undefined ? undefined : { type: mode, data: this.t(data) };
      }
      case 'formUrlEncoded':
        return { type: 'form-urlencoded', data: this.rows(block(file, 'body:form-urlencoded')) };
      case 'multipartForm':
        return {
          type: 'multipart-form',
          data: pairsOf(block(file, 'body:multipart-form')).map((pair) => {
            const { value, contentType } = splitContentType(pair.value);
            const files = filePaths(value);
            return {
              name: pair.key,
              type: files !== undefined ? 'file' : 'text',
              value: files ?? this.t(value),
              ...(contentType !== undefined ? { contentType } : {}),
              ...(pair.enabled ? {} : { disabled: true }),
            };
          }),
        };
      case 'file':
        return {
          type: 'file',
          data: pairsOf(block(file, 'body:file')).flatMap((pair) => {
            const { value, contentType } = splitContentType(pair.value);
            const path = filePaths(value)?.[0];
            return path === undefined
              ? []
              : [{ filePath: path, ...(contentType !== undefined ? { contentType } : {}), selected: pair.enabled }];
          }),
        };
      default:
        this.report.note(`${label}: its ${mode} body has no Wirebench equivalent and was left out.`);
        return undefined;
    }
  }

  /** A note for each body block the request does not send. */
  private unusedBodies(file: BruFile, mode: string, label: string): void {
    const active = new Set([BODY_BLOCKS[mode], ...(mode === 'graphql' ? ['body:graphql:vars'] : [])]);
    if (mode === 'json' && block(file, 'body:json') === undefined) active.add('body');
    for (const b of file.blocks) {
      if ((b.name === 'body' || b.name.startsWith('body:')) && !active.has(b.name) && !b.name.startsWith('body:grpc')) {
        if (b.name === 'body:ws') continue;
        this.report.note(`${label}: its ${b.name} block was left out; the request sends its ${mode} body.`);
      }
    }
  }

  /** One request file as an OpenCollection item, or undefined when it is not one. */
  request(path: string, file: BruFile): OcItem | undefined {
    const meta = fields(block(file, 'meta'));
    const name = (meta['name'] ?? '').trim() !== '' ? (meta['name'] ?? '').trim() : baseName(path);
    const bruType = meta['type'] ?? 'http';
    const type = Object.hasOwn(ITEM_TYPES, bruType) ? (ITEM_TYPES[bruType] ?? 'http') : 'http';
    const docs = textOf(block(file, 'docs'));
    const info = {
      name,
      type,
      seq: numberOf(meta['seq']) ?? 1,
      ...(docs !== undefined && docs.trim() !== '' ? { description: docs } : {}),
    };
    if (type === 'app') return { info, path };
    if (blocks(file, 'example').length > 0) {
      this.report.note(`${name}: its saved examples were not imported.`);
    }
    const scripts = this.scripts(file);
    const variables = this.variables(block(file, 'vars:pre-request'));
    this.postResponse(file, name);
    const assertions = this.assertions(file);
    const settings = this.settings(file);
    const runtime = {
      ...(scripts.length > 0 ? { scripts } : {}),
      ...(variables.length > 0 ? { variables } : {}),
      ...(assertions.length > 0 ? { assertions } : {}),
    };
    const shared = {
      info,
      path,
      ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
      ...(settings !== undefined ? { settings } : {}),
    };

    if (type === 'grpc') return { ...shared, grpc: this.grpc(file, name) };
    if (type === 'websocket') {
      const ws = fields(block(file, 'ws'));
      const messages = blocks(file, 'body:ws').map((b) => {
        const f = fields(b);
        return { name: f['name'] ?? '', data: this.t(f['content'] ?? '') };
      });
      return {
        ...shared,
        websocket: {
          url: this.t(ws['url'] ?? ''),
          headers: this.rows(block(file, 'headers')),
          auth: this.auth(file, ws['auth'] ?? 'none'),
          messages,
        },
      };
    }

    const verb = VERBS.find((v) => block(file, v) !== undefined) ?? (block(file, 'http') !== undefined ? 'http' : '');
    if (verb === '') {
      this.report.warn(`${path}: it names no method and was skipped.`);
      return undefined;
    }
    const http = fields(block(file, verb));
    const method = verb === 'http' ? (http['method'] ?? 'GET').toUpperCase() : verb.toUpperCase();
    const queryBlock = block(file, 'params:query') ?? block(file, 'query');
    const rawUrl = this.t(http['url'] ?? '');
    const url = queryBlock !== undefined ? withoutQuery(rawUrl) : rawUrl;
    const params = [...this.rows(queryBlock, 'query'), ...this.rows(block(file, 'params:path'), 'path')];
    const headers = this.rows(block(file, 'headers'));
    const auth = this.auth(file, http['auth'] ?? 'none');
    const mode =
      block(file, 'body') !== undefined && (http['body'] ?? 'none') === 'none' ? 'json' : (http['body'] ?? 'none');
    this.unusedBodies(file, mode, name);

    if (type === 'graphql' || mode === 'graphql') {
      return {
        ...shared,
        info: { ...info, type: 'graphql' },
        graphql: {
          url,
          params,
          headers,
          auth,
          body: {
            query: this.t(textOf(block(file, 'body:graphql')) ?? ''),
            variables: this.t(textOf(block(file, 'body:graphql:vars')) ?? ''),
          },
        },
      };
    }
    const body = this.body(file, mode, name);
    return {
      ...shared,
      http: { method, url, params, headers, auth, ...(body !== undefined ? { body } : {}) },
    };
  }

  private grpc(file: BruFile, name: string): Rec {
    const g = fields(block(file, 'grpc'));
    const messages = blocks(file, 'body:grpc');
    if (messages.length > 1) {
      this.report.note(`${name}: only the first of its ${String(messages.length)} gRPC messages was imported.`);
    }
    const first = messages[0] !== undefined ? fields(messages[0])['content'] : undefined;
    return {
      url: this.t(g['url'] ?? ''),
      method: g['method'] ?? '',
      ...(g['methodType'] !== undefined ? { methodType: g['methodType'] } : {}),
      metadata: this.rows(block(file, 'metadata')),
      ...(first !== undefined ? { message: this.t(first) } : {}),
      auth: this.auth(file, g['auth'] ?? 'none'),
      ...(g['protoPath'] !== undefined && g['protoPath'] !== '' ? { protoFilePath: g['protoPath'] } : {}),
    };
  }

  environment(path: string, file: BruFile): OcEnvironment {
    const variables: OcVariable[] = this.variables(block(file, 'vars'));
    const secrets = block(file, 'vars:secret');
    if (secrets?.kind === 'list') {
      for (const item of secrets.items) {
        variables.push({ name: item.value, secret: true, ...(item.enabled ? {} : { disabled: true }) });
      }
    }
    const extras = file.blocks
      .map((b) => b.name)
      .filter((n) => n === 'extends' || n === 'color' || n.startsWith('vars:externalsecrets:'));
    return { name: baseName(path), variables, extras: [...new Set(extras)] };
  }

  /** A warning for the prompt variables kept as written. */
  reportKept(): void {
    if (this.kept.size > 0) {
      this.report.warn(
        `The prompt variables ${[...this.kept].join(', ')} were kept as written; Wirebench does not ask for a value when it sends.`,
      );
    }
  }
}

function sortItems(items: OcItem[]): OcItem[] {
  return items.sort((a, b) => {
    const bySeq = (a.info.seq ?? 1) - (b.info.seq ?? 1);
    if (bySeq !== 0) return bySeq;
    return a.info.name < b.info.name ? -1 : a.info.name > b.info.name ? 1 : 0;
  });
}

/** `bruno.json`'s name, ignored paths and the settings Wirebench does not read. */
function config(text: string | undefined, rootName: string, report: ReportBuilder) {
  if (text === undefined) return { name: rootName, ignore: [] as string[], extras: [] as string[] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    report.warn('bruno.json could not be read, so the collection is named after its folder.');
    return { name: rootName, ignore: [], extras: [] };
  }
  const rec = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Rec) : {};
  const name = typeof rec['name'] === 'string' && rec['name'].trim() !== '' ? rec['name'].trim() : rootName;
  const ignore = Array.isArray(rec['ignore'])
    ? rec['ignore'].filter((p): p is string => typeof p === 'string' && p !== '')
    : [];
  const extras = ['proxy', 'clientCertificates'].filter((key) => rec[key] !== undefined);
  return { name, ignore, extras };
}

/**
 * A Bruno collection folder as an OpenCollection. `files` maps root-relative POSIX paths to their
 * text, as the folder walk hands them over; `rootName` names the collection when `bruno.json`
 * does not.
 */
export function ocOfBrunoFolder(
  files: ReadonlyMap<string, string>,
  rootName: string,
): { collection: OcCollection; report: ImportReport } {
  const conv = new Converter();
  const { name, ignore, extras } = config(files.get('bruno.json'), rootName, conv.report);
  const ignored = (path: string): boolean => ignore.some((p) => path === p || path.startsWith(`${p}/`));

  const folders = new Map<string, Folder>();
  const folder = (dir: string): Folder => {
    let found = folders.get(dir);
    if (found === undefined) {
      found = { dir, items: [] };
      folders.set(dir, found);
      if (dir !== '') folder(dirOf(dir));
    }
    return found;
  };
  folder('');

  let collectionFile: BruFile | undefined;
  const environments: OcEnvironment[] = [];
  for (const path of [...files.keys()].sort()) {
    const text = files.get(path) ?? '';
    if (ignored(path) || path === 'bruno.json') continue;
    const lower = path.toLowerCase();
    if (lower.endsWith('.js')) {
      folder(dirOf(path)).items.push({ info: { name: baseName(path), type: 'script' }, path, script: text });
      continue;
    }
    if (!lower.endsWith('.bru')) continue;
    if (path === 'collection.bru') {
      collectionFile = conv.parse(text, 'folder', path);
    } else if (dirOf(path) === 'environments') {
      const env = conv.parse(text, 'environment', path);
      if (env !== undefined) environments.push(conv.environment(path, env));
    } else if (path === 'folder.bru' || path.endsWith('/folder.bru')) {
      const parsed = conv.parse(text, 'folder', path);
      if (parsed !== undefined && dirOf(path) !== '') folder(dirOf(path)).file = parsed;
    } else {
      const parsed = conv.parse(text, 'request', path);
      const item = parsed !== undefined ? conv.request(path, parsed) : undefined;
      if (item !== undefined) folder(dirOf(path)).items.push(item);
    }
  }

  const build = (dir: string): OcItem[] => {
    const own = folders.get(dir);
    const children = [...folders.values()].filter((f) => f.dir !== '' && f.dir !== dir && dirOf(f.dir) === dir);
    const items = [...(own?.items ?? [])];
    for (const child of children) {
      const meta = fields(child.file !== undefined ? block(child.file, 'meta') : undefined);
      const childName = (meta['name'] ?? '').trim() !== '' ? (meta['name'] ?? '').trim() : baseName(child.dir);
      const request = child.file !== undefined ? conv.defaults(child.file, childName) : undefined;
      items.push({
        info: { name: childName, type: 'folder', seq: numberOf(meta['seq']) ?? 1 },
        path: child.dir,
        items: build(child.dir),
        ...(request !== undefined && Object.keys(request).length > 0 ? { request } : {}),
      });
    }
    return sortItems(items);
  };

  const items = build('');
  const request = collectionFile !== undefined ? conv.defaults(collectionFile, name) : undefined;
  conv.reportKept();
  return {
    collection: {
      version: '1',
      info: { name },
      items,
      ...(request !== undefined && Object.keys(request).length > 0 ? { request } : {}),
      environments,
      configExtras: extras,
    },
    report: conv.report.build(),
  };
}
