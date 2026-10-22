/**
 * The client layers over requests that are not REST. An importer attaches Bruno, Hoppscotch and
 * Thunder Client scripts to gRPC calls, whose snapshots have `metadata` instead of headers, a
 * `status` object and a `message` instead of a body; each layer reads them through the shared
 * request and response adapters. SOAP and MCP requests get a layered API only by a hand edit, so
 * there every layer has only to start.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { LayeredApi, ScriptOutcome } from '../../../src/script/model.js';
import type { ScriptRunInput } from '../../../src/script/run.js';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { GRPC, GRPC_RESPONSE, MCP, MCP_RESPONSE, SOAP, SOAP_RESPONSE } from './snapshots.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const run = (
  api: LayeredApi,
  phase: 'pre' | 'post',
  source: string,
  request: ScriptRunInput['request'] = GRPC,
  response: NonNullable<ScriptRunInput['response']> = GRPC_RESPONSE,
): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase,
    api,
    source,
    filename: `Get cart.${phase}.js`,
    request,
    ...(phase === 'post' ? { response } : {}),
    vars: {},
    props: {},
    secrets: {},
    requestName: 'Get cart',
  });

describe('the Bruno layer on a gRPC call', () => {
  it('pre: req reads the message and metadata, and writes them', async () => {
    const outcome = await run(
      'bruno',
      'pre',
      `bru.setVar('id', req.getBody().id);
       console.log(req.getHeader('x-trace'), req.getUrl(), req.getMethod());
       req.setHeader('x-tenant', 'acme');
       req.setBody({ id: '8' });`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [{ name: 'id', value: '7' }],
      log: { lines: ['1 grpc.test:443 shop.Carts/Get'] },
      request: {
        metadata: [
          ['x-trace', '1'],
          ['x-tenant', 'acme'],
        ],
        message: { id: '8' },
      },
    });
  });

  it('pre: a URL or method change is refused by name', async () => {
    const url = await run('bruno', 'pre', 'req.setUrl("grpc://other.test")');
    expect(url).toMatchObject({ ok: false, error: { code: 'script-unsupported', message: /^req\.setUrl/ } });
    const method = await run('bruno', 'pre', 'req.setMethod("shop.Carts/Put")');
    expect(method).toMatchObject({ ok: false, error: { code: 'script-unsupported', message: /^req\.setMethod/ } });
  });

  it('post: res reads the status code, the message and the metadata', async () => {
    const outcome = await run(
      'bruno',
      'post',
      `test('ok', () => {
         expect(res.getStatus()).to.equal(0);
         expect(res.status).to.equal(0);
         expect(res.getBody().id).to.equal('9');
         expect(res.body.items).to.equal(2);
         expect(res.getHeader('X-Server')).to.equal('carts-1');
       });`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'ok', passed: true }] });
  });
});

describe('the Hoppscotch layer on a gRPC call', () => {
  it('pre: hopp.request reads the message as JSON text and the metadata as rows', async () => {
    const outcome = await run(
      'hoppscotch',
      'pre',
      `const body = hopp.request.body;
       pw.env.set('id', JSON.parse(body.body).id);
       console.log(body.contentType, JSON.stringify(hopp.request.headers), JSON.stringify(hopp.request.params));
       hopp.request.setHeader('x-tenant', 'acme');
       hopp.request.setBody({ contentType: 'application/json', body: '{"id":"8"}' });`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [{ name: 'id', value: '7' }],
      log: { lines: ['application/json [{"key":"x-trace","value":"1"}] []'] },
      request: {
        metadata: [
          ['x-trace', '1'],
          ['x-tenant', 'acme'],
        ],
        message: { id: '8' },
      },
    });
  });

  it('pre: a query parameter is refused by name', async () => {
    const outcome = await run('hoppscotch', 'pre', 'hopp.request.setParam("page", "2")');
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'script-unsupported', message: /^hopp\.request\.setParam/ },
    });
  });

  it('post: pw.response and hopp.response read the status code and the message', async () => {
    const outcome = await run(
      'hoppscotch',
      'post',
      `pw.test('ok', () => {
         pw.expect(pw.response.status).toBe(0);
         pw.expect(pw.response.body.id).toBe('9');
         pw.expect(hopp.response.statusCode).toBe(0);
         pw.expect(hopp.response.statusText).toBe('OK');
         pw.expect(hopp.response.body.asJSON().items).toBe(2);
         pw.expect(hopp.response.headers[0].key).toBe('x-server');
       });`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'ok', passed: true }] });
  });
});

describe('the Thunder Client layer on a gRPC call', () => {
  it('pre: tc.request reads the message and metadata, and writes them', async () => {
    const outcome = await run(
      'thunder-client',
      'pre',
      `tc.setVar('id', tc.request.body.id);
       console.log(tc.request.getHeader('x-trace'), tc.request.headers[0].name, tc.request.url);
       tc.request.setHeader('x-tenant', 'acme');
       tc.request.setBody({ id: '8' });`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [{ name: 'id', value: '7' }],
      log: { lines: ['1 x-trace grpc.test:443'] },
      request: {
        metadata: [
          ['x-trace', '1'],
          ['x-tenant', 'acme'],
        ],
        message: { id: '8' },
      },
    });
  });

  it('pre: a query parameter is refused by name', async () => {
    const outcome = await run('thunder-client', 'pre', 'tc.setParam("page", "2")');
    expect(outcome).toMatchObject({ ok: false, error: { code: 'script-unsupported', message: /^tc\.setParam/ } });
  });

  it('post: tc.response reads the status code, the message and the metadata', async () => {
    const outcome = await run(
      'thunder-client',
      'post',
      `tc.test('ok', () => {
         expect(tc.response.status).to.equal(0);
         expect(tc.response.json.id).to.equal('9');
         expect(tc.response.text).to.equal('{"id":"9","items":2}');
         expect(tc.response.getHeader('x-server')).to.equal('carts-1');
         expect(tc.response.headers[0].name).to.equal('x-server');
       });`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'ok', passed: true }] });
  });
});

describe('every layer starts on SOAP and MCP requests', () => {
  const layers: readonly LayeredApi[] = ['postman', 'insomnia', 'bruno', 'hoppscotch', 'thunder-client'];
  for (const api of layers) {
    it(`${api}: pre and post scripts start on a SOAP request`, async () => {
      expect(await run(api, 'pre', 'console.log("up")', SOAP)).toMatchObject({ ok: true });
      expect(await run(api, 'post', 'console.log("up")', SOAP, SOAP_RESPONSE)).toMatchObject({ ok: true });
    });

    it(`${api}: pre and post scripts start on an MCP request`, async () => {
      expect(await run(api, 'pre', 'console.log("up")', MCP)).toMatchObject({ ok: true });
      expect(await run(api, 'post', 'console.log("up")', MCP, MCP_RESPONSE)).toMatchObject({ ok: true });
    });
  }
});
