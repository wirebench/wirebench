import { afterEach, describe, expect, it } from 'vitest';
import { sendSoapRequest } from '../../../src/send.js';
import { DEFAULT_WSA_CONFIG } from '../../../src/wsa/model.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

const ENVELOPE = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><ping/></soapenv:Body></soapenv:Envelope>`;

describe('send — token authentication', () => {
  let server: TestSoapServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('sends a Bearer token in the Authorization header', async () => {
    server = await startTestSoapServer();
    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      auth: { type: 'bearer', token: 't' },
    });

    expect(exchange.http.status).toBe(200);
    expect(server.requests[0]?.headers.authorization).toBe('Bearer t');
    expect(exchange.auth).toBeUndefined();
  });

  it('puts a query API key on the wire but not in wsa:To', async () => {
    server = await startTestSoapServer();
    const endpoint = `${server.url}/soap`;
    await sendSoapRequest({
      endpoint,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      auth: { type: 'api-key', name: 'key', value: 'k', in: 'query' },
      wsa: { config: { ...DEFAULT_WSA_CONFIG, enabled: true }, defaultAction: 'urn:ping' },
    });

    const recorded = server.requests[0]!;
    expect(recorded.url).toBe('/soap?key=k');
    const sent = recorded.body.toString('utf-8');
    expect(sent).toContain(`>${endpoint}</`);
    expect(sent).not.toContain('key=k');
  });
});
