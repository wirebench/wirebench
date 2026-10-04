/**
 * Reading a `.http` request file from disk or text and turning it into REST and WebSocket APIs.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { HttpFileError } from '../../errors.js';
import type { IdGenerator } from '../../project/model.js';
import type { ParsedHttpFile } from '../../rest/http-file/parse.js';
import type { MappedHttpFile } from './map.js';
import { mapHttpFile } from './map.js';
import { MAX_HTTP_FILE_BYTES, parseHttpFile } from '../../rest/http-file/parse.js';

/** Where a `.http` file comes from: a file on disk, or text with an optional API name. */
export type HttpFileSource =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'text'; readonly text: string; readonly name?: string };

export interface ImportHttpFileOptions {
  readonly newId?: IdGenerator;
  readonly firstOrder?: number;
}

function tooLarge(): HttpFileError {
  return new HttpFileError(
    'http-file-too-large',
    `The .http file is larger than ${MAX_HTTP_FILE_BYTES / (1024 * 1024)} MB`,
  );
}

async function readSource(path: string): Promise<string> {
  let size: number | undefined;
  try {
    size = (await stat(path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_HTTP_FILE_BYTES) throw tooLarge();
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new HttpFileError(
      'http-file-read-failed',
      `Failed to read .http file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** A note for each `< file` body that is not beside the `.http` file; a path holding a template is not checked. */
async function missingBodyFiles(parsed: ParsedHttpFile, fileDir: string): Promise<string[]> {
  const notes: string[] = [];
  for (const request of parsed.requests) {
    const body = request.body;
    if (body?.kind !== 'file' || body.path.includes('{{')) continue;
    const path = resolve(fileDir, body.path);
    try {
      await stat(path);
    } catch {
      notes.push(`The body file ${path} (line ${request.line}) was not found.`);
    }
  }
  return notes;
}

/**
 * Reads, parses and maps a `.http` or `.rest` file. A file's API is named after it and its
 * `< file` bodies resolve beside it; text has no directory, so those stay relative.
 *
 * @throws HttpFileError `http-file-too-large`, `http-file-read-failed` or `http-file-too-many`.
 */
export async function importHttpFile(
  source: HttpFileSource,
  options: ImportHttpFileOptions = {},
): Promise<MappedHttpFile> {
  if (source.kind === 'text') {
    if (source.text.length > MAX_HTTP_FILE_BYTES) throw tooLarge();
    return mapHttpFile(parseHttpFile(source.text), { ...options, name: source.name ?? 'Imported requests' });
  }
  const path = resolve(source.path);
  const parsed = parseHttpFile(await readSource(path));
  const fileDir = dirname(path);
  const mapped = mapHttpFile(parsed, { ...options, name: basename(path).replace(/\.(http|rest)$/i, ''), fileDir });
  const missing = await missingBodyFiles(parsed, fileDir);
  if (missing.length === 0) return mapped;
  return { ...mapped, report: { ...mapped.report, notes: [...mapped.report.notes, ...missing] } };
}
