/**
 * Turns a read OpenCollection into Wirebench APIs (spec §7.2): HTTP and GraphQL items go to one
 * REST API, its folders rebuilt only where REST items live under them.
 *
 * In core, not `rest/`, because one collection becomes several protocols' APIs and a protocol
 * folder never imports another (protocol modules spec §7.2). Every protocol import of this
 * importer is in this file, each a listed exception. Pure, but it creates ids, so format detection
 * never imports it.
 */

import { blankIfLiteral, blankJsonText, blankText, headersAndAuth, resolvePath } from '../credential-values.js';
import { MAX_EXAMPLE_BODY_CHARS, maskRecordedResponse } from '../examples.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import type { ImportedScriptFile } from '../scripts.js';
import { colonPathParams, rewriteMustache } from '../templates.js';
import type { ImportedVariables } from '../variables.js';
import { stripUserinfo } from '../values.js';
import type { KeyValueEntry } from '../../http/entries.js';
import { entry } from '../../http/entries.js';
import type { IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { uniqueSlug } from '../../project/paths.js';
import type { GrpcApi } from '../../grpc/model.js';
import type { WsApi } from '../../ws/model.js';
import type {
  MultipartFormPart,
  RestApi,
  RestBody,
  RestFolder,
  RestRequestDef,
  RestRequestSettings,
  RestResponseExample,
} from '../../rest/model.js';
import { NO_BODY, createApi, createFolder, createRestRequest } from '../../rest/model.js';
import { splitQueryKeepingReferences } from '../../rest/url.js';
import type { MappedOcAuth } from './auth.js';
import { mapOcAuth } from './auth.js';
import type { OcCollection, OcItem, OcKeyValue } from './model.js';

export interface MappedOpenCollection {
  /** Absent when the collection has no HTTP or GraphQL item. */
  readonly rest?: RestApi;
  readonly grpc?: GrpcApi;
  readonly websocket?: WsApi;
  /** The `.proto` files the gRPC items name, root-relative. */
  readonly protoFiles: readonly string[];
  /** The variable plan; its report holds the variable lines only. */
  readonly variables: ImportedVariables;
  /** Scripts, to be written under `imported-scripts/` and never run. */
  readonly scripts: readonly ImportedScriptFile[];
  readonly counts: {
    readonly requests: number;
    readonly folders: number;
    readonly assertions: number;
    readonly assertionsSkipped: number;
  };
  /** What the mapping of items did not bring across, and what it did on the user's behalf. */
  readonly report: ImportReport;
}

export interface MapOpenCollectionOptions {
  readonly newId?: IdGenerator;
  /** The `order` of the first API. 0 by default. */
  readonly firstOrder?: number;
  /** The collection's folder, which relative body file paths are resolved against. */
  readonly rootDir?: string;
}

type Rec = Readonly<Record<string, unknown>>;

const SETTINGS = new Set(['timeout', 'followRedirects', 'maxRedirects', 'encodeUrl']);
const ABSOLUTE_PATH = /^(?:[A-Za-z]:)?[\\/]/;
/** A content type for an example body that names none in its headers, by the body's declared type. */
const EXAMPLE_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  text: 'text/plain',
};

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A scalar as text; anything else (an object, a list) is empty. */
function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function records(value: unknown): readonly Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The `{name, value, disabled, type}` rows of a list, those without a string name left out. */
function rows(value: unknown): readonly OcKeyValue[] {
  return records(value)
    .filter((r) => typeof r['name'] === 'string')
    .map((r) => ({
      name: r['name'] as string,
      value: r['value'],
      ...(r['disabled'] === true ? { disabled: true } : {}),
      ...(typeof r['type'] === 'string' ? { type: r['type'] } : {}),
    }));
}

function named(list: readonly { readonly name: string }[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some((r) => r.name.toLowerCase() === lower);
}

/** The selected variant of a variant list (else the first), and the titles of the others. */
function pickVariant(raw: unknown): { body: unknown; others: string[]; title?: string } {
  if (!Array.isArray(raw)) return { body: raw, others: [] };
  const variants = records(raw);
  const chosen = variants.find((v) => v['selected'] === true) ?? variants[0];
  if (chosen === undefined) return { body: undefined, others: [] };
  const others = variants.filter((v) => v !== chosen).map((v, i) => str(v['title']) || `variant ${i + 1}`);
  return { body: chosen['body'], others, title: str(chosen['title']) };
}

const isHttp = (item: OcItem): boolean => item.info.type === 'http' && item.http !== undefined;
const isGraphql = (item: OcItem): boolean => item.info.type === 'graphql' && item.graphql !== undefined;
const isRest = (item: OcItem): boolean => isHttp(item) || isGraphql(item);

/** True when `item` is a folder that holds a REST item somewhere below it. */
function holdsRest(item: OcItem): boolean {
  return item.items?.some((child) => isRest(child) || holdsRest(child)) ?? false;
}

/** What a request inherits from the folders and collection above it. */
interface Scope {
  /** Enabled default headers, the nearest owner's first. */
  readonly headers: readonly KeyValueEntry[];
  /** The rows a references-only credential of the nearest owner with auth sends. */
  readonly auth: Pick<MappedOcAuth, 'header' | 'query'>;
}

/** The mapping's running state: one report, one id source, one set of dynamic names, the counts. */
class Mapper {
  readonly report = new ReportBuilder();
  readonly dynamic = new Set<string>();
  requests = 0;
  folders = 0;

  constructor(
    private readonly newId: IdGenerator,
    private readonly rootDir: string | undefined,
  ) {}

  rewrite(text: string): string {
    return rewriteMustache(text, this.dynamic);
  }

  auth(raw: unknown, where: string): MappedOcAuth {
    return mapOcAuth(raw, where, this.report, this.dynamic);
  }

  /** `scope` below an owner with these default headers and this auth; a note for each credential row added. */
  scopeBelow(scope: Scope, headers: unknown, auth: MappedOcAuth, where: string): Scope {
    const own = rows(headers)
      .filter((h) => h.disabled !== true)
      .map((h) => entry(h.name, this.rewrite(scalar(h.value))));
    this.noteAuthRows(auth, where, ' on each request below it');
    return {
      headers: [...own, ...scope.headers.filter((h) => !named(own, h.name))],
      auth: auth.auth.type === 'inherit' ? scope.auth : auth,
    };
  }

  private noteAuthRows(auth: MappedOcAuth, where: string, tail: string): void {
    for (const row of [auth.header, auth.query]) {
      if (row !== undefined) this.report.note(`${where}: the credential reference was added as ${row.name}${tail}.`);
    }
  }

  /** The folders and requests of one level, a folder kept only when REST items live under it. */
  walk(items: readonly OcItem[], scope: Scope): { folders: RestFolder[]; requests: RestRequestDef[] } {
    const folders: RestFolder[] = [];
    const requests: RestRequestDef[] = [];
    const folderSlugs = new Set<string>();
    const requestSlugs = new Set<string>();
    for (const item of items) {
      const name = item.info.name;
      if (item.items !== undefined) {
        if (!holdsRest(item)) continue;
        const auth = this.auth(item.request?.auth, name);
        const inner = this.walk(item.items, this.scopeBelow(scope, item.request?.headers, auth, name));
        const slug = uniqueSlug(name, folderSlugs);
        folderSlugs.add(slug);
        folders.push(
          createFolder(name, {
            newId: this.newId,
            order: folders.length,
            slug,
            ...(auth.auth.type !== 'inherit' ? { auth: auth.auth } : {}),
            folders: inner.folders,
            requests: inner.requests,
          }),
        );
        this.folders += 1;
        continue;
      }
      if (!isRest(item)) continue;
      const slug = uniqueSlug(name, requestSlugs);
      requestSlugs.add(slug);
      requests.push(this.request(item, scope, slug, requests.length));
      this.requests += 1;
    }
    return { folders, requests };
  }

  private request(item: OcItem, scope: Scope, slug: string, order: number): RestRequestDef {
    const label = item.info.name;
    const graphql = isGraphql(item);
    const details = (graphql ? item.graphql : item.http) ?? {};
    const blanked = new Set<string>();

    const method = graphql ? 'POST' : (str(details['method']) || 'GET').toUpperCase();
    const { url: withoutUser, stripped, username } = stripUserinfo(this.rewrite(str(details['url'])));
    const split = splitQueryKeepingReferences(withoutUser);
    const url = colonPathParams(split.path);

    const params = rows(details['params']);
    const param = (p: OcKeyValue): KeyValueEntry =>
      entry(p.name, blankIfLiteral(p.name, this.rewrite(scalar(p.value)), blanked), { enabled: p.disabled !== true });
    const pathParams = params.filter((p) => p.type === 'path').map(param);
    const query = params.filter((p) => p.type !== 'path').map(param);
    // The URL may repeat the query the params list: a param of the same name wins.
    for (const q of split.query) {
      if (!query.some((p) => p.name === q.name)) query.push(entry(q.name, blankIfLiteral(q.name, q.value, blanked)));
    }

    const own = rows(details['headers']).map((h) => ({
      name: h.name,
      value: this.rewrite(scalar(h.value)),
      enabled: h.disabled !== true,
    }));
    const defaults = scope.headers.filter((h) => !named(own, h.name));
    if (defaults.length > 0) this.report.note(`${label}: folder and collection default headers were added.`);
    const ownAuth = this.auth(details['auth'], label);
    this.noteAuthRows(ownAuth, label, '');
    const rowsFrom = ownAuth.auth.type === 'inherit' ? scope.auth : ownAuth;
    const merged = [...own, ...defaults];
    if (rowsFrom.header !== undefined && !named(merged, rowsFrom.header.name)) merged.push(rowsFrom.header);
    if (rowsFrom.query !== undefined && !named(query, rowsFrom.query.name)) query.push(rowsFrom.query);

    const fromHeaders = headersAndAuth(merged, label, this.report, blanked);
    let auth = ownAuth.auth.type === 'inherit' ? fromHeaders.auth : ownAuth.auth;
    if (stripped) {
      this.report.warn(`${label}: the credential in the URL was not imported; set it on the request.`);
      if (auth.type === 'inherit' && !named(merged, 'authorization')) {
        auth = { type: 'basic', ...(username !== undefined ? { username } : {}) };
      }
    }

    const body = graphql
      ? this.graphqlBody(details['body'], label, blanked)
      : this.body(details['body'], label, blanked);
    if (graphql) this.report.note(`${label}: GraphQL was imported as an HTTP POST; GraphQL support is tracked in #77.`);
    if (blanked.size > 0) {
      this.report.warn(
        `${label}: the recorded value of ${[...blanked].join(', ')} was not imported; set it on the request.`,
      );
    }
    const examples = this.examples(item.examples ?? [], label);
    return {
      ...createRestRequest(label, {
        newId: this.newId,
        order,
        slug,
        method,
        url,
        pathParams,
        query,
        headers: fromHeaders.headers,
        body,
        auth,
        settings: this.settings(item.settings, label),
      }),
      ...(examples.length > 0 ? { examples } : {}),
    };
  }

  /** A body file path, rewritten and resolved against the collection folder when there is one. */
  private filePath(raw: string, label: string): string {
    const rel = this.rewrite(raw);
    if (ABSOLUTE_PATH.test(rel)) return rel;
    if (this.rootDir === undefined) {
      this.report.warn(`${label}: the body file ${rel} is relative to the collection; check its path on the request.`);
      return rel;
    }
    return resolvePath(this.rootDir, rel);
  }

  private body(raw: unknown, label: string, blanked: Set<string>): RestBody {
    const { body, others, title } = pickVariant(raw);
    if (others.length > 0) {
      this.report.note(
        `${label}: the body "${title ?? ''}" was imported; the other variants were left out: ${others.join(', ')}.`,
      );
    }
    if (!isRecord(body)) return NO_BODY;
    const type = str(body['type']);
    const data = body['data'];
    switch (type) {
      case 'json':
        return { kind: 'raw', language: 'json', text: blankJsonText(this.rewrite(str(data)), blanked) };
      case 'xml':
        return { kind: 'raw', language: 'xml', text: this.rewrite(str(data)) };
      case 'text':
        return { kind: 'raw', language: 'text', text: blankText(this.rewrite(str(data)), undefined, blanked) };
      case 'sparql':
        return {
          kind: 'raw',
          language: 'text',
          contentType: 'application/sparql-query',
          text: this.rewrite(str(data)),
        };
      case 'form-urlencoded':
        return {
          kind: 'form',
          fields: rows(data).map((f) =>
            entry(f.name, blankIfLiteral(f.name, this.rewrite(scalar(f.value)), blanked), {
              enabled: f.disabled !== true,
            }),
          ),
        };
      case 'multipart-form':
        return { kind: 'multipart', parts: records(data).flatMap((p) => this.part(p, label, blanked)) };
      case 'file': {
        const files = records(data);
        const chosen = files.find((f) => f['selected'] === true) ?? files[0];
        if (chosen === undefined || str(chosen['filePath']) === '') return NO_BODY;
        return {
          kind: 'binary',
          source: { kind: 'path', path: this.filePath(str(chosen['filePath']), label) },
          contentType: str(chosen['contentType']) || 'application/octet-stream',
        };
      }
      default:
        this.report.note(`${label}: a ${type === '' ? 'body without a type' : `${type} body`} was left out.`);
        return NO_BODY;
    }
  }

  private part(raw: Rec, label: string, blanked: Set<string>): MultipartFormPart[] {
    if (typeof raw['name'] !== 'string') return [];
    const name = raw['name'];
    const enabled = raw['disabled'] !== true;
    const contentType = str(raw['contentType']);
    const typed = contentType !== '' ? { contentType } : {};
    if (raw['type'] === 'file') {
      const paths = (Array.isArray(raw['value']) ? raw['value'] : [raw['value']]).filter(
        (v): v is string => typeof v === 'string' && v !== '',
      );
      if (paths.length > 1) {
        this.report.note(`${label}: the file part "${name}" lists ${paths.length} files; only the first was imported.`);
      }
      const first = paths[0];
      if (first === undefined) return [];
      return [{ kind: 'file', name, source: { kind: 'path', path: this.filePath(first, label) }, enabled, ...typed }];
    }
    const value = blankIfLiteral(name, this.rewrite(scalar(raw['value'])), blanked);
    return [{ kind: 'text', name, value, enabled, ...typed }];
  }

  private graphqlBody(raw: unknown, label: string, blanked: Set<string>): RestBody {
    const { body, others, title } = pickVariant(raw);
    if (others.length > 0) {
      this.report.note(
        `${label}: the body "${title ?? ''}" was imported; the other variants were left out: ${others.join(', ')}.`,
      );
    }
    const graph = isRecord(body) ? body : {};
    const query = this.rewrite(str(graph['query']));
    let variables: unknown;
    const rawVariables = graph['variables'];
    if (typeof rawVariables === 'string' && rawVariables.trim() !== '') {
      const rewritten = this.rewrite(rawVariables);
      try {
        variables = JSON.parse(rewritten) as unknown;
      } catch {
        variables = rewritten;
      }
    } else if (isRecord(rawVariables)) {
      variables = rawVariables;
    }
    const text = JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) });
    return { kind: 'raw', language: 'json', contentType: 'application/json', text: blankJsonText(text, blanked) };
  }

  /** The REST settings the item names; any other setting is noted once. */
  private settings(raw: Rec | undefined, label: string): RestRequestSettings {
    if (raw === undefined) return {};
    const { timeout, followRedirects, maxRedirects, encodeUrl } = raw;
    const others = Object.keys(raw).filter((key) => !SETTINGS.has(key));
    if (others.length > 0) {
      this.report.note(`${label}: the settings ${others.join(', ')} have no Wirebench equivalent and were ignored.`);
    }
    return {
      ...(typeof timeout === 'number' && Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
      ...(typeof followRedirects === 'boolean' ? { followRedirects } : {}),
      ...(typeof maxRedirects === 'number' && Number.isFinite(maxRedirects) ? { maxRedirects } : {}),
      ...(typeof encodeUrl === 'boolean' ? { encodeUrl } : {}),
    };
  }

  /** The examples with a numeric status, masked as every importer masks a recorded response. */
  private examples(raw: readonly unknown[], label: string): RestResponseExample[] {
    const out: RestResponseExample[] = [];
    let skipped = 0;
    for (const example of raw) {
      const response = isRecord(example) && isRecord(example['response']) ? example['response'] : undefined;
      const status = response?.['status'];
      if (response === undefined || typeof status !== 'number' || !Number.isFinite(status)) {
        skipped += 1;
        continue;
      }
      const recorded = rows(response['headers']).map((h) => ({ name: h.name, value: scalar(h.value) }));
      const bodyRec = isRecord(response['body']) ? response['body'] : undefined;
      const bodyType = str(bodyRec?.['type']);
      let body = typeof bodyRec?.['data'] === 'string' ? bodyRec['data'] : undefined;
      if (bodyType === 'binary' && body !== undefined) {
        this.report.note(`${label}: a binary response body was left out of the example.`);
        body = undefined;
      }
      const contentType =
        recorded.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? EXAMPLE_TYPES[bodyType];
      const masked = maskRecordedResponse(recorded, body, contentType);
      if (masked.masked) this.report.note(`${label}: credentials in a recorded response were masked in its example.`);
      let kept = masked.body;
      if (kept !== undefined && kept.length > MAX_EXAMPLE_BODY_CHARS) {
        kept = kept.slice(0, MAX_EXAMPLE_BODY_CHARS);
        this.report.note(`${label}: a ${status} example body was larger than 256 KB and was cut.`);
      }
      const name = isRecord(example) ? str(example['name']) : '';
      out.push({
        id: this.newId(),
        name: name !== '' ? name : `${status}`,
        status,
        statusText: str(response['statusText']),
        headers: masked.headers,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(kept !== undefined ? { body: kept } : {}),
      });
    }
    if (skipped > 0) {
      this.report.note(`${label}: ${skipped} example(s) without a response status were skipped.`);
    }
    return out;
  }
}

/** Maps a read OpenCollection to Wirebench APIs. */
export function mapOpenCollection(
  collection: OcCollection,
  options: MapOpenCollectionOptions = {},
): MappedOpenCollection {
  const mapper = new Mapper(options.newId ?? generateId, options.rootDir);
  const name = collection.info.name !== '' ? collection.info.name : 'Collection';
  const rootAuth = mapper.auth(collection.request?.auth, name);
  const root = mapper.scopeBelow({ headers: [], auth: {} }, collection.request?.headers, rootAuth, name);
  const { folders, requests } = mapper.walk(collection.items, root);
  const rest =
    mapper.requests === 0
      ? undefined
      : createApi(name, {
          newId: options.newId ?? generateId,
          order: options.firstOrder ?? 0,
          baseUrl: '',
          servers: [],
          ...(rootAuth.auth.type !== 'inherit' ? { auth: rootAuth.auth } : {}),
          folders,
          requests,
        });
  if (mapper.dynamic.size > 0) {
    mapper.report.warn(
      `Dynamic variables are kept as written and not expanded: ${[...mapper.dynamic].sort().join(', ')}`,
    );
  }
  return {
    ...(rest !== undefined ? { rest } : {}),
    protoFiles: [],
    variables: { environments: [], report: { warnings: [], notes: [] } },
    scripts: [],
    counts: { requests: mapper.requests, folders: mapper.folders, assertions: 0, assertionsSkipped: 0 },
    report: mapper.report.build(),
  };
}
