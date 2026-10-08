import { readFileSync } from 'node:fs';
import { generateSoapRequest, importWsdl, parseFault, parseSoapResponse, parseXml } from '@wirebench/engine';
import type { HttpExchange, RestExchange, SoapExchange } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import {
  toExchangeSummary,
  toGenerateResponse,
  toInterfaceSummary,
  toWireFault,
  redactExchangeSummary,
  toRestExchangeSummary,
} from '../src/main/engine-wire.js';
import * as redact from '../src/main/redact.js';
import type { ExchangeSummary } from '../src/shared/wire-types.js';
import { fixturePath, readPublicFixture } from './helpers/fixtures.js';

const CALCULATOR_URL = 'http://example.test/calculator/service.wsdl';

async function importCalculator() {
  return importWsdl({ kind: 'text', text: readPublicFixture('calculator'), location: CALCULATOR_URL });
}

describe('toInterfaceSummary', () => {
  it('projects a real WsdlImportResult into a JSON-serialisable InterfaceSummary', async () => {
    const result = await importCalculator();

    const summary = toInterfaceSummary(result, 'iface-1', CALCULATOR_URL);

    expect(summary.id).toBe('iface-1');
    expect(summary.definitionUrl).toBe(CALCULATOR_URL);
    expect(summary.targetNamespace).toBe(result.definition.targetNamespace);
    expect(summary.documentCount).toBe(result.bundle.documents.length);
    expect(summary.services.length).toBeGreaterThan(0);
    expect(summary.operations.length).toBe(result.operations.length);

    // Every value must survive a JSON round-trip (no DOM nodes, no functions, no undefined).
    expect(() => void JSON.parse(JSON.stringify(summary))).not.toThrow();

    const addOp = summary.operations.find((op) => op.name === 'Add');
    expect(addOp).toBeDefined();
    expect(addOp?.binding).toMatch(/^\{.*\}.+$/);
    expect(addOp?.bindingLocal.length).toBeGreaterThan(0);
    expect(addOp?.ports.length).toBeGreaterThan(0);

    for (const service of summary.services) {
      for (const port of service.ports) {
        expect(port.binding).toMatch(/^\{.*\}.+$/);
        expect(['1.1', '1.2', 'none']).toContain(port.soapVersion);
      }
    }
  });

  it('names the interface after the WSDL service when one is present', async () => {
    const result = await importCalculator();
    const summary = toInterfaceSummary(result, 'iface-1', CALCULATOR_URL);
    expect(summary.name).toBe(result.definition.services[0]?.name.localName);
  });

  it('falls back to the definition URL basename when there is no service', async () => {
    const result = await importCalculator();
    const noServices = { ...result, definition: { ...result.definition, services: [] } };
    const summary = toInterfaceSummary(noServices, 'iface-2', CALCULATOR_URL);
    expect(summary.name).toBe('service.wsdl');
  });

  it("gives each port the endpoint URL its address becomes, the definition's ${ escaped (#223)", async () => {
    const text = readPublicFixture('calculator').replace(
      /location="[^"]*"/,
      'location="http://calc.test/${#System#HOME}"',
    );
    const result = await importWsdl({ kind: 'text', text, location: CALCULATOR_URL });
    const ports = toInterfaceSummary(result, 'iface-4', CALCULATOR_URL).services.flatMap((service) => service.ports);
    const crafted = ports.find((port) => port.address === 'http://calc.test/${#System#HOME}');
    expect(crafted?.endpointUrl).toBe('http://calc.test/$${#System#HOME}');
    for (const port of ports) {
      expect(port.endpointUrl).toBe(port.address?.replaceAll('${', () => '$${'));
    }
  });

  it('carries the binding mime parts through to the operation summary', async () => {
    const location = fixturePath('wsdl/crafted/attachments/service.wsdl');
    const result = await importWsdl({ kind: 'text', text: readFileSync(location, 'utf-8'), location });
    const summary = toInterfaceSummary(result, 'iface-3', location);
    expect(summary.operations.find((op) => op.name === 'Upload')?.inputMimeParts).toEqual([
      { part: 'file', type: 'application/octet-stream' },
    ]);
    expect(summary.operations.find((op) => op.name === 'SendRef')?.inputMimeParts).toEqual([]);
  });

  it('carries each operation’s WS-SecurityPolicy, and none where the WSDL attaches none', async () => {
    const location = fixturePath('wsdl/crafted/ws-security-policy/service.wsdl');
    const result = await importWsdl({ kind: 'text', text: readFileSync(location, 'utf-8'), location });
    const summary = toInterfaceSummary(result, 'iface-5', location);
    const of = (binding: string) => summary.operations.find((op) => op.bindingLocal === binding && op.name === 'Echo');
    expect(of('TransportUtBinding')?.wssPolicy).toMatchObject({
      binding: 'transport',
      requiresTls: true,
      tokens: [{ kind: 'username', password: 'digest' }],
    });
    expect(of('PlainBinding')).not.toHaveProperty('wssPolicy');
  });
});

/** A completed exchange whose response carries two attachment parts (one unnamed). */
function attachmentExchange(): SoapExchange {
  return {
    durationMs: 1,
    http: {
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawBody: new Uint8Array(),
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      truncated: false,
      httpVersion: '1.1',
      timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
      redirects: [],
      request: { url: 'http://example.test/soap', method: 'POST', headers: {} },
    },
    response: {
      envelopeXml: '<a/>',
      isSoap: true,
      attachments: [
        {
          contentId: 'part1@wirebench',
          contentType: 'image/png',
          size: 3,
          bytes: new Uint8Array([1, 2, 3]),
          name: 'logo.png',
        },
        {
          contentId: 'part2@wirebench',
          contentType: 'application/octet-stream',
          size: 1,
          bytes: new Uint8Array([9]),
        },
      ],
    },
    problems: [],
  };
}

describe('toExchangeSummary attachments', () => {
  it('lists response attachments by index, with no bytes on the wire', () => {
    const summary = toExchangeSummary(attachmentExchange(), 'send-1', { show: true });

    expect(summary.response?.attachments).toEqual([
      { index: 0, contentId: 'part1@wirebench', contentType: 'image/png', size: 3, name: 'logo.png' },
      { index: 1, contentId: 'part2@wirebench', contentType: 'application/octet-stream', size: 1 },
    ]);
    expect(JSON.stringify(summary)).not.toContain('bytes');
  });

  it('leaves the attachment list of the unredacted master copy unmasked', () => {
    // `engine-service` builds the cached master with `{ show: true }`; running redaction over
    // it would mask the only unmasked copy there is, and `exchanges.get` could never un-hide it
    // on a later show-secrets toggle.
    const exchange = attachmentExchange();
    const spy = vi.spyOn(redact, 'redactResponseAttachments');

    toExchangeSummary(exchange, 'send-1', { show: true });
    expect(spy).not.toHaveBeenCalled();

    toExchangeSummary(exchange, 'send-1');
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('lists no attachments for a response that carried none', () => {
    const summary = toExchangeSummary(
      {
        durationMs: 1,
        http: {
          status: 200,
          statusText: 'OK',
          headers: {},
          rawHeaders: [],
          body: new Uint8Array(),
          rawBody: new Uint8Array(),
          rawRequest: new Uint8Array(),
          rawResponse: new Uint8Array(),
          truncated: false,
          httpVersion: '1.1',
          timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
          redirects: [],
          request: { url: 'http://example.test/soap', method: 'POST', headers: {} },
        },
        response: { envelopeXml: '<a/>', isSoap: true },
        problems: [],
      },
      'send-2',
    );
    expect(summary.response?.attachments).toEqual([]);
  });
});

describe('toGenerateResponse', () => {
  it('converts a GeneratedRequest into the wire response shape', async () => {
    const result = await importCalculator();
    const op = result.operations[0];
    if (op === undefined) throw new Error('fixture has no operations');
    const generated = generateSoapRequest(result, { bindingName: op.bindingName, operationName: op.operationName });

    const wire = toGenerateResponse(generated);

    expect(wire.envelopeXml).toBe(generated.envelopeXml);
    expect(wire.soapVersion).toBe(generated.soapVersion);
    expect(wire.contentType).toBe(generated.contentType);
    expect(wire.headers).toEqual(generated.headers);
    expect(() => void JSON.parse(JSON.stringify(wire))).not.toThrow();
  });
});

describe('toWireFault', () => {
  it('drops the non-serialisable DOM element and keeps the structural fields', () => {
    const parsed = parseSoapResponse(`<?xml version="1.0"?>
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
        <soapenv:Body>
          <soapenv:Fault>
            <faultcode>soapenv:Server</faultcode>
            <faultstring>boom</faultstring>
            <detail><code>42</code></detail>
          </soapenv:Fault>
        </soapenv:Body>
      </soapenv:Envelope>`);
    expect(parsed.fault).toBeDefined();
    const fault = parsed.fault;
    if (fault === undefined) throw new Error('expected a parsed fault');

    const wire = toWireFault(fault);

    expect(wire).not.toHaveProperty('element');
    expect(wire.code).toBe('soapenv:Server');
    expect(wire.reason).toBe('boom');
    expect(wire.subcodes).toEqual([]);
    expect(() => void JSON.parse(JSON.stringify(wire))).not.toThrow();
  });

  it('is exercised indirectly via parseFault for a 1.2 fault', () => {
    const doc = parseXml(
      `<?xml version="1.0"?>
      <env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
        <env:Body>
          <env:Fault>
            <env:Code><env:Value>env:Sender</env:Value></env:Code>
            <env:Reason><env:Text xml:lang="en">bad request</env:Text></env:Reason>
          </env:Fault>
        </env:Body>
      </env:Envelope>`,
    );
    const fault = parseFault(doc);
    expect(fault).toBeDefined();
    if (fault === undefined) throw new Error('expected a parsed fault');
    const wire = toWireFault(fault);
    expect(wire.version).toBe('1.2');
    expect(wire.code).toBe('env:Sender');
  });
});

describe('toExchangeSummary', () => {
  function fakeHttpExchange(): HttpExchange {
    return {
      request: { url: 'http://example.test/soap', method: 'POST', headers: { 'content-type': 'text/xml' } },
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/xml' },
      rawHeaders: [['content-type', 'text/xml']],
      body: new TextEncoder().encode('<a/>'),
      rawBody: new TextEncoder().encode('<a/>'),
      truncated: false,
      httpVersion: '1.1',
      timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 12 },
      rawRequest: new TextEncoder().encode('POST /soap HTTP/1.1\r\n\r\n'),
      rawResponse: new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n<a/>'),
      redirects: [],
    };
  }

  it('base64-round-trips every byte field', () => {
    const http = fakeHttpExchange();
    const exchange: SoapExchange = {
      http,
      response: { envelopeXml: '<a/>', isSoap: false },
      durationMs: 12,
      problems: [{ code: 'not-soap', message: 'not soap' }],
    };

    const wire = toExchangeSummary(exchange, 'send-1');

    expect(wire.sendId).toBe('send-1');
    expect(Buffer.from(wire.http.bodyBase64, 'base64')).toEqual(Buffer.from(http.body));
    expect(Buffer.from(wire.http.rawBodyBase64, 'base64')).toEqual(Buffer.from(http.rawBody));
    expect(Buffer.from(wire.http.rawRequestBase64, 'base64')).toEqual(Buffer.from(http.rawRequest));
    expect(Buffer.from(wire.http.rawResponseBase64, 'base64')).toEqual(Buffer.from(http.rawResponse));
    expect(wire.response?.isSoap).toBe(false);
    expect(() => void JSON.parse(JSON.stringify(wire))).not.toThrow();
  });

  it('redacts sensitive rawHeaders pairs (Set-Cookie) unless show is set', () => {
    const http = fakeHttpExchange();
    const withCookie: HttpExchange = {
      ...http,
      headers: { ...http.headers, 'set-cookie': 'sid=abc; HttpOnly' },
      rawHeaders: [...http.rawHeaders, ['Set-Cookie', 'sid=abc; HttpOnly'], ['Set-Cookie', 'tok=xyz']],
    };
    const exchange: SoapExchange = { http: withCookie, durationMs: 1, problems: [] };

    const wire = toExchangeSummary(exchange, 'send-3');
    expect(wire.http.rawHeaders.filter(([name]) => name === 'Set-Cookie').map(([, value]) => value)).toEqual([
      '<redacted>',
      '<redacted>',
    ]);
    expect(JSON.stringify(wire)).not.toContain('sid=abc');

    const shown = toExchangeSummary(exchange, 'send-4', { show: true });
    expect(shown.http.rawHeaders).toContainEqual(['Set-Cookie', 'sid=abc; HttpOnly']);
  });

  it('carries the WS-Security debugger fields: reference checks, clock skew and timeline (#57)', () => {
    const check = {
      canonicalization: 'exc-c14n',
      signatureMethod: 'rsa-sha256',
      signatureValueOk: true,
      references: [
        {
          uri: 'Id-1',
          element: 'Body',
          ok: false,
          transforms: ['exc-c14n'],
          inclusivePrefixes: ['soapenv'],
          digestAlgorithm: 'sha256',
          expectedDigest: 'A=',
          computedDigest: 'B=',
        },
      ],
    };
    const exchange: SoapExchange = {
      http: fakeHttpExchange(),
      durationMs: 1,
      problems: [],
      wss: {
        incoming: {
          actions: [
            { kind: 'signature', ok: false, detail: 'd', check },
            { kind: 'timestamp', ok: true, detail: 't', created: 'T0', skewSeconds: 3, toleranceSeconds: 300 },
          ],
          errors: ['d'],
          timeline: [{ kind: 'signature', summary: 'Signed Body', covers: ['Body'], actor: 'urn:gw' }],
        },
      },
    };
    const incoming = toExchangeSummary(exchange, 'send-wss').wss?.incoming;
    expect(incoming?.actions[0]?.check).toEqual(check);
    expect(incoming?.actions[1]).toMatchObject({ skewSeconds: 3, toleranceSeconds: 300 });
    expect(incoming?.timeline).toEqual([
      { kind: 'signature', summary: 'Signed Body', covers: ['Body'], actor: 'urn:gw' },
    ]);
  });

  it('omits `response` when the exchange had none', () => {
    const wire = toExchangeSummary({ http: fakeHttpExchange(), durationMs: 5, problems: [] }, 'send-2');
    expect(wire.response).toBeUndefined();
  });

  it('copies the whole SslInfo, peer chain included, onto the wire', () => {
    const http: HttpExchange = {
      ...fakeHttpExchange(),
      tls: {
        protocol: 'TLSv1.3',
        cipher: 'TLS_AES_256_GCM_SHA384',
        authorized: false,
        authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
        servername: 'example.test',
        alpn: 'http/1.1',
        peerChain: [
          {
            subject: 'CN=example.test',
            issuer: 'CN=Example CA',
            validFrom: '2026-01-01T00:00:00.000Z',
            validTo: '2027-01-01T00:00:00.000Z',
            serialNumber: '01',
            sans: ['example.test', '127.0.0.1'],
            fingerprint256: 'ab'.repeat(32),
            isCA: false,
          },
        ],
      },
    };

    const wire = toExchangeSummary({ http, durationMs: 1, problems: [] }, 'send-tls');

    expect(wire.http.tls).toEqual(http.tls);
    // Deep-copied, not aliased: the wire object must not share arrays with the engine's.
    expect(wire.http.tls?.peerChain).not.toBe(http.tls?.peerChain);
    expect(wire.http.tls?.peerChain[0]?.sans).not.toBe(http.tls?.peerChain[0]?.sans);
    expect(() => void JSON.parse(JSON.stringify(wire))).not.toThrow();
  });

  it('leaves `tls` absent for a plain-HTTP exchange', () => {
    expect(
      toExchangeSummary({ http: fakeHttpExchange(), durationMs: 1, problems: [] }, 'send-plain').http.tls,
    ).toBeUndefined();
  });
});

describe('redactExchangeSummary', () => {
  it('redacts wsse:Password in response.envelopeXml when show is false', () => {
    const envelope = `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">s3cret</wsse:Password>
    </wsse:Security>
  </soapenv:Body>
</soapenv:Envelope>`;

    const summary: ExchangeSummary = {
      sendId: 'send-5',
      durationMs: 12,
      http: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/xml' },
        rawHeaders: [['content-type', 'text/xml']],
        bodyBase64: 'PGEvPg==',
        rawBodyBase64: 'PGEvPg==',
        rawRequestBase64: Buffer.from('POST /soap HTTP/1.1\r\n\r\n').toString('base64'),
        rawResponseBase64: Buffer.from('HTTP/1.1 200 OK\r\n\r\n<a/>').toString('base64'),
        truncated: false,
        httpVersion: '1.1',
        timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 12 },
        redirects: [],
        request: { url: 'http://example.test/soap', method: 'POST', headers: { 'content-type': 'text/xml' } },
      },
      response: {
        envelopeXml: envelope,
        isSoap: true,
        attachments: [],
      },
      problems: [],
    };

    const redacted = redactExchangeSummary(summary);
    expect(redacted.response?.envelopeXml).toContain('&lt;redacted&gt;');
    expect(redacted.response?.envelopeXml).not.toContain('s3cret');

    const shown = redactExchangeSummary(summary, { show: true });
    expect(shown.response?.envelopeXml).toContain('s3cret');
  });

  it('redacts wsse:Password in response.fault.detailXml when show is false', () => {
    const detailXml = `<detail>
  <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">s3cret</wsse:Password>
</detail>`;

    const summary: ExchangeSummary = {
      sendId: 'send-6',
      durationMs: 12,
      http: {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'text/xml' },
        rawHeaders: [['content-type', 'text/xml']],
        bodyBase64: 'PGEvPg==',
        rawBodyBase64: 'PGEvPg==',
        rawRequestBase64: Buffer.from('POST /soap HTTP/1.1\r\n\r\n').toString('base64'),
        rawResponseBase64: Buffer.from('HTTP/1.1 500 Internal Server Error\r\n\r\n<a/>').toString('base64'),
        truncated: false,
        httpVersion: '1.1',
        timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 12 },
        redirects: [],
        request: { url: 'http://example.test/soap', method: 'POST', headers: { 'content-type': 'text/xml' } },
      },
      response: {
        envelopeXml: `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <soapenv:Fault>
      <faultcode>soapenv:Server</faultcode>
      <faultstring>Authentication failed</faultstring>
    </soapenv:Fault>
  </soapenv:Body>
</soapenv:Envelope>`,
        isSoap: true,
        attachments: [],
        fault: {
          version: '1.1',
          code: 'soapenv:Server',
          subcodes: [],
          reason: 'Authentication failed',
          detailXml,
        },
      },
      problems: [],
    };

    const redacted = redactExchangeSummary(summary);
    expect(redacted.response?.fault?.detailXml).toContain('&lt;redacted&gt;');
    expect(redacted.response?.fault?.detailXml).not.toContain('s3cret');

    const shown = redactExchangeSummary(summary, { show: true });
    expect(shown.response?.fault?.detailXml).toContain('s3cret');
  });
});

describe('toRestExchangeSummary — an API key in the query', () => {
  function restExchange(target: string): RestExchange {
    const rawRequest = Buffer.from(`GET ${target} HTTP/1.1\r\nHost: example.test\r\n\r\n`, 'latin1');
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawBody: new Uint8Array(),
      rawRequest,
      rawResponse: Buffer.from('HTTP/1.1 200 OK\r\n\r\n', 'latin1'),
      truncated: false,
      httpVersion: '1.1',
      timings: {},
      redirects: [],
      request: { url: `http://example.test${target}`, method: 'GET', headers: {} },
      text: '',
      language: 'text',
      cookies: [],
      methodChanged: false,
    } as unknown as RestExchange;
  }

  function rawRequestLine(summary: { http: { rawRequestBase64: string } }): string {
    return Buffer.from(summary.http.rawRequestBase64, 'base64').toString('latin1').split('\r\n')[0] ?? '';
  }

  it('masks a recorded secret an echoing server put in the body, the raw body and the decoded text', () => {
    redact.recordSecretValue('echoed-secret-value-284');
    const echoed = new TextEncoder().encode('{"echo":"echoed-secret-value-284"}');
    const binary = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x0a]),
      Buffer.from('echoed-secret-value-284'),
      Buffer.from([0xfe, 0x80]),
    ]);
    const exchange = {
      ...restExchange('/x'),
      body: echoed,
      rawBody: binary,
      text: '{"echo":"echoed-secret-value-284"}',
    };

    const hidden = toRestExchangeSummary(exchange, 's1', { method: 'GET' });
    expect(Buffer.from(hidden.http.bodyBase64, 'base64').toString('utf8')).not.toContain('echoed-secret-value-284');
    const raw = Buffer.from(hidden.http.rawBodyBase64, 'base64');
    expect(raw.includes(Buffer.from('echoed-secret-value-284'))).toBe(false);
    // The bytes around the value are untouched, so a binary body is not corrupted.
    expect([...raw.subarray(0, 3)]).toEqual([0x00, 0xff, 0x0a]);
    expect([...raw.subarray(raw.length - 2)]).toEqual([0xfe, 0x80]);
    // The decoded text the pane renders and copies is masked at this one source.
    expect(hidden.text).not.toContain('echoed-secret-value-284');

    const shown = toRestExchangeSummary(exchange, 's2', { method: 'GET', show: true });
    expect(Buffer.from(shown.http.bodyBase64, 'base64').toString('utf8')).toContain('echoed-secret-value-284');
    expect(Buffer.from(shown.http.rawBodyBase64, 'base64')).toEqual(binary);
    expect(shown.text).toContain('echoed-secret-value-284');
  });

  it('writes the escaped marker into decoded XML and HTML text, the raw one into JSON', () => {
    redact.recordSecretValue('echoed-markup-secret-284');
    const cases = [
      { language: 'xml', text: '<echo>echoed-markup-secret-284</echo>', marker: '&lt;redacted&gt;' },
      { language: 'html', text: '<p>echoed-markup-secret-284</p>', marker: '&lt;redacted&gt;' },
      { language: 'json', text: '{"echo":"echoed-markup-secret-284"}', marker: '<redacted>' },
    ] as const;
    for (const { language, text, marker } of cases) {
      const summary = toRestExchangeSummary({ ...restExchange('/x'), text, language }, 's1', { method: 'GET' });
      expect(summary.text).not.toContain('echoed-markup-secret-284');
      expect(summary.text).toContain(marker);
    }
  });

  it('masks the keyParams parameter on the raw request line', () => {
    const summary = toRestExchangeSummary(restExchange('/calc?key=secret123&a=1'), 's1', {
      method: 'GET',
      keyParams: ['key'],
    });
    const line = rawRequestLine(summary);
    expect(line).not.toContain('secret123');
    expect(line.startsWith('GET /calc?')).toBe(true);
    expect(line).toContain('a=1');
    expect(line.endsWith(' HTTP/1.1')).toBe(true);
    expect(summary.http.request.url).not.toContain('secret123');
  });

  it('matches a URL-encoded name with either space encoding', () => {
    for (const target of ['/calc?api+key=secret123', '/calc?api%20key=secret123', '/calc?%61pi%20key=secret123']) {
      const summary = toRestExchangeSummary(restExchange(target), 's1', { method: 'GET', keyParams: ['api key'] });
      expect(rawRequestLine(summary)).not.toContain('secret123');
    }
  });

  it('leaves the request line alone when show is set', () => {
    const summary = toRestExchangeSummary(restExchange('/calc?key=secret123'), 's1', {
      method: 'GET',
      show: true,
      keyParams: ['key'],
    });
    expect(rawRequestLine(summary)).toBe('GET /calc?key=secret123 HTTP/1.1');
  });
});

describe('toRestExchangeSummary — the cookie jar verdicts', () => {
  function withCookies(extra: Record<string, unknown>): RestExchange {
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawBody: new Uint8Array(),
      rawRequest: Buffer.from('GET / HTTP/1.1\r\nHost: example.test\r\n\r\n', 'latin1'),
      rawResponse: Buffer.from('HTTP/1.1 200 OK\r\n\r\n', 'latin1'),
      truncated: false,
      httpVersion: '1.1',
      timings: {},
      redirects: [],
      request: { url: 'http://example.test/', method: 'GET', headers: {} },
      text: '',
      language: 'text',
      cookies: [
        { name: 'sid', value: '1' },
        { name: 'far', value: '2', domain: 'other.test' },
      ],
      methodChanged: false,
      ...extra,
    } as unknown as RestExchange;
  }

  it("marks each cookie with the jar's verdict", () => {
    const summary = toRestExchangeSummary(
      withCookies({ cookieVerdicts: [{ stored: true }, { stored: false, reason: 'domain-mismatch' }] }),
      's1',
      { method: 'GET' },
    );
    expect(summary.cookies.map((cookie) => cookie.jar)).toEqual([
      { stored: true },
      { stored: false, reason: 'domain-mismatch' },
    ]);
  });

  it('marks nothing when the send had no jar', () => {
    const summary = toRestExchangeSummary(withCookies({}), 's1', { method: 'GET' });
    expect(summary.cookies.map((cookie) => cookie.jar)).toEqual([undefined, undefined]);
  });
});
