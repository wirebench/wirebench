/**
 * Interoperability convenience: export a send as a `curl` command, and parse a pasted `curl` command
 * back into a partial send input.
 *
 * {@link toCurl} describes a request in `curl`'s own terms — a method, a URL, headers and one of the
 * body shapes `curl` has a flag for — and knows nothing about SOAP or REST. Each protocol builds that
 * description from its own send input ({@link soapToCurl} here, `restToCurl` in `rest/curl.ts`), so the
 * quoting, the line continuations and the two shells have one implementation rather than two.
 */

import type { SoapSendInput } from '../types.js';
import { soapActionHeaders } from '../soap/soap-action.js';
import { findHeredoc, findHereString } from './heredoc.js';
import { expandBundles, takesNoValue } from './curl-flags.js';

/** One header of an exported command, in the order the user wrote it. */
export interface CurlHeader {
  readonly name: string;
  readonly value: string;
}

/** One part of an exported `multipart/form-data` body. */
export type CurlPart =
  | { readonly kind: 'text'; readonly name: string; readonly value: string; readonly contentType?: string }
  /** A file `curl` reads itself, as `-F name=@path`. An empty path is written as a placeholder. */
  | { readonly kind: 'file'; readonly name: string; readonly path: string; readonly contentType?: string };

/**
 * What the command sends.
 *
 * Each arm maps to the flag `curl` users expect for it, which is what makes an exported command worth
 * pasting: `--data-urlencode` per form field rather than one pre-encoded blob, `-F` per part rather
 * than a hand-built multipart body, and `@file` where the bytes live on disk rather than inline.
 */
export type CurlBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'raw'; readonly text: string }
  | { readonly kind: 'form'; readonly fields: readonly CurlHeader[] }
  | { readonly kind: 'multipart'; readonly parts: readonly CurlPart[] }
  | { readonly kind: 'binary'; readonly path: string };

/** A request as `curl` would describe it. */
export interface CurlCommand {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly CurlHeader[];
  readonly body?: CurlBody;
  /** `-u user:password`. The password is the caller's to redact before it gets here. */
  readonly basic?: { readonly username: string; readonly password: string };
  /** `-k`: send even when the certificate does not verify. */
  readonly insecure?: boolean;
  /** `-L`, with `--max-redirs` when a limit is set. */
  readonly followRedirects?: boolean;
  readonly maxRedirects?: number;
}

/** Options for {@link toCurl} and {@link soapToCurl}. */
export interface ToCurlOptions {
  /** Target shell for line continuations and quoting. Default 'posix'. */
  readonly shell?: 'posix' | 'powershell';
}

/** Escapes a value for a POSIX single-quoted shell string. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Escapes a value for a PowerShell single-quoted string. */
function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quotes one argument for `shell`; shared with the gRPC command renderer so both quote alike. */
export function quoteForShell(value: string, shell: 'posix' | 'powershell'): string {
  return shell === 'powershell' ? powershellQuote(value) : posixQuote(value);
}

/** The path a `@file` argument names, or a placeholder when no file has been chosen yet. */
function filePath(path: string): string {
  return path.length > 0 ? path : '/path/to/file';
}

/**
 * Builds a `curl` command from {@link CurlCommand}.
 *
 * A raw body travels as a heredoc (POSIX) or a here-string (PowerShell) rather than as a quoted
 * argument: it may contain newlines, quotes and anything else, and a heredoc is the one form that
 * carries all of it unchanged — which is also what {@link fromCurl} reads back.
 */
export function toCurl(command: CurlCommand, options: ToCurlOptions = {}): string {
  const shell = options.shell ?? 'posix';
  const powershell = shell === 'powershell';
  const quote = powershell ? powershellQuote : posixQuote;
  const continuation = powershell ? '`' : '\\';
  const program = powershell ? 'curl.exe' : 'curl';
  const body = command.body ?? { kind: 'none' };

  // The method and the URL stay on the first line together: that is the shape everyone recognises,
  // and it is what makes the rest of the command read as a list of options rather than of arguments.
  const args: string[] = [`--request ${command.method} ${quote(command.url)}`];
  for (const header of command.headers) {
    args.push(`--header ${quote(`${header.name}: ${header.value}`)}`);
  }
  if (command.basic !== undefined) {
    args.push(`--user ${quote(`${command.basic.username}:${command.basic.password}`)}`);
  }
  if (command.insecure === true) {
    args.push('--insecure');
  }
  if (command.followRedirects === true) {
    args.push('--location');
    if (command.maxRedirects !== undefined) {
      args.push(`--max-redirs ${String(command.maxRedirects)}`);
    }
  }

  switch (body.kind) {
    case 'form':
      for (const field of body.fields) {
        args.push(`--data-urlencode ${quote(`${field.name}=${field.value}`)}`);
      }
      break;
    case 'multipart':
      for (const part of body.parts) {
        const value = part.kind === 'file' ? `${part.name}=@${filePath(part.path)}` : `${part.name}=${part.value}`;
        const typed = part.contentType !== undefined ? `${value};type=${part.contentType}` : value;
        args.push(`--form ${quote(typed)}`);
      }
      break;
    case 'binary':
      args.push(`--data-binary ${quote(`@${filePath(body.path)}`)}`);
      break;
    case 'raw':
      args.push(powershell ? `--data-binary @'` : `--data-binary @- <<'EOF'`);
      break;
    default:
      break;
  }

  const lines: string[] = [];
  const last = args.length - 1;
  args.forEach((argument, index) => {
    const prefix = index === 0 ? `${program} ` : '  ';
    // The heredoc opener must be the last argument, and takes no continuation: its body follows.
    const tail = index === last ? '' : ` ${continuation}`;
    lines.push(`${prefix}${argument}${tail}`);
  });
  if (body.kind === 'raw') {
    lines.push(body.text, powershell ? `'@` : 'EOF');
  }
  return lines.join('\n');
}

/** Builds a `curl` command reproducing a SOAP send — headers, envelope and all. */
export function soapToCurl(
  input: SoapSendInput & { readonly contentType?: string },
  options: ToCurlOptions = {},
): string {
  const actionHeaders = soapActionHeaders(
    input.soapVersion,
    input.soapAction,
    input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {},
  );
  const contentType = input.contentType ?? input.headers?.['Content-Type'] ?? actionHeaders.contentType;

  const headers: CurlHeader[] = [{ name: 'Content-Type', value: contentType }];
  if (input.soapVersion === '1.1' && input.headers?.['SOAPAction'] === undefined) {
    headers.push({ name: 'SOAPAction', value: `"${input.soapAction ?? ''}"` });
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (name === 'Content-Type') continue;
    headers.push({ name, value });
  }

  return toCurl(
    { method: 'POST', url: input.endpoint, headers, body: { kind: 'raw', text: input.envelopeXml } },
    options,
  );
}

/** Result of {@link fromCurl}. */
export interface FromCurlResult {
  readonly input: Partial<SoapSendInput>;
  readonly problems: readonly string[];
}

/** Splits a command line into tokens, respecting single/double quoted spans (no `$'…'` support). */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && /\s/.test(text[i] as string)) i += 1;
    if (i >= len) break;
    let token = '';
    while (i < len && !/\s/.test(text[i] as string)) {
      const ch = text[i] as string;
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i += 1;
        const start = i;
        while (i < len && text[i] !== quote) i += 1;
        token += text.slice(start, i);
        i += 1;
      } else if (ch === '\\' && i + 1 < len) {
        token += text[i + 1];
        i += 2;
      } else if (ch === '`' || (ch === '\\' && text[i + 1] === '\n')) {
        // line continuation markers; skip
        i += 1;
      } else {
        token += ch;
        i += 1;
      }
    }
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

/** Parses a pasted `curl` command back into a partial {@link SoapSendInput}. */
export function fromCurl(text: string): FromCurlResult {
  const problems: string[] = [];

  // Pull out a heredoc/here-string body (`<<'EOF' ... EOF` or `@'...'@`) before line-splicing and
  // tokenizing the rest — its content is verbatim and may contain anything, including newlines.
  let heredocData: string | undefined;
  let withoutHeredoc = text;
  const embedded = findHeredoc(text) ?? findHereString(text);
  if (embedded !== undefined) {
    heredocData = embedded.body;
    withoutHeredoc = text.slice(0, embedded.start) + text.slice(embedded.end);
  }

  const normalized = withoutHeredoc
    .replace(/\\\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .trim();
  const tokens = expandBundles(tokenize(normalized));

  let endpoint: string | undefined;
  let envelopeXml: string | undefined;
  const headers: Record<string, string> = {};

  let i = 0;
  if (tokens[0] === 'curl' || tokens[0] === 'curl.exe') i += 1;

  while (i < tokens.length) {
    const tok = tokens[i] as string;
    if (tok === '-X' || tok === '--request') {
      i += 2;
      continue;
    }
    if (tok === '-H' || tok === '--header') {
      const header = tokens[i + 1] ?? '';
      const colon = header.indexOf(':');
      if (colon !== -1) {
        const key = header.slice(0, colon).trim();
        const value = header.slice(colon + 1).trim();
        headers[key] = value;
      }
      i += 2;
      continue;
    }
    if (tok === '-d' || tok === '--data' || tok === '--data-binary' || tok === '--data-raw') {
      const data = tokens[i + 1] ?? '';
      if ((data === '@-' || data === '') && heredocData !== undefined) {
        envelopeXml = heredocData;
      } else if (data.startsWith('@')) {
        problems.push('data-from-file-unsupported');
      } else {
        envelopeXml = data;
      }
      i += 2;
      continue;
    }
    if (tok === '--url') {
      endpoint = tokens[i + 1];
      i += 2;
      continue;
    }
    if (tok === '-u' || tok === '--user') {
      problems.push('basic-auth-ignored');
      i += 2;
      continue;
    }
    if (tok.startsWith('-')) {
      // A flag with no field here: skip its value too, unless it is one that takes none.
      problems.push(`ignored-flag:${tok}`);
      i += takesNoValue(tok) ? 1 : 2;
      continue;
    }
    // bare token: the URL
    if (endpoint === undefined) {
      endpoint = tok;
    }
    i += 1;
  }

  const soapActionHeader = headers['SOAPAction'];
  let soapAction: string | undefined;
  if (soapActionHeader !== undefined) {
    soapAction = soapActionHeader.replace(/^"|"$/g, '');
  }

  const contentType = headers['Content-Type'];
  const soapVersion: '1.1' | '1.2' = contentType?.includes('application/soap+xml') === true ? '1.2' : '1.1';

  const extraHeaders = { ...headers };
  delete extraHeaders['SOAPAction'];
  delete extraHeaders['Content-Type'];

  const input: Partial<SoapSendInput> = {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(envelopeXml !== undefined ? { envelopeXml } : {}),
    soapVersion,
    ...(soapAction !== undefined ? { soapAction } : {}),
    ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
  };

  return { input, problems };
}
