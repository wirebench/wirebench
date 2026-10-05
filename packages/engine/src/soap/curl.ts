/**
 * A SOAP send as a `curl` command, and a pasted `curl` command back as a partial SOAP send input.
 *
 * The command itself — the quoting, the line continuations, the two shells — is `http/curl.ts`'s
 * {@link toCurl}; this file builds its description from a {@link SoapSendInput}, as `rest/curl.ts`
 * does from a REST one.
 */

import { expandBundles, takesNoValue } from '../http/curl-flags.js';
import { toCurl } from '../http/curl.js';
import type { CurlCommand, CurlHeader, ToCurlOptions } from '../http/curl.js';
import { findHeredoc, findHereString } from '../http/heredoc.js';
import { soapActionHeaders } from './soap-action.js';
import type { SoapSendInput } from './types.js';

/** Builds a `curl` command reproducing a SOAP send — headers, envelope and all. */
export function soapToCurl(
  input: SoapSendInput & { readonly contentType?: string; readonly negotiate?: CurlCommand['negotiate'] },
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
    {
      method: 'POST',
      url: input.endpoint,
      headers,
      body: { kind: 'raw', text: input.envelopeXml },
      ...(input.negotiate !== undefined ? { negotiate: input.negotiate } : {}),
    },
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
