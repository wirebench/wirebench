/**
 * `.http` request file parser: a line state machine that yields the file variables and the
 * requests, with names, directives, headers, bodies and response handlers.
 *
 * Browser-safe: format detection may reach this module from the renderer, so it must stay free
 * of Node (`node:` modules, `Buffer`, ULIDs).
 */

import { HttpFileError } from '../../errors.js';

export const MAX_HTTP_FILE_BYTES = 10 * 1024 * 1024;

const MAX_REQUESTS = 5000;

export const HTTP_FILE_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
  'WEBSOCKET',
  'GRAPHQL',
  'GRPC',
]);

export interface HttpFileRequest {
  readonly name?: string;
  /** 1-based line number of the request line. */
  readonly line: number;
  readonly method: string;
  /** Query continuation lines are already joined. */
  readonly url: string;
  readonly httpVersion?: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly body?: { readonly kind: 'inline'; readonly text: string } | { readonly kind: 'file'; readonly path: string };
  readonly handlers: readonly { readonly kind: 'inline' | 'file'; readonly text: string }[];
  readonly redirects: number;
  readonly directives: readonly { readonly name: string; readonly value?: string }[];
}

export interface ParsedHttpFile {
  readonly variables: readonly { readonly name: string; readonly value: string; readonly line: number }[];
  readonly requests: readonly HttpFileRequest[];
}

interface Draft {
  name: string | undefined;
  line: number;
  method: string;
  url: string;
  httpVersion: string | undefined;
  headers: { name: string; value: string }[];
  bodyLines: string[];
  bodyFile: string | undefined;
  handlers: { kind: 'inline' | 'file'; text: string }[];
  redirects: number;
  directives: { name: string; value?: string }[];
}

type State = 'between' | 'headers' | 'body' | 'handler';

const VARIABLE = /^@([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;
const NAME_COMMENT = /^(?:#|\/\/)\s*@name\s+(\S+)/;
const DIRECTIVE_COMMENT = /^(?:#|\/\/)\s*@([\w-]+)(?:\s+(.*))?$/;
const REQUEST_LINE = /^(?:([A-Z]+)\s+)?(.+?)(?:\s+(HTTP\/[\d.]+))?\s*$/;
const HEADER = /^([^:\s]+):\s*(.*)$/;

function finish(draft: Draft): HttpFileRequest {
  let start = 0;
  let end = draft.bodyLines.length;
  while (start < end && draft.bodyLines[start]?.trim() === '') start += 1;
  while (end > start && draft.bodyLines[end - 1]?.trim() === '') end -= 1;
  const text = draft.bodyLines.slice(start, end).join('\n');
  const body: HttpFileRequest['body'] =
    draft.bodyFile !== undefined
      ? { kind: 'file', path: draft.bodyFile }
      : text === ''
        ? undefined
        : { kind: 'inline', text };
  return {
    ...(draft.name !== undefined ? { name: draft.name } : {}),
    line: draft.line,
    method: draft.method,
    url: draft.url,
    ...(draft.httpVersion !== undefined ? { httpVersion: draft.httpVersion } : {}),
    headers: draft.headers,
    ...(body !== undefined ? { body } : {}),
    handlers: draft.handlers,
    redirects: draft.redirects,
    directives: draft.directives,
  };
}

/** Parses the text of a `.http` file. Throws `HttpFileError` past 5,000 requests. */
export function parseHttpFile(text: string): ParsedHttpFile {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const variables: { name: string; value: string; line: number }[] = [];
  const requests: HttpFileRequest[] = [];
  let state: State = 'between';
  let draft: Draft | undefined;
  let pendingName: string | undefined;
  let pendingDirectives: { name: string; value?: string }[] = [];
  let handlerLines: string[] = [];

  const close = (): void => {
    if (draft !== undefined) requests.push(finish(draft));
    draft = undefined;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (line.startsWith('###')) {
      if (state === 'handler' && draft !== undefined) {
        draft.handlers.push({ kind: 'inline', text: handlerLines.join('\n').trim() });
        handlerLines = [];
      }
      close();
      const rest = line.slice(3).trim();
      pendingName = rest === '' ? undefined : rest;
      pendingDirectives = [];
      state = 'between';
      continue;
    }

    if (state === 'between') {
      const variable = VARIABLE.exec(line);
      if (variable) {
        variables.push({ name: variable[1] ?? '', value: (variable[2] ?? '').trim(), line: i + 1 });
        continue;
      }
      const named = NAME_COMMENT.exec(line);
      if (named) {
        pendingName = named[1];
        continue;
      }
      const directive = DIRECTIVE_COMMENT.exec(line);
      if (directive) {
        const value = directive[2]?.trim();
        pendingDirectives.push({
          name: directive[1] ?? '',
          ...(value !== undefined && value !== '' ? { value } : {}),
        });
        continue;
      }
      if (line.trim() === '' || line.startsWith('#') || line.startsWith('//')) continue;
      const match = REQUEST_LINE.exec(line.trim());
      if (!match) continue;
      if (requests.length >= MAX_REQUESTS) {
        throw new HttpFileError('http-file-too-many', 'The file holds more than 5,000 requests');
      }
      const known = match[1] !== undefined && HTTP_FILE_METHODS.has(match[1]);
      draft = {
        name: pendingName,
        line: i + 1,
        method: known ? (match[1] ?? 'GET') : 'GET',
        url: known ? (match[2] ?? '') : line.trim(),
        httpVersion: known ? match[3] : undefined,
        headers: [],
        bodyLines: [],
        bodyFile: undefined,
        handlers: [],
        redirects: 0,
        directives: pendingDirectives,
      };
      pendingName = undefined;
      pendingDirectives = [];
      state = 'headers';
      continue;
    }

    if (draft === undefined) continue;

    if (state === 'headers') {
      if (draft.headers.length === 0 && /^\s+[?&]/.test(line)) {
        draft.url += line.trim();
        continue;
      }
      const header = HEADER.exec(line);
      if (header) {
        draft.headers.push({ name: header[1] ?? '', value: (header[2] ?? '').trim() });
        continue;
      }
      if (line.trim() === '') state = 'body';
      continue;
    }

    if (state === 'handler') {
      if (line.trim() === '%}') {
        draft.handlers.push({ kind: 'inline', text: handlerLines.join('\n').trim() });
        handlerLines = [];
        state = 'body';
      } else {
        handlerLines.push(line);
      }
      continue;
    }

    // state === 'body'
    if (/^>\s*\{%\s*$/.test(line)) {
      handlerLines = [];
      state = 'handler';
      continue;
    }
    const oneLine = /^>\s*\{%(.*)%\}\s*$/.exec(line);
    if (oneLine) {
      draft.handlers.push({ kind: 'inline', text: (oneLine[1] ?? '').trim() });
      continue;
    }
    const handlerFile = /^>\s+(\S+)\s*$/.exec(line);
    if (handlerFile) {
      draft.handlers.push({ kind: 'file', text: handlerFile[1] ?? '' });
      continue;
    }
    if (/^>>!?\s/.test(line)) {
      draft.redirects += 1;
      continue;
    }
    const bodyFile = /^<\s+(\S+)\s*$/.exec(line);
    if (bodyFile && draft.bodyFile === undefined && draft.bodyLines.every((l) => l.trim() === '')) {
      draft.bodyFile = bodyFile[1];
      continue;
    }
    draft.bodyLines.push(line);
  }

  if (state === 'handler' && draft !== undefined) {
    draft.handlers.push({ kind: 'inline', text: handlerLines.join('\n').trim() });
  }
  close();
  return { variables, requests };
}
