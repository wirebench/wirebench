import { describe, expect, it } from 'vitest';
import type { SoapExchange } from '../../../../src/types.js';
import { WSI_MESSAGE_ASSERTIONS } from '../../../../src/validate/wsi/assertions/message/index.js';
import { runMessageAssertions, wsiMessageContext } from '../../../../src/validate/wsi/run-message.js';
import type { WsiMessageBinding, WsiReport } from '../../../../src/validate/wsi/types.js';

const DOC_LITERAL: WsiMessageBinding = {
  soapVersion: '1.1',
  style: 'document',
  use: 'literal',
  operation: 'Echo',
  soapAction: 'urn:wb:wsi:Echo',
};

/** A conforming document/literal SOAP 1.1 request envelope. */
const REQUEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:wb:wsi">
  <soapenv:Header>
    <tns:AuthHeader soapenv:mustUnderstand="0">token</tns:AuthHeader>
  </soapenv:Header>
  <soapenv:Body>
    <tns:Echo>hello</tns:Echo>
  </soapenv:Body>
</soapenv:Envelope>`;

/** The matching, conforming response envelope. */
const RESPONSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:wb:wsi">
  <soapenv:Body>
    <tns:EchoResult>hello</tns:EchoResult>
  </soapenv:Body>
</soapenv:Envelope>`;

/** A conforming SOAP 1.1 fault, returned with the status the profile requires. */
const FAULT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <soapenv:Fault>
      <faultcode>soapenv:Client</faultcode>
      <faultstring>bad input</faultstring>
      <detail><problem>nope</problem></detail>
    </soapenv:Fault>
  </soapenv:Body>
</soapenv:Envelope>`;

interface ExchangeOverrides {
  readonly requestHeaders?: Record<string, string>;
  readonly responseHeaders?: Record<string, string>;
  readonly responseXml?: string | undefined;
  readonly status?: number;
  readonly method?: string;
}

/** Builds a `SoapExchange` with the wire fields the message assertions read. */
function exchangeWith(overrides: ExchangeOverrides = {}): SoapExchange {
  const responseXml = 'responseXml' in overrides ? overrides.responseXml : RESPONSE_XML;
  const status = overrides.status ?? 200;
  return {
    http: {
      request: {
        url: 'http://example.invalid/wsi',
        method: overrides.method ?? 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          SOAPAction: '"urn:wb:wsi:Echo"',
          ...overrides.requestHeaders,
        },
      },
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'text/xml; charset=UTF-8', ...overrides.responseHeaders },
      rawHeaders: [],
      body: new Uint8Array(),
      rawBody: new Uint8Array(),
      truncated: false,
      timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
      rawRequest: new TextEncoder().encode(`POST /wsi HTTP/1.1\r\n\r\n${REQUEST_XML}`),
      rawResponse: new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n'),
      redirects: [],
    },
    ...(responseXml !== undefined ? { response: { envelopeXml: responseXml, version: '1.1', isSoap: true } } : {}),
    durationMs: 1,
    problems: [],
  };
}

/** Runs the whole catalogue verbosely over one exchange. */
function report(exchange: SoapExchange, binding: WsiMessageBinding = DOC_LITERAL, requestXml = REQUEST_XML): WsiReport {
  return runMessageAssertions(exchange, {
    binding,
    direction: 'request',
    requestEnvelopeXml: requestXml,
    verbose: true,
  });
}

/** The ids that ended in `failed` or `warning`. */
function offenders(result: WsiReport): readonly string[] {
  return result.assertions
    .filter((assertion) => assertion.result === 'failed' || assertion.result === 'warning')
    .map((assertion) => assertion.id);
}

describe('WS-I BP 1.1 message assertions', () => {
  it('registers at least 20 assertions with unique, ordered ids', () => {
    const ids = WSI_MESSAGE_ASSERTIONS.map((assertion) => assertion.id);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('reports no failure for a conforming document/literal exchange', () => {
    const result = report(exchangeWith());
    expect(offenders(result)).toEqual([]);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.warning).toBe(0);
    expect(result.summary.passed + result.summary.notApplicable).toBe(WSI_MESSAGE_ASSERTIONS.length);
    expect(result.summary.passed).toBeGreaterThan(0);
    expect(result.summary.notApplicable).toBeGreaterThan(0);
    expect(result.profile).toBe('BP1.1');
    expect(result.target).toBe('http://example.invalid/wsi');
  });

  it('fails the expected ids for a bad exchange', () => {
    const badRequest = REQUEST_XML.replace(
      '<tns:Echo>',
      '<tns:Echo soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    );
    const result = report(
      exchangeWith({
        requestHeaders: { 'Content-Type': 'text/xml', SOAPAction: 'urn:wb:wsi:Echo' },
        responseHeaders: { 'content-type': 'text/xml' },
      }),
      DOC_LITERAL,
      badRequest,
    );
    // No charset on either half, an encodingStyle in a document/literal body, an unquoted action.
    expect(offenders(result)).toEqual(expect.arrayContaining(['R1015', 'R1109', 'R1141']));
    expect(result.summary.failed).toBeGreaterThanOrEqual(3);
  });

  it('omits passing rows unless verbose, but always counts them', () => {
    const exchange = exchangeWith({ requestHeaders: { SOAPAction: 'unquoted' } });
    const quiet = runMessageAssertions(exchange, { binding: DOC_LITERAL, direction: 'request' });
    const verbose = runMessageAssertions(exchange, { binding: DOC_LITERAL, direction: 'request', verbose: true });
    expect(quiet.summary).toEqual(verbose.summary);
    expect(quiet.assertions.every((assertion) => assertion.result !== 'passed')).toBe(true);
    expect(quiet.assertions.map((assertion) => assertion.id)).toEqual(['R1109']);
  });

  it('runs only the requested assertion ids', () => {
    const result = runMessageAssertions(exchangeWith(), {
      binding: DOC_LITERAL,
      direction: 'request',
      ids: ['R1141', 'R9999'],
      verbose: true,
    });
    expect(result.assertions.map((assertion) => assertion.id)).toEqual(['R1141']);
  });

  describe.each(WSI_MESSAGE_ASSERTIONS.map((assertion) => [assertion.id, assertion] as const))('%s', (id) => {
    it('passes or does not apply to the conforming exchange', () => {
      const [row] = report(exchangeWith()).assertions.filter((assertion) => assertion.id === id);
      expect(row?.result === 'passed' || row?.result === 'notApplicable').toBe(true);
    });
  });

  it('R1001 reports a response that is not a SOAP envelope of the bound version', () => {
    const html = '<html><body>gateway error</body></html>';
    const result = report(exchangeWith({ responseXml: html, status: 502 }));
    expect(offenders(result)).toContain('R1001');
    const row = result.assertions.find((assertion) => assertion.id === 'R1001');
    expect(row?.findings[0]?.message).toContain('not soap:Envelope');
    expect(row?.findings[0]?.location?.document).toBe('response');
  });

  it('R1001 reports a SOAP 1.2 envelope answering a SOAP 1.1 binding', () => {
    const soap12 = RESPONSE_XML.replace(
      'http://schemas.xmlsoap.org/soap/envelope/',
      'http://www.w3.org/2003/05/soap-envelope',
    );
    expect(offenders(report(exchangeWith({ responseXml: soap12 })))).toContain('R1001');
  });

  it('R1001 reports a half that is not well-formed XML', () => {
    expect(offenders(report(exchangeWith({ responseXml: '<a><b></a>' })))).toContain('R1001');
  });

  it('R1012 reports a declared encoding the profile does not allow', () => {
    const latin = REQUEST_XML.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, latin))).toContain('R1012');
  });

  it('R1005 reports a Document Type Declaration', () => {
    const doctype = REQUEST_XML.replace('?>\n', '?>\n<!DOCTYPE soapenv:Envelope>\n');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, doctype))).toContain('R1005');
  });

  it('R1006 reports a processing instruction, but not the XML declaration', () => {
    expect(offenders(report(exchangeWith()))).not.toContain('R1006');
    const pi = REQUEST_XML.replace('  <soapenv:Body>', '  <?wirebench keep?>\n  <soapenv:Body>');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, pi))).toContain('R1006');
  });

  it('R1007 reports an unexpected element child of soap:Envelope', () => {
    const extra = REQUEST_XML.replace('</soapenv:Envelope>', '  <tns:Trailer/>\n</soapenv:Envelope>');
    const result = report(exchangeWith(), DOC_LITERAL, extra);
    expect(offenders(result)).toContain('R1007');
    // The same construct sits after the body, so R1011 reports it too.
    expect(offenders(result)).toContain('R1011');
  });

  it('R1003 reports a second soap:Body and a header that follows it', () => {
    const twoBodies = REQUEST_XML.replace('</soapenv:Envelope>', '  <soapenv:Body/>\n</soapenv:Envelope>');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, twoBodies))).toContain('R1003');

    const headerLast = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:wb:wsi">
  <soapenv:Body><tns:Echo>hi</tns:Echo></soapenv:Body>
  <soapenv:Header/>
</soapenv:Envelope>`;
    const row = report(exchangeWith(), DOC_LITERAL, headerLast).assertions.find(
      (assertion) => assertion.id === 'R1003',
    );
    expect(row?.result).toBe('failed');
    expect(row?.findings.map((finding) => finding.message).join('\n')).toContain('must precede');
  });

  it('R1013 reports an illegal mustUnderstand value, and accepts SOAP 1.2 booleans', () => {
    const bad = REQUEST_XML.replace('mustUnderstand="0"', 'mustUnderstand="yes"');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, bad))).toContain('R1013');

    const soap12Value = REQUEST_XML.replace('mustUnderstand="0"', 'mustUnderstand="true"');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, soap12Value))).toContain('R1013');
    const asSoap12 = report(
      exchangeWith({ responseXml: undefined }),
      { ...DOC_LITERAL, soapVersion: '1.2' },
      soap12Value.replace('http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'),
    );
    expect(offenders(asSoap12)).not.toContain('R1013');
  });

  it('R1014 reports an unqualified soap:Body child', () => {
    const unqualified = REQUEST_XML.replace('<tns:Echo>hello</tns:Echo>', '<Echo>hello</Echo>');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, unqualified))).toContain('R1014');
  });

  it('R1015 does not apply to an encoded binding', () => {
    const withStyle = REQUEST_XML.replace(
      '<tns:Echo>',
      '<tns:Echo soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    );
    const encoded = report(exchangeWith(), { ...DOC_LITERAL, style: 'rpc', use: 'encoded' }, withStyle);
    expect(encoded.assertions.find((assertion) => assertion.id === 'R1015')?.result).toBe('notApplicable');
  });

  it('R1017 reports an unqualified header block', () => {
    const unqualified = REQUEST_XML.replaceAll('tns:AuthHeader', 'AuthHeader');
    expect(offenders(report(exchangeWith(), DOC_LITERAL, unqualified))).toContain('R1017');
  });

  it('accepts a conforming fault returned with status 500', () => {
    const result = report(exchangeWith({ responseXml: FAULT_XML, status: 500 }));
    expect(offenders(result)).toEqual([]);
    const fault = result.assertions.find((assertion) => assertion.id === 'R1100');
    expect(fault?.result).toBe('passed');
  });

  it('R1100/R1101/R1102/R1103/R1107 report a malformed fault', () => {
    const bad = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <soapenv:Fault>
      <soapenv:faultcode>gone:Client</soapenv:faultcode>
      <faultstring>bad</faultstring>
      <extra>no</extra>
      <detail soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/>
    </soapenv:Fault>
  </soapenv:Body>
</soapenv:Envelope>`;
    const ids = offenders(report(exchangeWith({ responseXml: bad, status: 200 })));
    // The faultcode is qualified, so it is not the unqualified `faultcode` R1102 looks for.
    expect(ids).toEqual(expect.arrayContaining(['R1100', 'R1101', 'R1103', 'R1107']));
  });

  it('R1102 reports an undeclared faultcode prefix and an empty faultcode', () => {
    const undeclared = FAULT_XML.replace('soapenv:Client', 'gone:Client');
    expect(offenders(report(exchangeWith({ responseXml: undeclared, status: 500 })))).toContain('R1102');
    const empty = FAULT_XML.replace('<faultcode>soapenv:Client</faultcode>', '<faultcode></faultcode>');
    const row = report(exchangeWith({ responseXml: empty, status: 500 })).assertions.find(
      (assertion) => assertion.id === 'R1102',
    );
    expect(row?.findings[0]?.message).toContain('empty');
  });

  it('the fault assertions do not apply to a SOAP 1.2 binding', () => {
    const result = report(exchangeWith({ responseXml: FAULT_XML, status: 500 }), {
      ...DOC_LITERAL,
      soapVersion: '1.2',
    });
    for (const id of ['R1100', 'R1101', 'R1102']) {
      expect(result.assertions.find((assertion) => assertion.id === id)?.result).toBe('notApplicable');
    }
  });

  it('R1109 does not apply to SOAP 1.2, nor when no SOAPAction is sent', () => {
    const soap12 = report(exchangeWith(), { ...DOC_LITERAL, soapVersion: '1.2' });
    expect(soap12.assertions.find((assertion) => assertion.id === 'R1109')?.result).toBe('notApplicable');
    const none = runMessageAssertions(
      { ...exchangeWith(), http: { ...exchangeWith().http, request: { url: 'u', method: 'POST', headers: {} } } },
      { binding: DOC_LITERAL, direction: 'request', requestEnvelopeXml: REQUEST_XML, verbose: true },
    );
    expect(none.assertions.find((assertion) => assertion.id === 'R1109')?.result).toBe('notApplicable');
  });

  it('R1124 fails a non-fault response on an unexpected status', () => {
    const result = report(exchangeWith({ status: 418 }));
    const row = result.assertions.find((assertion) => assertion.id === 'R1124');
    expect(row?.result).toBe('failed');
    expect(row?.findings[0]?.message).toContain('418');
  });

  it('R1132 reports a request that is not a POST', () => {
    expect(offenders(report(exchangeWith({ method: 'GET' })))).toContain('R1132');
  });

  it('R1140 reports a wrong media type and skips a multipart message', () => {
    expect(
      offenders(report(exchangeWith({ responseHeaders: { 'content-type': 'text/html; charset=UTF-8' } }))),
    ).toContain('R1140');
    const multipart = report(
      exchangeWith({
        requestHeaders: { 'Content-Type': 'multipart/related; type="text/xml"; boundary=x' },
        responseHeaders: { 'content-type': 'multipart/related; type="text/xml"; boundary=x' },
      }),
    );
    expect(multipart.assertions.find((assertion) => assertion.id === 'R1140')?.result).toBe('notApplicable');
    expect(multipart.assertions.find((assertion) => assertion.id === 'R1141')?.result).toBe('notApplicable');
  });

  it('R2113 reports a soapenc:arrayType attribute in the envelope', () => {
    const encoded = REQUEST_XML.replace(
      '<tns:Echo>',
      '<tns:Echo xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" soapenc:arrayType="xsd:string[2]">',
    );
    expect(offenders(report(exchangeWith(), DOC_LITERAL, encoded))).toContain('R2113');
  });

  it('R2211 reports xsi:nil on an rpc-literal part accessor, and only then', () => {
    const rpc = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="urn:wb:wsi">
  <soapenv:Body>
    <tns:Echo><text xsi:nil="true"/></tns:Echo>
  </soapenv:Body>
</soapenv:Envelope>`;
    const rpcLiteral: WsiMessageBinding = { ...DOC_LITERAL, style: 'rpc', use: 'literal' };
    expect(offenders(report(exchangeWith({ responseXml: undefined }), rpcLiteral, rpc))).toContain('R2211');
    // The very same message under a document/literal binding is not an rpc part accessor.
    expect(report(exchangeWith(), DOC_LITERAL, rpc).assertions.find((a) => a.id === 'R2211')?.result).toBe(
      'notApplicable',
    );
  });

  it('redacts headers to the allow-list the assertions need, dropping Authorization', () => {
    const secret = 'Bearer super-secret-token';
    const context = wsiMessageContext(
      exchangeWith({ requestHeaders: { Authorization: secret }, responseHeaders: { Authorization: secret } }),
      { binding: DOC_LITERAL, direction: 'request', requestEnvelopeXml: REQUEST_XML },
    );
    expect(context.request.headers['authorization']).toBeUndefined();
    expect(context.response?.headers['authorization']).toBeUndefined();
    expect(context.request.headers['content-type']).toBeDefined();

    // The secret must never leak into a finding message, whatever assertion fails.
    const result = report(
      exchangeWith({ requestHeaders: { Authorization: secret, SOAPAction: 'unquoted' } }),
      DOC_LITERAL,
    );
    const allMessages = result.assertions.flatMap((assertion) => assertion.findings.map((f) => f.message));
    expect(allMessages.some((message) => message.includes(secret))).toBe(false);
  });

  it('falls back to the raw request frame when no request envelope is supplied', () => {
    const context = wsiMessageContext(exchangeWith(), { binding: DOC_LITERAL, direction: 'request' });
    expect(context.request.envelopeXml).toContain('<tns:Echo>hello</tns:Echo>');
    expect(context.messages).toHaveLength(2);
  });

  it('analyses a request-only exchange when no response arrived', () => {
    const exchange = exchangeWith({ responseXml: undefined });
    const withoutResponse: SoapExchange = {
      ...exchange,
      http: { ...exchange.http, rawResponse: new Uint8Array() },
    };
    const result = report(withoutResponse);
    expect(wsiMessageContext(withoutResponse, { binding: DOC_LITERAL, direction: 'request' }).response).toBeUndefined();
    expect(result.assertions.find((assertion) => assertion.id === 'R1103')?.result).toBe('notApplicable');
    expect(result.assertions.find((assertion) => assertion.id === 'R1124')?.result).toBe('notApplicable');
  });

  it('reports notApplicable across the board for an exchange with no XML at all', () => {
    const exchange = exchangeWith({ responseXml: undefined });
    const blank: SoapExchange = {
      ...exchange,
      http: { ...exchange.http, rawRequest: new Uint8Array(), rawResponse: new Uint8Array() },
    };
    const result = runMessageAssertions(blank, { binding: DOC_LITERAL, direction: 'request', verbose: true });
    expect(result.summary.failed).toBe(0);
    expect(result.summary.notApplicable).toBeGreaterThan(15);
  });
});
