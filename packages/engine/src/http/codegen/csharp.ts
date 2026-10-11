/** C# with `HttpClient`, as top-level statements (.NET 6+). */

import { hasEnv } from './model.js';
import type { CodeRequest, GeneratedCode } from './model.js';
import { withoutHeader } from './target.js';
import type { Layout } from './target.js';
import { baseName, cEscape, CodeLines, expr, filePath, headerValue } from './text.js';
import type { Syntax } from './text.js';

const CS: Syntax = {
  quote: (text) => `"${cEscape(text, '"')}"`,
  env: (name) => `Environment.GetEnvironmentVariable("${name}")`,
  join: ' + ',
};

/** A verbatim string keeps a multi-line body readable; only `"` needs doubling in one. */
function bodyLiteral(text: string): string {
  return text.includes('\n') && !hasEnv(text) ? `@"${text.replace(/"/g, '""')}"` : expr(CS, text);
}

/** C# with `HttpClient`. */
export function csharpHttpClient(request: CodeRequest, layout: Layout): GeneratedCode {
  const usings = new Set<string>();
  const notes: string[] = [];
  const code = new CodeLines(layout.unit);
  const { body } = request;
  const contentType = headerValue(request.headers, 'content-type');
  let headers = withoutHeader(request.headers, 'content-type');

  const handler: string[] = [];
  if (!layout.followRedirects) {
    handler.push('AllowAutoRedirect = false,');
  } else if (layout.maxRedirects !== undefined) {
    handler.push(`MaxAutomaticRedirections = ${String(layout.maxRedirects)},`);
  }
  if (request.insecure === true) {
    handler.push(
      'ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator,',
    );
  }
  const main = new CodeLines(layout.unit);
  if (handler.length > 0) {
    main.add(0, 'var handler = new HttpClientHandler').add(0, '{');
    for (const line of handler) main.add(1, line);
    main.add(0, '};');
  }
  main.add(0, `using var client = new HttpClient(${handler.length > 0 ? 'handler' : ''});`);
  main.add(
    0,
    layout.timeoutMs !== undefined
      ? `client.Timeout = TimeSpan.FromMilliseconds(${String(layout.timeoutMs)});`
      : 'client.Timeout = Timeout.InfiniteTimeSpan;',
  );
  main.blank();
  main.add(
    0,
    `using var request = new HttpRequestMessage(new HttpMethod(${CS.quote(request.method)}), ${expr(CS, request.url)});`,
  );

  // Content-* headers belong to the content in .NET, and are refused on the request.
  const contentHeaders =
    body.kind === 'none' ? [] : headers.filter((row) => row.name.toLowerCase().startsWith('content-'));
  headers = headers.filter((row) => !contentHeaders.includes(row));
  for (const row of headers) {
    main.add(0, `request.Headers.TryAddWithoutValidation(${CS.quote(row.name)}, ${expr(CS, row.value)});`);
  }
  if (request.basic !== undefined) {
    usings.add('System.Net.Http.Headers').add('System.Text');
    const credentials = expr(CS, `${request.basic.username}:${request.basic.password}`);
    main.add(
      0,
      `request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(${credentials})));`,
    );
  }

  switch (body.kind) {
    case 'raw':
      main.add(0, `request.Content = new StringContent(${bodyLiteral(body.text)});`);
      break;
    case 'form':
      main.add(0, 'request.Content = new FormUrlEncodedContent(new[]').add(0, '{');
      for (const field of body.fields) {
        main.add(1, `new KeyValuePair<string, string>(${expr(CS, field.name)}, ${expr(CS, field.value)}),`);
      }
      main.add(0, '});');
      break;
    case 'multipart': {
      main.add(0, 'var form = new MultipartFormDataContent();');
      let files = 0;
      for (const part of body.parts) {
        const name = expr(CS, part.name);
        if (part.kind === 'file') {
          files += 1;
          const variable = `file${String(files)}`;
          const path = filePath(part.path);
          main.add(0, `var ${variable} = new ByteArrayContent(File.ReadAllBytes(${CS.quote(path)}));`);
          if (part.contentType !== undefined) {
            usings.add('System.Net.Http.Headers');
            main.add(0, `${variable}.Headers.ContentType = MediaTypeHeaderValue.Parse(${CS.quote(part.contentType)});`);
          }
          main.add(0, `form.Add(${variable}, ${name}, ${CS.quote(baseName(path))});`);
        } else if (part.contentType !== undefined) {
          usings.add('System.Net.Http.Headers');
          main.add(0, `var part${String(files + 1)} = new StringContent(${expr(CS, part.value)});`);
          main.add(
            0,
            `part${String(files + 1)}.Headers.ContentType = MediaTypeHeaderValue.Parse(${CS.quote(part.contentType)});`,
          );
          main.add(0, `form.Add(part${String(files + 1)}, ${name});`);
          files += 1;
        } else {
          main.add(0, `form.Add(new StringContent(${expr(CS, part.value)}), ${name});`);
        }
      }
      main.add(0, 'request.Content = form;');
      break;
    }
    case 'binary':
      main.add(0, `request.Content = new ByteArrayContent(File.ReadAllBytes(${CS.quote(filePath(body.path))}));`);
      break;
    default:
      break;
  }
  if (body.kind === 'raw' || body.kind === 'binary') {
    if (contentType !== undefined) {
      usings.add('System.Net.Http.Headers');
      main.add(0, `request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${expr(CS, contentType)});`);
    } else {
      main.add(0, 'request.Content.Headers.ContentType = null;');
    }
  }
  for (const row of contentHeaders) {
    main.add(0, `request.Content.Headers.TryAddWithoutValidation(${CS.quote(row.name)}, ${expr(CS, row.value)});`);
  }
  main.blank();
  main.add(0, 'using var response = await client.SendAsync(request);');
  main.add(0, 'Console.WriteLine((int)response.StatusCode);');
  main.add(0, 'Console.WriteLine(await response.Content.ReadAsStringAsync());');

  for (const name of [...usings].sort()) {
    code.add(0, `using ${name};`);
  }
  if (usings.size > 0) code.blank();
  return { code: `${code.toString()}${usings.size > 0 ? '\n' : ''}${main.toString()}`, notes };
}
