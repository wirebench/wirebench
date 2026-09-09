/**
 * XML namespace URIs used across WSDL, SOAP, XSD, WS-Security, WS-Addressing
 * and WS-Policy. Centralizing these avoids typos scattered through the
 * codebase and gives every consumer the same canonical values.
 */
export const NS = {
  WSDL: 'http://schemas.xmlsoap.org/wsdl/',
  WSDL_SOAP11: 'http://schemas.xmlsoap.org/wsdl/soap/',
  WSDL_SOAP12: 'http://schemas.xmlsoap.org/wsdl/soap12/',
  WSDL_HTTP: 'http://schemas.xmlsoap.org/wsdl/http/',
  WSDL_MIME: 'http://schemas.xmlsoap.org/wsdl/mime/',
  SOAP11_ENV: 'http://schemas.xmlsoap.org/soap/envelope/',
  SOAP11_ENC: 'http://schemas.xmlsoap.org/soap/encoding/',
  SOAP12_ENV: 'http://www.w3.org/2003/05/soap-envelope',
  SOAP12_ENC: 'http://www.w3.org/2003/05/soap-encoding',
  XSD: 'http://www.w3.org/2001/XMLSchema',
  XSI: 'http://www.w3.org/2001/XMLSchema-instance',
  XML: 'http://www.w3.org/XML/1998/namespace',
  XOP: 'http://www.w3.org/2004/08/xop/include',
  XMLMIME: 'http://www.w3.org/2005/05/xmlmime',
  WSSE: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  WSU: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  DS: 'http://www.w3.org/2000/09/xmldsig#',
  XENC: 'http://www.w3.org/2001/04/xmlenc#',
  WSA_200508: 'http://www.w3.org/2005/08/addressing',
  WSA_200408: 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
  WSAW: 'http://www.w3.org/2006/05/addressing/wsdl',
  WSAM: 'http://www.w3.org/2007/05/addressing/metadata',
  WSP: 'http://www.w3.org/ns/ws-policy',
  WSP_2004: 'http://schemas.xmlsoap.org/ws/2004/09/policy',
} as const;

/** Union of every namespace URI known to {@link NS}. */
export type NamespaceUri = (typeof NS)[keyof typeof NS];

/** Conventional XML prefix for each namespace in {@link NS}. */
export const PREFIX: Record<keyof typeof NS, string> = {
  WSDL: 'wsdl',
  WSDL_SOAP11: 'soap',
  WSDL_SOAP12: 'soap12',
  WSDL_HTTP: 'http',
  WSDL_MIME: 'mime',
  SOAP11_ENV: 'soapenv',
  SOAP11_ENC: 'soapenc',
  SOAP12_ENV: 'soapenv',
  SOAP12_ENC: 'soapenc',
  XSD: 'xs',
  XSI: 'xsi',
  XML: 'xml',
  XOP: 'xop',
  XMLMIME: 'xmlmime',
  WSSE: 'wsse',
  WSU: 'wsu',
  DS: 'ds',
  XENC: 'xenc',
  WSA_200508: 'wsa',
  WSA_200408: 'wsa',
  WSAW: 'wsaw',
  WSAM: 'wsam',
  WSP: 'wsp',
  WSP_2004: 'wsp',
};
