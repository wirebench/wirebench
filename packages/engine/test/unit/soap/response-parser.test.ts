import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { parseSoapResponse } from '../../../src/soap/response-parser.js';

const ADD_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
   <soap:Header><t:Trace xmlns:t="urn:wb:t">abc</t:Trace></soap:Header>
   <soap:Body>
      <AddResponse xmlns="http://tempuri.org/"><AddResult>3</AddResult></AddResponse>
   </soap:Body>
</soap:Envelope>`;

/** The `code` of the {@link WirebenchError} `fn` throws. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isWirebenchError(error) ? error.code : `unexpected:${String(error)}`;
  }
  return 'did-not-throw';
}

describe('parseSoapResponse', () => {
  it('dissects a SOAP 1.1 response', () => {
    const parsed = parseSoapResponse(ADD_RESPONSE);
    expect(parsed.version).toBe('1.1');
    expect(parsed.envelope.localName).toBe('Envelope');
    expect(parsed.header?.localName).toBe('Header');
    expect(parsed.body.localName).toBe('Body');
    expect(parsed.bodyChildren).toHaveLength(1);
    expect(parsed.bodyChildren[0]?.localName).toBe('AddResponse');
    expect(parsed.fault).toBeUndefined();
  });

  it('dissects a SOAP 1.2 response with no header and an empty body', () => {
    const parsed = parseSoapResponse(
      '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body/></e:Envelope>',
    );
    expect(parsed.version).toBe('1.2');
    expect(parsed.header).toBeUndefined();
    expect(parsed.bodyChildren).toEqual([]);
  });

  it('exposes the parsed fault when the body carries one', () => {
    const parsed = parseSoapResponse(
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
        '<faultcode>s:Client</faultcode><faultstring>bad request</faultstring></s:Fault></s:Body></s:Envelope>',
    );
    expect(parsed.fault?.code).toBe('s:Client');
    expect(parsed.fault?.reason).toBe('bad request');
    expect(parsed.bodyChildren[0]?.localName).toBe('Fault');
  });

  it('rejects a document that is not a SOAP envelope', () => {
    expect(codeOf(() => parseSoapResponse('<html><body>502 Bad Gateway</body></html>'))).toBe('not-a-soap-envelope');
    expect(codeOf(() => parseSoapResponse('<Envelope xmlns="urn:nope"><Body/></Envelope>'))).toBe(
      'not-a-soap-envelope',
    );
  });

  it('rejects a SOAP envelope with no Body', () => {
    expect(
      codeOf(() =>
        parseSoapResponse('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header/></s:Envelope>'),
      ),
    ).toBe('not-a-soap-envelope');
  });

  it('propagates an XML parse error', () => {
    expect(codeOf(() => parseSoapResponse('<not-xml'))).toBe('xml-parse-error');
  });
});
