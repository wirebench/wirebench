import { describe, expect, it } from 'vitest';
import type { Element } from '@xmldom/xmldom';
import { WssError } from '../../../src/errors.js';
import { securityIndex } from '../../../src/wss/security-header.js';
import { NS } from '../../../src/xml/namespaces.js';
import { parseXml } from '../../../src/xml/parse.js';

const ENVELOPE_NS = 'http://schemas.xmlsoap.org/soap/envelope/';

function headerOf(xml: string): Element {
  const root = parseXml(xml, { location: 'envelope' }).documentElement;
  if (root === null) {
    throw new Error('no root');
  }
  for (let node = root.firstChild; node !== null; node = node.nextSibling) {
    const element = node as Element;
    if (element.nodeType === 1 && element.localName === 'Header') {
      return element;
    }
  }
  throw new Error('no header');
}

describe('securityIndex', () => {
  it('throws wss-security-missing when no direct child is addressed to the actor', () => {
    const header = headerOf(`<soapenv:Envelope xmlns:soapenv="${ENVELOPE_NS}"><soapenv:Header/></soapenv:Envelope>`);
    expect(() => securityIndex(header, '1.1', undefined)).toThrow(WssError);
    expect(() => securityIndex(header, '1.1', undefined)).toThrow(
      expect.objectContaining({ code: 'wss-security-missing' }),
    );
  });

  it('counts only direct Header children, ignoring a wsse:Security nested elsewhere', () => {
    const header = headerOf(
      `<soapenv:Envelope xmlns:soapenv="${ENVELOPE_NS}"><soapenv:Header>` +
        `<wsse:Security xmlns:wsse="${NS.WSSE}"/>` +
        '</soapenv:Header>' +
        `<soapenv:Body><tns:Echo xmlns:tns="urn:test"><wsse:Security xmlns:wsse="${NS.WSSE}"/></tns:Echo></soapenv:Body>` +
        '</soapenv:Envelope>',
    );
    expect(securityIndex(header, '1.1', undefined)).toBe(1);
  });
});
