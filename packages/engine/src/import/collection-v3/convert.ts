/**
 * The HTTP side of a folder (v3) collection written as the v2.1 JSON document it means, so it goes
 * through the same parser and mapper as an exported v2.1 collection: auth, bodies, `{{var}}`
 * templates, scripts, examples and variables then behave exactly as they do there. What the v2.1
 * document cannot say is reported here, per file.
 */

import type { ReportBuilder } from '#core/import/report';
import type { V3Folder, V3Request, V3Script } from './model.js';

type Rec = Readonly<Record<string, unknown>>;
type Json = Record<string, unknown>;

export const V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

const DEFINITION_FIELDS = new Set(['$kind', 'name', 'description', 'order', 'variables', 'auth', 'scripts']);
const HTTP_FIELDS = new Set([
  '$kind',
  'name',
  'description',
  'order',
  'url',
  'method',
  'headers',
  'queryParams',
  'pathVariables',
  'body',
  'auth',
  'settings',
  'scripts',
  'examples',
]);
/** HTTP settings the v2.1 document carries in `protocolProfileBehavior`. */
const HTTP_SETTINGS_READ = new Set(['followRedirects', 'maxRedirects']);
/** Raw body types and the v2.1 language each is written as. */
const RAW_BODIES: Readonly<Record<string, string>> = {
  json: 'json',
  text: 'text',
  xml: 'xml',
  html: 'html',
  javascript: 'javascript',
};

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A scalar as text; anything else as JSON, so nothing is silently lost. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export interface V3Row {
  readonly key: string;
  readonly value: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly extra: Rec;
}

/** A list of `{key, value, …}` or a `key: value` map, as rows. Rows without a key are dropped. */
export function rowsOf(value: unknown): V3Row[] {
  if (Array.isArray(value)) {
    const out: V3Row[] = [];
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const key = str(entry['key']) ?? str(entry['name']);
      if (key === undefined || key === '') continue;
      const description = str(entry['description']);
      out.push({
        key,
        value: text(entry['value']),
        ...(description !== undefined ? { description } : {}),
        ...(entry['disabled'] === true || entry['enabled'] === false ? { disabled: true } : {}),
        extra: entry,
      });
    }
    return out;
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== '')
      .map(([key, v]) => ({ key, value: text(v), extra: {} }));
  }
  return [];
}

function keyValues(rows: readonly V3Row[]): Json[] {
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    ...(row.description !== undefined ? { description: row.description } : {}),
    ...(row.disabled === true ? { disabled: true } : {}),
  }));
}

/** The fields of `doc` not in `known`, sorted. */
export function unknownFields(doc: Rec, known: ReadonlySet<string>): string[] {
  return Object.keys(doc)
    .filter((key) => !known.has(key))
    .sort();
}

export function reportUnread(report: ReportBuilder, path: string, fields: readonly string[]): void {
  if (fields.length > 0) {
    report.warn(
      `${path}: Wirebench does not read ${fields.join(', ')}, so ${fields.length === 1 ? 'it was' : 'they were'} left out.`,
    );
  }
}

/**
 * A v3 auth as the v2.1 `{type, <type>: [{key, value}]}`. A list of auths keeps its first and says
 * so; credentials may be a list of `{key, value}` or a map.
 */
export function v21Auth(raw: unknown, path: string, report: ReportBuilder): Json | undefined {
  let auth = raw;
  if (Array.isArray(raw)) {
    const records = raw.filter(isRecord);
    auth = records[0];
    if (records.length > 1) {
      const name = str(records[0]?.['name']);
      report.note(
        `${path}: it holds ${String(records.length)} auths; the first${name !== undefined ? ` ("${name}")` : ''} was imported and the others were left out.`,
      );
    }
  }
  if (!isRecord(auth)) return undefined;
  const type = str(auth['type'])?.toLowerCase();
  if (type === undefined || type === '') return undefined;
  const credentials = rowsOf(auth['credentials']).map((row) => ({ key: row.key, value: row.value }));
  return { type, [type]: credentials };
}

/**
 * Scripts as v2.1 events: `beforeRequest` → `prerequest`, `afterResponse` → `test`, with a prefix
 * (`http:`) for a definition's. Another protocol's or an unknown type is reported.
 */
function events(scripts: readonly V3Script[], prefix: string, path: string, report: ReportBuilder): Json[] {
  const out: Json[] = [];
  for (const script of scripts) {
    const listen =
      script.type === `${prefix}beforeRequest`
        ? 'prerequest'
        : script.type === `${prefix}afterResponse`
          ? 'test'
          : undefined;
    if (listen === undefined) {
      report.warn(
        `${path}: its ${script.type || 'untyped'} script runs where Wirebench has no scripts, so it was left out.`,
      );
      continue;
    }
    if (script.code.trim() !== '') out.push({ listen, script: { type: 'text/javascript', exec: script.code } });
  }
  return out;
}

function variables(raw: unknown): Json[] {
  return rowsOf(raw).map((row) => {
    const type = str(row.extra['type']);
    return {
      key: row.key,
      value: row.value,
      ...(row.description !== undefined ? { description: row.description } : {}),
      ...(row.disabled === true ? { disabled: true } : {}),
      ...(type !== undefined ? { type } : {}),
    };
  });
}

function body(raw: unknown, path: string, report: ReportBuilder): Json | undefined {
  if (!isRecord(raw)) return undefined;
  const type = str(raw['type'])?.toLowerCase();
  const content = raw['content'];
  if (type === undefined || type === 'none') return undefined;
  const language = Object.hasOwn(RAW_BODIES, type) ? RAW_BODIES[type] : undefined;
  if (language !== undefined) {
    return { mode: 'raw', raw: text(content), options: { raw: { language } } };
  }
  if (type === 'urlencoded') return { mode: 'urlencoded', urlencoded: keyValues(rowsOf(content)) };
  if (type === 'formdata') {
    const parts = rowsOf(content).map((row) => {
      const file = str(row.extra['type']) === 'file';
      const src = row.extra['src'];
      const contentType = str(row.extra['contentType']);
      return {
        key: row.key,
        type: file ? 'file' : 'text',
        ...(file
          ? { src: Array.isArray(src) ? src.filter((s) => typeof s === 'string') : text(src) }
          : { value: row.value }),
        ...(contentType !== undefined ? { contentType } : {}),
        ...(row.description !== undefined ? { description: row.description } : {}),
        ...(row.disabled === true ? { disabled: true } : {}),
      };
    });
    return { mode: 'formdata', formdata: parts };
  }
  if (type === 'file') {
    const src = str(raw['src']) ?? str(content) ?? (isRecord(content) ? str(content['src']) : undefined) ?? '';
    return { mode: 'file', file: { src } };
  }
  report.warn(`${path}: its body type "${type}" is unknown, so the body was left out.`);
  return undefined;
}

/** HTTP settings as v2.1 `protocolProfileBehavior`; the ones Wirebench does not take are listed. */
function settings(raw: unknown, unread: string[]): Json | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Json = {};
  for (const [key, value] of Object.entries(raw)) {
    if (HTTP_SETTINGS_READ.has(key)) out[key] = value;
    else if (!(key === 'strictSSL' && value === true)) unread.push(`settings.${key}`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function example(doc: Rec): Json {
  const response = isRecord(doc['response']) ? doc['response'] : {};
  const status = response['statusCode'];
  const bodyRec = isRecord(response['body']) ? response['body'] : undefined;
  const preview = str(bodyRec?.['type']);
  const content = bodyRec?.['content'];
  return {
    ...(str(doc['name']) !== undefined ? { name: doc['name'] } : {}),
    ...(typeof status === 'number'
      ? { code: status }
      : typeof status === 'string' && /^\d{3}$/.test(status)
        ? { code: Number(status) }
        : {}),
    ...(response['statusText'] !== undefined ? { status: text(response['statusText']) } : {}),
    header: rowsOf(response['headers']).map((row) => ({ key: row.key, value: row.value })),
    ...(content !== undefined && content !== null ? { body: text(content) } : {}),
    ...(preview !== undefined ? { _postman_previewlanguage: preview } : {}),
  };
}

function httpItem(request: V3Request, report: ReportBuilder): Json {
  const doc = request.doc;
  const unread = unknownFields(doc, HTTP_FIELDS);
  const description = str(doc['description']);
  const auth = v21Auth(doc['auth'], request.path, report);
  const behaviour = settings(doc['settings'], unread);
  const pathVariables = rowsOf(doc['pathVariables']);
  const query = rowsOf(doc['queryParams']);
  const requestBody = body(doc['body'], request.path, report);
  const event = events(request.scripts, '', request.path, report);
  reportUnread(report, request.path, unread);
  return {
    name: request.name,
    ...(description !== undefined ? { description } : {}),
    request: {
      method: (str(doc['method']) ?? 'GET').toUpperCase(),
      url: {
        raw: text(doc['url']),
        ...(query.length > 0 ? { query: keyValues(query) } : {}),
        ...(pathVariables.length > 0 ? { variable: keyValues(pathVariables) } : {}),
      },
      header: keyValues(rowsOf(doc['headers'])),
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      ...(auth !== undefined ? { auth } : {}),
    },
    ...(event.length > 0 ? { event } : {}),
    ...(request.examples.length > 0 ? { response: request.examples.map((e) => example(e.doc)) } : {}),
    ...(behaviour !== undefined ? { protocolProfileBehavior: behaviour } : {}),
  };
}

/** Where a folder's definition is, for the report. */
export function definitionPathOf(folder: V3Folder): string {
  return `${folder.path === '' ? '' : `${folder.path}/`}.resources/definition.yaml`;
}

/** Reports the fields a definition carries that Wirebench does not read. */
export function reportDefinitionFields(folder: V3Folder, report: ReportBuilder): void {
  if (folder.definition !== undefined) {
    reportUnread(report, definitionPathOf(folder), unknownFields(folder.definition, DEFINITION_FIELDS));
  }
}

/** A folder's or collection's own fields: description, auth, variables, scripts. */
function scopeFields(folder: V3Folder, report: ReportBuilder): Json {
  const definition = folder.definition;
  if (definition === undefined) return {};
  const where = definitionPathOf(folder);
  const description = str(definition['description']);
  const auth = v21Auth(definition['auth'], where, report);
  const variable = variables(definition['variables']);
  const event = events(folder.scripts, 'http:', where, report);
  return {
    ...(description !== undefined ? { description } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(variable.length > 0 ? { variable } : {}),
    ...(event.length > 0 ? { event } : {}),
  };
}

function items(folder: V3Folder, report: ReportBuilder): Json[] {
  const out: Json[] = [];
  for (const child of folder.children) {
    if (child.type === 'request') {
      if (child.kind === 'http-request') out.push(httpItem(child, report));
      continue;
    }
    const inner = items(child, report);
    // A folder with no HTTP request below it is no folder of the REST API.
    if (inner.length === 0) continue;
    out.push({ name: child.name, item: inner, ...scopeFields(child, report) });
  }
  return out;
}

/**
 * The collection's HTTP requests as a v2.1 collection document. Its definition's scripts of other
 * protocols, and its folders' definitions, are reported as they are written into it.
 */
export function v21DocumentOf(collection: V3Folder, name: string, report: ReportBuilder): Json {
  const own = scopeFields(collection, report);
  const { description, ...rest } = own;
  return {
    info: { name, schema: V21_SCHEMA, ...(description !== undefined ? { description } : {}) },
    item: items(collection, report),
    ...rest,
  };
}
