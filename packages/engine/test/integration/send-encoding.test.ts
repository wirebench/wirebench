import { afterEach, describe, expect, it } from 'vitest';
import { sendSoapRequest } from '../../src/send.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-soap-server.js';

describe('sendSoapRequest — request body encoding', () => {
  let server: TestSoapServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("encodes the body as ISO-8859-1 (mapped to Node's latin1) instead of throwing unsupported-encoding", async () => {
    server = await startTestSoapServer();
    // "é" is outside ASCII but representable in ISO-8859-1/latin1 as a single byte (0xE9).
    const text = '<a>café</a>';

    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: text,
      soapVersion: '1.1',
      encoding: 'ISO-8859-1',
    });

    expect(exchange.http.status).toBe(200);
    const recorded = server.requests.at(-1);
    expect(recorded?.body).toEqual(Buffer.from(text, 'latin1'));
  });
});
