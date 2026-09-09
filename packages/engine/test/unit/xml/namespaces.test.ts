import { describe, expect, it } from 'vitest';
import { NS, PREFIX } from '../../../src/xml/namespaces.js';

describe('NS', () => {
  it('matches the known namespace table', () => {
    expect(NS).toMatchInlineSnapshot(`
      {
        "DS": "http://www.w3.org/2000/09/xmldsig#",
        "SOAP11_ENC": "http://schemas.xmlsoap.org/soap/encoding/",
        "SOAP11_ENV": "http://schemas.xmlsoap.org/soap/envelope/",
        "SOAP12_ENC": "http://www.w3.org/2003/05/soap-encoding",
        "SOAP12_ENV": "http://www.w3.org/2003/05/soap-envelope",
        "WSAM": "http://www.w3.org/2007/05/addressing/metadata",
        "WSAW": "http://www.w3.org/2006/05/addressing/wsdl",
        "WSA_200408": "http://schemas.xmlsoap.org/ws/2004/08/addressing",
        "WSA_200508": "http://www.w3.org/2005/08/addressing",
        "WSDL": "http://schemas.xmlsoap.org/wsdl/",
        "WSDL_HTTP": "http://schemas.xmlsoap.org/wsdl/http/",
        "WSDL_MIME": "http://schemas.xmlsoap.org/wsdl/mime/",
        "WSDL_SOAP11": "http://schemas.xmlsoap.org/wsdl/soap/",
        "WSDL_SOAP12": "http://schemas.xmlsoap.org/wsdl/soap12/",
        "WSP": "http://www.w3.org/ns/ws-policy",
        "WSP_2004": "http://schemas.xmlsoap.org/ws/2004/09/policy",
        "WSSE": "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
        "WSU": "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
        "XENC": "http://www.w3.org/2001/04/xmlenc#",
        "XML": "http://www.w3.org/XML/1998/namespace",
        "XMLMIME": "http://www.w3.org/2005/05/xmlmime",
        "XOP": "http://www.w3.org/2004/08/xop/include",
        "XSD": "http://www.w3.org/2001/XMLSchema",
        "XSI": "http://www.w3.org/2001/XMLSchema-instance",
      }
    `);
  });

  it('every PREFIX key matches an NS key', () => {
    const nsKeys = new Set(Object.keys(NS));
    for (const key of Object.keys(PREFIX)) {
      expect(nsKeys.has(key)).toBe(true);
    }
    for (const key of nsKeys) {
      expect(typeof PREFIX[key as keyof typeof PREFIX]).toBe('string');
    }
  });
});
