/**
 * Parsing and normalizing Postman Collection v2.0 and v2.1 documents.
 *
 * Handles tolerant parsing of Postman JSON exports, variable translation (`{{var}}` to `${var}`),
 * path parameter syntax normalization (`:param` to `{param}`), and structure validation.
 */

import { PostmanError } from '../../errors.js';
import type {
  PostmanAuth,
  PostmanAuthAttribute,
  PostmanBody,
  PostmanCollection,
  PostmanFormDataParam,
  PostmanHeader,
  PostmanInfo,
  PostmanItem,
  PostmanQueryParam,
  PostmanRequest,
  PostmanUrl,
  PostmanUrlEncodedParam,
  PostmanVariable,
} from './model.js';

type Record_ = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Translates Postman's `{{var}}` variable interpolation to Wirebench's `${var}` format. */
export function translatePostmanVariables(text: string): string {
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, '${$1}');
}

/** Normalizes Postman's `:param` path segment syntax to Wirebench's `{param}` format. */
export function normalizePostmanPath(path: string): string {
  return path.replace(/(^|\/):([a-zA-Z0-9_-]+)(?=\/|\?|#|$)/g, '$1{$2}');
}

export function extractDescription(desc: unknown): string | undefined {
  if (typeof desc === 'string') {
    return desc;
  }
  if (isRecord(desc) && typeof desc['content'] === 'string') {
    return desc['content'];
  }
  return undefined;
}

/** Checks whether a parsed JSON object has the shape of a Postman Collection. */
export function isPostmanCollection(root: unknown): boolean {
  if (!isRecord(root)) {
    return false;
  }
  const info = root['info'];
  if (!isRecord(info)) {
    return false;
  }
  const schema = asString(info['schema']);
  if (schema !== undefined && schema.includes('schema.getpostman.com/json/collection')) {
    return true;
  }
  return typeof info['name'] === 'string' && Array.isArray(root['item']);
}

/**
 * Parses JSON text as a Postman Collection.
 *
 * @throws PostmanError `postman-malformed` if invalid JSON, or `postman-not-a-collection`.
 */
export function parsePostmanCollectionText(text: string): PostmanCollection {
  const trimmed = text.replace(/^﻿/, '').trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (error) {
    throw new PostmanError(
      'postman-malformed',
      `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parsePostmanCollection(json);
}

/** Validates and normalizes an already parsed Postman JSON structure into {@link PostmanCollection}. */
export function parsePostmanCollection(root: unknown): PostmanCollection {
  if (!isPostmanCollection(root)) {
    throw new PostmanError(
      'postman-not-a-collection',
      'This file does not contain a Postman Collection (v2.0 or v2.1)',
    );
  }
  const doc = root as Record_;
  const rawInfo = doc['info'] as Record_;

  const desc = extractDescription(rawInfo['description']);
  const version = asString(rawInfo['version']);
  const schema = asString(rawInfo['schema']);
  const postmanId = asString(rawInfo['_postman_id']);

  const info: PostmanInfo = {
    name: translatePostmanVariables(asString(rawInfo['name']) ?? 'Imported Collection'),
    ...(desc !== undefined ? { description: desc } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(postmanId !== undefined ? { _postman_id: postmanId } : {}),
  };

  const rawItems = Array.isArray(doc['item']) ? doc['item'] : [];
  const item = rawItems.filter(isRecord).map(parseItem);
  const auth = isRecord(doc['auth']) ? parseAuth(doc['auth']) : undefined;
  const variable = Array.isArray(doc['variable']) ? parseVariables(doc['variable']) : undefined;

  return {
    info,
    item,
    ...(auth !== undefined ? { auth } : {}),
    ...(variable !== undefined ? { variable } : {}),
  };
}

function parseItem(raw: Record_): PostmanItem {
  const name = translatePostmanVariables(asString(raw['name']) ?? 'Request');
  const description = extractDescription(raw['description']);
  const auth = isRecord(raw['auth']) ? parseAuth(raw['auth']) : undefined;
  const variable = Array.isArray(raw['variable']) ? parseVariables(raw['variable']) : undefined;

  if (Array.isArray(raw['item'])) {
    // Folder item
    const children = raw['item'].filter(isRecord).map(parseItem);
    return {
      name,
      item: children,
      ...(description !== undefined ? { description } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(variable !== undefined ? { variable } : {}),
    };
  }

  // Request item
  const request = parseRequest(raw['request']);
  return {
    name,
    request,
    ...(description !== undefined ? { description } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(variable !== undefined ? { variable } : {}),
  };
}

function parseRequest(raw: unknown): PostmanRequest | string {
  if (typeof raw === 'string') {
    return normalizePostmanPath(translatePostmanVariables(raw));
  }
  if (!isRecord(raw)) {
    return { method: 'GET', url: '' };
  }

  const method = asString(raw['method'])?.toUpperCase() ?? 'GET';
  const url = parseUrl(raw['url']);
  const header = parseHeaders(raw['header']);
  const body = isRecord(raw['body']) ? parseBody(raw['body']) : undefined;
  const auth = isRecord(raw['auth']) ? parseAuth(raw['auth']) : undefined;
  const description = extractDescription(raw['description']);

  return {
    method,
    url,
    header,
    ...(body !== undefined ? { body } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function parseUrl(raw: unknown): PostmanUrl {
  if (typeof raw === 'string') {
    return { raw: normalizePostmanPath(translatePostmanVariables(raw)) };
  }
  if (!isRecord(raw)) {
    return { raw: '' };
  }

  const rawString = asString(raw['raw']);
  let rawUrl: string | undefined;
  if (rawString !== undefined) {
    rawUrl = normalizePostmanPath(translatePostmanVariables(rawString));
  } else {
    // Construct raw URL from parts if raw is omitted
    const protocol = asString(raw['protocol']) ? `${asString(raw['protocol'])}://` : '';
    let host = '';
    if (Array.isArray(raw['host'])) {
      host = raw['host'].filter((h): h is string => typeof h === 'string').join('.');
    } else if (typeof raw['host'] === 'string') {
      host = raw['host'];
    }
    const port = asString(raw['port']) ? `:${asString(raw['port'])}` : '';
    let path = '';
    if (Array.isArray(raw['path'])) {
      path = '/' + raw['path'].filter((p): p is string => typeof p === 'string').join('/');
    } else if (typeof raw['path'] === 'string') {
      path = raw['path'].startsWith('/') ? raw['path'] : `/${raw['path']}`;
    }
    rawUrl = normalizePostmanPath(translatePostmanVariables(`${protocol}${host}${port}${path}`));
  }

  const query: PostmanQueryParam[] = [];
  if (Array.isArray(raw['query'])) {
    for (const q of raw['query']) {
      if (!isRecord(q)) continue;
      const key = asString(q['key']);
      const value = asString(q['value']);
      const desc = extractDescription(q['description']);
      if (key !== undefined) {
        query.push({
          key: translatePostmanVariables(key),
          value: value !== undefined ? translatePostmanVariables(value) : '',
          ...(desc !== undefined ? { description: desc } : {}),
          ...(asBoolean(q['disabled']) === true ? { disabled: true } : {}),
        });
      }
    }
  }

  const variable: PostmanVariable[] = [];
  if (Array.isArray(raw['variable'])) {
    for (const v of raw['variable']) {
      if (!isRecord(v)) continue;
      const key = asString(v['key']);
      if (key !== undefined) {
        // Strip leading colon if present
        const cleanKey = key.startsWith(':') ? key.slice(1) : key;
        const val = asString(v['value']);
        const desc = extractDescription(v['description']);
        variable.push({
          key: cleanKey,
          value: val !== undefined ? translatePostmanVariables(val) : '',
          ...(desc !== undefined ? { description: desc } : {}),
        });
      }
    }
  }

  return {
    raw: rawUrl,
    ...(query.length > 0 ? { query } : {}),
    ...(variable.length > 0 ? { variable } : {}),
  };
}

function parseHeaders(raw: unknown): readonly PostmanHeader[] {
  if (typeof raw === 'string') {
    // Parse raw newline-delimited headers
    const lines = raw.split(/\r?\n/);
    const headers: PostmanHeader[] = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key.length > 0) {
        headers.push({
          key: translatePostmanVariables(key),
          value: translatePostmanVariables(value),
        });
      }
    }
    return headers;
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  const headers: PostmanHeader[] = [];
  for (const h of raw) {
    if (!isRecord(h)) continue;
    const key = asString(h['key']);
    const value = asString(h['value']) ?? '';
    const desc = extractDescription(h['description']);
    if (key !== undefined && key.length > 0) {
      headers.push({
        key: translatePostmanVariables(key),
        value: translatePostmanVariables(value),
        ...(desc !== undefined ? { description: desc } : {}),
        ...(asBoolean(h['disabled']) === true ? { disabled: true } : {}),
      });
    }
  }
  return headers;
}

function parseBody(raw: Record_): PostmanBody {
  const mode = asString(raw['mode']);

  if (mode === 'raw') {
    const rawText = asString(raw['raw']) ?? '';
    let options: PostmanBody['options'] | undefined;
    if (isRecord(raw['options']) && isRecord(raw['options']['raw'])) {
      const rawLanguage = asString(raw['options']['raw']['language']);
      options = {
        raw: {
          ...(rawLanguage !== undefined ? { language: rawLanguage } : {}),
        },
      };
    }
    return {
      mode: 'raw',
      raw: translatePostmanVariables(rawText),
      ...(options !== undefined ? { options } : {}),
    };
  }

  if (mode === 'urlencoded') {
    const params: PostmanUrlEncodedParam[] = [];
    if (Array.isArray(raw['urlencoded'])) {
      for (const p of raw['urlencoded']) {
        if (!isRecord(p)) continue;
        const key = asString(p['key']);
        const desc = extractDescription(p['description']);
        if (key !== undefined) {
          params.push({
            key: translatePostmanVariables(key),
            value: translatePostmanVariables(asString(p['value']) ?? ''),
            ...(desc !== undefined ? { description: desc } : {}),
            ...(asBoolean(p['disabled']) === true ? { disabled: true } : {}),
          });
        }
      }
    }
    return {
      mode: 'urlencoded',
      urlencoded: params,
    };
  }

  if (mode === 'formdata') {
    const parts: PostmanFormDataParam[] = [];
    if (Array.isArray(raw['formdata'])) {
      for (const p of raw['formdata']) {
        if (!isRecord(p)) continue;
        const key = asString(p['key']);
        if (key !== undefined) {
          const type = asString(p['type']) === 'file' ? 'file' : 'text';
          const value = asString(p['value']);
          const src = asString(p['src']);
          const contentType = asString(p['contentType']);
          const desc = extractDescription(p['description']);
          const disabled = asBoolean(p['disabled']);
          parts.push({
            key: translatePostmanVariables(key),
            type,
            ...(value !== undefined ? { value: translatePostmanVariables(value) } : {}),
            ...(src !== undefined ? { src } : {}),
            ...(contentType !== undefined ? { contentType } : {}),
            ...(desc !== undefined ? { description: desc } : {}),
            ...(disabled === true ? { disabled: true } : {}),
          });
        }
      }
    }
    return {
      mode: 'formdata',
      formdata: parts,
    };
  }

  if (mode === 'file') {
    const fileObj = isRecord(raw['file']) ? raw['file'] : {};
    const src = asString(fileObj['src']);
    return {
      mode: 'file',
      file: {
        ...(src !== undefined ? { src } : {}),
      },
    };
  }

  if (mode === 'graphql') {
    const gql = isRecord(raw['graphql']) ? raw['graphql'] : {};
    const query = asString(gql['query']) ?? '';
    const variables = asString(gql['variables']) ?? '';
    const graphqlJson = JSON.stringify({ query, variables });
    return {
      mode: 'raw',
      raw: translatePostmanVariables(graphqlJson),
      options: { raw: { language: 'json' } },
    };
  }

  return { mode: 'raw', raw: '' };
}

function parseAuth(raw: Record_): PostmanAuth {
  const type = asString(raw['type'])?.toLowerCase();
  const extractAttributes = (field: string): readonly PostmanAuthAttribute[] | undefined => {
    const list = raw[field];
    if (Array.isArray(list)) {
      const attrs: PostmanAuthAttribute[] = [];
      for (const entry of list) {
        if (!isRecord(entry)) continue;
        const key = asString(entry['key']);
        const attrType = asString(entry['type']);
        if (key !== undefined) {
          attrs.push({
            key,
            value: entry['value'],
            ...(attrType !== undefined ? { type: attrType } : {}),
          });
        }
      }
      return attrs.length > 0 ? attrs : undefined;
    }
    if (isRecord(list)) {
      const attrs: PostmanAuthAttribute[] = [];
      for (const [key, val] of Object.entries(list)) {
        if (isRecord(val) && 'value' in val) {
          attrs.push({
            key,
            value: val['value'],
            ...(typeof val['type'] === 'string' ? { type: val['type'] } : {}),
          });
        } else {
          attrs.push({
            key,
            value: val,
          });
        }
      }
      return attrs.length > 0 ? attrs : undefined;
    }
    return undefined;
  };

  const basic = extractAttributes('basic');
  const bearer = extractAttributes('bearer');
  const apikey = extractAttributes('apikey');
  const oauth2 = extractAttributes('oauth2');
  const ntlm = extractAttributes('ntlm');

  return {
    ...(type !== undefined ? { type } : {}),
    ...(basic !== undefined ? { basic } : {}),
    ...(bearer !== undefined ? { bearer } : {}),
    ...(apikey !== undefined ? { apikey } : {}),
    ...(oauth2 !== undefined ? { oauth2 } : {}),
    ...(ntlm !== undefined ? { ntlm } : {}),
  };
}

function asVariableValue(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return undefined;
}

function parseVariables(raw: readonly unknown[]): readonly PostmanVariable[] {
  const vars: PostmanVariable[] = [];
  for (const v of raw) {
    if (!isRecord(v)) continue;
    const key = asString(v['key']);
    if (key !== undefined) {
      const varType = asString(v['type']);
      const desc = extractDescription(v['description']);
      const val = asVariableValue(v['value']);
      vars.push({
        key,
        ...(val !== undefined ? { value: val } : {}),
        ...(varType !== undefined ? { type: varType } : {}),
        ...(desc !== undefined ? { description: desc } : {}),
      });
    }
  }
  return vars;
}
