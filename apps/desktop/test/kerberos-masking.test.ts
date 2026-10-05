// @vitest-environment node
/**
 * SC-K9 on the desktop side: a Negotiate token, sent or received, is masked in History, in a HAR
 * export and in the exchange summary the renderer is shown with show-secrets off.
 */
import { describe, expect, it } from 'vitest';
import { redactExchangeSummary } from '../src/main/engine-wire.js';
import { harOf } from '../src/main/har.js';
import { buildHistoryEntry } from '../src/main/history-service.js';
import type { LogEntryWire, ResolvedSendInputWire } from '../src/shared/wire-types.js';
import { b64, makeExchange } from './mocks/wire-fixtures.js';

const SENT = 'abc123';
const RECEIVED = 'def456';

/** An exchange whose request carried a Negotiate token and whose response carried the server's reply token. */
function negotiateExchange() {
  const base = makeExchange();
  return makeExchange({
    http: {
      ...base.http,
      status: 200,
      headers: { 'content-type': 'text/xml', 'www-authenticate': `Negotiate ${RECEIVED}` },
      rawHeaders: [
        ['content-type', 'text/xml'],
        ['www-authenticate', `Negotiate ${RECEIVED}`],
      ],
      rawRequestBase64: b64(
        `POST /calc HTTP/1.1\r\nHost: example.test\r\nAuthorization: Negotiate ${SENT}\r\n\r\n<request/>`,
      ),
      rawResponseBase64: b64(`HTTP/1.1 200 OK\r\nWWW-Authenticate: Negotiate ${RECEIVED}\r\n\r\n<response/>`),
      request: {
        url: 'https://example.test/calc.asmx',
        method: 'POST',
        headers: { Authorization: `Negotiate ${SENT}` },
      },
    },
  });
}

describe('Negotiate tokens on the desktop side (SC-K9)', () => {
  it('are masked in the History entry', () => {
    const input = {
      endpoint: 'https://example.test/calc.asmx',
      soapVersion: '1.1',
      envelopeXml: '<request/>',
      headers: { Authorization: `Negotiate ${SENT}` },
    } as unknown as ResolvedSendInputWire;
    const entry = buildHistoryEntry('p1', {
      requestName: 'Request 1',
      interfaceName: 'Calc',
      operationName: 'Add',
      input,
      exchange: negotiateExchange(),
      durationMs: 5,
    });

    const text = JSON.stringify(entry);
    expect(text).not.toContain(SENT);
    expect(text).not.toContain(RECEIVED);
  });

  it('are masked in a HAR export', () => {
    const row = { kind: 'exchange', protocol: 'soap', exchange: negotiateExchange() } as unknown as LogEntryWire;
    const text = JSON.stringify(harOf([row], { name: 'Wirebench', version: '0' }));

    expect(text).not.toContain(SENT);
    expect(text).not.toContain(RECEIVED);
  });

  it('are masked in the exchange summary with show-secrets off, and shown with it on', () => {
    const exchange = negotiateExchange();
    const masked = redactExchangeSummary(exchange, { show: false });
    const text = JSON.stringify(masked);
    const raw = [masked.http.rawRequestBase64, masked.http.rawResponseBase64]
      .map((value) => Buffer.from(value, 'base64').toString('latin1'))
      .join('\n');

    expect(text).not.toContain(SENT);
    expect(text).not.toContain(RECEIVED);
    expect(raw).not.toContain(SENT);
    expect(raw).not.toContain(RECEIVED);
    expect(JSON.stringify(redactExchangeSummary(exchange, { show: true }))).toContain(RECEIVED);
  });
});
