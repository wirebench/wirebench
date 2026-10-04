import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HarError } from '../../../../src/errors.js';
import { REDACTED_MARKER } from '../../../../src/redact/index.js';
import { importHar } from '../../../../src/rest/har/import.js';
import { mapHar } from '../../../../src/rest/har/map.js';
import type { HarEntryIn, HarLogIn } from '../../../../src/rest/har/model.js';
import { parseHarText } from '../../../../src/rest/har/parse.js';
import { entry } from '../../../../src/rest/model.js';

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(rel: string): string {
  return readFileSync(resolve(here, '../../../../../../fixtures', rel), 'utf8');
}

/** A one-entry log; `overrides` replace parts of a plain `GET https://api.example.com/x` → 200. */
function oneEntry(overrides: {
  request?: Partial<HarEntryIn['request']>;
  response?: Partial<HarEntryIn['response']>;
}): HarLogIn {
  return {
    version: '1.2',
    skippedMalformed: 0,
    entries: [
      {
        startedDateTime: '2026-10-04T10:00:00.000Z',
        time: 5,
        request: {
          method: 'GET',
          url: 'https://api.example.com/x',
          headers: [],
          queryString: [],
          ...overrides.request,
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
          content: { mimeType: 'application/json', text: '{}' },
          ...overrides.response,
        },
      },
    ],
  };
}

describe('mapHar', () => {
  const log = parseHarText(readFixture('har/crafted/session.har'));

  it('keeps one API per origin and skips preflights, static assets and non-HTTP URLs', () => {
    const mapped = mapHar(log);
    expect(mapped.apis.map((a) => [a.name, a.servers[0]?.url])).toEqual([
      ['api.example.com', 'https://api.example.com'],
      ['auth.example.com', 'https://auth.example.com'],
    ]);
    expect(mapped.summary).toMatchObject({ entries: 9, kept: 6, requests: 4, apis: 2 });
    expect(mapped.report.notes).toEqual(
      expect.arrayContaining([
        '1 CORS preflight request was skipped.',
        '1 static asset was skipped; tick "Include static assets" to import them.',
        '1 entry with a non-HTTP URL was skipped.',
      ]),
    );
  });

  it('counts statuses of kept entries and orders APIs from firstOrder', () => {
    const mapped = mapHar(log, { firstOrder: 3 });
    expect(mapped.summary.statuses).toEqual({ '200': 4, '201': 1, '500': 1 });
    expect(mapped.apis.map((a) => [a.order, a.baseUrl])).toEqual([
      [3, 'https://api.example.com'],
      [4, 'https://auth.example.com'],
    ]);
    expect(mapped.exchanges).toEqual([]);
  });

  it('deduplicates on method, path and query names; names requests METHOD /path', () => {
    const api = mapHar(log).apis[0]!;
    expect(api.requests.map((r) => r.name)).toEqual(['GET /pets', 'POST /pets', 'POST /login']);
    expect(api.requests.map((r) => [r.slug, r.order, r.method, r.url])).toEqual([
      ['GET _pets', 0, 'GET', '/pets'],
      ['POST _pets', 1, 'POST', '/pets'],
      ['POST _login', 2, 'POST', '/login'],
    ]);
    expect(api.requests[0]?.query).toEqual([entry('limit', '10')]);
  });

  it('drops Cookie, pseudo and hop-by-hop headers; a literal bearer becomes credential-free auth', () => {
    const mapped = mapHar(log);
    const get = mapped.apis[0]!.requests[0]!;
    expect(get.headers.map((h) => h.name.toLowerCase())).toEqual(['accept']);
    expect(get.auth).toEqual({ type: 'bearer' });
    expect(mapped.report.warnings).toEqual(
      expect.arrayContaining([
        'GET /pets: the recorded Authorization credential was not imported; set it on the request or API.',
      ]),
    );
    expect(mapped.report.notes).toEqual(
      expect.arrayContaining(['Cookies were dropped from 1 request; the cookie jar handles them at send time.']),
    );
    expect(mapped.apis[1]!.requests[0]!.headers).toEqual([]);
  });

  it('keeps the user name of a Basic credential and never its password', () => {
    const basic = Buffer.from('alice:s3cret').toString('base64');
    const mapped = mapHar(oneEntry({ request: { headers: [{ name: 'Authorization', value: `Basic ${basic}` }] } }), {
      responses: 'history',
    });
    const request = mapped.apis[0]!.requests[0]!;
    expect(request.auth).toEqual({ type: 'basic', username: 'alice' });
    expect(JSON.stringify(mapped.apis)).not.toContain('s3cret');
    expect(JSON.stringify(mapped.apis)).not.toContain(basic);
  });

  it('drops other credential headers from the request with a warning', () => {
    const mapped = mapHar(
      oneEntry({
        request: {
          headers: [
            { name: 'Proxy-Authorization', value: 'Basic cHJveHk6cHc=' },
            { name: 'X-Api-Key', value: 'k-123' },
            { name: 'Accept', value: '*/*' },
          ],
        },
      }),
    );
    const request = mapped.apis[0]!.requests[0]!;
    expect(request.headers).toEqual([entry('Accept', '*/*')]);
    expect(request.auth).toEqual({ type: 'inherit' });
    expect(mapped.report.warnings).toEqual([
      'GET /x: the recorded Proxy-Authorization credential was not imported; set it on the request or API.',
      'GET /x: the recorded X-Api-Key credential was not imported; set it on the request or API.',
    ]);
    expect(JSON.stringify(mapped.apis)).not.toMatch(/cHJveHk6cHc=|k-123/);
  });

  it('maps JSON and form bodies', () => {
    const [, post, login] = mapHar(log).apis[0]!.requests;
    expect(post?.body).toMatchObject({ kind: 'raw', language: 'json', text: '{"name":"Rex"}' });
    expect(login?.body).toEqual({ kind: 'form', fields: [entry('user', 'a')] });
  });

  it('maps a urlencoded body with no params from its text, and multipart parts', () => {
    const form = mapHar(
      oneEntry({
        request: { method: 'POST', postData: { mimeType: 'application/x-www-form-urlencoded', text: 'a=1&b=2' } },
      }),
    );
    expect(form.apis[0]!.requests[0]!.body).toEqual({ kind: 'form', fields: [entry('a', '1'), entry('b', '2')] });

    const multipart = mapHar(
      oneEntry({
        request: {
          method: 'POST',
          postData: {
            mimeType: 'multipart/form-data; boundary=x',
            params: [
              { name: 'title', value: 'Rex' },
              { name: 'photo', fileName: 'rex.png', contentType: 'image/png' },
            ],
          },
        },
      }),
    );
    expect(multipart.apis[0]!.requests[0]!.body).toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'title', value: 'Rex', enabled: true },
        {
          kind: 'file',
          name: 'photo',
          source: { kind: 'path', path: '' },
          enabled: true,
          fileName: 'rex.png',
          contentType: 'image/png',
        },
      ],
    });
    expect(multipart.report.notes).toContain(
      'POST /x: the file part "photo" (rex.png) has no file attached; pick it on the request.',
    );
  });

  it('includes static assets when asked', () => {
    expect(mapHar(log, { includeStaticAssets: true }).apis.map((a) => a.name)).toContain('cdn.example.com');
  });

  it('saves one example per distinct status when responses = examples', () => {
    const get = mapHar(log, { responses: 'examples' }).apis[0]!.requests[0]!;
    expect(get.examples?.map((e) => e.status)).toEqual([200, 500]);
    expect(get.examples?.[0]?.name).toMatch(/^200 OK — recorded \d{4}-\d{2}-\d{2}$/);
    expect(get.examples?.[0]).toMatchObject({
      statusText: 'OK',
      headers: [entry('Content-Type', 'application/json')],
      contentType: 'application/json',
      body: '[{"id":1}]',
    });
  });

  it('attaches no examples unless responses = examples', () => {
    expect(mapHar(log).apis[0]!.requests[0]!.examples).toBeUndefined();
    expect(mapHar(log, { responses: 'drop' }).apis[0]!.requests[0]!.examples).toBeUndefined();
  });

  it('drops cookies from example headers and masks credential headers', () => {
    const mapped = mapHar(
      oneEntry({
        response: {
          headers: [
            { name: 'Set-Cookie', value: 'sid=abc' },
            { name: 'Cookie', value: 'x=1' },
            { name: 'Authorization', value: 'Bearer leaked' },
            { name: 'Proxy-Authorization', value: 'Basic leaked2' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      }),
      { responses: 'examples' },
    );
    const example = mapped.apis[0]!.requests[0]!.examples![0]!;
    expect(example.headers).toEqual([
      entry('Authorization', REDACTED_MARKER),
      entry('Proxy-Authorization', REDACTED_MARKER),
      entry('Content-Type', 'application/json'),
    ]);
    expect(JSON.stringify(mapped.apis)).not.toMatch(/leaked|sid=abc/);
  });

  it('masks secret-keyed values in an example body and leaves other bodies untouched', () => {
    const mapped = mapHar(
      oneEntry({
        response: { content: { mimeType: 'application/json', text: '{"access_token":"tok-1","expires_in":60}' } },
      }),
      { responses: 'examples' },
    );
    const body = mapped.apis[0]!.requests[0]!.examples![0]!.body!;
    expect(body).not.toContain('tok-1');
    expect(JSON.parse(body)).toEqual({ access_token: REDACTED_MARKER, expires_in: 60 });

    const plain = mapHar(oneEntry({ response: { content: { mimeType: 'application/json', text: '{ "a": 1 }' } } }), {
      responses: 'examples',
    });
    expect(plain.apis[0]!.requests[0]!.examples![0]!.body).toBe('{ "a": 1 }');
  });

  it('leaves a binary response body out of the example with a note', () => {
    const mapped = mapHar(
      oneEntry({ response: { content: { mimeType: 'application/octet-stream', text: 'AAEC', encoding: 'base64' } } }),
      { responses: 'examples' },
    );
    const example = mapped.apis[0]!.requests[0]!.examples![0]!;
    expect(example.body).toBeUndefined();
    expect(mapped.report.notes).toContain('GET /x: a binary response body was left out of the example.');
  });

  it('keeps at most five examples per request', () => {
    const base = oneEntry({}).entries[0]!;
    const entries = [200, 201, 202, 400, 404, 500, 503].map((status) => ({
      ...base,
      response: { ...base.response, status },
    }));
    const mapped = mapHar({ version: '1.2', skippedMalformed: 0, entries }, { responses: 'examples' });
    expect(mapped.apis[0]!.requests[0]!.examples?.map((e) => e.status)).toEqual([200, 201, 202, 400, 404]);
  });

  it('returns one exchange per kept entry, repeats included, when responses = history', () => {
    const mapped = mapHar(log, { responses: 'history' });
    expect(mapped.exchanges).toHaveLength(6);
    const pets = mapped.exchanges.filter((x) => x.method === 'GET' && x.url.includes('/pets'));
    expect(pets).toHaveLength(3);
    expect(new Set(pets.map((x) => x.requestId)).size).toBe(1);
    expect(pets[0]?.requestId).toBe(mapped.apis[0]!.requests[0]!.id);
    expect(pets[0]).toMatchObject({ durationMs: 12, status: 200, requestBody: '', responseBody: '[{"id":1}]' });
  });

  it('sorts exchanges by start time', () => {
    const base = oneEntry({}).entries[0]!;
    const entries = [
      { ...base, startedDateTime: '2026-10-04T10:00:02.000Z' },
      { ...base, startedDateTime: '2026-10-04T10:00:01.000Z' },
    ];
    const mapped = mapHar({ version: '1.2', skippedMalformed: 0, entries }, { responses: 'history' });
    expect(mapped.exchanges.map((x) => x.at)).toEqual(['2026-10-04T10:00:01.000Z', '2026-10-04T10:00:02.000Z']);
  });

  it('decodes a textual base64 body', () => {
    const userinfo = mapHar(log, { responses: 'examples' }).apis[1]!.requests[0]!;
    expect(userinfo.examples?.[0]?.body).toBe('hello');
  });

  it('notes malformed entries the parser skipped', () => {
    const mapped = mapHar({ ...oneEntry({}), skippedMalformed: 2 });
    expect(mapped.report.notes).toContain('2 malformed entries were skipped.');
  });

  it('uses the injected id generator', () => {
    let n = 0;
    const mapped = mapHar(oneEntry({}), { newId: () => `id-${(n += 1)}` });
    expect(mapped.apis[0]!.id).toBe('id-1');
    expect(mapped.apis[0]!.requests[0]!.id).toBe('id-2');
  });
});

describe('importHar', () => {
  it('maps HAR text', async () => {
    const mapped = await importHar({ kind: 'text', text: readFixture('har/crafted/session.har') });
    expect(mapped.summary.apis).toBe(2);
  });

  it('reads a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-har-'));
    try {
      const path = join(dir, 'session.har');
      await writeFile(path, readFixture('har/crafted/session.har'));
      const mapped = await importHar({ kind: 'file', path }, { responses: 'history' });
      expect(mapped.exchanges).toHaveLength(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a missing file with har-read-failed', async () => {
    await expect(importHar({ kind: 'file', path: join(tmpdir(), 'no-such-dir-wb', 'x.har') })).rejects.toMatchObject({
      name: 'HarError',
      code: 'har-read-failed',
    });
  });

  it('refuses text over the size limit with har-too-large', async () => {
    const error = await importHar({ kind: 'text', text: ' '.repeat(100 * 1024 * 1024 + 1) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HarError);
    expect(error).toMatchObject({ code: 'har-too-large' });
  });
});
