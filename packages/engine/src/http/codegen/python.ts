/** Python with requests. */

import { hasEnv } from './model.js';
import type { CodeRequest, GeneratedCode } from './model.js';
import { mergedHeaders, readsEnv } from './target.js';
import type { Layout } from './target.js';
import { baseName, cEscape, CodeLines, expr, filePath, hexEscape } from './text.js';
import type { Syntax } from './text.js';

const PY: Syntax = {
  quote: (text) => `'${cEscape(text, "'", hexEscape)}'`,
  env: (name) => `os.environ[${`'${name}'`}]`,
  join: ' + ',
};

/** A triple-quoted body that keeps its lines as lines; plain text that cannot be one is a literal. */
function bodyLiteral(text: string): string {
  if (!text.includes('\n') || hasEnv(text) || text.includes('\r')) {
    return expr(PY, text);
  }
  const escaped = text.replace(/\\/g, '\\\\').replace(/'''/g, "''\\'").replace(/'$/, "\\'");
  return `'''\\\n${escaped}'''`;
}

/** Python with `requests`. Seconds for the timeout, as requests counts them. */
export function pythonRequests(request: CodeRequest, layout: Layout): GeneratedCode {
  const code = new CodeLines(layout.unit);
  if (readsEnv(request)) {
    code.add(0, 'import os');
  }
  code.add(0, 'import requests').blank();

  const { body } = request;
  const args: string[] = [PY.quote(request.method), expr(PY, request.url)];
  if (body.kind === 'raw') {
    code.add(0, `body = ${bodyLiteral(body.text)}`);
    args.push('data=body.encode()');
  } else if (body.kind === 'form') {
    code.add(0, 'body = [');
    for (const field of body.fields) {
      code.add(1, `(${expr(PY, field.name)}, ${expr(PY, field.value)}),`);
    }
    code.add(0, ']');
    args.push('data=body');
  } else if (body.kind === 'multipart') {
    code.add(0, 'files = [');
    for (const part of body.parts) {
      const type = part.contentType !== undefined ? `, ${PY.quote(part.contentType)}` : '';
      if (part.kind === 'file') {
        const path = filePath(part.path);
        code.add(1, `(${expr(PY, part.name)}, (${PY.quote(baseName(path))}, open(${PY.quote(path)}, 'rb')${type})),`);
      } else {
        code.add(1, `(${expr(PY, part.name)}, (None, ${expr(PY, part.value)}${type})),`);
      }
    }
    code.add(0, ']');
    args.push('files=files');
  } else if (body.kind === 'binary') {
    code.add(0, `body = open(${PY.quote(filePath(body.path))}, 'rb')`);
    args.push('data=body');
  }
  if (body.kind !== 'none') {
    code.blank();
  }

  const headers = mergedHeaders(request.headers);
  if (headers.length > 0) {
    code.add(0, 'headers = {');
    for (const header of headers) {
      code.add(1, `${PY.quote(header.name)}: ${expr(PY, header.value)},`);
    }
    code.add(0, '}').blank();
    args.push('headers=headers');
  }
  if (request.basic !== undefined) {
    args.push(`auth=(${expr(PY, request.basic.username)}, ${expr(PY, request.basic.password)})`);
  }
  args.push(`allow_redirects=${layout.followRedirects ? 'True' : 'False'}`);
  if (layout.timeoutMs !== undefined) {
    args.push(`timeout=${String(layout.timeoutMs / 1000)}`);
  }
  if (request.insecure === true) {
    args.push('verify=False');
  }

  const session = layout.followRedirects && layout.maxRedirects !== undefined;
  if (session) {
    code.add(0, 'session = requests.Session()');
    code.add(0, `session.max_redirects = ${String(layout.maxRedirects)}`);
  }
  code.add(0, `response = ${session ? 'session' : 'requests'}.request(`);
  for (const argument of args) {
    code.add(1, `${argument},`);
  }
  code.add(0, ')').blank();
  code.add(0, 'print(response.status_code)');
  code.add(0, 'print(response.text)');
  return { code: code.toString(), notes: [] };
}
