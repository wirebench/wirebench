import { describe, expect, it } from 'vitest';
import { soapActionHeaders } from '../../../src/soap/soap-action.js';

describe('soapActionHeaders (SOAP 1.1)', () => {
  it('always quotes the action', () => {
    const result = soapActionHeaders('1.1', 'http://tempuri.org/Add', {});
    expect(result.contentType).toBe('text/xml;charset=UTF-8');
    expect(result.headers).toEqual({ SOAPAction: '"http://tempuri.org/Add"' });
  });

  it('sends an empty quoted action when the binding declares none', () => {
    expect(soapActionHeaders('1.1', undefined, {}).headers).toEqual({ SOAPAction: '""' });
    expect(soapActionHeaders('1.1', '', {}).headers).toEqual({ SOAPAction: '""' });
  });

  it('omits the header entirely when asked to skip it', () => {
    expect(soapActionHeaders('1.1', 'urn:a', { skipSoapAction: true }).headers).toEqual({});
  });

  it('honours a custom charset', () => {
    expect(soapActionHeaders('1.1', undefined, { charset: 'ISO-8859-1' }).contentType).toBe(
      'text/xml;charset=ISO-8859-1',
    );
  });
});

describe('soapActionHeaders (SOAP 1.2)', () => {
  it('carries the action as a media-type parameter and sends no SOAPAction header', () => {
    const result = soapActionHeaders('1.2', 'urn:a:Op', {});
    expect(result.contentType).toBe('application/soap+xml;charset=UTF-8;action="urn:a:Op"');
    expect(result.headers).toEqual({});
  });

  it('omits the action parameter when there is no action', () => {
    expect(soapActionHeaders('1.2', undefined, {}).contentType).toBe('application/soap+xml;charset=UTF-8');
    expect(soapActionHeaders('1.2', '', {}).contentType).toBe('application/soap+xml;charset=UTF-8');
  });

  it('omits the action parameter when asked to skip it', () => {
    expect(soapActionHeaders('1.2', 'urn:a:Op', { skipSoapAction: true }).contentType).toBe(
      'application/soap+xml;charset=UTF-8',
    );
  });

  it('defaults its options argument', () => {
    expect(soapActionHeaders('1.2', 'urn:a:Op').contentType).toContain('action="urn:a:Op"');
  });
});
