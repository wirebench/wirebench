/**
 * HAR 1.1 and 1.2 parser.
 *
 * Browser-safe: {@link isHar} is called by format detection in the renderer, so this module and
 * everything it imports must stay free of Node (`node:` modules, `Buffer`, ULIDs).
 */

import { HarError } from '../../errors.js';
import type { HarEntryIn, HarLogIn, HarNameValue, HarPostData } from './model.js';

export { MAX_HAR_INPUT_BYTES } from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `root` is a HAR document: a `log` with a string `version` and an `entries` array. */
export function isHar(root: unknown): boolean {
  if (!isRecord(root)) return false;
  const log = root['log'];
  return isRecord(log) && typeof log['version'] === 'string' && Array.isArray(log['entries']);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nameValues(value: unknown): HarNameValue[] {
  if (!Array.isArray(value)) return [];
  const out: HarNameValue[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item['name'] === 'string') {
      out.push({ name: item['name'], value: str(item['value']) ?? '' });
    }
  }
  return out;
}

function postData(value: unknown): HarPostData | undefined {
  if (!isRecord(value)) return undefined;
  const text = str(value['text']);
  const params = Array.isArray(value['params'])
    ? value['params'].flatMap((param) => {
        if (!isRecord(param) || typeof param['name'] !== 'string') return [];
        const entry: { name: string; value?: string; fileName?: string; contentType?: string } = {
          name: param['name'],
        };
        const paramValue = str(param['value']);
        const fileName = str(param['fileName']);
        const contentType = str(param['contentType']);
        if (paramValue !== undefined) entry.value = paramValue;
        if (fileName !== undefined) entry.fileName = fileName;
        if (contentType !== undefined) entry.contentType = contentType;
        return [entry];
      })
    : undefined;
  return {
    mimeType: str(value['mimeType']) ?? '',
    ...(text !== undefined ? { text } : {}),
    ...(params !== undefined ? { params } : {}),
  };
}

function normalizeEntry(raw: unknown): HarEntryIn | undefined {
  if (!isRecord(raw)) return undefined;
  const request = raw['request'];
  if (!isRecord(request)) return undefined;
  const method = str(request['method']);
  const url = str(request['url']);
  if (method === undefined || method === '' || url === undefined || url === '') return undefined;
  const response = isRecord(raw['response']) ? raw['response'] : {};
  const content = isRecord(response['content']) ? response['content'] : {};
  const text = str(content['text']);
  const encoding = str(content['encoding']);
  const body = postData(request['postData']);
  const resourceType = str(raw['_resourceType']);
  return {
    startedDateTime: str(raw['startedDateTime']) ?? '',
    time: typeof raw['time'] === 'number' ? raw['time'] : 0,
    ...(resourceType !== undefined ? { resourceType } : {}),
    request: {
      method,
      url,
      headers: nameValues(request['headers']),
      queryString: nameValues(request['queryString']),
      ...(body !== undefined ? { postData: body } : {}),
    },
    response: {
      status: typeof response['status'] === 'number' ? response['status'] : 0,
      statusText: str(response['statusText']) ?? '',
      headers: nameValues(response['headers']),
      content: {
        mimeType: str(content['mimeType']) ?? '',
        ...(text !== undefined ? { text } : {}),
        ...(encoding !== undefined ? { encoding } : {}),
      },
    },
  };
}

/**
 * Parses HAR text into a normalized log, in file order. An entry with no request method or URL is
 * dropped and counted in `skippedMalformed`; fields the importer does not read, `_` extensions
 * other than `_resourceType` among them, are ignored.
 *
 * @throws HarError `har-malformed` if the text is not JSON, or `har-not-har` if it is not a HAR log.
 */
export function parseHarText(text: string): HarLogIn {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new HarError(
      'har-malformed',
      `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isHar(json)) {
    throw new HarError('har-not-har', 'The file is not a HAR capture: it has no log with a version and entries.');
  }
  const log = (json as { log: { version: string; entries: unknown[] } }).log;
  const entries: HarEntryIn[] = [];
  let skippedMalformed = 0;
  for (const raw of log.entries) {
    const entry = normalizeEntry(raw);
    if (entry === undefined) skippedMalformed += 1;
    else entries.push(entry);
  }
  return { version: log.version, entries, skippedMalformed };
}
