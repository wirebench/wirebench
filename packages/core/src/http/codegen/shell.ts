/** The shell targets beyond `curl`: PowerShell's `Invoke-RestMethod`, and HTTPie. */

import { hasEnv } from './model.js';
import type { CodeRequest, GeneratedCode } from './model.js';
import { mergedHeaders, withoutHeader } from './target.js';
import type { Layout } from './target.js';
import { CodeLines, expr, filePath, formExpr, headerValue, shellQuote } from './text.js';
import type { Syntax } from './text.js';

const PS: Syntax = {
  quote: (text) => `'${text.replace(/'/g, "''")}'`,
  env: (name) => `$env:${name}`,
  join: ' + ',
};

/** A value in a hashtable: an expression of several pieces needs parentheses there. */
function psValue(text: string): string {
  const value = expr(PS, text);
  return hasEnv(text) && value.includes(' + ') ? `(${value})` : value;
}

/** A here-string keeps a multi-line body as it is, unless a line of it would close the string. */
function psBody(text: string): string {
  return text.includes('\n') && !hasEnv(text) && !/^'@/m.test(text) ? `@'\n${text}\n'@` : psValue(text);
}

/** PowerShell 7's `Invoke-RestMethod`, its arguments splatted so each sits on its own line. */
export function powershellIrm(request: CodeRequest, layout: Layout): GeneratedCode {
  const code = new CodeLines(layout.unit);
  const { body } = request;
  const contentType = headerValue(request.headers, 'content-type');
  const headers = mergedHeaders(withoutHeader(request.headers, 'content-type'));
  const params: [string, string][] = [
    ['Uri', psValue(request.url)],
    ['Method', PS.quote(request.method)],
  ];
  if (headers.length > 0) {
    code.add(0, '$headers = @{');
    for (const row of headers) code.add(1, `${PS.quote(row.name)} = ${psValue(row.value)}`);
    code.add(0, '}');
    params.push(['Headers', '$headers']);
  }
  switch (body.kind) {
    case 'raw':
      code.add(0, `$body = ${psBody(body.text)}`);
      params.push(['Body', '$body']);
      break;
    case 'form':
      code.add(0, `$body = ${formExpr(PS, body.fields, (read) => `[uri]::EscapeDataString(${read})`)}`);
      params.push(['Body', '$body']);
      if (contentType === undefined) params.push(['ContentType', PS.quote('application/x-www-form-urlencoded')]);
      break;
    case 'multipart':
      code.add(0, '$form = @{');
      for (const part of body.parts) {
        code.add(
          1,
          `${psValue(part.name)} = ${part.kind === 'file' ? `Get-Item -LiteralPath ${PS.quote(filePath(part.path))}` : psValue(part.value)}`,
        );
      }
      code.add(0, '}');
      params.push(['Form', '$form']);
      break;
    case 'binary':
      params.push(['InFile', PS.quote(filePath(body.path))]);
      break;
    default:
      break;
  }
  if (contentType !== undefined && body.kind !== 'multipart') {
    params.push(['ContentType', psValue(contentType)]);
  }
  if (request.basic !== undefined) {
    code.add(
      0,
      `$credential = [pscredential]::new(${psValue(request.basic.username)}, (ConvertTo-SecureString ${psValue(request.basic.password)} -AsPlainText -Force))`,
    );
    params.push(['Authentication', "'Basic'"], ['Credential', '$credential']);
    if (request.url.startsWith('http:')) params.push(['AllowUnencryptedAuthentication', '$true']);
  }
  if (!layout.followRedirects) {
    params.push(['MaximumRedirection', '0']);
  } else if (layout.maxRedirects !== undefined) {
    params.push(['MaximumRedirection', String(layout.maxRedirects)]);
  }
  if (layout.timeoutMs !== undefined) {
    params.push(['TimeoutSec', String(Math.max(1, Math.ceil(layout.timeoutMs / 1000)))]);
  }
  if (request.insecure === true) params.push(['SkipCertificateCheck', '$true']);
  params.push(['SkipHttpErrorCheck', '$true']);

  code.add(0, '$params = @{');
  for (const [name, value] of params) code.add(1, `${name} = ${value}`);
  code.add(0, '}').blank();
  code.add(0, '$response = Invoke-RestMethod @params');
  code.add(0, '$response');
  return { code: code.toString(), notes: [] };
}

const SH: Syntax = { quote: shellQuote, env: (name) => `"$${name}"`, join: '' };

/** An item name with HTTPie's separators escaped, so `a:b=c` stays one name. */
function itemName(name: string): string {
  return name.replace(/[\\:=@]/g, (character) => `\\${character}`);
}

/** HTTPie: options first, then the method, the URL and one item per header or field. */
export function httpie(request: CodeRequest, layout: Layout): GeneratedCode {
  const { body } = request;
  const args: string[] = [];
  if (body.kind === 'form') args.push('--form');
  if (body.kind === 'multipart') args.push('--multipart');
  if (layout.followRedirects) {
    args.push('--follow');
    if (layout.maxRedirects !== undefined) args.push(`--max-redirects=${String(layout.maxRedirects)}`);
  }
  if (layout.timeoutMs !== undefined) args.push(`--timeout=${String(layout.timeoutMs / 1000)}`);
  if (request.insecure === true) args.push('--verify=no');
  if (request.basic !== undefined) {
    args.push(`--auth=${expr(SH, `${request.basic.username}:${request.basic.password}`)}`);
  }
  const raw = body.kind === 'raw' ? body.text : undefined;
  if (raw !== undefined && hasEnv(raw)) args.push(`--raw=${expr(SH, raw)}`);
  args.push(`${request.method} ${expr(SH, request.url)}`);
  for (const row of request.headers) {
    args.push(row.value === '' ? expr(SH, `${itemName(row.name)};`) : expr(SH, `${itemName(row.name)}:${row.value}`));
  }
  if (body.kind === 'form') {
    for (const field of body.fields) args.push(expr(SH, `${itemName(field.name)}=${field.value}`));
  }
  if (body.kind === 'multipart') {
    for (const part of body.parts) {
      if (part.kind === 'file') {
        const type = part.contentType !== undefined ? `;type=${part.contentType}` : '';
        args.push(expr(SH, `${itemName(part.name)}@${filePath(part.path)}${type}`));
      } else {
        args.push(expr(SH, `${itemName(part.name)}=${part.value}`));
      }
    }
  }
  const heredoc = raw !== undefined && !hasEnv(raw);
  if (heredoc) args.push(`<<'EOF'`);
  if (body.kind === 'binary') args.push(`< ${shellQuote(filePath(body.path))}`);

  const lines = args.map((argument, index) => {
    const prefix = index === 0 ? 'http ' : layout.unit;
    return `${prefix}${argument}${index === args.length - 1 ? '' : ' \\'}`;
  });
  if (heredoc) lines.push(raw, 'EOF');
  return { code: lines.join('\n'), notes: [] };
}
