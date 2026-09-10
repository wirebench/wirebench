import { describe, expect, it } from 'vitest';
import { parseXml } from '../../../src/xml/parse.js';
import { NS } from '../../../src/xml/namespaces.js';
import { createEnvelope, detectEnvelopeVersion, envelopeNamespace } from '../../../src/soap/envelope.js';

describe('envelopeNamespace', () => {
  it('maps each version to its envelope namespace', () => {
    expect(envelopeNamespace('1.1')).toBe(NS.SOAP11_ENV);
    expect(envelopeNamespace('1.2')).toBe(NS.SOAP12_ENV);
  });
});

describe('createEnvelope', () => {
  it('emits an empty Header and the body, three-space indented', () => {
    const xml = createEnvelope('1.1', {
      bodyXml: '<tem:Add>\n   <tem:intA>?</tem:intA>\n</tem:Add>',
      namespaces: { tem: 'http://tempuri.org/' },
    });
    expect(xml).toBe(
      [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
        '   <soapenv:Header/>',
        '   <soapenv:Body>',
        '      <tem:Add>',
        '         <tem:intA>?</tem:intA>',
        '      </tem:Add>',
        '   </soapenv:Body>',
        '</soapenv:Envelope>',
      ].join('\n'),
    );
  });

  it('emits header children when there are any', () => {
    const xml = createEnvelope('1.2', { headerXml: '<h:Auth/>', bodyXml: '<b/>', namespaces: { h: 'urn:h' } });
    expect(xml).toContain('   <soapenv:Header>\n      <h:Auth/>\n   </soapenv:Header>');
    expect(xml).toContain(`xmlns:soapenv="${NS.SOAP12_ENV}"`);
  });

  it('collapses an empty body and a whitespace-only header', () => {
    expect(createEnvelope('1.1', { headerXml: '  \n ', bodyXml: '' })).toBe(
      [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '   <soapenv:Header/>',
        '   <soapenv:Body/>',
        '</soapenv:Envelope>',
      ].join('\n'),
    );
  });

  it('honours a custom indent', () => {
    expect(createEnvelope('1.1', { bodyXml: '<b/>' }, { indent: '  ' })).toContain('\n  <soapenv:Body>\n    <b/>');
  });

  it('escapes namespace URIs it declares', () => {
    expect(createEnvelope('1.1', { bodyXml: '<b/>', namespaces: { x: 'urn:a&b' } })).toContain('xmlns:x="urn:a&amp;b"');
  });
});

describe('detectEnvelopeVersion', () => {
  it.each([
    [NS.SOAP11_ENV, '1.1'],
    [NS.SOAP12_ENV, '1.2'],
  ])('detects %s', (ns, expected) => {
    expect(detectEnvelopeVersion(parseXml(`<e:Envelope xmlns:e="${ns}"><e:Body/></e:Envelope>`))).toBe(expected);
  });

  it('returns undefined for a non-envelope root and for an unknown namespace', () => {
    expect(detectEnvelopeVersion(parseXml('<html/>'))).toBeUndefined();
    expect(detectEnvelopeVersion(parseXml('<Envelope xmlns="urn:nope"/>'))).toBeUndefined();
  });
});
