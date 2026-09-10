import { readFileSync } from 'node:fs';
import { generateRequest, importDefinition, parseFault, parseSoapResponse, parseXml } from '@wirebench/engine';
import type { HttpExchange, SoapExchange } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import {
  toExchangeSummary,
  toGenerateResponse,
  toInterfaceSummary,
  toWireFault,
  redactExchangeSummary,
} from '../src/main/engine-wire.js';
import type { ExchangeSummary } from '../src/shared/wire-types.js';

const CALCULATOR_URL = 'http://example.test/calculator/service.wsdl';

/** Reads a public WSDL fixture, resolved relative to the repo root vitest runs from. */
function readPublicFixture(name: string): string {
  return readFileSync(`${process.cwd()}/fixtures/wsdl/public/${name}/service.wsdl`, 'utf-8');
}

async function importCalculator() {
  return importDefinition({ kind: 'text', text: readPublicFixture('calculator'), location: CALCULATOR_URL });
}

describe('toInterfaceSummary', () => {
  it('projects a real ImportResult into a JSON-serialisable InterfaceSummary', async () => {
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

  it('carries the binding mime parts through to the operation summary', async () => {
    const location = `${process.cwd()}/fixtures/wsdl/crafted/attachments/service.wsdl`;
    const result = await importDefinition({ kind: 'text', text: readFileSync(location, 'utf-8'), location });
    const summary = toInterfaceSummary(result, 'iface-3', location);
    expect(summary.operations.find((op) => op.name === 'Upload')?.inputMimeParts).toEqual([
      { part: 'file', type: 'application/octet-stream' },
    ]);
    expect(summary.operations.find((op) => op.name === 'SendRef')?.inputMimeParts).toEqual([]);
  });
});

describe('toExchangeSummary attachments', () => {
  it('lists response attachments by index, with no bytes on the wire', () => {
    const exchange = {
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
    } as unknown as SoapExchange;

    const summary = toExchangeSummary(exchange, 'send-1', { show: true });

    expect(summary.response?.attachments).toEqual([
      { index: 0, contentId: 'part1@wirebench', contentType: 'image/png', size: 3, name: 'logo.png' },
      { index: 1, contentId: 'part2@wirebench', contentType: 'application/octet-stream', size: 1 },
    ]);
    expect(JSON.stringify(summary)).not.toContain('bytes');
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
    const generated = generateRequest(result, { bindingName: op.bindingName, operationName: op.operationName });

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
    expect(redacted.response?.envelopeXml).toContain('<redacted>');
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
    expect(redacted.response?.fault?.detailXml).toContain('<redacted>');
    expect(redacted.response?.fault?.detailXml).not.toContain('s3cret');

    const shown = redactExchangeSummary(summary, { show: true });
    expect(shown.response?.fault?.detailXml).toContain('s3cret');
  });
});
