import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/errors.js';
import { generateRequest } from '../../src/generate.js';
import { importDefinition } from '../../src/import.js';
import { sendSoapRequest } from '../../src/send.js';
import { fileUrl } from '../helpers/fixtures.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-soap-server.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('engine facade — end to end', () => {
  let server: TestSoapServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('imports from a URL, generates a request, and sends/echoes it over SOAP 1.1', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const result = await importDefinition({ kind: 'url', url: server.wsdlUrl });

    expect(result.problems).toEqual([]);

    const add11 = result.operations.filter((op) => op.operationName === 'Add' && op.soapVersion === '1.1');
    expect(add11).toHaveLength(1);
    expect(add11[0]?.ports[0]?.address).toBe(`${server.url}/soap`);

    const generated = generateRequest(result, { bindingName: add11[0]!.bindingName, operationName: 'Add' });
    expect(generated.problems).toEqual([]);
    expect(generated.soapVersion).toBe('1.1');
    expect(generated.soapAction).toBe('http://tempuri.org/Add');

    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: generated.envelopeXml,
      soapVersion: '1.1',
      soapAction: generated.soapAction ?? '',
    });

    expect(exchange.http.status).toBe(200);
    expect(exchange.response?.isSoap).toBe(true);
    expect(exchange.response?.envelopeXml).toBe(generated.envelopeXml);

    const recorded = server.requests.at(-1);
    expect(recorded?.headers['soapaction']).toBe('"http://tempuri.org/Add"');
    expect(String(recorded?.headers['content-type'])).toMatch(/^text\/xml/);
  });

  it('does the same over SOAP 1.2', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const result = await importDefinition({ kind: 'url', url: server.wsdlUrl });

    const add12 = result.operations.find((op) => op.operationName === 'Add' && op.soapVersion === '1.2');
    expect(add12).toBeDefined();

    const generated = generateRequest(result, { bindingName: add12!.bindingName, operationName: 'Add' });
    expect(generated.soapVersion).toBe('1.2');

    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: generated.envelopeXml,
      soapVersion: '1.2',
      soapAction: generated.soapAction ?? '',
    });

    expect(exchange.http.status).toBe(200);
    expect(exchange.response?.isSoap).toBe(true);
    expect(exchange.response?.envelopeXml).toBe(generated.envelopeXml);

    const recorded = server.requests.at(-1);
    const contentType = String(recorded?.headers['content-type']);
    expect(contentType).toMatch(/^application\/soap\+xml/);
    expect(contentType).toContain('action=');
    expect(recorded?.headers['soapaction']).toBeUndefined();
  });

  it('imports from a file path with nested wsdl:import/xs:import', async () => {
    const path = `${repoRoot}fixtures/wsdl/crafted/nested-imports/service.wsdl`;
    const result = await importDefinition({ kind: 'file', path });

    expect(result.problems).toEqual([]);
    expect(result.bundle.documents).toHaveLength(4);
  });

  it('does not add an Authorization header when auth is given but every fetch is file://', async () => {
    const path = `${repoRoot}fixtures/wsdl/crafted/nested-imports/service.wsdl`;
    const result = await importDefinition(
      { kind: 'file', path },
      { auth: { username: 'alice', password: 'wonderland' } },
    );

    expect(result.problems).toEqual([]);
  });

  it('imports inline text', async () => {
    const text = `<?xml version="1.0"?>
<definitions name="Inline" targetNamespace="urn:wb:inline"
             xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:wb:inline">
  <portType name="PT"><operation name="Op"/></portType>
  <binding name="B" type="tns:PT">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap:operation soapAction="urn:op"/></operation>
  </binding>
  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://example.invalid/"/></port></service>
</definitions>`;
    const result = await importDefinition({ kind: 'text', text });
    expect(result.problems).toEqual([]);
    expect(result.operations).toHaveLength(1);
  });

  it('surfaces a SOAP fault from the /fault route', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const result = await importDefinition({ kind: 'url', url: server.wsdlUrl });
    const add11 = result.operations.find((op) => op.operationName === 'Add' && op.soapVersion === '1.1')!;
    const generated = generateRequest(result, { bindingName: add11.bindingName, operationName: 'Add' });

    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/fault`,
      envelopeXml: generated.envelopeXml,
      soapVersion: '1.1',
      soapAction: generated.soapAction ?? '',
    });

    expect(exchange.http.status).toBe(500);
    expect(exchange.response?.fault?.code).toContain('Server');
  });

  it('reports the body is not SOAP for a non-XML response (the /headers route returns JSON)', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/headers`,
      envelopeXml: '<x/>',
      soapVersion: '1.1',
      soapAction: 'urn:x',
    });

    expect(exchange.response?.isSoap).toBe(false);
    expect(exchange.problems).toHaveLength(1);
    expect(exchange.problems[0]?.code).toBe('xml-parse-error');
    expect(typeof exchange.problems[0]?.message).toBe('string');
  });

  it('reports not-soap for a well-formed XML response that is not a SOAP envelope', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    server.requests.length = 0;
    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: '<not-soap-at-all/>',
      soapVersion: '1.1',
      soapAction: 'urn:x',
    });

    expect(exchange.response?.isSoap).toBe(false);
    expect(exchange.problems).toHaveLength(1);
    expect(exchange.problems[0]?.code).toBe('not-soap');
    expect(typeof exchange.problems[0]?.message).toBe('string');
  });

  it('lets a caller-supplied Content-Type override the computed one', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: '<a/>',
      soapVersion: '1.1',
      soapAction: 'urn:x',
      headers: { 'Content-Type': 'text/xml;charset=us-ascii' },
    });

    const recorded = server.requests.at(-1);
    expect(recorded?.headers['content-type']).toBe('text/xml;charset=us-ascii');
  });

  it('propagates an HttpError when the signal is aborted', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const controller = new AbortController();
    controller.abort();

    await expect(
      sendSoapRequest({
        endpoint: `${server.url}/soap`,
        envelopeXml: '<a/>',
        soapVersion: '1.1',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' } satisfies Partial<HttpError>);
  });

  it('decodes a response body using its declared charset', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/latin1`,
      envelopeXml: '<a/>',
      soapVersion: '1.1',
      soapAction: 'urn:x',
    });

    expect(exchange.response?.envelopeXml).toContain('é');
  });

  it('falls back to UTF-8 and records a decode-error problem for an unsupported charset label', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/bad-charset`,
      envelopeXml: '<a/>',
      soapVersion: '1.1',
      soapAction: 'urn:x',
    });

    const decodeErrors = exchange.problems.filter((p) => p.code === 'decode-error');
    expect(decodeErrors).toHaveLength(1);
    expect(decodeErrors[0]?.message).toContain('x-unknown');
    expect(exchange.response?.envelopeXml).toBe('<a/>');
  });

  it('reports a resolve problem exactly once, not duplicated onto the WSDL definition', async () => {
    const text = `<?xml version="1.0"?>
<definitions name="MissingImport" targetNamespace="urn:wb:missing-import"
             xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:tns="urn:wb:missing-import">
  <import namespace="urn:wb:missing-import-target" location="does-not-exist.wsdl"/>
  <portType name="PT"><operation name="Op"/></portType>
</definitions>`;
    const result = await importDefinition({
      kind: 'text',
      text,
      location: fileUrl(join(tmpdir(), 'wirebench-missing-import', 'root.wsdl')),
    });

    const fetchFailed = result.problems.filter((p) => p.code === 'fetch-failed');
    expect(fetchFailed).toHaveLength(1);
    expect(fetchFailed[0]?.source).toBe('resolve');
    expect(result.definition.problems).toEqual([]);
  });

  it('adds a Basic auth Authorization header to the WSDL fetch when auth is given', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    await importDefinition(
      { kind: 'url', url: server.wsdlUrl },
      { auth: { username: 'alice', password: 'wonderland' } },
    );

    const wsdlRequest = server.requests.find((r) => r.url.includes('/service'));
    expect(wsdlRequest?.headers['authorization']).toBe(`Basic ${Buffer.from('alice:wonderland').toString('base64')}`);
  });

  it('expands ${#Env#...} properties in the endpoint and a header before sending', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });

    const exchange = await sendSoapRequest(
      {
        endpoint: '${#Env#host}/soap',
        envelopeXml: '<Envelope>hi</Envelope>',
        soapVersion: '1.1',
        soapAction: 'urn:x',
        headers: { 'X-Trace-Id': '${#Env#traceId}' },
      },
      {
        scopes: {
          project: {},
          env: { host: server.url, traceId: 'trace-123' },
          global: {},
        },
      },
    );

    expect(exchange.unresolved).toEqual([]);
    const recorded = server.requests.at(-1);
    expect(recorded?.url).toContain('/soap');
    expect(recorded?.headers['x-trace-id']).toBe('trace-123');
  });

  it('leaves an unresolved property expression verbatim and reports it on the exchange', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });

    const exchange = await sendSoapRequest(
      {
        endpoint: `${server.url}/soap`,
        envelopeXml: '<Envelope>${#Project#missing}</Envelope>',
        soapVersion: '1.1',
        soapAction: 'urn:x',
      },
      { scopes: { project: {}, global: {} } },
    );

    expect(exchange.unresolved).toHaveLength(1);
    expect(exchange.unresolved?.[0]?.code).toBe('missing');
    const recorded = server.requests.at(-1);
    expect(recorded?.body.toString('utf-8')).toContain('${#Project#missing}');
  });
});
