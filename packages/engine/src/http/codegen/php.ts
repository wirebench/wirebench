/** PHP with the cURL extension, and Ruby with Net::HTTP: the two scripting targets. */

import type { CodeRequest, GeneratedCode } from './model.js';
import { NO_FOLLOW_NOTE } from './target.js';
import type { Layout } from './target.js';
import { baseName, CodeLines, expr, filePath, formExpr, headerValue } from './text.js';
import type { Syntax } from './text.js';

/** A single-quoted string: only `\` and `'` are special, and a newline is kept as it is. */
function singleQuote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const PHP: Syntax = { quote: singleQuote, env: (name) => `getenv('${name}')`, join: ' . ' };

/** PHP with the cURL extension. */
export function phpCurl(request: CodeRequest, layout: Layout): GeneratedCode {
  const code = new CodeLines(layout.unit);
  const { body } = request;
  code.add(0, '<?php').blank();
  switch (body.kind) {
    case 'raw':
      code.add(0, `$body = ${expr(PHP, body.text)};`).blank();
      break;
    case 'form':
      code.add(0, `$body = ${formExpr(PHP, body.fields, (read) => `urlencode(${read})`)};`).blank();
      break;
    case 'multipart':
      code.add(0, '$body = [');
      for (const part of body.parts) {
        if (part.kind === 'file') {
          const path = filePath(part.path);
          code.add(
            1,
            `${expr(PHP, part.name)} => new CURLFile(${PHP.quote(path)}, ${PHP.quote(part.contentType ?? 'application/octet-stream')}, ${PHP.quote(baseName(path))}),`,
          );
        } else {
          code.add(1, `${expr(PHP, part.name)} => ${expr(PHP, part.value)},`);
        }
      }
      code.add(0, '];').blank();
      break;
    case 'binary':
      code.add(0, `$body = file_get_contents(${PHP.quote(filePath(body.path))});`).blank();
      break;
    default:
      break;
  }
  code.add(0, '$curl = curl_init();');
  code.add(0, 'curl_setopt_array($curl, [');
  code.add(1, `CURLOPT_URL => ${expr(PHP, request.url)},`);
  if (request.method === 'HEAD') {
    code.add(1, 'CURLOPT_NOBODY => true,');
  } else {
    code.add(1, `CURLOPT_CUSTOMREQUEST => ${PHP.quote(request.method)},`);
  }
  code.add(1, 'CURLOPT_RETURNTRANSFER => true,');
  if (layout.followRedirects) {
    code.add(1, 'CURLOPT_FOLLOWLOCATION => true,');
    if (layout.maxRedirects !== undefined) code.add(1, `CURLOPT_MAXREDIRS => ${String(layout.maxRedirects)},`);
  }
  if (layout.timeoutMs !== undefined) {
    code.add(1, `CURLOPT_TIMEOUT_MS => ${String(layout.timeoutMs)},`);
  }
  if (request.insecure === true) {
    code.add(1, 'CURLOPT_SSL_VERIFYPEER => false,');
    code.add(1, 'CURLOPT_SSL_VERIFYHOST => 0,');
  }
  if (request.basic !== undefined) {
    code.add(1, 'CURLOPT_HTTPAUTH => CURLAUTH_BASIC,');
    code.add(1, `CURLOPT_USERPWD => ${expr(PHP, `${request.basic.username}:${request.basic.password}`)},`);
  }
  if (request.headers.length > 0) {
    code.add(1, 'CURLOPT_HTTPHEADER => [');
    for (const row of request.headers) {
      code.add(2, `${expr(PHP, `${row.name}: ${row.value}`)},`);
    }
    code.add(1, '],');
  }
  if (body.kind !== 'none') {
    code.add(1, 'CURLOPT_POSTFIELDS => $body,');
  }
  code.add(0, ']);').blank();
  code.add(0, '$response = curl_exec($curl);');
  code.add(0, 'if ($response === false) {');
  code.add(1, 'fwrite(STDERR, curl_error($curl) . PHP_EOL);');
  code.add(1, 'exit(1);');
  code.add(0, '}');
  code.add(0, 'echo curl_getinfo($curl, CURLINFO_RESPONSE_CODE) . PHP_EOL;');
  code.add(0, 'echo $response . PHP_EOL;');
  code.add(0, 'curl_close($curl);');
  return { code: code.toString(), notes: [] };
}

const RUBY: Syntax = { quote: singleQuote, env: (name) => `ENV.fetch('${name}')`, join: ' + ' };

/** The `Net::HTTP` request classes, by method. */
const RUBY_METHODS: Readonly<Record<string, string>> = {
  GET: 'Get',
  POST: 'Post',
  PUT: 'Put',
  PATCH: 'Patch',
  DELETE: 'Delete',
  HEAD: 'Head',
  OPTIONS: 'Options',
  TRACE: 'Trace',
};

/** Ruby with `Net::HTTP`, which never follows a redirect. */
export function rubyNetHttp(request: CodeRequest, layout: Layout): GeneratedCode {
  const notes: string[] = layout.followRedirects ? [NO_FOLLOW_NOTE] : [];
  const code = new CodeLines(layout.unit);
  for (const note of notes) code.add(0, `# Note: ${note}`);
  code.add(0, "require 'net/http'");
  if (request.insecure === true) code.add(0, "require 'openssl'");
  code.add(0, "require 'uri'").blank();

  const { body } = request;
  code.add(0, `uri = URI(${expr(RUBY, request.url)})`);
  const known = RUBY_METHODS[request.method];
  code.add(
    0,
    known !== undefined
      ? `request = Net::HTTP::${known}.new(uri)`
      : `request = Net::HTTPGenericRequest.new(${RUBY.quote(request.method)}, ${body.kind === 'none' ? 'false' : 'true'}, true, uri)`,
  );
  const seen = new Set<string>();
  for (const row of request.headers) {
    const lower = row.name.toLowerCase();
    code.add(
      0,
      seen.has(lower)
        ? `request.add_field(${RUBY.quote(row.name)}, ${expr(RUBY, row.value)})`
        : `request[${RUBY.quote(row.name)}] = ${expr(RUBY, row.value)}`,
    );
    seen.add(lower);
  }
  if (request.basic !== undefined) {
    code.add(0, `request.basic_auth(${expr(RUBY, request.basic.username)}, ${expr(RUBY, request.basic.password)})`);
  }
  switch (body.kind) {
    case 'raw':
      code.add(0, `request.body = ${expr(RUBY, body.text)}`);
      break;
    case 'form':
      if (headerValue(request.headers, 'content-type') === undefined) {
        code.add(0, "request['Content-Type'] = 'application/x-www-form-urlencoded'");
      }
      code.add(0, `request.body = ${formExpr(RUBY, body.fields, (read) => `URI.encode_www_form_component(${read})`)}`);
      break;
    case 'multipart':
      code.add(0, 'request.set_form([');
      for (const part of body.parts) {
        if (part.kind === 'file') {
          const path = filePath(part.path);
          const options = [`filename: ${RUBY.quote(baseName(path))}`];
          if (part.contentType !== undefined) options.push(`content_type: ${RUBY.quote(part.contentType)}`);
          code.add(1, `[${expr(RUBY, part.name)}, File.open(${RUBY.quote(path)}), { ${options.join(', ')} }],`);
        } else if (part.contentType !== undefined) {
          code.add(
            1,
            `[${expr(RUBY, part.name)}, ${expr(RUBY, part.value)}, { content_type: ${RUBY.quote(part.contentType)} }],`,
          );
        } else {
          code.add(1, `[${expr(RUBY, part.name)}, ${expr(RUBY, part.value)}],`);
        }
      }
      code.add(0, "], 'multipart/form-data')");
      break;
    case 'binary':
      code.add(0, `request.body = File.binread(${RUBY.quote(filePath(body.path))})`);
      break;
    default:
      break;
  }
  code.blank();

  const options = ["use_ssl: uri.scheme == 'https'"];
  if (request.insecure === true) options.push('verify_mode: OpenSSL::SSL::VERIFY_NONE');
  if (layout.timeoutMs !== undefined) {
    const seconds = String(layout.timeoutMs / 1000);
    options.push(`open_timeout: ${seconds}`, `read_timeout: ${seconds}`);
  }
  code.add(0, 'response = Net::HTTP.start(');
  code.add(1, 'uri.hostname,');
  code.add(1, 'uri.port,');
  options.forEach((option, index) => {
    code.add(1, `${option}${index === options.length - 1 ? '' : ','}`);
  });
  code.add(0, ') do |http|');
  code.add(1, 'http.request(request)');
  code.add(0, 'end').blank();
  code.add(0, 'puts response.code');
  code.add(0, 'puts response.body');
  return { code: code.toString(), notes };
}
