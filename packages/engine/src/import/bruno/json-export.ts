/**
 * A Bruno JSON export (spec §5.5) as an OpenCollection: the same model as the parsed `.bru` files,
 * serialised, so it converts by the same rules with no grammar. Its environments follow §5.4 and
 * its secrets are empty in the file. The `brunoConfig` it embeds is only reported: a proxy password
 * in it is never read into anything.
 */

import { BrunoError } from '#core/errors';
import type { ImportReport } from '#core/import/report';
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
import { Converter, sortItems, withoutQuery } from './convert.js';

type Rec = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rec(value: unknown): Rec | undefined {
  return isRecord(value) ? value : undefined;
}

function list(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function seqOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

/** The export's camel-case OAuth 2 field names, by the names a `.bru` file gives them. */
const OAUTH2_FIELDS: Readonly<Record<string, string>> = {
  grantType: 'grant_type',
  accessTokenUrl: 'access_token_url',
  authorizationUrl: 'authorization_url',
  clientId: 'client_id',
  clientSecret: 'client_secret',
  credentialsPlacement: 'credentials_placement',
};

const ITEM_TYPES: Readonly<Record<string, string>> = {
  http: 'http',
  'http-request': 'http',
  graphql: 'graphql',
  'graphql-request': 'graphql',
  grpc: 'grpc',
  'grpc-request': 'grpc',
  ws: 'websocket',
  'ws-request': 'websocket',
  app: 'app',
};

const TEXT_BODIES = new Set(['json', 'text', 'xml', 'sparql']);

class ExportReader {
  constructor(private readonly conv: Converter) {}

  private t(value: unknown): string {
    return this.conv.t(scalar(value));
  }

  rows(value: unknown, type?: string): OcKeyValue[] {
    return list(value)
      .filter((row) => typeof row['name'] === 'string')
      .map((row) => ({
        name: row['name'] as string,
        value: this.t(row['value']),
        ...(row['enabled'] === false ? { disabled: true } : {}),
        ...(type !== undefined ? { type } : {}),
      }));
  }

  auth(value: unknown): unknown {
    const auth = rec(value);
    if (auth === undefined) return 'none';
    const mode = str(auth['mode']) || 'none';
    const data = rec(auth[mode]) ?? {};
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(data)) {
      const name = Object.hasOwn(OAUTH2_FIELDS, key) ? (OAUTH2_FIELDS[key] ?? key) : key;
      fields[name] = typeof raw === 'boolean' ? String(raw) : scalar(raw);
    }
    return this.conv.authFrom(mode, fields);
  }

  scripts(request: Rec | undefined): OcScript[] {
    const script = rec(request?.['script']);
    const out: OcScript[] = [];
    const add = (type: string, code: unknown): void => {
      if (typeof code === 'string' && code.trim() !== '') out.push({ type, code });
    };
    add('before-request', script?.['req']);
    add('after-response', script?.['res']);
    add('tests', request?.['tests']);
    return out;
  }

  variables(request: Rec | undefined, owner: string): OcVariable[] {
    const vars = rec(request?.['vars']);
    this.conv.postResponseNames(
      list(vars?.['res'])
        .map((v) => str(v['name']))
        .filter((name) => name !== ''),
      owner,
    );
    return list(vars?.['req'])
      .filter((v) => typeof v['name'] === 'string')
      .map((v) => ({
        name: str(v['name']).startsWith('@') ? str(v['name']).slice(1) : str(v['name']),
        value: this.t(v['value']),
        ...(v['enabled'] === false ? { disabled: true } : {}),
      }));
  }

  defaults(request: Rec | undefined, owner: string): OcRequestDefaults {
    const headers = this.rows(request?.['headers']);
    const variables = this.variables(request, owner);
    const scripts = this.scripts(request);
    const auth = request?.['auth'];
    return {
      ...(headers.length > 0 ? { headers } : {}),
      ...(auth !== undefined ? { auth: this.auth(auth) } : {}),
      ...(variables.length > 0 ? { variables } : {}),
      ...(scripts.length > 0 ? { scripts } : {}),
    };
  }

  private assertions(request: Rec): OcAssertion[] {
    return list(request['assertions'])
      .filter((a) => typeof a['name'] === 'string')
      .map((a) => this.conv.assertion(str(a['name']), scalar(a['value']), a['enabled'] !== false));
  }

  private settings(value: unknown): Rec | undefined {
    const settings = rec(value);
    if (settings === undefined) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(settings)) {
      if (key === 'omitHeaders') {
        const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : [];
        if (names.length > 0) out[key] = names;
      } else if (raw !== 'inherit' && raw !== null && raw !== undefined) {
        out[key] = raw;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private body(request: Rec, mode: string): unknown {
    const body = rec(request['body']) ?? {};
    if (TEXT_BODIES.has(mode)) {
      const data = body[mode];
      return typeof data === 'string' ? { type: mode, data: this.t(data) } : undefined;
    }
    switch (mode) {
      case 'formUrlEncoded':
        return { type: 'form-urlencoded', data: this.rows(body['formUrlEncoded']) };
      case 'multipartForm':
        return {
          type: 'multipart-form',
          data: list(body['multipartForm'])
            .filter((part) => typeof part['name'] === 'string')
            .map((part) => {
              const file = part['type'] === 'file';
              const value = part['value'];
              return {
                name: part['name'] as string,
                type: file ? 'file' : 'text',
                value: file
                  ? (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string')
                  : this.t(value),
                ...(str(part['contentType']) !== '' ? { contentType: str(part['contentType']) } : {}),
                ...(part['enabled'] === false ? { disabled: true } : {}),
              };
            }),
        };
      case 'file':
        return {
          type: 'file',
          data: list(body['file'])
            .filter((f) => str(f['filePath']) !== '')
            .map((f) => ({
              filePath: str(f['filePath']),
              ...(str(f['contentType']) !== '' ? { contentType: str(f['contentType']) } : {}),
              selected: f['selected'] === true,
            })),
        };
      default:
        return undefined;
    }
  }

  item(raw: Rec): OcItem | undefined {
    const rawType = str(raw['type']);
    const name = str(raw['name']) || 'Untitled';
    if (rawType === 'folder') {
      const root = rec(raw['root']);
      const meta = rec(root?.['meta']);
      const folderName = str(meta?.['name']) || name;
      const request = this.defaults(rec(root?.['request']), folderName);
      return {
        info: { name: folderName, type: 'folder', seq: seqOf(meta?.['seq'] ?? raw['seq']) },
        path: folderName,
        items: this.items(raw['items']),
        ...(Object.keys(request).length > 0 ? { request } : {}),
      };
    }
    if (rawType === 'js') {
      const source = raw['fileContent'] ?? raw['raw'];
      return typeof source === 'string' ? { info: { name, type: 'script' }, path: name, script: source } : undefined;
    }
    const type = Object.hasOwn(ITEM_TYPES, rawType) ? (ITEM_TYPES[rawType] ?? 'http') : 'http';
    const request = rec(raw['request']) ?? {};
    const docs = str(request['docs']) || str(raw['docs']);
    const info = {
      name,
      type,
      seq: seqOf(raw['seq']),
      ...(docs.trim() !== '' ? { description: docs } : {}),
    };
    if (type === 'app') return { info, path: name };
    if (list(raw['examples']).length > 0) this.conv.report.note(`${name}: its saved examples were not imported.`);
    const scripts = this.scripts(request);
    const variables = this.variables(request, name);
    const assertions = this.assertions(request);
    const settings = this.settings(raw['settings']);
    const runtime = {
      ...(scripts.length > 0 ? { scripts } : {}),
      ...(variables.length > 0 ? { variables } : {}),
      ...(assertions.length > 0 ? { assertions } : {}),
    };
    const shared = {
      info,
      path: name,
      ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
      ...(settings !== undefined ? { settings } : {}),
    };
    const body = rec(request['body']) ?? {};
    const auth = this.auth(request['auth']);

    if (type === 'grpc') {
      const messages = list(body['grpc']);
      if (messages.length > 1) {
        this.conv.report.note(`${name}: only the first of its ${String(messages.length)} gRPC messages was imported.`);
      }
      const first = messages[0]?.['content'];
      return {
        ...shared,
        grpc: {
          url: this.t(request['url']),
          method: str(request['method']),
          ...(str(request['methodType']) !== '' ? { methodType: str(request['methodType']) } : {}),
          metadata: this.rows(request['metadata'] ?? request['headers']),
          ...(first !== undefined ? { message: this.t(first) } : {}),
          auth,
          ...(str(request['protoPath']) !== '' ? { protoFilePath: str(request['protoPath']) } : {}),
        },
      };
    }
    if (type === 'websocket') {
      return {
        ...shared,
        websocket: {
          url: this.t(request['url']),
          headers: this.rows(request['headers']),
          auth,
          messages: list(body['ws']).map((m) => ({ name: str(m['name']), data: this.t(m['content']) })),
        },
      };
    }

    // An older export lists its query as `request.query`; a current one, path and query, as `params`.
    const params = Array.isArray(request['params'])
      ? list(request['params']).flatMap((p) => this.rows([p], p['type'] === 'path' ? 'path' : 'query'))
      : this.rows(request['query'], 'query');
    const rawUrl = this.t(request['url']);
    const url = params.some((p) => p.type === 'query') ? withoutQuery(rawUrl) : rawUrl;
    const headers = this.rows(request['headers']);
    const mode = str(body['mode']) || 'none';
    if (type === 'graphql' || mode === 'graphql') {
      const graphql = rec(body['graphql']) ?? {};
      return {
        ...shared,
        info: { ...info, type: 'graphql' },
        graphql: {
          url,
          params,
          headers,
          auth,
          body: { query: this.t(graphql['query']), variables: this.t(graphql['variables']) },
        },
      };
    }
    const mapped = mode === 'none' ? undefined : this.body(request, mode);
    if (mode !== 'none' && mapped === undefined) {
      this.conv.report.note(`${name}: its ${mode} body has no Wirebench equivalent and was left out.`);
    }
    return {
      ...shared,
      http: {
        method: (str(request['method']) || 'GET').toUpperCase(),
        url,
        params,
        headers,
        auth,
        ...(mapped !== undefined ? { body: mapped } : {}),
      },
    };
  }

  items(value: unknown): OcItem[] {
    return sortItems(list(value).flatMap((raw) => this.item(raw) ?? []));
  }

  environment(raw: Rec): OcEnvironment {
    const variables: OcVariable[] = list(raw['variables'])
      .filter((v) => typeof v['name'] === 'string')
      .map((v) => {
        const disabled = v['enabled'] === false ? { disabled: true } : {};
        if (v['secret'] === true) {
          const value = scalar(v['value']);
          return { name: str(v['name']), secret: true, ...(value !== '' ? { value } : {}), ...disabled };
        }
        return { name: str(v['name']), value: this.t(v['value']), ...disabled };
      });
    const extras = ['color', 'extends'].filter((key) => raw[key] !== undefined && raw[key] !== null);
    return { name: str(raw['name']) || 'Environment', variables, extras };
  }
}

/** Whether `json` is a Bruno JSON export: a string `version` and `name`, and an `items` array. */
export function isBrunoExport(json: unknown): json is Rec {
  return (
    isRecord(json) &&
    typeof json['version'] === 'string' &&
    json['version'] !== '' &&
    typeof json['name'] === 'string' &&
    Array.isArray(json['items'])
  );
}

/**
 * A Bruno JSON export as an OpenCollection.
 *
 * @throws BrunoError `bruno-not-export` when `json` is not one
 */
export function ocOfBrunoExport(json: unknown): { collection: OcCollection; report: ImportReport } {
  if (!isBrunoExport(json)) {
    throw new BrunoError(
      'bruno-not-export',
      'This is not a Bruno collection export: it needs a version, a name and a list of items.',
    );
  }
  const conv = new Converter();
  const reader = new ExportReader(conv);
  const name = str(json['name']).trim() || 'Collection';
  const items = reader.items(json['items']);
  const request = reader.defaults(rec(rec(json['root'])?.['request']), name);
  const environments = list(json['environments']).map((env) => reader.environment(env));
  const config = rec(json['brunoConfig']);
  const configExtras = ['proxy', 'clientCertificates'].filter((key) => config?.[key] !== undefined);
  const flow = str(rec(config?.['scripts'])?.['flow']) || undefined;
  conv.reportKept();
  return {
    collection: {
      version: '1',
      info: { name },
      items,
      ...(Object.keys(request).length > 0 ? { request } : {}),
      environments,
      configExtras,
      ...(flow !== undefined ? { scriptFlow: flow } : {}),
    },
    report: conv.report.build(),
  };
}
