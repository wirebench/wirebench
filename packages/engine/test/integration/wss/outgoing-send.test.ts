/**
 * WS-Security's contract with the send pipeline: the header must be inside the envelope that
 * actually goes on the wire, which the echoing test server proves by sending it back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { sendSoapRequest } from '../../../src/send.js';
import { createWssContext } from '../../../src/wss/model.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

const servers: TestSoapServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

describe('sendSoapRequest with WS-Security', () => {
  it('sends the Security header inside the envelope', async () => {
    const server = await startTestSoapServer();
    servers.push(server);

    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      wss: {
        outgoing: {
          id: 'w1',
          name: 'Outgoing',
          mustUnderstand: true,
          entries: [
            { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
            {
              kind: 'username-token',
              username: 'bob',
              passwordRef: 'secret:pw',
              passwordType: 'digest',
              addNonce: true,
              addCreated: true,
            },
          ],
        },
        ctx: createWssContext({ secrets: () => Promise.resolve('hunter2') }),
      },
    });

    const echoed = exchange.response?.envelopeXml ?? '';
    expect(echoed).toContain('wsse:Security');
    expect(echoed).toContain('wsu:Timestamp');
    expect(echoed).toContain('#PasswordDigest');
    expect(echoed).not.toContain('hunter2');
    expect(exchange.wss).toEqual({ applied: ['timestamp', 'username-token'] });
  });

  it('leaves the envelope alone without an outgoing configuration', async () => {
    const server = await startTestSoapServer();
    servers.push(server);
    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      wss: { ctx: createWssContext() },
    });
    expect(exchange.response?.envelopeXml).toBe(ENVELOPE);
    expect(exchange.wss).toBeUndefined();
  });
});
