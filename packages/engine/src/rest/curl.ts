/**
 * A REST request as a `curl` command, and a pasted `curl` command as a REST request.
 *
 * Both directions are conveniences with a sharp edge: what is exported must be *exactly* what the app
 * would send, or a user debugging a difference between the two chases a ghost. So the exporter takes
 * the resolved {@link RestSendInput} — the same value the send path uses, with the URL composed, the
 * credentials applied and the settings decided — rather than the saved request, which still has
 * properties to expand and a chain of auth to walk.
 *
 * The importer is the looser half by nature: a command in the wild may use flags this client has no
 * field for. Anything understood becomes a field, everything else becomes a problem the dialog shows,
 * and nothing is guessed at.
 */

import type { CurlBody, CurlCommand, CurlHeader, ToCurlOptions } from '../http/curl.js';
import { toCurl } from '../http/curl.js';
import type { KeyValueEntry, RawLanguage, RestBody, RestMethod, RestRequestSettings } from './model.js';
import { entry, RAW_LANGUAGE_CONTENT_TYPES } from './model.js';
import type { RestSendInput } from './send.js';
import { applyAuth } from './auth.js';
import { composeUrl, splitQuery, trimTrailingSlashes } from './url.js';

/** What a redacted secret reads as in an exported command. Matches the host's own marker. */
export const CURL_REDACTED = '<redacted>';

/** A stand-in that survives URL encoding untouched, swapped for {@link CURL_REDACTED} afterwards. */
const QUERY_STAND_IN = 'wirebenchRedactedValue';

/** Options for {@link restToCurl}. */
export interface RestToCurlOptions extends ToCurlOptions {
  /**
   * Replace every credential value with {@link CURL_REDACTED}. On unless the session's show-secrets
   * switch is on, so a command copied for a colleague does not carry a token with it.
   */
  readonly redactSecrets?: boolean;
}

/** The body of an exported command, per kind. */
function curlBody(body: RestBody): CurlBody {
  switch (body.kind) {
    case 'raw':
      return { kind: 'raw', text: body.text };
    case 'form':
      return {
        kind: 'form',
        fields: body.fields.filter((field) => field.enabled).map((field) => ({ name: field.name, value: field.value })),
      };
    case 'multipart':
      return {
        kind: 'multipart',
        parts: body.parts
          .filter((part) => part.enabled)
          .map((part) =>
            part.kind === 'file'
              ? {
                  kind: 'file',
                  name: part.name,
                  path: part.source.kind === 'path' ? part.source.path : '',
                  ...(part.contentType !== undefined ? { contentType: part.contentType } : {}),
                }
              : {
                  kind: 'text',
                  name: part.name,
                  value: part.value,
                  ...(part.contentType !== undefined ? { contentType: part.contentType } : {}),
                },
          ),
      };
    case 'binary':
      return { kind: 'binary', path: body.source.kind === 'path' ? body.source.path : '' };
    default:
      return { kind: 'none' };
  }
}

/**
 * Builds a `curl` command for one resolved REST send.
 *
 * Credentials go on as they will go on the wire: a bearer token, an OAuth2 access token and a header
 * API key as `--header`, a query API key in the URL, and Basic as `--user` — which is what `curl`
 * users expect, and which also keeps a non-preemptive Basic credential behaving as it does here (curl
 * waits for the challenge too).
 */
export function restToCurl(input: RestSendInput, options: RestToCurlOptions = {}): string {
  const redact = options.redactSecrets !== false;
  const applied = applyAuth(input.auth);
  // A credential in the query is composed under an encoding-safe stand-in and swapped afterwards:
  // `composeUrl` would otherwise percent-encode the marker's own angle brackets, leaving the user
  // reading `%3Credacted%3E` where the point was to be legible.
  const composed = composeUrl(
    input.baseUrl,
    input.request.url,
    input.request.pathParams,
    [...input.request.query, ...applied.query.map((row) => (redact ? { ...row, value: QUERY_STAND_IN } : row))],
    { encode: input.settings.encodeUrl ?? true },
  );
  const url = redact ? composed.url.split(QUERY_STAND_IN).join(CURL_REDACTED) : composed.url;

  const headers: CurlHeader[] = [];
  for (const row of input.request.headers) {
    if (row.enabled) {
      headers.push({ name: row.name, value: row.value });
    }
  }
  for (const [name, value] of Object.entries(applied.headers)) {
    headers.push({ name, value: redact ? CURL_REDACTED : value });
  }

  const transport = applied.transportAuth;
  const basic =
    transport?.type === 'basic'
      ? { username: transport.username, password: redact ? CURL_REDACTED : transport.password }
      : undefined;

  const command: CurlCommand = {
    method: input.request.method,
    url,
    headers,
    body: curlBody(input.request.body),
    ...(basic !== undefined ? { basic } : {}),
    ...(input.tls?.rejectUnauthorized === false ? { insecure: true } : {}),
    ...(input.settings.followRedirects ? { followRedirects: true } : {}),
    ...(input.settings.followRedirects && input.settings.maxRedirects !== undefined
      ? { maxRedirects: input.settings.maxRedirects }
      : {}),
  };
  return toCurl(command, options.shell !== undefined ? { shell: options.shell } : {});
}

/** What a pasted command turned into, and what it could not. */
export interface FromRestCurlResult {
  /** The fields a new or edited request should take. Absent fields were not in the command. */
  readonly request: {
    readonly method?: RestMethod;
    readonly url?: string;
    readonly pathParams?: readonly KeyValueEntry[];
    readonly query?: readonly KeyValueEntry[];
    readonly headers?: readonly KeyValueEntry[];
    readonly body?: RestBody;
    readonly settings?: RestRequestSettings;
  };
  /**
   * A `-u` password, for the caller to store in the keychain and reference. Never put in `request`:
   * nothing in the model holds a credential value (ADR-0004).
   */
  readonly basic?: { readonly username: string; readonly password?: string };
  /** What the command said that this client has no field for, in the order it was met. */
  readonly problems: readonly string[];
}

/** Options for {@link fromRestCurl}. */
export interface FromRestCurlOptions {
  /**
   * The API's base URL. A command whose URL starts with it is split, so the request keeps a relative
   * path and follows the API's environment overrides like every other request in it.
   */
  readonly baseUrl?: string;
}

/** Flags that take no value, so a parser must not eat the token after them. */
const BOOLEAN_FLAGS = new Set([
  '-k',
  '--insecure',
  '-L',
  '--location',
  '-s',
  '--silent',
  '-v',
  '--verbose',
  '-i',
  '--include',
  '-f',
  '--fail',
  '-g',
  '--globoff',
  '--compressed',
  '-4',
  '-6',
  '--http1.1',
  '--http2',
]);

/** The raw-body language a content type implies. */
function languageOf(contentType: string | undefined): RawLanguage {
  if (contentType === undefined) {
    return 'text';
  }
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/json' || type.endsWith('+json')) {
    return 'json';
  }
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) {
    return 'xml';
  }
  if (type === 'text/html') {
    return 'html';
  }
  if (type === 'application/javascript' || type === 'text/javascript') {
    return 'javascript';
  }
  return 'text';
}

/** One `name=value` argument, as `-F` and `--data-urlencode` both spell a field. */
function splitField(argument: string): { readonly name: string; readonly value: string } {
  const equals = argument.indexOf('=');
  return equals === -1
    ? { name: argument, value: '' }
    : { name: argument.slice(0, equals), value: argument.slice(equals + 1) };
}

/**
 * Reads a pasted `curl` command as a REST request.
 *
 * The body is decided by the most specific flag present, because a command may carry several: `-F`
 * means multipart, `--data-urlencode` means a form, and a plain `-d` means raw in whatever the
 * `Content-Type` says. A `-d` naming a file (`@path`) becomes a binary body pointing at that file,
 * which is the reading that loses nothing.
 */
export function fromRestCurl(text: string, options: FromRestCurlOptions = {}): FromRestCurlResult {
  const problems: string[] = [];
  const { tokens, heredoc } = tokenizeCommand(text);

  let method: RestMethod | undefined;
  let url: string | undefined;
  const headers: KeyValueEntry[] = [];
  const formFields: KeyValueEntry[] = [];
  const parts: NonNullable<Extract<RestBody, { kind: 'multipart' }>['parts']>[number][] = [];
  let rawData: string | undefined;
  let binaryPath: string | undefined;
  let basic: { username: string; password?: string } | undefined;
  const settings: { trustInvalid?: boolean; followRedirects?: boolean; maxRedirects?: number } = {};

  let index = tokens[0] === 'curl' || tokens[0] === 'curl.exe' ? 1 : 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    const next = tokens[index + 1] ?? '';

    if (token === '-X' || token === '--request') {
      method = next.toUpperCase();
      index += 2;
      continue;
    }
    if (token === '-H' || token === '--header') {
      const colon = next.indexOf(':');
      if (colon !== -1) {
        headers.push(entry(next.slice(0, colon).trim(), next.slice(colon + 1).trim()));
      }
      index += 2;
      continue;
    }
    if (token === '--url') {
      url = next;
      index += 2;
      continue;
    }
    if (token === '-u' || token === '--user') {
      const colon = next.indexOf(':');
      basic = colon === -1 ? { username: next } : { username: next.slice(0, colon), password: next.slice(colon + 1) };
      index += 2;
      continue;
    }
    if (token === '-F' || token === '--form') {
      const field = splitField(next);
      if (field.value.startsWith('@') || field.value.startsWith('<')) {
        parts.push({
          kind: 'file',
          name: field.name,
          source: { kind: 'path', path: field.value.slice(1) },
          enabled: true,
        });
      } else {
        parts.push({ kind: 'text', name: field.name, value: field.value, enabled: true });
      }
      index += 2;
      continue;
    }
    if (token === '--data-urlencode') {
      const field = splitField(next);
      formFields.push(entry(field.name, field.value));
      index += 2;
      continue;
    }
    if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary') {
      if ((next === '@-' || next === '') && heredoc !== undefined) {
        rawData = heredoc;
      } else if (next.startsWith('@')) {
        binaryPath = next.slice(1);
      } else {
        rawData = next;
      }
      index += 2;
      continue;
    }
    if (token === '-k' || token === '--insecure') {
      settings.trustInvalid = true;
      index += 1;
      continue;
    }
    if (token === '-L' || token === '--location') {
      settings.followRedirects = true;
      index += 1;
      continue;
    }
    if (token === '--max-redirs') {
      const limit = Number.parseInt(next, 10);
      if (!Number.isNaN(limit)) {
        settings.maxRedirects = limit;
      }
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      // A flag with no field here. Boolean ones are simply dropped; one that takes a value must also
      // consume it, or its argument would be read as the URL.
      problems.push(`Ignored ${token}`);
      index += BOOLEAN_FLAGS.has(token) || token.includes('=') ? 1 : 2;
      continue;
    }
    if (url === undefined) {
      url = token;
    }
    index += 1;
  }

  if (url === undefined) {
    problems.push('No URL in the command');
  }

  const body = bodyFrom({ parts, formFields, rawData, binaryPath, headers });
  const split = url === undefined ? undefined : splitAgainstBase(url, options.baseUrl);
  const pathParams = split === undefined ? [] : paramRows(split.path);

  return {
    request: {
      // A command with no `-X` sends a GET, unless it carries a body, which makes it a POST — the
      // same rule curl itself applies.
      method: method ?? (body.kind === 'none' ? 'GET' : 'POST'),
      ...(split !== undefined ? { url: split.path, query: split.query } : {}),
      ...(pathParams.length > 0 ? { pathParams } : {}),
      ...(headers.length > 0 ? { headers } : {}),
      body,
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    },
    ...(basic !== undefined ? { basic } : {}),
    problems,
  };
}

/** The body the flags add up to, most specific first. */
function bodyFrom(input: {
  readonly parts: readonly NonNullable<Extract<RestBody, { kind: 'multipart' }>['parts']>[number][];
  readonly formFields: readonly KeyValueEntry[];
  readonly rawData: string | undefined;
  readonly binaryPath: string | undefined;
  readonly headers: readonly KeyValueEntry[];
}): RestBody {
  if (input.parts.length > 0) {
    return { kind: 'multipart', parts: input.parts };
  }
  if (input.formFields.length > 0) {
    return { kind: 'form', fields: input.formFields };
  }
  if (input.binaryPath !== undefined) {
    const declared = input.headers.find((row) => row.name.toLowerCase() === 'content-type')?.value;
    return {
      kind: 'binary',
      source: { kind: 'path', path: input.binaryPath },
      contentType: declared ?? 'application/octet-stream',
    };
  }
  if (input.rawData !== undefined) {
    const declared = input.headers.find((row) => row.name.toLowerCase() === 'content-type')?.value;
    const language = languageOf(declared);
    return {
      kind: 'raw',
      language,
      // A declared type that the language's own default does not cover has to be kept, or the
      // request would go out as something the server was never offered.
      ...(declared !== undefined && declared !== RAW_LANGUAGE_CONTENT_TYPES[language] ? { contentType: declared } : {}),
      text: input.rawData,
    };
  }
  return { kind: 'none' };
}

/** A URL split into a path (relative to `baseUrl` when it matches) and its query rows. */
function splitAgainstBase(
  url: string,
  baseUrl: string | undefined,
): { readonly path: string; readonly query: readonly KeyValueEntry[] } {
  const { path, query } = splitQuery(url);
  if (baseUrl === undefined || baseUrl === '') {
    return { path, query };
  }
  const base = trimTrailingSlashes(baseUrl);
  if (path === base) {
    return { path: '/', query };
  }
  if (path.startsWith(`${base}/`)) {
    return { path: path.slice(base.length), query };
  }
  return { path, query };
}

/** One row per `{param}` the path names, so the table is filled in as the editor expects. */
function paramRows(path: string): KeyValueEntry[] {
  const rows: KeyValueEntry[] = [];
  for (const match of path.matchAll(/\{([^{}/?#]+)\}/g)) {
    const name = match[1] as string;
    if (!rows.some((row) => row.name === name)) {
      rows.push(entry(name, ''));
    }
  }
  return rows;
}

/**
 * Splits a command into tokens, pulling out a heredoc or here-string body first.
 *
 * Shared shape with the SOAP parser in `http/curl.ts`, but its own implementation: that one folds a
 * heredoc into `envelopeXml`, and the two would drift into one function with a mode flag.
 */
function tokenizeCommand(text: string): { readonly tokens: readonly string[]; readonly heredoc: string | undefined } {
  let heredoc: string | undefined;
  let remainder = text;
  const heredocMatch = /<<\s*'?(\w+)'?\r?\n([\s\S]*?)\r?\n\1/.exec(text);
  if (heredocMatch !== null) {
    heredoc = heredocMatch[2];
    remainder = text.slice(0, heredocMatch.index) + text.slice(heredocMatch.index + heredocMatch[0].length);
  } else {
    const hereString = /@'\r?\n([\s\S]*?)\r?\n'@/.exec(text);
    if (hereString !== null) {
      heredoc = hereString[1];
      remainder = text.slice(0, hereString.index) + text.slice(hereString.index + hereString[0].length);
    }
  }

  const normalized = remainder
    .replace(/\\\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .trim();

  const tokens: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    while (index < normalized.length && /\s/.test(normalized[index] as string)) {
      index += 1;
    }
    if (index >= normalized.length) {
      break;
    }
    let token = '';
    while (index < normalized.length && !/\s/.test(normalized[index] as string)) {
      const character = normalized[index] as string;
      if (character === "'" || character === '"') {
        index += 1;
        const start = index;
        while (index < normalized.length && normalized[index] !== character) {
          index += 1;
        }
        token += normalized.slice(start, index);
        index += 1;
      } else if (character === '\\' && index + 1 < normalized.length) {
        token += normalized[index + 1];
        index += 2;
      } else {
        token += character;
        index += 1;
      }
    }
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return { tokens, heredoc };
}
