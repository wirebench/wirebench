import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendSoapRequest } from '../../src/send.js';
import { DEFAULT_WSA_CONFIG } from '../../src/wsa/model.js';
import type { SoapSendInput } from '../../src/types.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-soap-server.js';

let server: TestSoapServer;

const ENVELOPE = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><tem:Add xmlns:tem="http://tempuri.org/"/></soapenv:Body></soapenv:Envelope>`;

function input(wsa: SoapSendInput['wsa']): SoapSendInput {
  return {
    endpoint: `${server.url}/soap`,
    envelopeXml: ENVELOPE,
    soapVersion: '1.1',
    soapAction: 'http://tempuri.org/Add',
    ...(wsa !== undefined ? { wsa } : {}),
  };
}

beforeAll(async () => {
  server = await startTestSoapServer({ fixture: 'ws-addressing' });
});

afterAll(async () => {
  await server.close();
});

describe('WS-Addressing on a real send', () => {
  it('puts the headers on the wire and reports what it sent', async () => {
    const exchange = await sendSoapRequest(
      input({ config: { ...DEFAULT_WSA_CONFIG, enabled: true }, defaultAction: 'urn:default' }),
    );
    const sent = server.requests.at(-1)?.body.toString('utf-8') ?? '';
    expect(sent).toContain('<wsa:Action');
    expect(sent).toContain('http://tempuri.org/Add');
    expect(sent).toContain(`<wsa:To xmlns:wsa="http://www.w3.org/2005/08/addressing">${server.url}/soap</wsa:To>`);
    expect(sent).toMatch(/<wsa:MessageID[^>]*>urn:uuid:/);
    expect(exchange.wsa?.action).toBe('http://tempuri.org/Add');
    expect(exchange.wsa?.messageId).toMatch(/^urn:uuid:/);
  });

  it('mints a different MessageID on every send', async () => {
    const first = await sendSoapRequest(
      input({ config: { ...DEFAULT_WSA_CONFIG, enabled: true }, defaultAction: 'urn:default' }),
    );
    const second = await sendSoapRequest(
      input({ config: { ...DEFAULT_WSA_CONFIG, enabled: true }, defaultAction: 'urn:default' }),
    );
    expect(first.wsa?.messageId).not.toBe(second.wsa?.messageId);
  });

  it('reuses a fixed MessageID across sends', async () => {
    const fixed = { config: { ...DEFAULT_WSA_CONFIG, enabled: true, messageId: 'urn:uuid:fixed' }, defaultAction: 'x' };
    const first = await sendSoapRequest(input(fixed));
    const second = await sendSoapRequest(input(fixed));
    expect(first.wsa?.messageId).toBe('urn:uuid:fixed');
    expect(second.wsa?.messageId).toBe('urn:uuid:fixed');
  });

  it('writes nothing, and reports nothing, when the configuration is disabled', async () => {
    const exchange = await sendSoapRequest(input({ config: DEFAULT_WSA_CONFIG, defaultAction: 'urn:default' }));
    expect(server.requests.at(-1)?.body.toString('utf-8')).not.toContain('wsa:');
    expect(exchange.wsa).toBeUndefined();
  });

  it('serves the ws-addressing crafted fixture as its WSDL', async () => {
    const response = await fetch(server.wsdlUrl);
    expect(await response.text()).toContain('wsaw:UsingAddressing');
  });
});
