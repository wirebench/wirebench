/** JavaScript targets: `fetch` (Node 18+) and Node.js with axios. */

import { hasEnv, splitEnv } from './model.js';
import type { CodeRequest, GeneratedCode } from './model.js';
import { INSECURE_NOTE, maxRedirectsNote, mergedHeaders, readsFiles } from './target.js';
import type { Layout } from './target.js';
import { baseName, cEscape, CodeLines, expr, filePath } from './text.js';
import type { Syntax } from './text.js';

const JS: Syntax = {
  quote: (text) => `'${cEscape(text, "'")}'`,
  env: (name) => `process.env.${name}`,
  join: ' + ',
};

/** A template literal: what a multi-line body reads best as, environment reads spliced in. */
function template(text: string): string {
  return `\`${splitEnv(text)
    .map((part) =>
      'env' in part
        ? `\${process.env.${part.env}}`
        : part.text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'),
    )
    .join('')}\``;
}

/** A body value: a template literal when it spans lines or reads the environment, a plain string otherwise. */
function bodyLiteral(text: string): string {
  return text.includes('\n') || hasEnv(text) ? template(text) : JS.quote(text);
}

/** `const body = …` statements for the request's body, shared by both targets. */
function bodyStatements(code: CodeLines, request: CodeRequest): void {
  const { body } = request;
  switch (body.kind) {
    case 'raw':
      code.add(0, `const body = ${bodyLiteral(body.text)};`);
      break;
    case 'form':
      code.add(0, 'const body = new URLSearchParams();');
      for (const field of body.fields) {
        code.add(0, `body.append(${expr(JS, field.name)}, ${expr(JS, field.value)});`);
      }
      break;
    case 'multipart':
      code.add(0, 'const body = new FormData();');
      for (const part of body.parts) {
        if (part.kind === 'file') {
          const type = part.contentType !== undefined ? `, { type: ${JS.quote(part.contentType)} }` : '';
          code.add(
            0,
            `body.append(${expr(JS, part.name)}, new Blob([await readFile(${JS.quote(filePath(part.path))})]${type}), ${JS.quote(baseName(filePath(part.path)))});`,
          );
        } else if (part.contentType !== undefined) {
          code.add(
            0,
            `body.append(${expr(JS, part.name)}, new Blob([${expr(JS, part.value)}], { type: ${JS.quote(part.contentType)} }));`,
          );
        } else {
          code.add(0, `body.append(${expr(JS, part.name)}, ${expr(JS, part.value)});`);
        }
      }
      break;
    case 'binary':
      code.add(0, `const body = await readFile(${JS.quote(filePath(body.path))});`);
      break;
    default:
      break;
  }
}

/** The header rows of an object literal at `level`, Basic as an `Authorization` header when asked. */
function headerRows(code: CodeLines, level: number, request: CodeRequest, basicAsHeader: boolean): void {
  for (const header of mergedHeaders(request.headers)) {
    code.add(level, `${JS.quote(header.name)}: ${expr(JS, header.value)},`);
  }
  if (basicAsHeader && request.basic !== undefined) {
    const credentials = expr(JS, `${request.basic.username}:${request.basic.password}`);
    code.add(level, `'Authorization': 'Basic ' + btoa(${credentials}),`);
  }
}

function comments(code: CodeLines, notes: readonly string[]): void {
  for (const note of notes) {
    code.add(0, `// Note: ${note}`);
  }
  if (notes.length > 0) {
    code.blank();
  }
}

/** `fetch`, as Node 18+ ships it. */
export function jsFetch(request: CodeRequest, layout: Layout): GeneratedCode {
  const notes: string[] = [];
  if (request.insecure === true) {
    notes.push(INSECURE_NOTE);
  }
  if (layout.followRedirects && layout.maxRedirects !== undefined) {
    notes.push(maxRedirectsNote(layout.maxRedirects));
  }
  const code = new CodeLines(layout.unit);
  comments(code, notes);
  if (readsFiles(request)) {
    code.add(0, "import { readFile } from 'node:fs/promises';").blank();
  }
  if (request.body.kind !== 'none') {
    bodyStatements(code, request);
    code.blank();
  }
  code.add(0, `const response = await fetch(${expr(JS, request.url)}, {`);
  code.add(1, `method: ${JS.quote(request.method)},`);
  if (request.headers.length > 0 || request.basic !== undefined) {
    code.add(1, 'headers: {');
    headerRows(code, 2, request, true);
    code.add(1, '},');
  }
  if (request.body.kind !== 'none') {
    code.add(1, 'body,');
  }
  code.add(1, `redirect: ${JS.quote(layout.followRedirects ? 'follow' : 'manual')},`);
  if (layout.timeoutMs !== undefined) {
    code.add(1, `signal: AbortSignal.timeout(${String(layout.timeoutMs)}),`);
  }
  code.add(0, '});').blank();
  code.add(0, 'console.log(response.status);');
  code.add(0, 'console.log(await response.text());');
  return { code: code.toString(), notes };
}

/** axios on Node.js. */
export function nodeAxios(request: CodeRequest, layout: Layout): GeneratedCode {
  const notes: string[] = [];
  const code = new CodeLines(layout.unit);
  code.add(0, "import axios from 'axios';");
  if (readsFiles(request)) {
    code.add(0, "import { readFile } from 'node:fs/promises';");
  }
  if (request.insecure === true) {
    code.add(0, "import https from 'node:https';");
  }
  code.blank();
  if (request.body.kind !== 'none') {
    bodyStatements(code, request);
    code.blank();
  }
  code.add(0, 'const response = await axios.request({');
  code.add(1, `method: ${JS.quote(request.method.toLowerCase())},`);
  code.add(1, `url: ${expr(JS, request.url)},`);
  if (request.headers.length > 0) {
    code.add(1, 'headers: {');
    headerRows(code, 2, request, false);
    code.add(1, '},');
  }
  if (request.body.kind !== 'none') {
    code.add(1, 'data: body,');
  }
  if (request.basic !== undefined) {
    code.add(
      1,
      `auth: { username: ${expr(JS, request.basic.username)}, password: ${expr(JS, request.basic.password)} },`,
    );
  }
  if (!layout.followRedirects) {
    code.add(1, 'maxRedirects: 0,');
  } else if (layout.maxRedirects !== undefined) {
    code.add(1, `maxRedirects: ${String(layout.maxRedirects)},`);
  }
  if (layout.timeoutMs !== undefined) {
    code.add(1, `timeout: ${String(layout.timeoutMs)},`);
  }
  if (request.insecure === true) {
    code.add(1, 'httpsAgent: new https.Agent({ rejectUnauthorized: false }),');
  }
  code.add(1, "responseType: 'text',");
  code.add(1, 'validateStatus: () => true,');
  code.add(0, '});').blank();
  code.add(0, 'console.log(response.status);');
  code.add(0, 'console.log(response.data);');
  return { code: code.toString(), notes };
}
