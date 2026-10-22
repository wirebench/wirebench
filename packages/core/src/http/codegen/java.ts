/** Java targets: the JDK's `java.net.http.HttpClient`, and OkHttp 4. */

import { hasEnv } from './model.js';
import type { CodeHeader, CodeRequest, GeneratedCode } from './model.js';
import { INSECURE_NOTE, maxRedirectsNote, withoutHeader } from './target.js';
import type { Layout } from './target.js';
import { baseName, cEscape, CodeLines, expr, filePath, formExpr, headerValue } from './text.js';
import type { Syntax } from './text.js';

/** `\NNN`: Java's octal escape. A `\u` escape would be read before the lexer and break the literal. */
function octalEscape(character: string): string {
  return `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`;
}

const JAVA: Syntax = {
  quote: (text) => `"${cEscape(text, '"', octalEscape)}"`,
  env: (name) => `System.getenv("${name}")`,
  join: ' + ',
};

/**
 * A text block (Java 15+) when the body spans lines: content at column 0 so no indentation is
 * stripped, trailing whitespace escaped so it is not, and the closing delimiter on the last line
 * so no newline is added.
 */
function bodyLiteral(text: string): string {
  if (!text.includes('\n') || text.includes('\r') || hasEnv(text)) {
    return expr(JAVA, text);
  }
  const lines = text
    .replace(/\\/g, '\\\\')
    .replace(/"""/g, '""\\"')
    .replace(/"$/, '\\"')
    .split('\n')
    .map((line) => line.replace(/[ \t]$/, (space) => (space === ' ' ? '\\040' : '\\011')));
  return `"""\n${lines.join('\n')}"""`;
}

/** Notes heading the snippet, as `//` comments. */
function header(code: CodeLines, notes: readonly string[], imports: ReadonlySet<string>): void {
  for (const note of notes) {
    code.add(0, `// Note: ${note}`);
  }
  for (const name of [...imports].sort()) {
    code.add(0, `import ${name};`);
  }
  code.blank().add(0, 'public class Main {');
  code.add(1, 'public static void main(String[] args) throws Exception {');
}

/** The headers `HttpClient` refuses to have set, because it sets them itself. */
const RESTRICTED = new Set(['connection', 'content-length', 'expect', 'host', 'upgrade']);

/** `"Basic " + base64(user:password)`, computed in Java so an environment read stays one. */
function basicHeader(request: CodeRequest): string | undefined {
  if (request.basic === undefined) return undefined;
  const credentials = expr(JAVA, `${request.basic.username}:${request.basic.password}`);
  return `"Basic " + Base64.getEncoder().encodeToString((${credentials}).getBytes(StandardCharsets.UTF_8))`;
}

/** The JDK's `HttpClient` (Java 11+; a text block needs 15+). */
export function javaHttpClient(request: CodeRequest, layout: Layout): GeneratedCode {
  const imports = new Set([
    'java.net.URI',
    'java.net.http.HttpClient',
    'java.net.http.HttpRequest',
    'java.net.http.HttpResponse',
  ]);
  const notes: string[] = [];
  if (request.insecure === true) notes.push(INSECURE_NOTE);
  if (layout.followRedirects && layout.maxRedirects !== undefined) notes.push(maxRedirectsNote(layout.maxRedirects));
  const body = new CodeLines(layout.unit);
  const { body: content } = request;
  let publisher = 'HttpRequest.BodyPublishers.noBody()';
  let headers: readonly CodeHeader[] = request.headers;

  switch (content.kind) {
    case 'raw':
      body.add(2, `String body = ${bodyLiteral(content.text)};`);
      publisher = 'HttpRequest.BodyPublishers.ofString(body)';
      break;
    case 'form':
      body.add(
        2,
        `String body = ${formExpr(JAVA, content.fields, (read) => {
          imports.add('java.net.URLEncoder').add('java.nio.charset.StandardCharsets');
          return `URLEncoder.encode(${read}, StandardCharsets.UTF_8)`;
        })};`,
      );
      publisher = 'HttpRequest.BodyPublishers.ofString(body)';
      if (headerValue(headers, 'content-type') === undefined) {
        headers = [...headers, { name: 'Content-Type', value: 'application/x-www-form-urlencoded' }];
      }
      break;
    case 'multipart': {
      imports.add('java.io.ByteArrayOutputStream').add('java.nio.charset.StandardCharsets');
      body.add(2, 'String boundary = "WirebenchBoundary";');
      body.add(2, 'ByteArrayOutputStream body = new ByteArrayOutputStream();');
      const write = (bytes: string): void => {
        body.add(2, `body.write(${bytes});`);
      };
      const utf8 = (text: string): string => `(${text}).getBytes(StandardCharsets.UTF_8)`;
      for (const part of content.parts) {
        const name = part.name.replace(/[\r\n"]/g, '_');
        if (part.kind === 'file') {
          imports.add('java.nio.file.Files').add('java.nio.file.Path');
          const path = filePath(part.path);
          const fileName = baseName(path).replace(/[\r\n"]/g, '_');
          write(
            utf8(
              `"--" + boundary + ${JAVA.quote(
                `\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
              )}`,
            ),
          );
          write(`Files.readAllBytes(Path.of(${JAVA.quote(path)}))`);
        } else {
          const type = part.contentType !== undefined ? `\r\nContent-Type: ${part.contentType}` : '';
          write(
            utf8(
              `"--" + boundary + ${JAVA.quote(`\r\nContent-Disposition: form-data; name="${name}"${type}\r\n\r\n`)}`,
            ),
          );
          write(utf8(expr(JAVA, part.value)));
        }
        write(utf8(JAVA.quote('\r\n')));
      }
      write(utf8(`"--" + boundary + "--\\r\\n"`));
      publisher = 'HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())';
      headers = [...withoutHeader(headers, 'content-type'), { name: 'Content-Type', value: '' }];
      break;
    }
    case 'binary':
      imports.add('java.nio.file.Path');
      publisher = `HttpRequest.BodyPublishers.ofFile(Path.of(${JAVA.quote(filePath(content.path))}))`;
      break;
    default:
      break;
  }

  const builder: string[] = [`.uri(URI.create(${expr(JAVA, request.url)}))`];
  if (layout.timeoutMs !== undefined) {
    imports.add('java.time.Duration');
    builder.push(`.timeout(Duration.ofMillis(${String(layout.timeoutMs)}))`);
  }
  for (const row of headers) {
    if (RESTRICTED.has(row.name.toLowerCase())) {
      notes.push(`The ${row.name} header is set by HttpClient itself and is left out.`);
    } else if (content.kind === 'multipart' && row.name === 'Content-Type' && row.value === '') {
      builder.push('.header("Content-Type", "multipart/form-data; boundary=" + boundary)');
    } else {
      builder.push(`.header(${JAVA.quote(row.name)}, ${expr(JAVA, row.value)})`);
    }
  }
  const basic = basicHeader(request);
  if (basic !== undefined) {
    imports.add('java.util.Base64').add('java.nio.charset.StandardCharsets');
    builder.push(`.header("Authorization", ${basic})`);
  }
  builder.push(`.method(${JAVA.quote(request.method)}, ${publisher})`, '.build();');

  const code = new CodeLines(layout.unit);
  header(code, notes, imports);
  if (content.kind !== 'none' && content.kind !== 'binary') {
    code.add(0, body.toString()).blank();
  }
  code.add(2, 'HttpClient client = HttpClient.newBuilder()');
  code.add(4, `.followRedirects(HttpClient.Redirect.${layout.followRedirects ? 'NORMAL' : 'NEVER'})`);
  code.add(4, '.build();');
  code.add(2, 'HttpRequest request = HttpRequest.newBuilder()');
  for (const line of builder) code.add(4, line);
  code.add(2, 'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());');
  code.add(2, 'System.out.println(response.statusCode());');
  code.add(2, 'System.out.println(response.body());');
  code.add(1, '}').add(0, '}');
  return { code: code.toString(), notes };
}

/** OkHttp 4. */
export function javaOkHttp(request: CodeRequest, layout: Layout): GeneratedCode {
  const imports = new Set(['okhttp3.OkHttpClient', 'okhttp3.Request', 'okhttp3.Response']);
  const notes: string[] = [];
  if (request.insecure === true) notes.push(INSECURE_NOTE);
  if (layout.followRedirects && layout.maxRedirects !== undefined) notes.push(maxRedirectsNote(layout.maxRedirects));
  const { body: content } = request;
  const lines = new CodeLines(layout.unit);
  let headers: readonly CodeHeader[] = request.headers;
  const mediaType = (type: string | undefined): string => {
    imports.add('okhttp3.MediaType');
    return type === undefined ? 'null' : `MediaType.parse(${JAVA.quote(type)})`;
  };

  switch (content.kind) {
    case 'raw':
      imports.add('okhttp3.RequestBody');
      lines.add(2, `String content = ${bodyLiteral(content.text)};`);
      lines.add(
        2,
        `RequestBody body = RequestBody.create(content, ${mediaType(headerValue(headers, 'content-type'))});`,
      );
      headers = withoutHeader(headers, 'content-type');
      break;
    case 'form':
      imports.add('okhttp3.FormBody').add('okhttp3.RequestBody');
      lines.add(2, 'RequestBody body = new FormBody.Builder()');
      for (const field of content.fields) {
        lines.add(4, `.add(${expr(JAVA, field.name)}, ${expr(JAVA, field.value)})`);
      }
      lines.add(4, '.build();');
      break;
    case 'multipart':
      imports.add('okhttp3.MultipartBody').add('okhttp3.RequestBody');
      lines.add(2, 'RequestBody body = new MultipartBody.Builder()');
      lines.add(4, '.setType(MultipartBody.FORM)');
      for (const part of content.parts) {
        if (part.kind === 'file') {
          imports.add('java.io.File');
          const path = filePath(part.path);
          lines.add(
            4,
            `.addFormDataPart(${expr(JAVA, part.name)}, ${JAVA.quote(baseName(path))}, RequestBody.create(new File(${JAVA.quote(path)}), ${mediaType(part.contentType ?? 'application/octet-stream')}))`,
          );
        } else if (part.contentType !== undefined) {
          lines.add(
            4,
            `.addFormDataPart(${expr(JAVA, part.name)}, null, RequestBody.create(${expr(JAVA, part.value)}, ${mediaType(part.contentType)}))`,
          );
        } else {
          lines.add(4, `.addFormDataPart(${expr(JAVA, part.name)}, ${expr(JAVA, part.value)})`);
        }
      }
      lines.add(4, '.build();');
      break;
    case 'binary':
      imports.add('java.io.File').add('okhttp3.RequestBody');
      lines.add(
        2,
        `RequestBody body = RequestBody.create(new File(${JAVA.quote(filePath(content.path))}), ${mediaType(headerValue(headers, 'content-type'))});`,
      );
      headers = withoutHeader(headers, 'content-type');
      break;
    default:
      break;
  }

  const code = new CodeLines(layout.unit);
  const client: string[] = [];
  if (!layout.followRedirects) client.push('.followRedirects(false)', '.followSslRedirects(false)');
  if (layout.timeoutMs !== undefined) {
    imports.add('java.util.concurrent.TimeUnit');
    client.push(`.callTimeout(${String(layout.timeoutMs)}, TimeUnit.MILLISECONDS)`);
  }
  if (request.basic !== undefined) imports.add('okhttp3.Credentials');
  header(code, notes, imports);
  code.add(2, 'OkHttpClient client = new OkHttpClient.Builder()');
  for (const line of client) code.add(4, line);
  code.add(4, '.build();');
  if (content.kind !== 'none') {
    code.add(0, lines.toString());
  }
  code.add(2, 'Request request = new Request.Builder()');
  code.add(4, `.url(${expr(JAVA, request.url)})`);
  code.add(4, `.method(${JAVA.quote(request.method)}, ${content.kind === 'none' ? 'null' : 'body'})`);
  for (const row of headers) {
    code.add(4, `.addHeader(${JAVA.quote(row.name)}, ${expr(JAVA, row.value)})`);
  }
  if (request.basic !== undefined) {
    code.add(
      4,
      `.addHeader("Authorization", Credentials.basic(${expr(JAVA, request.basic.username)}, ${expr(JAVA, request.basic.password)}))`,
    );
  }
  code.add(4, '.build();');
  code.add(2, 'try (Response response = client.newCall(request).execute()) {');
  code.add(3, 'System.out.println(response.code());');
  code.add(3, 'System.out.println(response.body().string());');
  code.add(2, '}');
  code.add(1, '}').add(0, '}');
  return { code: code.toString(), notes };
}
