/** Go with net/http. */

import { hasEnv } from './model.js';
import type { CodeRequest, GeneratedCode } from './model.js';
import type { Layout } from './target.js';
import { baseName, cEscape, CodeLines, expr, filePath, formExpr, headerValue, hexEscape } from './text.js';
import type { Syntax } from './text.js';

const GO: Syntax = {
  quote: (text) => `"${cEscape(text, '"', hexEscape)}"`,
  env: (name) => `os.Getenv("${name}")`,
  join: ' + ',
};

/** A raw string literal when the text allows one: it keeps a JSON or XML body readable. */
function bodyLiteral(text: string): string {
  return text.includes('\n') && !text.includes('`') && !text.includes('\r') && !hasEnv(text)
    ? `\`${text}\``
    : expr(GO, text);
}

const MUST = ['if err != nil {', 'panic(err)', '}'] as const;

/** `if err != nil { panic(err) }` at `level`. */
function check(code: CodeLines, level: number): void {
  code
    .add(level, MUST[0])
    .add(level + 1, MUST[1])
    .add(level, MUST[2]);
}

/** Go with `net/http`: a whole program, imports limited to what it uses, as the compiler insists. */
export function goNetHttp(request: CodeRequest, layout: Layout): GeneratedCode {
  const imports = new Set<string>(['fmt', 'io', 'net/http']);
  const notes: string[] = [];
  const main = new CodeLines(layout.unit);
  const { body } = request;
  let bodyName = 'nil';

  switch (body.kind) {
    case 'raw':
      imports.add('strings');
      main.add(1, `body := strings.NewReader(${bodyLiteral(body.text)})`);
      bodyName = 'body';
      break;
    case 'form':
      imports.add('strings');
      main.add(
        1,
        `body := strings.NewReader(${formExpr(GO, body.fields, (read) => {
          imports.add('net/url');
          return `url.QueryEscape(${read})`;
        })})`,
      );
      bodyName = 'body';
      break;
    case 'multipart': {
      imports.add('bytes').add('mime/multipart');
      main.add(1, 'body := &bytes.Buffer{}');
      main.add(1, 'writer := multipart.NewWriter(body)');
      let files = 0;
      for (const part of body.parts) {
        if (part.kind === 'file') {
          files += 1;
          imports.add('os');
          const path = filePath(part.path);
          main.add(1, `file${String(files)}, err := os.Open(${GO.quote(path)})`);
          check(main, 1);
          main.add(1, `defer file${String(files)}.Close()`);
          main.add(
            1,
            `part${String(files)}, err := writer.CreateFormFile(${expr(GO, part.name)}, ${GO.quote(baseName(path))})`,
          );
          check(main, 1);
          main.add(1, `if _, err := io.Copy(part${String(files)}, file${String(files)}); err != nil {`);
          main.add(2, 'panic(err)').add(1, '}');
        } else {
          main.add(1, `if err := writer.WriteField(${expr(GO, part.name)}, ${expr(GO, part.value)}); err != nil {`);
          main.add(2, 'panic(err)').add(1, '}');
        }
      }
      main.add(1, 'if err := writer.Close(); err != nil {').add(2, 'panic(err)').add(1, '}');
      if (body.parts.some((part) => part.contentType !== undefined)) {
        notes.push('Part content types are not set; CreateFormFile sends application/octet-stream.');
      }
      bodyName = 'body';
      break;
    }
    case 'binary':
      imports.add('os');
      main.add(1, `body, err := os.Open(${GO.quote(filePath(body.path))})`);
      check(main, 1);
      main.add(1, 'defer body.Close()');
      bodyName = 'body';
      break;
    default:
      break;
  }
  if (body.kind !== 'none') {
    main.blank();
  }

  main.add(1, `req, err := http.NewRequest(${GO.quote(request.method)}, ${expr(GO, request.url)}, ${bodyName})`);
  check(main, 1);
  for (const header of request.headers) {
    main.add(1, `req.Header.Add(${GO.quote(header.name)}, ${expr(GO, header.value)})`);
  }
  if (body.kind === 'multipart') {
    main.add(1, 'req.Header.Set("Content-Type", writer.FormDataContentType())');
  }
  if (body.kind === 'form' && headerValue(request.headers, 'content-type') === undefined) {
    main.add(1, 'req.Header.Set("Content-Type", "application/x-www-form-urlencoded")');
  }
  if (request.basic !== undefined) {
    main.add(1, `req.SetBasicAuth(${expr(GO, request.basic.username)}, ${expr(GO, request.basic.password)})`);
  }
  main.blank();

  const client = new CodeLines(layout.unit);
  if (layout.timeoutMs !== undefined) {
    imports.add('time');
    client.add(2, `Timeout: ${String(layout.timeoutMs)} * time.Millisecond,`);
  }
  if (!layout.followRedirects || layout.maxRedirects !== undefined) {
    client.add(2, 'CheckRedirect: func(req *http.Request, via []*http.Request) error {');
    if (layout.followRedirects) {
      client
        .add(3, `if len(via) > ${String(layout.maxRedirects)} {`)
        .add(4, 'return http.ErrUseLastResponse')
        .add(3, '}');
      client.add(3, 'return nil');
    } else {
      client.add(3, 'return http.ErrUseLastResponse');
    }
    client.add(2, '},');
  }
  if (request.insecure === true) {
    imports.add('crypto/tls');
    client.add(2, 'Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},');
  }
  const fields = client.toString();
  if (fields === '') {
    main.add(1, 'client := &http.Client{}').blank();
  } else {
    main.add(1, 'client := &http.Client{').add(0, fields).add(1, '}').blank();
  }
  main.add(1, 'res, err := client.Do(req)');
  check(main, 1);
  main.add(1, 'defer res.Body.Close()');
  main.add(1, 'data, err := io.ReadAll(res.Body)');
  check(main, 1);
  main.add(1, 'fmt.Println(res.Status)');
  main.add(1, 'fmt.Println(string(data))');
  if (hasEnv(JSON.stringify(request))) {
    imports.add('os');
  }

  const code = new CodeLines(layout.unit);
  for (const note of notes) {
    code.add(0, `// Note: ${note}`);
  }
  code.add(0, 'package main').blank().add(0, 'import (');
  for (const name of [...imports].sort()) {
    code.add(1, `"${name}"`);
  }
  code.add(0, ')').blank().add(0, 'func main() {');
  return { code: `${code.toString()}\n${main.toString()}\n}`, notes };
}
