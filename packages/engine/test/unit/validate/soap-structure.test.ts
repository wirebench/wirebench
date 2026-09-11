import { describe, expect, it } from 'vitest';
import { checkSoapStructure } from '../../../src/validate/soap-structure.js';

const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

function envelope11(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="${SOAP11}">\n${inner}\n</soapenv:Envelope>`;
}

const codes = (problems: readonly { code: string }[]): string[] => problems.map((problem) => problem.code);

describe('checkSoapStructure', () => {
  it('accepts a well-formed 1.1 envelope', () => {
    const problems = checkSoapStructure(
      envelope11('  <soapenv:Header/>\n  <soapenv:Body><Add xmlns="urn:x"/></soapenv:Body>'),
      { expectedVersion: '1.1' },
    );
    expect(problems).toEqual([]);
  });

  it('reports malformed XML with a position', () => {
    const problems = checkSoapStructure('<a>\n<b></a>', { expectedVersion: '1.1' });
    expect(codes(problems)).toEqual(['xml-not-well-formed']);
    expect(problems[0]?.line).toBeGreaterThan(0);
    expect(problems[0]?.severity).toBe('error');
    expect(problems[0]?.source).toBe('structure');
  });

  it('reports a non-envelope root', () => {
    expect(codes(checkSoapStructure('<Add xmlns="urn:x"/>', { expectedVersion: '1.1' }))).toEqual(['not-an-envelope']);
  });

  it('reports an Envelope in an unknown namespace', () => {
    expect(codes(checkSoapStructure('<Envelope xmlns="urn:nope"/>', { expectedVersion: '1.1' }))).toEqual([
      'not-an-envelope',
    ]);
  });

  it('flags a 1.2 envelope sent against a 1.1 binding', () => {
    const problems = checkSoapStructure(`<env:Envelope xmlns:env="${SOAP12}"><env:Body/></env:Envelope>`, {
      expectedVersion: '1.1',
    });
    expect(codes(problems)).toEqual(['soap-version-mismatch']);
    expect(problems[0]?.line).toBe(1);
  });

  it('flags a 1.1 envelope sent against a 1.2 binding', () => {
    expect(codes(checkSoapStructure(envelope11('<soapenv:Body/>'), { expectedVersion: '1.2' }))).toEqual([
      'soap-version-mismatch',
    ]);
  });

  it('flags a missing Body', () => {
    expect(codes(checkSoapStructure(envelope11('<soapenv:Header/>'), { expectedVersion: '1.1' }))).toEqual([
      'missing-body',
    ]);
  });

  it('flags more than one Body', () => {
    expect(codes(checkSoapStructure(envelope11('<soapenv:Body/><soapenv:Body/>'), { expectedVersion: '1.1' }))).toEqual(
      ['multiple-body'],
    );
  });

  it('flags more than one Header', () => {
    const problems = checkSoapStructure(envelope11('<soapenv:Header/><soapenv:Header/><soapenv:Body/>'), {
      expectedVersion: '1.1',
    });
    expect(codes(problems)).toEqual(['multiple-header']);
  });

  it('flags a Header after the Body', () => {
    expect(
      codes(checkSoapStructure(envelope11('<soapenv:Body/><soapenv:Header/>'), { expectedVersion: '1.1' })),
    ).toEqual(['header-after-body']);
  });

  it('flags a foreign child of Envelope', () => {
    expect(
      codes(checkSoapStructure(envelope11('<soapenv:Body/><Extra xmlns="urn:x"/>'), { expectedVersion: '1.1' })),
    ).toEqual(['unexpected-envelope-child']);
  });

  it('accepts a complete 1.1 Fault', () => {
    const problems = checkSoapStructure(
      envelope11(
        '<soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>boom</faultstring></soapenv:Fault></soapenv:Body>',
      ),
      { expectedVersion: '1.1' },
    );
    expect(problems).toEqual([]);
  });

  it('flags a 1.1 Fault missing faultcode and faultstring', () => {
    const problems = checkSoapStructure(envelope11('<soapenv:Body><soapenv:Fault/></soapenv:Body>'), {
      expectedVersion: '1.1',
    });
    expect(codes(problems)).toEqual(['fault-missing-faultcode', 'fault-missing-faultstring']);
  });

  it('accepts a complete 1.2 Fault', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Body><env:Fault><env:Code><env:Value>env:Sender</env:Value></env:Code><env:Reason><env:Text>boom</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>`;
    expect(checkSoapStructure(xml, { expectedVersion: '1.2' })).toEqual([]);
  });

  it('flags a 1.2 Fault missing Code/Value and Reason/Text', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Body><env:Fault><env:Code/><env:Reason/></env:Fault></env:Body></env:Envelope>`;
    expect(codes(checkSoapStructure(xml, { expectedVersion: '1.2' }))).toEqual([
      'fault-missing-code',
      'fault-missing-reason',
    ]);
  });

  it('flags an illegal 1.1 mustUnderstand value', () => {
    const problems = checkSoapStructure(
      envelope11('<soapenv:Header><h:A xmlns:h="urn:x" soapenv:mustUnderstand="true"/></soapenv:Header>'),
      { expectedVersion: '1.1' },
    );
    expect(codes(problems)).toContain('invalid-must-understand');
  });

  it('accepts "true" as a 1.2 mustUnderstand value', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Header><h:A xmlns:h="urn:x" env:mustUnderstand="true"/></env:Header><env:Body/></env:Envelope>`;
    expect(checkSoapStructure(xml, { expectedVersion: '1.2' })).toEqual([]);
  });

  it('flags an illegal 1.2 mustUnderstand value', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Header><h:A xmlns:h="urn:x" env:mustUnderstand="yes"/></env:Header><env:Body/></env:Envelope>`;
    expect(codes(checkSoapStructure(xml, { expectedVersion: '1.2' }))).toEqual(['invalid-must-understand']);
  });

  it('accepts a matching 1.1 Content-Type', () => {
    const problems = checkSoapStructure(envelope11('<soapenv:Body/>'), {
      expectedVersion: '1.1',
      contentType: 'text/xml; charset=utf-8',
    });
    expect(problems).toEqual([]);
  });

  it('warns about a 1.2 Content-Type on a 1.1 message', () => {
    const problems = checkSoapStructure(envelope11('<soapenv:Body/>'), {
      expectedVersion: '1.1',
      contentType: 'application/soap+xml',
    });
    expect(codes(problems)).toEqual(['content-type-mismatch']);
    expect(problems[0]?.severity).toBe('warning');
  });

  it('warns about a 1.1 Content-Type on a 1.2 message', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Body/></env:Envelope>`;
    expect(codes(checkSoapStructure(xml, { expectedVersion: '1.2', contentType: 'text/xml' }))).toEqual([
      'content-type-mismatch',
    ]);
  });

  it('accepts a 1.2 action parameter that matches the SOAPAction', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Body/></env:Envelope>`;
    const problems = checkSoapStructure(xml, {
      expectedVersion: '1.2',
      contentType: 'application/soap+xml; action="urn:x:Add"; charset=utf-8',
      soapAction: '"urn:x:Add"',
    });
    expect(problems).toEqual([]);
  });

  it('warns when the 1.2 action parameter disagrees with the SOAPAction', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Body/></env:Envelope>`;
    const problems = checkSoapStructure(xml, {
      expectedVersion: '1.2',
      contentType: 'application/soap+xml; action="urn:x:Other"',
      soapAction: 'urn:x:Add',
    });
    expect(codes(problems)).toEqual(['soap-action-mismatch']);
    expect(problems[0]?.severity).toBe('warning');
  });

  it('ignores the action parameter when no SOAPAction is configured', () => {
    const xml = `<env:Envelope xmlns:env="${SOAP12}"><env:Body/></env:Envelope>`;
    expect(
      checkSoapStructure(xml, { expectedVersion: '1.2', contentType: 'application/soap+xml; action="urn:a"' }),
    ).toEqual([]);
  });

  it('reports an empty document as not well-formed', () => {
    expect(codes(checkSoapStructure('', { expectedVersion: '1.1' }))).toEqual(['xml-not-well-formed']);
  });
});
