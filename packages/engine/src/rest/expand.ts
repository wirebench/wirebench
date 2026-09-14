/**
 * Property expansion for a REST send: every `${…}` reference in the base URL, the URL, the tables
 * and the body, resolved against the same scopes a SOAP send uses.
 *
 * Separate from `project/properties.ts`'s `expandSendInput` because the two inputs share no fields,
 * but the rules are deliberately the same ones: names as well as values are expanded, an
 * unresolved reference is reported rather than guessed at, and escaping is applied to the body
 * alone — escaping a header value or a URL would corrupt it.
 */

import { expand } from '../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { escapeForLanguage } from './body.js';
import type { KeyValueEntry, MultipartFormPart, RestBody } from './model.js';
import type { RestSendInput, RestSendRequest } from './send.js';

/** Options for {@link expandRestSendInput}. */
export interface ExpandRestOptions {
  /**
   * Escape substituted values for the body's own language — JSON string escaping, or the five XML
   * entities — which is the request's *escape properties* setting. Off by default.
   */
  readonly escape?: boolean;
}

/**
 * Expands every property reference in a REST send input.
 *
 * What is expanded: the base URL, the URL (including its `{param}` names' values), every path,
 * query and header row's name and value, a raw body's text, form field and multipart text values,
 * and a file part's path — the two places a property can reasonably appear in a file reference, as
 * for a SOAP attachment. What is not: a file's cache hash, which is content-addressed rather than
 * authored.
 *
 * Escaping is applied only to values substituted *into the body*, and only when asked. A header or
 * a URL is never escaped: `&amp;` in a query string is a different request.
 */
export function expandRestSendInput(
  input: RestSendInput,
  scopes: PropertyScopes,
  options: ExpandRestOptions = {},
): { readonly input: RestSendInput; readonly unresolved: UnresolvedRef[] } {
  const unresolved: UnresolvedRef[] = [];

  const run = (text: string): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    return result.text;
  };

  /** A body value: expanded, then escaped for the body's language when the request asks for it. */
  const runBody = (text: string, language: Parameters<typeof escapeForLanguage>[1] | undefined): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    if (options.escape !== true || language === undefined) {
      return result.text;
    }
    // Escaping has to happen per substituted value, not over the finished text, or the body's own
    // punctuation would be escaped too. `expand` reports which references it replaced, so the
    // cheapest correct thing is to re-expand with an escaping substitution.
    return expand(text, escapedScopes(scopes, language)).text;
  };

  const rows = (entries: readonly KeyValueEntry[]): KeyValueEntry[] =>
    entries.map((entry) => ({ ...entry, name: run(entry.name), value: run(entry.value) }));

  const request: RestSendRequest = {
    method: input.request.method,
    url: run(input.request.url),
    pathParams: rows(input.request.pathParams),
    query: rows(input.request.query),
    headers: rows(input.request.headers),
    body: expandBody(input.request.body, run, runBody),
  };

  return {
    input: { ...input, baseUrl: run(input.baseUrl), request },
    unresolved,
  };
}

/** The same scopes with every value escaped for `language`, so substitution escapes as it goes. */
function escapedScopes(scopes: PropertyScopes, language: Parameters<typeof escapeForLanguage>[1]): PropertyScopes {
  const escapeMap = (map: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(map ?? {})) {
      if (value !== undefined) {
        out[name] = escapeForLanguage(value, language);
      }
    }
    return out;
  };
  return {
    ...scopes,
    project: escapeMap(scopes.project),
    global: escapeMap(scopes.global),
    system: escapeMap(scopes.system),
    ...(scopes.env !== undefined ? { env: escapeMap(scopes.env) } : {}),
    ...(scopes.workspace !== undefined ? { workspace: escapeMap(scopes.workspace) } : {}),
  };
}

function expandBody(
  body: RestBody,
  run: (text: string) => string,
  runBody: (text: string, language: Parameters<typeof escapeForLanguage>[1] | undefined) => string,
): RestBody {
  switch (body.kind) {
    case 'raw':
      return { ...body, text: runBody(body.text, body.language) };
    case 'form':
      return {
        kind: 'form',
        fields: body.fields.map((field) => ({ ...field, name: run(field.name), value: runBody(field.value, 'form') })),
      };
    case 'multipart':
      return { kind: 'multipart', parts: body.parts.map((part) => expandPart(part, run)) };
    case 'binary':
      return body.source.kind === 'path' ? { ...body, source: { kind: 'path', path: run(body.source.path) } } : body;
    default:
      return body;
  }
}

function expandPart(part: MultipartFormPart, run: (text: string) => string): MultipartFormPart {
  if (part.kind === 'text') {
    return { ...part, name: run(part.name), value: run(part.value) };
  }
  return {
    ...part,
    name: run(part.name),
    ...(part.fileName !== undefined ? { fileName: run(part.fileName) } : {}),
    source: part.source.kind === 'path' ? { kind: 'path', path: run(part.source.path) } : part.source,
  };
}
