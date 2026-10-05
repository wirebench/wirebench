import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpFileError } from '../../../../src/errors.js';
import { importHttpFile } from '../../../../src/import/http-file/import.js';
import { mapHttpFile } from '../../../../src/import/http-file/map.js';
import { MAX_HTTP_FILE_BYTES, parseHttpFile } from '../../../../src/rest/http-file/parse.js';
import { entry } from '../../../../src/rest/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../../../../fixtures');

function readFixture(rel: string): string {
  return readFileSync(resolve(fixtureDir, rel), 'utf8');
}

function mapText(text: string, options: { name?: string; fileDir?: string } = {}): ReturnType<typeof mapHttpFile> {
  return mapHttpFile(parseHttpFile(text), { name: options.name ?? 'x', ...options });
}

describe('mapHttpFile', () => {
  const mapped = mapHttpFile(parseHttpFile(readFixture('http-file/crafted/api.http')), {
    name: 'api',
    fileDir: '/work',
  });
  const [list, create, upload, env] = mapped.rest.requests;

  it('makes one REST API named after the file', () => {
    expect(mapped.rest.name).toBe('api');
    expect(mapped.rest.requests.map((r) => r.name)).toEqual([
      'List pets',
      'createPet',
      'Upload',
      'GET /env/${#System#HOME}',
    ]);
    expect(list?.url).toBe('${host}/pets');
    expect(list?.query).toEqual([entry('limit', '10'), entry('sort', 'name')]);
    expect(mapped.counts).toEqual({ requests: 4, websocket: 1, skipped: 1 });
  });

  it('turns @variables into project properties, first definition kept', () => {
    expect(mapped.projectProperties.variables).toEqual([
      { name: 'host', value: '${baseUrl}/v1', enabled: true, secret: false },
      { name: 'user', value: 'alice', enabled: true, secret: false },
    ]);
  });

  it('keeps a bearer credential that is only a reference as a header, and maps directives and bodies', () => {
    expect(create?.auth).toEqual({ type: 'inherit' });
    expect(create?.headers).toContainEqual(entry('Authorization', 'Bearer ${token}'));
    expect(create?.settings).toMatchObject({ followRedirects: false, timeoutMs: 5000 });
    expect(create?.body).toMatchObject({ kind: 'raw', language: 'json', text: '{"name": "Rex", "id": "{{$uuid}}"}' });
    expect(upload?.body).toEqual({
      kind: 'binary',
      source: { kind: 'path', path: '/work/photo.png' },
      contentType: 'application/octet-stream',
    });
    expect(env?.url).toBe('https://example.com/env/${#System#HOME}');
  });

  it('drops a literal bearer credential and warns', () => {
    const m = mapText('GET https://x.example.com/a\nAuthorization: Bearer abc');
    expect(m.rest.requests[0]?.auth).toEqual({ type: 'bearer' });
    expect(m.rest.requests[0]?.headers.map((h) => h.name)).not.toContain('Authorization');
    expect(m.report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('credential was not imported')]));
    expect(JSON.stringify(m)).not.toContain('abc');
  });

  it('keeps handler scripts as files and never as request scripts', () => {
    expect(mapped.scripts).toEqual([
      { path: 'imported-scripts/api/createpet.handler.js', source: 'client.global.set("petId", response.body.id);' },
    ]);
    expect(create?.scripts).toBeUndefined();
    expect(mapped.report.notes).toContain(
      'createPet: the response handler was saved to imported-scripts/api/createpet.handler.js and is never run.',
    );
  });

  it('puts WEBSOCKET requests in a WebSocket API, skips GRAPHQL, and reports chaining and dynamic variables', () => {
    expect(mapped.websocket?.name).toBe('api (WebSocket)');
    expect(mapped.websocket?.requests[0]).toMatchObject({ url: 'wss://example.com/ws' });
    expect(mapped.websocket?.requests[0]?.messages[0]?.content).toBe('{"hello": "world"}');
    expect(upload?.url).toContain('{{createPet.response.body.$.id}}');
    expect(mapped.report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GRAPHQL request at line'),
        expect.stringContaining('createPet.response'),
        'Dynamic variables are kept as written and not expanded: $uuid',
      ]),
    );
    expect(mapped.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('output redirect')]));
    expect(mapped.report.notes).toEqual(
      expect.arrayContaining(['Project properties: "host" is defined more than once; the first value was kept.']),
    );
  });
});

describe('mapHttpFile credentials', () => {
  it('keeps the user name of a literal Basic credential and drops the rest', () => {
    const encoded = mapText(`GET https://x.example.com/a\nAuthorization: Basic ${btoa('ann:pw1')}`);
    expect(encoded.rest.requests[0]?.auth).toEqual({ type: 'basic', username: 'ann' });
    const spaced = mapText('GET https://x.example.com/a\nAuthorization: Basic bob pw2');
    expect(spaced.rest.requests[0]?.auth).toEqual({ type: 'basic', username: 'bob' });
    expect(JSON.stringify([encoded, spaced])).not.toMatch(/pw1|pw2|YW5uOnB3MQ/);
  });

  it('maps another Authorization scheme to none, naming the scheme but not the credential', () => {
    const m = mapText('GET https://x.example.com/a\nAuthorization: Digest username="u", response="zz9"');
    expect(m.rest.requests[0]?.auth).toEqual({ type: 'none' });
    expect(m.rest.requests[0]?.headers).toEqual([]);
    expect(m.report.warnings).toContain('GET /a: Digest authentication is not supported and was imported as none.');
    const bare = mapText('GET https://x.example.com/a\nAuthorization: zz9secret');
    expect(bare.rest.requests[0]?.auth).toEqual({ type: 'none' });
    expect(JSON.stringify([m, bare])).not.toContain('zz9');
  });

  it('drops a literal credential header, blanks a literal credential query value, and keeps references', () => {
    const m = mapText(
      [
        'GET https://x.example.com/a?api_key=lit1&page=2&token={{tok}}',
        'X-Api-Key: lit2',
        'X-Session: {{session}}',
        'Accept: text/plain',
      ].join('\n'),
    );
    const request = m.rest.requests[0];
    expect(request?.query).toEqual([entry('api_key', ''), entry('page', '2'), entry('token', '${tok}')]);
    expect(request?.headers).toEqual([entry('X-Session', '${session}'), entry('Accept', 'text/plain')]);
    expect(m.report.warnings).toContain(
      'GET /a: the recorded value of api_key, X-Api-Key was not imported; set it on the request.',
    );
    expect(JSON.stringify(m)).not.toMatch(/lit1|lit2/);
  });

  it('blanks literal credential fields in JSON and form bodies, keeping references and formatting', () => {
    const json = mapText(
      'POST https://x.example.com/a\nContent-Type: application/json\n\n{\n  "user": "ann",\n  "password": "pw3",\n  "token": "{{tok}}"\n}',
    );
    expect(json.rest.requests[0]?.body).toMatchObject({
      kind: 'raw',
      language: 'json',
      text: '{\n  "user": "ann",\n  "password": "",\n  "token": "${tok}"\n}',
    });
    const form = mapText(
      'POST https://x.example.com/a\nContent-Type: application/x-www-form-urlencoded\n\nuser=ann&secret=pw4&csrf={{c}}',
    );
    expect(form.rest.requests[0]?.body).toEqual({
      kind: 'form',
      fields: [entry('user', 'ann'), entry('secret', ''), entry('csrf', '${c}')],
    });
    expect(form.report.warnings).toContain(
      'POST /a: the recorded value of secret was not imported; set it on the request.',
    );
    expect(JSON.stringify([json, form])).not.toMatch(/pw3|pw4/);
  });

  it('blanks a credential in a JSON body that does not parse, leaving the rest as written', () => {
    const m = mapText(
      'POST https://x.example.com/a\nContent-Type: application/json\n\n{"password": "pw5", "count": {{n}}}',
    );
    expect(m.rest.requests[0]?.body).toMatchObject({ text: '{"password": "", "count": ${n}}' });
  });

  it('stores a credential-named @variable with a literal value as a secret', () => {
    const m = mapText('@apiToken = pw6\n@authHeader = {{other}}\n\nGET https://x.example.com/a');
    expect(m.projectProperties.variables).toEqual([
      { name: 'apiToken', value: '', enabled: true, secret: true, secretValue: 'pw6' },
      { name: 'authHeader', value: '${other}', enabled: true, secret: false },
    ]);
  });
});

describe('mapHttpFile shape', () => {
  it('infers a shared origin as the base URL', () => {
    const m = mapText('GET https://api.example.com\n\n###\nGET https://api.example.com/pets?x=1');
    expect(m.rest.baseUrl).toBe('https://api.example.com');
    expect(m.rest.servers).toEqual([{ url: 'https://api.example.com' }]);
    expect(m.rest.requests.map((r) => r.url)).toEqual(['/', '/pets']);
    expect(m.rest.requests[1]?.query).toEqual([entry('x', '1')]);
  });

  it('infers a shared leading reference as the base URL', () => {
    const m = mapText('GET {{base}}/a\n\n###\nGET {{base}}/b');
    expect(m.rest.baseUrl).toBe('${base}');
    expect(m.rest.requests.map((r) => r.url)).toEqual(['/a', '/b']);
  });

  it('keeps a query that follows a system property in the query rows', () => {
    const m = mapText('GET https://x.example.com/{{$processEnv HOME}}?a=1\n\n###\nGET https://y.example.com/');
    expect(m.rest.requests[0]?.url).toBe('https://x.example.com/${#System#HOME}');
    expect(m.rest.requests[0]?.query).toEqual([entry('a', '1')]);
  });

  it('reads timeouts in milliseconds or with a unit, and notes other directives', () => {
    const m = mapText(
      '# @timeout 2500\nGET https://x.example.com/a\n\n###\n# @timeout 2 m\n# @no-log\nGET https://x.example.com/b',
    );
    expect(m.rest.requests.map((r) => r.settings.timeoutMs)).toEqual([2500, 120000]);
    expect(m.report.notes).toContain('GET /b: the "@no-log" directive has no Wirebench equivalent and was ignored.');
  });

  it('blanks literal credentials in an XML body, keeping references', () => {
    const m = mapText(
      [
        'POST https://x.example.com/a',
        'Content-Type: text/xml',
        '',
        '<l><user>u</user><password>hx-pw-1</password><token>{{t}}</token><a key="hx-k-2"/></l>',
      ].join('\n'),
    );
    expect(m.rest.requests[0]?.body).toMatchObject({
      kind: 'raw',
      language: 'xml',
      text: '<l><user>u</user><password></password><token>${t}</token><a key=""/></l>',
    });
    expect(JSON.stringify(m.rest)).not.toMatch(/hx-pw-1|hx-k-2/);
    expect(m.report.warnings.some((w) => w.includes('password, key'))).toBe(true);
  });

  it('maps XML, multipart and other bodies to raw text', () => {
    const m = mapText(
      [
        'POST https://x.example.com/a',
        'Content-Type: application/xml',
        '',
        '<a/>',
        '###',
        'POST https://x.example.com/b',
        'Content-Type: multipart/form-data; boundary=B',
        '',
        '--B--',
        '###',
        'POST https://x.example.com/c',
        '',
        'plain',
      ].join('\n'),
    );
    const [xml, multipart, plain] = m.rest.requests;
    expect(xml?.body).toMatchObject({ kind: 'raw', language: 'xml', text: '<a/>' });
    expect(multipart?.body).toEqual({
      kind: 'raw',
      language: 'text',
      contentType: 'multipart/form-data; boundary=B',
      text: '--B--',
    });
    expect(plain?.body).toEqual({ kind: 'raw', language: 'text', text: 'plain' });
    expect(m.report.notes).toContain('POST /b: the multipart body was kept as raw text.');
  });

  it('warns that a body file stays relative without the file directory, and notes a handler file', () => {
    const m = mapText('POST https://x.example.com/a\n\n< ../data/in.bin\n\n> check.js');
    expect(m.rest.requests[0]?.body).toEqual({
      kind: 'binary',
      source: { kind: 'path', path: '../data/in.bin' },
      contentType: 'application/octet-stream',
    });
    expect(m.report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('../data/in.bin')]));
    expect(m.report.notes).toContain('POST /a: the response handler file check.js was not copied.');
    expect(m.scripts).toEqual([]);
  });

  it('resolves a body file against a Windows directory', () => {
    const m = mapText('POST https://x.example.com/a\n\n< ..\\in.bin', { fileDir: 'C:\\work\\api' });
    expect(m.rest.requests[0]?.body).toMatchObject({ source: { kind: 'path', path: 'C:\\work\\in.bin' } });
  });

  it('skips GRPC requests and leaves out the WebSocket API when there is none', () => {
    const m = mapText('GRPC localhost:50051/pets.Pets/List\n\n{}');
    expect(m.websocket).toBeUndefined();
    expect(m.counts).toEqual({ requests: 0, websocket: 0, skipped: 1 });
    expect(m.report.warnings).toContain(
      'The GRPC request at line 1 was skipped: a gRPC request needs a definition; import its .proto.',
    );
  });

  it('uses the ids and order it is given', () => {
    let n = 0;
    expect(mapText('GET https://x.example.com/a').rest.order).toBe(0);
    const ordered = mapHttpFile(parseHttpFile('GET https://x.example.com/a\n\n###\nWEBSOCKET wss://x.example.com/ws'), {
      name: 'x',
      newId: () => `id-${(n += 1)}`,
      firstOrder: 4,
    });
    expect(ordered.rest.order).toBe(4);
    expect(ordered.websocket?.order).toBe(5);
    expect(ordered.rest.id).toMatch(/^id-/);
    expect(ordered.rest.requests[0]?.id).toMatch(/^id-/);
  });
});

describe('importHttpFile', () => {
  it('names the API after the file and resolves body files beside it', async () => {
    const mapped = await importHttpFile({ kind: 'file', path: resolve(fixtureDir, 'http-file/crafted/api.http') });
    expect(mapped.rest.name).toBe('api');
    expect(mapped.rest.requests[2]?.body).toMatchObject({
      source: { kind: 'path', path: resolve(fixtureDir, 'http-file/crafted/photo.png') },
    });
  });

  it('names a text import "Imported requests" unless told otherwise', async () => {
    const text = 'GET https://x.example.com/a';
    expect((await importHttpFile({ kind: 'text', text })).rest.name).toBe('Imported requests');
    expect((await importHttpFile({ kind: 'text', text, name: 'Mine' })).rest.name).toBe('Mine');
  });

  it('refuses a file over the size cap and reports a read failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-http-'));
    try {
      const path = join(dir, 'big.http');
      await writeFile(path, ' '.repeat(MAX_HTTP_FILE_BYTES + 1));
      await expect(importHttpFile({ kind: 'file', path })).rejects.toMatchObject({ code: 'http-file-too-large' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const error = await importHttpFile({ kind: 'file', path: join(tmpdir(), 'no-such-dir-wb', 'x.http') }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpFileError);
    expect(error).toMatchObject({ code: 'http-file-read-failed' });
  });
});

describe('mapHttpFile credentials, review round 1', () => {
  it('strips literal user info from a URL into Basic auth, and keeps user info made of references', () => {
    const m = mapText('GET https://ann:pw7@x.example.com/a\n\n###\nGET https://ann:pw7@x.example.com/b');
    expect(m.rest.baseUrl).toBe('https://x.example.com');
    expect(m.rest.servers).toEqual([{ url: 'https://x.example.com' }]);
    expect(m.rest.requests[0]?.auth).toEqual({ type: 'basic', username: 'ann' });
    expect(m.report.warnings).toContain('GET /a: the credential in the URL was not imported; set it on the request.');
    const bearer = mapText('GET https://ann:pw7@x.example.com/a\nAuthorization: Bearer {{t}}');
    expect(bearer.rest.requests[0]?.auth).toEqual({ type: 'inherit' });
    const refs = mapText('GET https://{{u}}:{{p}}@x.example.com/a\n\n###\nGET https://y.example.com/');
    expect(refs.rest.requests[0]?.url).toBe('https://${u}:${p}@x.example.com/a');
    expect(JSON.stringify([m, bearer])).not.toContain('pw7');
  });

  it('strips literal user info from a URL-valued @variable', () => {
    const m = mapText('@host = wss://u:pw8@x.example.com\n\nWEBSOCKET {{host}}/ws');
    expect(m.projectProperties.variables[0]?.value).toBe('wss://x.example.com');
    expect(m.report.warnings).toContain('Project properties: the credential in the URL of "host" was not imported.');
    expect(JSON.stringify(m)).not.toContain('pw8');
  });

  it('blanks literal credentials in a WebSocket message, with or without a Content-Type', () => {
    const m = mapText(
      'WEBSOCKET wss://x.example.com/ws\n\n{"token": "pw9", "op": "hi"}\n\n###\nWEBSOCKET wss://x.example.com/f\nContent-Type: application/x-www-form-urlencoded\n\nop=hi&password=pw10',
    );
    const [json, form] = m.websocket?.requests ?? [];
    expect(json?.messages[0]?.content).toBe('{"token": "", "op": "hi"}');
    expect(form?.messages[0]?.content).toBe('op=hi&password=');
    expect(m.report.warnings).toContain(
      'WEBSOCKET /ws: the recorded value of token was not imported; set it on the request.',
    );
    expect(JSON.stringify(m)).not.toMatch(/pw9|pw10/);
  });

  it('blanks literal credential text parts of a multipart body and keeps the rest raw', () => {
    const body = [
      '--B',
      'Content-Disposition: form-data; name="user"',
      '',
      'ann',
      '--B',
      'Content-Disposition: form-data; name="password"',
      '',
      'pw11',
      '--B',
      'Content-Disposition: form-data; name="apiKey"',
      '',
      '{{key}}',
      '--B--',
    ];
    const m = mapText(
      ['POST https://x.example.com/a', 'Content-Type: multipart/form-data; boundary=B', '', ...body].join('\n'),
    );
    const expected = [...body];
    expected[7] = '';
    expected[11] = '${key}';
    expect(m.rest.requests[0]?.body).toMatchObject({ kind: 'raw', text: expected.join('\n') });
    expect(m.report.warnings).toContain(
      'POST /a: the recorded value of password was not imported; set it on the request.',
    );
    expect(JSON.stringify(m)).not.toContain('pw11');
  });

  it('treats request chaining and dynamic variables as references', () => {
    const m = mapText(
      'GET https://x.example.com/a\nAuthorization: Bearer {{login.response.body.token}}\nX-Session: {{login.response.headers.X-Session}}\nX-Nonce-Token: {{$uuid}}',
    );
    const request = m.rest.requests[0];
    expect(request?.auth).toEqual({ type: 'inherit' });
    expect(request?.headers).toEqual([
      entry('Authorization', 'Bearer {{login.response.body.token}}'),
      entry('X-Session', '{{login.response.headers.X-Session}}'),
      entry('X-Nonce-Token', '{{$uuid}}'),
    ]);
  });

  it('blanks duplicate JSON keys, bare literals, and JSON bodies without a Content-Type', () => {
    const dup = mapText(
      'POST https://x.example.com/a\nContent-Type: application/json\n\n{"password":"LEAK1","password":""}',
    );
    expect(dup.rest.requests[0]?.body).toMatchObject({ text: '{"password":"","password":""}' });
    const bare = mapText(
      'POST https://x.example.com/a\nContent-Type: application/json\n\n{"pin": 1, "secret": 4242, "count": {{n}}}',
    );
    expect(bare.rest.requests[0]?.body).toMatchObject({ text: '{"pin": 1, "secret": "", "count": ${n}}' });
    const untyped = mapText('POST https://x.example.com/a\n\n{"password": "LEAK2"}');
    expect(untyped.rest.requests[0]?.body).toEqual({ kind: 'raw', language: 'text', text: '{"password": ""}' });
    expect(JSON.stringify([dup, bare, untyped])).not.toMatch(/LEAK|4242/);
  });

  it('notes the @variables that went to the secret store', () => {
    const m = mapText('@apiToken = pw12\n@password = pw13\n\nGET https://x.example.com/a');
    expect(m.report.notes).toContain(
      'Project properties: apiToken, password look like credentials; their values were stored as secrets.',
    );
  });
});

describe('importHttpFile body files', () => {
  it('notes a body file that does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-http-'));
    try {
      const path = join(dir, 'a.http');
      await writeFile(join(dir, 'here.bin'), 'x');
      await writeFile(
        path,
        'POST https://x.example.com/a\n\n< ./here.bin\n\n###\nPOST https://x.example.com/b\n\n< ./gone.bin',
      );
      const mapped = await importHttpFile({ kind: 'file', path });
      expect(mapped.report.notes).toContain(`The body file ${join(dir, 'gone.bin')} (line 6) was not found.`);
      expect(mapped.report.notes.filter((n) => n.includes('was not found'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mapHttpFile credentials, review round 2', () => {
  it('cuts user info at the last @ before the path', () => {
    const m = mapText('GET https://ann:p@SECRET1@x.example.com/a\n\n###\nGET https://ann:p@SECRET1@x.example.com/b');
    expect(m.rest.baseUrl).toBe('https://x.example.com');
    expect(m.rest.requests[0]?.auth).toEqual({ type: 'basic', username: 'ann' });
    expect(JSON.stringify(m)).not.toContain('SECRET1');
  });

  it('strips user info from a scheme-less authority @variable', () => {
    const m = mapText(
      '@host = u:SECRET4@x.example.com\n@site = ann@x.example.com\n@mail = bob@example.com\n\nGET https://{{site}}/a\n\n###\nGET https://{{host}}/b',
    );
    expect(m.projectProperties.variables.map((v) => v.value)).toEqual([
      'x.example.com',
      'x.example.com',
      'bob@example.com',
    ]);
    expect(m.report.warnings).toContain('Project properties: the credential in the URL of "host" was not imported.');
    expect(JSON.stringify(m)).not.toContain('SECRET4');
  });
});

describe('importHttpFile body files, review round 2', () => {
  it('checks the body files of mapped REST requests only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-http-'));
    try {
      const path = join(dir, 'a.http');
      await writeFile(
        path,
        'WEBSOCKET wss://x.example.com/ws\n\n< ./m.json\n\n###\nGRAPHQL https://x.example.com/g\n\n< ./q.graphql',
      );
      const mapped = await importHttpFile({ kind: 'file', path });
      expect(mapped.report.notes.filter((n) => n.includes('was not found'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mapHttpFile, final review', () => {
  const run = ' '.repeat(100_000);

  it('maps hostile lines in under 200 ms each', () => {
    const inputs = [
      `GET https://x/${'a'.repeat(100_000)}`,
      `GET https://{{${run}x y`,
      `@a = {{${run}x y\n\nGET https://x/a`,
      `GET https://x/a\nX: {{$processEnv${run}x y`,
      `GET https://x/a\nX: {{a.response.${run}x y`,
      `@a = ${'b:'.repeat(50_000)}@\n\nGET https://x/a`,
      `@a = http://${'b'.repeat(100_000)}\n\nGET https://x/a`,
      `POST https://x/a\nContent-Type: application/json\n\n{"a"${run}x y`,
      `POST https://x/a\n\n{"password":${run}x y`,
      `# @timeout 1${run}x y\nGET https://x/a`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      mapText(input);
      expect(performance.now() - started, input.slice(0, 30)).toBeLessThan(200);
    }
  });

  it('notes a line among the headers that is not a header', () => {
    const m = mapText('GET https://x.example.com/a\nAccept: a\nnot a header');
    expect(m.report.notes).toContain('GET /a: line 3 among the headers is not a header and was ignored.');
  });

  it('keeps a response handler written straight after the headers', () => {
    const m = mapText('GET https://x.example.com/a\nAccept: a\n> {%\nclient.global.set("t", response.body.t);\n%}');
    expect(m.scripts.map((script) => script.source)).toEqual(['client.global.set("t", response.body.t);']);
    expect(m.scripts[0]?.path).toMatch(/handler\.js$/);
  });

  it('blanks a JSON-looking body with no Content-Type in place when it does not parse after the rewrite', () => {
    const m = mapText('POST https://x.example.com/a\n\n{"password": "LEAK3", "n": {{n}}}');
    expect(m.rest.requests[0]?.body).toEqual({ kind: 'raw', language: 'text', text: '{"password": "", "n": ${n}}' });
    expect(m.report.warnings).toContain(
      'POST /a: the recorded value of password was not imported; set it on the request.',
    );
    const list = mapText('POST https://x.example.com/a\n\n  [{"token": "LEAK4", "x": {{x}}}]');
    expect(list.rest.requests[0]?.body).toMatchObject({ text: '  [{"token": "", "x": ${x}}]' });
    const prose = mapText('POST https://x.example.com/a\n\nsee "password": "kept" here');
    expect(prose.rest.requests[0]?.body).toMatchObject({ text: 'see "password": "kept" here' });
    expect(JSON.stringify([m, list])).not.toMatch(/LEAK/);
  });
});

describe('importHttpFile body files, final review', () => {
  it('does not look for an absolute or escaping body file, and says it was not checked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-http-'));
    try {
      const path = join(dir, 'a.http');
      await writeFile(
        path,
        [
          'POST https://x.example.com/a\n\n< /no/such/abs.bin',
          'POST https://x.example.com/b\n\n< ../escape.bin',
          'POST https://x.example.com/c\n\n< ./sub/../../escape2.bin',
          'POST https://x.example.com/d\n\n< ./sub/../inside.bin',
        ].join('\n\n###\n'),
      );
      const mapped = await importHttpFile({ kind: 'file', path });
      expect(mapped.report.notes).toEqual(
        expect.arrayContaining([
          "The body file /no/such/abs.bin (line 1) is outside the .http file's folder and was not checked.",
          "The body file ../escape.bin (line 6) is outside the .http file's folder and was not checked.",
          "The body file ./sub/../../escape2.bin (line 11) is outside the .http file's folder and was not checked.",
          `The body file ${join(dir, 'inside.bin')} (line 16) was not found.`,
        ]),
      );
      expect(mapped.report.notes.filter((n) => n.includes('was not found'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
