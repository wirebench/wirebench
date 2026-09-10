/**
 * Beyond-SoapUI convenience: export a SOAP send as a `curl` command, and
 * parse a pasted `curl` command back into a partial send input.
 */

import type { SoapSendInput } from '../types.js';
import { soapActionHeaders } from '../soap/soap-action.js';

/** Options for {@link toCurl}. */
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

/** Builds a `curl` command reproducing `input` — headers, body and all. */
export function toCurl(input: SoapSendInput & { readonly contentType?: string }, options: ToCurlOptions = {}): string {
  const shell = options.shell ?? 'posix';
  const actionHeaders = soapActionHeaders(
    input.soapVersion,
    input.soapAction,
    input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {},
  );
  const contentType = input.contentType ?? input.headers?.['Content-Type'] ?? actionHeaders.contentType;

  const headers: [string, string][] = [['Content-Type', contentType]];
  if (input.soapVersion === '1.1' && input.headers?.['SOAPAction'] === undefined) {
    headers.push(['SOAPAction', `"${input.soapAction ?? ''}"`]);
  }
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (key === 'Content-Type') continue;
    headers.push([key, value]);
  }

  if (shell === 'powershell') {
    const quote = powershellQuote;
    const lines = [`curl.exe --request POST ${quote(input.endpoint)} \``];
    for (const [key, value] of headers) {
      lines.push(`  --header ${quote(`${key}: ${value}`)} \``);
    }
    lines.push(`  --data-binary @'`, input.envelopeXml, `'@`);
    return lines.join('\n');
  }

  const quote = posixQuote;
  const lines = [`curl --request POST ${quote(input.endpoint)} \\`];
  for (const [key, value] of headers) {
    lines.push(`  --header ${quote(`${key}: ${value}`)} \\`);
  }
  lines.push(`  --data-binary @- <<'EOF'`, input.envelopeXml, `EOF`);
  return lines.join('\n');
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
  const heredocMatch = /<<\s*'?(\w+)'?\r?\n([\s\S]*?)\r?\n\1/.exec(text);
  if (heredocMatch !== undefined && heredocMatch !== null) {
    heredocData = heredocMatch[2];
    withoutHeredoc = text.slice(0, heredocMatch.index) + text.slice(heredocMatch.index + heredocMatch[0].length);
  } else {
    const hereStringMatch = /@'\r?\n([\s\S]*?)\r?\n'@/.exec(text);
    if (hereStringMatch !== null) {
      heredocData = hereStringMatch[1];
      withoutHeredoc = text.slice(0, hereStringMatch.index) + text.slice(hereStringMatch.index + hereStringMatch[0].length);
    }
  }

  const normalized = withoutHeredoc
    .replace(/\\\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .trim();
  const tokens = tokenize(normalized);

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
      // unknown flag; assume it takes no value unless it's a long flag with '=' embedded
      problems.push(`ignored-flag:${tok}`);
      i += 1;
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
