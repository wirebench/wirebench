/**
 * A REST request as `curl`, and back.
 *
 * The export goldens are written out in full: the whole point of the command is that a user pastes it
 * into a terminal, so what matters is the exact text, not that it "contains" the right flags.
 */
import { describe, expect, it } from 'vitest';
import { CURL_REDACTED, fromRestCurl, restToCurl } from '../../../src/rest/curl.js';
import { entry } from '../../../src/rest/model.js';
import type { RestBody, RestSendInput } from '../../../src/index.js';

/** A resolved send, with only what a test overrides spelled out. */
function input(overrides: {
  readonly method?: string;
  readonly url?: string;
  readonly baseUrl?: string;
  readonly query?: RestSendInput['request']['query'];
  readonly headers?: RestSendInput['request']['headers'];
  readonly body?: RestBody;
  readonly auth?: RestSendInput['auth'];
  readonly settings?: Partial<RestSendInput['settings']>;
  readonly tls?: RestSendInput['tls'];
}): RestSendInput {
  return {
    baseUrl: overrides.baseUrl ?? 'https://api.test',
    request: {
      method: overrides.method ?? 'GET',
      url: overrides.url ?? '/pets',
      pathParams: [],
      query: overrides.query ?? [],
      headers: overrides.headers ?? [],
      body: overrides.body ?? { kind: 'none' },
    },
    settings: { timeoutMs: 30_000, followRedirects: false, ...overrides.settings },
    ...(overrides.auth !== undefined ? { auth: overrides.auth } : {}),
    ...(overrides.tls !== undefined ? { tls: overrides.tls } : {}),
  };
}

describe('restToCurl', () => {
  it('writes the method and URL on one line, then the options', () => {
    const command = restToCurl(
      input({
        query: [entry('status', 'open'), entry('page', '2', { enabled: false })],
        headers: [entry('X-Trace', 'abc')],
      }),
    );

    // The disabled query row is absent, as it is on the wire.
    expect(command).toBe(
      ["curl --request GET 'https://api.test/pets?status=open' \\", "  --header 'X-Trace: abc'"].join('\n'),
    );
  });

  it('sends a raw body through a heredoc, so newlines and quotes survive', () => {
    const command = restToCurl(
      input({
        method: 'POST',
        body: { kind: 'raw', language: 'json', text: '{\n  "name": "it\'s a dog"\n}' },
        headers: [entry('Content-Type', 'application/json')],
      }),
    );

    expect(command).toBe(
      [
        "curl --request POST 'https://api.test/pets' \\",
        "  --header 'Content-Type: application/json' \\",
        "  --data-binary @- <<'EOF'",
        '{',
        '  "name": "it\'s a dog"',
        '}',
        'EOF',
      ].join('\n'),
    );
  });

  it('writes a form field per --data-urlencode, so curl does the encoding', () => {
    const command = restToCurl(
      input({
        method: 'POST',
        body: { kind: 'form', fields: [entry('grant_type', 'password'), entry('skip', 'x', { enabled: false })] },
      }),
    );

    expect(command).toBe(
      ["curl --request POST 'https://api.test/pets' \\", "  --data-urlencode 'grant_type=password'"].join('\n'),
    );
  });

  it('writes one --form per multipart part, with @file where the bytes are', () => {
    const command = restToCurl(
      input({
        method: 'POST',
        body: {
          kind: 'multipart',
          parts: [
            { kind: 'text', name: 'note', value: 'hello', enabled: true },
            {
              kind: 'file',
              name: 'file',
              source: { kind: 'path', path: '/tmp/cat.png' },
              enabled: true,
              contentType: 'image/png',
            },
            { kind: 'file', name: 'unset', source: { kind: 'path', path: '' }, enabled: true },
          ],
        },
      }),
    );

    expect(command).toContain("--form 'note=hello'");
    expect(command).toContain("--form 'file=@/tmp/cat.png;type=image/png'");
    // No file chosen yet: a placeholder the user edits beats a command that silently sends nothing.
    expect(command).toContain("--form 'unset=@/path/to/file'");
  });

  it('points --data-binary at the file a binary body names', () => {
    const command = restToCurl(
      input({
        method: 'PUT',
        body: {
          kind: 'binary',
          source: { kind: 'path', path: '/tmp/blob.bin' },
          contentType: 'application/octet-stream',
        },
      }),
    );

    expect(command).toContain("--data-binary '@/tmp/blob.bin'");
  });

  it('redacts every credential by default, and shows them when asked', () => {
    const bearer = input({ auth: { type: 'bearer', token: 'tok-123' } });
    expect(restToCurl(bearer)).toContain(`--header 'Authorization: ${CURL_REDACTED}'`);
    expect(restToCurl(bearer, { redactSecrets: false })).toContain("--header 'Authorization: Bearer tok-123'");

    const basic = input({ auth: { type: 'basic', username: 'ada', password: 'hunter2', preemptive: true } });
    expect(restToCurl(basic)).toContain(`--user 'ada:${CURL_REDACTED}'`);
    expect(restToCurl(basic, { redactSecrets: false })).toContain("--user 'ada:hunter2'");

    // A key in the query is part of the URL, so it is redacted there rather than in a header.
    const query = input({ auth: { type: 'api-key', name: 'api_key', value: 'k-1', in: 'query' } });
    expect(restToCurl(query)).toContain(`api_key=${CURL_REDACTED}`);
    expect(restToCurl(query, { redactSecrets: false })).toContain('api_key=k-1');
  });

  it('carries an OAuth2 access token as the Bearer header it becomes', () => {
    const command = restToCurl(input({ auth: { type: 'oauth2', accessToken: 'at-9' } }), { redactSecrets: false });

    expect(command).toContain("--header 'Authorization: Bearer at-9'");
  });

  it('says -k and -L only when the send actually does either', () => {
    expect(restToCurl(input({}))).not.toContain('--insecure');
    expect(restToCurl(input({}))).not.toContain('--location');

    const risky = restToCurl(
      input({ tls: { rejectUnauthorized: false }, settings: { followRedirects: true, maxRedirects: 3 } }),
    );
    expect(risky).toContain('--insecure');
    expect(risky).toContain('--location');
    expect(risky).toContain('--max-redirs 3');
  });

  it('quotes for PowerShell and continues its lines with a backtick', () => {
    const command = restToCurl(input({ method: 'POST', body: { kind: 'raw', language: 'json', text: '{}' } }), {
      shell: 'powershell',
    });

    expect(command.startsWith("curl.exe --request POST 'https://api.test/pets' `")).toBe(true);
    expect(command).toContain("--data-binary @'");
    expect(command.endsWith("'@")).toBe(true);
  });
});

describe('fromRestCurl', () => {
  it('reads the method, URL, query and headers', () => {
    const result = fromRestCurl(
      `curl -X PATCH 'https://api.test/pets/7?fields=name' -H 'Accept: application/json' -H 'X-Trace: abc'`,
    );

    expect(result.request.method).toBe('PATCH');
    expect(result.request.url).toBe('https://api.test/pets/7');
    expect(result.request.query).toEqual([{ name: 'fields', value: 'name', enabled: true }]);
    expect(result.request.headers).toEqual([
      { name: 'Accept', value: 'application/json', enabled: true },
      { name: 'X-Trace', value: 'abc', enabled: true },
    ]);
    expect(result.problems).toEqual([]);
  });

  it('splits the URL against the API base, so the request follows its environment', () => {
    const result = fromRestCurl(`curl https://api.test/v1/pets?x=1`, { baseUrl: 'https://api.test/v1' });

    expect(result.request.url).toBe('/pets');

    // A URL that is not under the base is left absolute rather than mangled.
    const elsewhere = fromRestCurl(`curl https://other.test/pets`, { baseUrl: 'https://api.test/v1' });
    expect(elsewhere.request.url).toBe('https://other.test/pets');
  });

  it('defaults to GET, and to POST when the command carries a body', () => {
    expect(fromRestCurl(`curl https://api.test/pets`).request.method).toBe('GET');
    expect(fromRestCurl(`curl https://api.test/pets -d '{}'`).request.method).toBe('POST');
    // An explicit -X always wins, even with a body.
    expect(fromRestCurl(`curl -X PUT https://api.test/pets -d '{}'`).request.method).toBe('PUT');
  });

  it('takes the body from the most specific flag, and its language from the content type', () => {
    const raw = fromRestCurl(`curl https://api.test/p -H 'Content-Type: application/json' -d '{"a":1}'`);
    expect(raw.request.body).toEqual({ kind: 'raw', language: 'json', text: '{"a":1}' });

    // A vendor type edits as JSON but must travel as itself.
    const vendor = fromRestCurl(`curl https://api.test/p -H 'Content-Type: application/vnd.api+json' -d '{}'`);
    expect(vendor.request.body).toEqual({
      kind: 'raw',
      language: 'json',
      contentType: 'application/vnd.api+json',
      text: '{}',
    });

    const form = fromRestCurl(`curl https://api.test/p --data-urlencode 'a=1' --data-urlencode 'b=2'`);
    expect(form.request.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'a', value: '1', enabled: true },
        { name: 'b', value: '2', enabled: true },
      ],
    });

    const multipart = fromRestCurl(`curl https://api.test/p -F 'note=hi' -F 'file=@/tmp/x.png'`);
    expect(multipart.request.body).toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'note', value: 'hi', enabled: true },
        { kind: 'file', name: 'file', source: { kind: 'path', path: '/tmp/x.png' }, enabled: true },
      ],
    });

    // `-d @file` names bytes on disk, which is a binary body rather than a lost one.
    const binary = fromRestCurl(`curl https://api.test/p --data-binary '@/tmp/blob.bin'`);
    expect(binary.request.body).toEqual({
      kind: 'binary',
      source: { kind: 'path', path: '/tmp/blob.bin' },
      contentType: 'application/octet-stream',
    });
  });

  it('reads a heredoc body verbatim, newlines and all', () => {
    const result = fromRestCurl(
      ["curl --request POST 'https://api.test/p' \\", "  --data-binary @- <<'EOF'", '{', '  "a": 1', '}', 'EOF'].join(
        '\n',
      ),
    );

    expect(result.request.body).toEqual({ kind: 'raw', language: 'text', text: '{\n  "a": 1\n}' });
  });

  it('hands a -u password back separately, never inside the request', () => {
    const result = fromRestCurl(`curl https://api.test/p -u 'ada:hunter2'`);

    expect(result.basic).toEqual({ username: 'ada', password: 'hunter2' });
    // Nothing in the model may hold a credential value.
    expect(JSON.stringify(result.request)).not.toContain('hunter2');
  });

  it('maps -k, -L and --max-redirs onto the request settings', () => {
    const result = fromRestCurl(`curl -k -L --max-redirs 2 https://api.test/p`);

    expect(result.request.settings).toEqual({ trustInvalid: true, followRedirects: true, maxRedirects: 2 });
  });

  it('fills the path-parameter table from a templated URL', () => {
    const result = fromRestCurl(`curl 'https://api.test/pets/{petId}/photos/{photoId}'`);

    expect(result.request.pathParams).toEqual([
      { name: 'petId', value: '', enabled: true },
      { name: 'photoId', value: '', enabled: true },
    ]);
  });

  it('names what it ignored rather than dropping it silently', () => {
    const result = fromRestCurl(`curl --retry 3 --compressed -o out.json https://api.test/p`);

    expect(result.problems).toEqual(['Ignored --retry', 'Ignored --compressed', 'Ignored -o']);
    // A value-taking flag consumes its argument, so the URL is still found.
    expect(result.request.url).toBe('https://api.test/p');
  });

  it('says so when there is no URL at all', () => {
    expect(fromRestCurl('curl -X POST').problems).toEqual(['No URL in the command']);
  });

  it('round-trips what restToCurl produced', () => {
    const original = input({
      method: 'POST',
      url: '/pets',
      query: [entry('status', 'open')],
      headers: [entry('Content-Type', 'application/json')],
      body: { kind: 'raw', language: 'json', text: '{"name":"Fido"}' },
    });

    const parsed = fromRestCurl(restToCurl(original), { baseUrl: 'https://api.test' });

    expect(parsed.request.method).toBe('POST');
    expect(parsed.request.url).toBe('/pets');
    expect(parsed.request.query).toEqual([{ name: 'status', value: 'open', enabled: true }]);
    expect(parsed.request.body).toEqual({ kind: 'raw', language: 'json', text: '{"name":"Fido"}' });
  });
});

describe('heredoc scan', () => {
  it('is linear, where the regex it replaces backtracked the body against the delimiter', () => {
    const time = (n: number): number => {
      // Many `<<` openers and no closing line: the old pattern retried the lazy body for each one.
      const input = "curl https://api.test/p --data-binary @- <<'EOF'\n" + '<<a\n'.repeat(n);
      const started = performance.now();
      fromRestCurl(input, { baseUrl: 'https://api.test' });
      return performance.now() - started;
    };
    time(10_000);
    expect(time(100_000)).toBeLessThan(400);
  });

  it('reads a CRLF heredoc, and a heredoc whose delimiter is unquoted', () => {
    const crlf = ['curl https://api.test/p --data-binary @- <<EOF', '{', '  "a": 1', '}', 'EOF'].join('\r\n');
    const result = fromRestCurl(crlf, { baseUrl: 'https://api.test' });
    expect(result.request.body).toMatchObject({ kind: 'raw', text: '{\r\n  "a": 1\r\n}' });
  });
});
