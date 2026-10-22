/**
 * Reading a Hoppscotch collections or environments export (spec 2026-10-15 §6.1). Every object
 * carries its own version, so each collection, folder and request is migrated on its own: a v0
 * REST request's `url` + `path` and string `auth`, an older OAuth 2 and API-key shape. A version
 * newer than this build knows is read as the newest and named in the report. Pure.
 */

import { HoppscotchError } from '#core/errors';
import type { ImportReport } from '#core/import/report';
import { ReportBuilder } from '#core/import/report';
import type {
  HopBody,
  HopCollection,
  HopEnvironment,
  HopRec,
  HopRequest,
  HopResponse,
  HopRow,
  HopVariable,
} from './model.js';
import { MAX_HOPPSCOTCH_BYTES, NEWEST } from './model.js';

/** Folders nested deeper are cut, with a warning. */
const MAX_DEPTH = 64;

function isRecord(value: unknown): value is HopRec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A `v` written as a number or a string of digits; `undefined` for none. */
function version(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value)) return Number(value);
  return undefined;
}

function parseJson(text: string, what: string): unknown {
  if (text.length > MAX_HOPPSCOTCH_BYTES) {
    throw new HoppscotchError('hoppscotch-too-large', `The Hoppscotch ${what} is larger than 50 MB`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HoppscotchError('hoppscotch-malformed', `The Hoppscotch ${what} is not valid JSON.`, { cause: error });
  }
}

/** Reads every object at its own version, and names each version newer than this build knows once. */
class Reader {
  readonly report = new ReportBuilder();
  private readonly newer = new Map<string, number>();

  private checkVersion(kind: keyof typeof NEWEST, v: number | undefined): void {
    if (v !== undefined && v > NEWEST[kind]) this.newer.set(kind, Math.max(this.newer.get(kind) ?? 0, v));
  }

  finish(): ImportReport {
    const NAMES: Readonly<Record<string, string>> = {
      collection: 'collection',
      rest: 'REST request',
      graphql: 'GraphQL request',
      environment: 'environment',
    };
    for (const [kind, v] of this.newer) {
      this.report.note(
        `The export holds a ${NAMES[kind] ?? kind} at version ${String(v)}, newer than the ${String(NEWEST[kind as keyof typeof NEWEST])} this build knows; it was read as that.`,
      );
    }
    return this.report.build();
  }

  rows(value: unknown): HopRow[] {
    return list(value)
      .filter(isRecord)
      .map((row) => {
        const description = str(row['description']);
        return {
          key: str(row['key']),
          value: str(row['value']),
          active: row['active'] !== false,
          ...(description !== '' ? { description } : {}),
        };
      });
  }

  variables(value: unknown): HopVariable[] {
    return list(value)
      .filter(isRecord)
      .filter((v) => str(v['key']) !== '')
      .map((v) => {
        const secret = v['secret'] === true;
        const current = str(v['currentValue']);
        const initial = str(v['initialValue']);
        return {
          key: str(v['key']),
          value: secret ? '' : current !== '' ? current : initial !== '' ? initial : str(v['value']),
          secret,
        };
      });
  }

  /** An auth object in the newest shape: the older flat OAuth 2 and free-text API-key placement migrated. */
  auth(value: unknown, fallback: string): HopRec {
    if (!isRecord(value) || typeof value['authType'] !== 'string') {
      return { authType: fallback, authActive: true };
    }
    if (value['authType'] === 'oauth-2' && !isRecord(value['grantTypeInfo'])) {
      return {
        authType: 'oauth-2',
        authActive: value['authActive'] !== false,
        addTo: 'HEADERS',
        grantTypeInfo: {
          grantType: 'AUTHORIZATION_CODE',
          authEndpoint: str(value['authURL']),
          tokenEndpoint: str(value['accessTokenURL']),
          clientID: str(value['clientID']),
          scopes: str(value['scope']),
          isPKCE: false,
        },
      };
    }
    if (value['authType'] === 'api-key') {
      const addTo = str(value['addTo']);
      return { ...value, addTo: addTo === 'QUERY_PARAMS' || addTo === 'Query params' ? 'QUERY_PARAMS' : 'HEADERS' };
    }
    return value;
  }

  responses(value: unknown): HopResponse[] {
    if (!isRecord(value)) return [];
    return Object.entries(value)
      .filter((entry): entry is [string, HopRec] => isRecord(entry[1]))
      .map(([key, response]) => {
        const code = response['code'];
        const status = str(response['status']);
        return {
          name: str(response['name']) !== '' ? str(response['name']) : key,
          ...(typeof code === 'number' && Number.isInteger(code) ? { code } : {}),
          ...(status !== '' ? { status } : {}),
          headers: list(response['headers'])
            .filter(isRecord)
            .map((h) => ({ key: str(h['key']), value: str(h['value']) })),
          body: str(response['body']),
        };
      });
  }

  /** A v0 REST request, as Hoppscotch's own migration to v1 reads it. */
  private restV0(raw: HopRec, name: string): HopRequest {
    const oldType = str(raw['contentType']).toLowerCase();
    const body: HopBody = oldType.includes('json')
      ? { contentType: 'application/json', body: str(raw['rawParams'] ?? raw['body']) }
      : { contentType: null, body: null };
    const authName = str(raw['auth']);
    const auth: HopRec =
      authName === 'Basic Auth'
        ? { authType: 'basic', authActive: true, username: str(raw['httpUser']), password: str(raw['httpPassword']) }
        : authName === 'Bearer Token'
          ? { authType: 'bearer', authActive: true, token: str(raw['bearerToken']) }
          : { authType: 'none', authActive: true };
    return {
      kind: 'rest',
      name,
      method: str(raw['method']) !== '' ? str(raw['method']) : 'GET',
      endpoint: str(raw['url']) + str(raw['path']),
      params: this.rows(raw['params']),
      headers: this.rows(raw['headers']),
      body,
      auth,
      pre: str(raw['preRequestScript']),
      test: str(raw['testScript']),
      requestVariables: [],
      responses: [],
    };
  }

  request(raw: unknown, trail: string): HopRequest | undefined {
    if (!isRecord(raw)) return undefined;
    const name = str(raw['name']) !== '' ? str(raw['name']) : 'Untitled request';
    const description = str(raw['description']);
    const common = {
      name,
      headers: this.rows(raw['headers']),
      pre: str(raw['preRequestScript']),
      test: str(raw['testScript']),
      responses: this.responses(raw['responses']),
      ...(description !== '' ? { description } : {}),
    };
    if (typeof raw['endpoint'] === 'string') {
      this.checkVersion('rest', version(raw['v']));
      const body = isRecord(raw['body'])
        ? {
            contentType: typeof raw['body']['contentType'] === 'string' ? raw['body']['contentType'] : null,
            body: raw['body']['body'] ?? null,
          }
        : { contentType: null, body: null };
      return {
        kind: 'rest',
        ...common,
        method: str(raw['method']) !== '' ? str(raw['method']) : 'GET',
        endpoint: raw['endpoint'],
        params: this.rows(raw['params']),
        body,
        auth: this.auth(raw['auth'], 'inherit'),
        requestVariables: this.rows(raw['requestVariables']),
      };
    }
    if (typeof raw['url'] === 'string' && typeof raw['query'] === 'string') {
      this.checkVersion('graphql', version(raw['v']));
      return {
        kind: 'graphql',
        ...common,
        url: raw['url'],
        query: raw['query'],
        variables: str(raw['variables']),
        auth: this.auth(raw['auth'], 'none'),
      };
    }
    if (typeof raw['url'] === 'string') return this.restV0(raw, name);
    this.report.warn(`${trail}${name}: it is neither a REST nor a GraphQL request, so it was not imported.`);
    return undefined;
  }

  collection(raw: HopRec, trail: string, depth: number): HopCollection {
    const name = str(raw['name']) !== '' ? str(raw['name']) : 'Untitled collection';
    const path = `${trail}${name}`;
    const v = version(raw['v']);
    this.checkVersion('collection', v);
    let folders: HopCollection[] = [];
    if (depth >= MAX_DEPTH) {
      if (list(raw['folders']).length > 0) {
        this.report.warn(`${path}: folders nested more than ${String(MAX_DEPTH)} levels deep were not imported.`);
      }
    } else {
      folders = list(raw['folders'])
        .filter(isRecord)
        .map((folder) => this.collection(folder, `${path} / `, depth + 1));
    }
    const requests = list(raw['requests'])
      .map((request) => this.request(request, `${path} / `))
      .filter((request): request is HopRequest => request !== undefined);
    const description = str(raw['description']);
    return {
      name,
      folders,
      requests,
      // A collection older than version 2 has no auth: it inherits, as Hoppscotch's migration says.
      auth: this.auth(raw['auth'], 'inherit'),
      headers: this.rows(raw['headers']),
      variables: this.variables(raw['variables']),
      ...(description !== '' ? { description } : {}),
      pre: str(raw['preRequestScript']),
      test: str(raw['testScript']),
    };
  }
}

function isCollection(value: unknown): value is HopRec {
  return isRecord(value) && Array.isArray(value['folders']) && Array.isArray(value['requests']);
}

function isEnvironment(value: unknown): value is HopRec {
  return isRecord(value) && Array.isArray(value['variables']) && !Array.isArray(value['requests']);
}

/**
 * A collections export: one collection object or an array of them.
 *
 * @throws HoppscotchError `hoppscotch-malformed`, `hoppscotch-too-large`, `hoppscotch-not-collection`
 */
export function parseHoppscotchCollections(text: string): { collections: HopCollection[]; report: ImportReport } {
  const parsed = parseJson(text, 'export');
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0 || !items.every(isCollection)) {
    throw new HoppscotchError(
      'hoppscotch-not-collection',
      items.length > 0 && items.every(isEnvironment)
        ? 'This Hoppscotch file holds environments: import it as Hoppscotch environments.'
        : 'This is not a Hoppscotch collections export: it needs collections with folders and requests.',
    );
  }
  const reader = new Reader();
  const collections = items.map((item) => reader.collection(item, '', 0));
  return { collections, report: reader.finish() };
}

/**
 * An environments export: one environment object or an array of them.
 *
 * @throws HoppscotchError `hoppscotch-malformed`, `hoppscotch-too-large`, `hoppscotch-not-environments`
 */
export function parseHoppscotchEnvironments(text: string): { environments: HopEnvironment[]; report: ImportReport } {
  const parsed = parseJson(text, 'environments file');
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0 || !items.every(isEnvironment)) {
    throw new HoppscotchError(
      'hoppscotch-not-environments',
      items.length > 0 && items.every(isCollection)
        ? 'This Hoppscotch file holds collections: import it as a Hoppscotch collection.'
        : 'This is not a Hoppscotch environments export: it needs environments with variables.',
    );
  }
  const reader = new Reader();
  const environments = items.map((item, index): HopEnvironment => {
    const v = version(item['v']);
    if (v !== undefined && v > NEWEST.environment) {
      reader.report.note(
        `The environment "${str(item['name'])}" is at version ${String(v)}, newer than the ${String(NEWEST.environment)} this build knows; it was read as that.`,
      );
    }
    const id = str(item['id']);
    return {
      name: str(item['name']) !== '' ? str(item['name']) : `Environment ${String(index + 1)}`,
      ...(id !== '' ? { id } : {}),
      variables: reader.variables(item['variables']),
    };
  });
  return { environments, report: reader.finish() };
}
