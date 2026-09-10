import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_PROPERTIES } from '../../src/project/model.js';
import { mergePreferences } from '../../src/project/preferences.js';
import { toSendInput } from '../../src/send-options.js';
import { sendSoapRequest } from '../../src/send.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-soap-server.js';

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ping/></soapenv:Body></soapenv:Envelope>';

describe('request-body compression', () => {
  let server: TestSoapServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('gzips the body, announces it, and the server reads the original envelope back', async () => {
    server = await startTestSoapServer();
    const input = toSendInput({
      request: { properties: DEFAULT_REQUEST_PROPERTIES, soapVersion: '1.1', headers: [], envelopeXml: ENVELOPE },
      endpoint: `${server.url}/soap`,
      preferences: mergePreferences({ http: { requestCompression: 'gzip' } }),
    });
    expect(input.compressBody).toBe('gzip');

    await sendSoapRequest(input);

    const recorded = server.requests.at(-1);
    expect(recorded?.headers['content-encoding']).toBe('gzip');
    expect(recorded?.headers['user-agent']).toBe('Wirebench/0.1');
    expect(recorded?.headers['accept-encoding']).toBe('gzip, deflate');
    // The helper gunzips what it received, so this asserts the compressed bytes were valid.
    expect(recorded?.body.toString('utf-8')).toBe(ENVELOPE);
  });

  it('sends the body uncompressed by default', async () => {
    server = await startTestSoapServer();
    const input = toSendInput({
      request: { properties: DEFAULT_REQUEST_PROPERTIES, soapVersion: '1.1', headers: [], envelopeXml: ENVELOPE },
      endpoint: `${server.url}/soap`,
    });
    await sendSoapRequest(input);

    const recorded = server.requests.at(-1);
    expect(recorded?.headers['content-encoding']).toBeUndefined();
    expect(recorded?.body.toString('utf-8')).toBe(ENVELOPE);
  });
});
