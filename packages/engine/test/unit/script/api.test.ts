/**
 * The script API end to end, through the sandbox: what a script can read and change per protocol,
 * `test`/`expect`, values, secrets, and the rules that refuse a change (ADR-0016, ADR-0015).
 */
import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  GrpcRequestSnapshot,
  RestRequestSnapshot,
  RestResponseSnapshot,
  ScriptOutcome,
  SoapRequestSnapshot,
} from '../../../src/script/model.js';
import { runScript, type ScriptRunInput } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const REST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'POST',
  url: 'https://shop.test/carts?page=1#top',
  headers: [
    ['Content-Type', 'application/json'],
    ['Authorization', 'Bearer ${secret:token}'],
  ],
  body: { kind: 'text', text: '{"items":[]}', language: 'json' },
};

const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 201,
  statusText: 'Created',
  headers: [['Location', '/carts/7']],
  text: '{"id":7,"items":[{"sku":"a"}]}',
  durationMs: 12,
};

const SOAP: SoapRequestSnapshot = {
  protocol: 'soap',
  endpoint: 'https://soap.test/stock',
  soapAction: 'urn:GetQuote',
  headers: [],
  envelope: '<soap:Envelope><soap:Body><q/></soap:Body></soap:Envelope>',
};

const GRPC: GrpcRequestSnapshot = {
  protocol: 'grpc',
  target: 'grpc.test:443',
  method: 'shop.Carts/Get',
  metadata: [['x-trace', '1']],
  message: { id: '7' },
};

const pre = (source: string, extra: Partial<ScriptRunInput> = {}): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase: 'pre',
    api: 'wirebench',
    source,
    filename: 'Checkout.pre.ts',
    request: REST,
    vars: {},
    props: {},
    secrets: {},
    requestName: 'Checkout',
    ...extra,
  });

const post = (source: string, extra: Partial<ScriptRunInput> = {}): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase: 'post',
    api: 'wirebench',
    source,
    filename: 'Checkout.post.ts',
    request: REST,
    response: RESPONSE,
    vars: {},
    props: {},
    secrets: {},
    requestName: 'Checkout',
    ...extra,
  });

const requestOf = (outcome: ScriptOutcome): unknown => (outcome.ok ? outcome.request : outcome.error);

describe('REST pre-request scripts', () => {
  it('change the method, headers, query and JSON body', async () => {
    const outcome = await pre(`
      const body = request.body.json as { items: string[] };
      body.items.push('x');
      request.body.json = body;
      request.headers.set('X-Signed', 'yes');
      request.headers.delete('content-type');
      request.headers.add('Accept', 'application/json');
      request.query.set('page', '2');
      request.query.add('q', 'a b&c');
      request.method = 'put';
    `);
    expect(requestOf(outcome)).toEqual({
      protocol: 'rest',
      method: 'PUT',
      url: 'https://shop.test/carts?page=2&q=a%20b%26c#top',
      headers: [
        ['Authorization', 'Bearer ${secret:token}'],
        ['X-Signed', 'yes'],
        ['Accept', 'application/json'],
      ],
      body: { kind: 'text', text: '{"items":["x"]}', language: 'json' },
    });
  });

  it('change the path of the URL, but not its origin', async () => {
    expect(requestOf(await pre('request.url = "https://shop.test/other?x=1";'))).toMatchObject({
      url: 'https://shop.test/other?x=1',
    });
    for (const url of ['https://evil.test/carts', 'http://shop.test/carts', 'https://shop.test:8443/carts']) {
      expect(requestOf(await pre(`request.url = ${JSON.stringify(url)};`))).toMatchObject({
        code: 'script-origin-change',
      });
    }
  });

  it('refuse a header with CR or LF', async () => {
    const outcome = await pre('request.headers.set("X-A", "a\\r\\nInjected: 1");');
    expect(outcome).toMatchObject({ ok: false, error: { code: 'script-value-invalid' } });
  });

  it('refuse a new secret reference, and allow one the request already had', async () => {
    expect(await pre('request.headers.set("X-B", "${secret:other}");')).toMatchObject({
      ok: false,
      error: { code: 'script-secret-denied', message: expect.stringContaining('other') as unknown },
    });
    const moved = await pre('request.headers.set("X-Token", request.headers.get("Authorization") ?? "");');
    expect(moved).toMatchObject({ ok: true });
  });

  it('cannot edit a body that is not text', async () => {
    const form: RestRequestSnapshot = { ...REST, body: { kind: 'other', description: 'a form' } };
    const outcome = await pre('request.body.text = "x";', { request: form });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'script-error', message: expect.stringContaining('a form') as unknown },
    });
    expect(await pre('request.headers.set("A", "1");', { request: form })).toMatchObject({ ok: true });
  });

  it('read listed secrets only, and report them for masking first', async () => {
    const seen: string[] = [];
    const outcome = await pre(
      `request.headers.set('X-Sig', crypto.hmac('sha256', secrets.get('signing_key'), request.body.text));`,
      { secrets: { signing_key: 'k3y' }, onSecretValue: (v) => seen.push(v) },
    );
    expect(seen).toEqual(['k3y']);
    expect(outcome.ok ? outcome.request : undefined).toMatchObject({
      headers: expect.arrayContaining([
        ['X-Sig', createHmac('sha256', 'k3y').update('{"items":[]}').digest('hex')],
      ]) as unknown,
    });
    expect(await pre('secrets.get("prod-db")')).toMatchObject({
      ok: false,
      error: { code: 'script-secret-denied', message: expect.stringContaining('prod-db') as unknown },
    });
  });

  it('read props and the run values', async () => {
    const outcome = await pre(
      'request.headers.set("X", String(props.get("region")) + ":" + vars.get("token") + ":" + String(props.get("nope")));',
      {
        props: { region: 'eu' },
        vars: { token: 't1' },
      },
    );
    expect(outcome.ok ? outcome.request : undefined).toMatchObject({
      headers: expect.arrayContaining([['X', 'eu:t1:undefined']]) as unknown,
    });
  });

  it('report a TypeScript syntax error the stripper refuses', async () => {
    expect(await pre('enum A { B }')).toMatchObject({ ok: false, error: { code: 'script-syntax-error' } });
  });

  it('refuse a forged __finish result', async () => {
    const outcome = await pre(
      'globalThis.__finish = () => ({ tests: [], values: [], request: { protocol: "soap" } });',
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'script-error' } });
  });
});

describe('REST post-response scripts', () => {
  it('read the response and record tests', async () => {
    const outcome = await post(`
      const cart = response.json() as { id: number; items: { sku: string }[] };
      test('created', () => expect(response.status).toBe(201));
      test('has one item', () => expect(cart.items).toHaveLength(1));
      test('fails', () => expect(cart.id).toBe(8));
      test('location', () => expect(response.headers.get('location')).toMatch(/carts/));
      test('not', () => expect(cart).not.toHaveProperty('missing'));
      test('deep', () => expect(cart).toEqual({ items: [{ sku: 'a' }], id: 7 }));
      log('cart', cart.id, { ok: true });
    `);
    expect(outcome).toMatchObject({
      ok: true,
      tests: [
        { name: 'created', passed: true },
        { name: 'has one item', passed: true },
        { name: 'fails', passed: false, message: 'Expected 7 to be 8' },
        { name: 'location', passed: true },
        { name: 'not', passed: true },
        { name: 'deep', passed: true },
      ],
      log: { lines: ['cart 7 {"ok":true}'], truncated: false },
    });
  });

  it('set values for later requests, verbatim', async () => {
    const hostile = ['${secret:k}', 'a\r\nb', 'http://evil/', '</x><y>'];
    const outcome = await post(`
      vars.set('token', (response.json() as { id: number }).id, { secret: true });
      ${hostile.map((v, i) => `vars.set('h${String(i)}', ${JSON.stringify(v)});`).join('\n')}
    `);
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'token', value: '7', secret: true },
        ...hostile.map((value, i) => ({ name: `h${String(i)}`, value, secret: false })),
      ],
    });
  });

  it('refuse a bad value name or type', async () => {
    expect(await post('vars.set("1bad", "x")')).toMatchObject({ ok: false, error: { code: 'script-value-invalid' } });
    expect(await post('vars.set("ok", {})')).toMatchObject({ ok: false, error: { code: 'script-value-invalid' } });
  });

  it('cannot change what was sent', async () => {
    expect(await post('request.headers.set("A", "1")')).toMatchObject({ ok: false, error: { code: 'script-error' } });
    expect(await post('(response as { status: number }).status = 1')).toMatchObject({
      ok: false,
      error: { code: 'script-error' },
    });
  });

  it('keep the tests a script recorded before it threw', async () => {
    const outcome = await post('test("first", () => {}); throw new Error("boom");');
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'script-error', message: 'Error: boom' },
      tests: [{ name: 'first', passed: true }],
    });
  });

  it('fail the script on an expect outside test', async () => {
    expect(await post('expect(1).toBe(2)')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Expected 1 to be 2') as unknown },
    });
  });
});

describe('SOAP and gRPC scripts', () => {
  it('SOAP: change the envelope, SOAPAction and headers, but not the endpoint origin', async () => {
    const changed = await pre(
      'request.envelope = request.envelope.replace("<q/>", "<q>IBM</q>"); request.soapAction = "urn:X"; request.headers.add("X-A", "1");',
      { request: SOAP },
    );
    expect(requestOf(changed)).toEqual({
      ...SOAP,
      soapAction: 'urn:X',
      headers: [['X-A', '1']],
      envelope: '<soap:Envelope><soap:Body><q>IBM</q></soap:Body></soap:Envelope>',
    });
    expect(await pre('request.endpoint = "https://evil.test/stock";', { request: SOAP })).toMatchObject({
      ok: false,
      error: { code: 'script-origin-change' },
    });
    expect(await pre('request.soapAction = "a\\nb";', { request: SOAP })).toMatchObject({
      ok: false,
      error: { code: 'script-value-invalid' },
    });
  });

  it('gRPC: change the message and metadata, never the target or method', async () => {
    const changed = await pre(
      'request.message = { ...(request.message as object), id: "8" }; request.metadata.set("x-trace", "2");',
      { request: GRPC },
    );
    expect(requestOf(changed)).toEqual({ ...GRPC, metadata: [['x-trace', '2']], message: { id: '8' } });
    const forged = await pre(
      'const f = globalThis.__finish; globalThis.__finish = () => { const r = f(); r.request.target = "evil:1"; return r; };',
      { request: GRPC },
    );
    expect(forged).toMatchObject({ ok: false, error: { code: 'script-origin-change' } });
  });

  it('gRPC post: read the status and message', async () => {
    const outcome = await post(
      'test("ok", () => expect(response.status.code).toBe(0)); vars.set("id", (response.message as { id: string }).id);',
      {
        request: GRPC,
        response: {
          protocol: 'grpc',
          status: { code: 0, name: 'OK', message: '' },
          metadata: [],
          trailers: [],
          message: { id: '9' },
          durationMs: 3,
        },
      },
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ passed: true }], values: [{ name: 'id', value: '9' }] });
  });

  it('SOAP post: read a fault', async () => {
    const outcome = await post('test("fault", () => expect(response.fault?.code).toBe("soap:Server"));', {
      request: SOAP,
      response: {
        protocol: 'soap',
        status: 500,
        headers: [],
        text: '<Envelope/>',
        durationMs: 5,
        fault: { code: 'soap:Server', reason: 'down' },
      },
    });
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'fault', passed: true }] });
  });
});
