import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogDetail, type LogDetailTab } from '../../src/renderer/features/console/log-detail.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import {
  b64,
  logExchange,
  makeExchange,
  makeFailure,
  makeRestExchange,
  makeWsHandshakeEntry,
} from '../mocks/exchange-fixtures.js';

afterEach(() => {
  cleanup();
});

function renderDetail(entry: LogEntry, tab: LogDetailTab = 'headers') {
  const onTabChange = vi.fn();
  render(<LogDetail entry={entry} tab={tab} onTabChange={onTabChange} />);
  return onTabChange;
}

const exchange = logExchange(
  makeExchange({
    http: {
      ...makeExchange().http,
      rawHeaders: [
        ['content-type', 'text/xml'],
        ['set-cookie', '<redacted>'],
      ],
      request: { url: 'https://example.test/calc.asmx', method: 'POST', headers: { SOAPAction: '"Add"' } },
    },
  }),
);
const failure: LogEntry = { kind: 'failure', failure: makeFailure() };

describe('LogDetail tabs', () => {
  it('lists the five tabs in order and reports a click', async () => {
    const onTabChange = renderDetail(exchange);

    const tabs = within(screen.getByRole('tablist', { name: 'Log detail' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Headers', 'Request', 'Response', 'Timing', 'Connection']);
    await userEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    expect(onTabChange).toHaveBeenCalledWith('timing');
  });
});

describe('LogDetail for an exchange', () => {
  it('Headers: request headers and the raw response headers as two tables', () => {
    renderDetail(exchange, 'headers');

    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('SOAPAction');
    const response = screen.getByTestId('log-detail-response-headers');
    expect(within(response).getAllByRole('row')).toHaveLength(2);
    expect(response.textContent).toContain('set-cookie');
  });

  it('Request and Response: the raw bytes', () => {
    renderDetail(exchange, 'request');
    expect(screen.getByLabelText('Raw request').textContent).toContain('POST /calc HTTP/1.1');
    cleanup();
    renderDetail(exchange, 'response');
    expect(screen.getByLabelText('Raw response').textContent).toContain('<AddResult>7</AddResult>');
  });

  it('Response: a binary payload is summarised by size', () => {
    const base = makeExchange();
    renderDetail(
      logExchange(makeExchange({ http: { ...base.http, rawResponseBase64: b64('\u0000\u0001\u0002\u0003') } })),
      'response',
    );
    expect(screen.getByLabelText('Raw response').textContent).toContain('<4 bytes>');
  });

  it('Timing: the bar plus a phase list that says why a phase is n/a', () => {
    renderDetail(exchange, 'timing');

    expect(screen.getByTestId('timings-total').textContent).toBe('total 143 ms');
    const phases = screen.getByTestId('timing-phases');
    expect(phases.textContent).toContain('ttfb 100 ms');
    expect(phases.textContent).toContain('dns n/a');
    expect(phases.textContent).toContain('DNS is not measured');
    expect(phases.textContent).toContain('connect n/a');
    expect(phases.textContent).toContain('keep-alive');
  });

  it('Connection: redirect hops and the TLS peer, from the shared http projection', () => {
    const base = makeRestExchange();
    const rest = logExchange(
      makeRestExchange({
        methodChanged: true,
        http: {
          ...base.http,
          redirects: [{ url: 'https://api.test/old', status: 301 }],
          tls: { protocol: 'TLSv1.3', authorized: true, servername: 'api.test', peerChain: [] },
        },
      }),
    );
    renderDetail(rest, 'connection');

    const connection = screen.getByTestId('log-detail-connection');
    expect(within(connection).getAllByTestId('rest-redirect-row')).toHaveLength(1);
    expect(connection.textContent).toContain('a redirect changed the method');
    expect(within(connection).getByTestId('ssl-authorized').textContent).toContain('Trusted');
  });

  it('Connection: a plain-HTTP SOAP exchange says so and shows no method-change note', () => {
    renderDetail(exchange, 'connection');

    const connection = screen.getByTestId('log-detail-connection');
    expect(connection.textContent).toContain('This request was not redirected.');
    expect(connection.textContent).toContain('No TLS — plain HTTP');
    expect(connection.textContent).not.toContain('Arrived as');
  });
});

describe('LogDetail for a WebSocket handshake', () => {
  const handshake = makeWsHandshakeEntry({
    requestHeaders: { Authorization: '<redacted>' },
    responseHeaders: { 'sec-websocket-accept': 'abc123=' },
  });

  it('Headers: request and response headers, from the handshake itself', () => {
    renderDetail(handshake, 'headers');

    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('Authorization');
    const response = screen.getByTestId('log-detail-response-headers');
    expect(response.textContent).toContain('sec-websocket-accept');
  });

  it('Request/Response/Timing/Connection: a note pointing at the WebSocket pane, not the raw-bytes views', () => {
    for (const tab of ['request', 'response', 'timing', 'connection'] as const) {
      renderDetail(handshake, tab);
      expect(screen.getByText(/Only the handshake is logged here/)).toBeDefined();
      cleanup();
    }
  });
});

describe('LogDetail for a failure', () => {
  it('Headers: the request headers, and a note that they are redacted for good', () => {
    renderDetail(failure, 'headers');

    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('X-Trace');
    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('<redacted>');
    expect(screen.queryByTestId('log-detail-response-headers')).toBeNull();
    expect(screen.getByTestId('log-detail-redaction-note').textContent).toMatch(/redacted/);
  });

  it('Request: says the raw request was not captured', () => {
    renderDetail(failure, 'request');
    expect(screen.getByText('Raw request was not captured for a failed send.')).toBeDefined();
  });

  it('Request: the raw request as sent, when the failure row carries one', () => {
    const raw = 'GET /nope?page=2 HTTP/1.1\r\nhost: 127.0.0.1:1\r\nauthorization: <redacted>\r\n\r\n';
    renderDetail({ kind: 'failure', failure: makeFailure({ rawRequestBase64: b64(raw) }) }, 'request');

    expect(screen.getByLabelText('Raw request').textContent).toContain('GET /nope?page=2 HTTP/1.1');
    expect(screen.queryByText('Raw request was not captured for a failed send.')).toBeNull();
  });

  it('Headers: no redaction note when nothing was redacted', () => {
    renderDetail(
      {
        kind: 'failure',
        failure: makeFailure({
          request: { url: 'http://127.0.0.1:1/nope', method: 'GET', headers: { 'X-Trace': 'abc' } },
        }),
      },
      'headers',
    );
    expect(screen.queryByTestId('log-detail-redaction-note')).toBeNull();
  });

  it('Headers: the redaction note when only the URL was redacted', () => {
    renderDetail(
      {
        kind: 'failure',
        failure: makeFailure({
          request: { url: 'http://127.0.0.1:1/nope?token=%3Credacted%3E', method: 'GET', headers: {} },
        }),
      },
      'headers',
    );
    expect(screen.getByTestId('log-detail-redaction-note')).toBeDefined();
  });

  it('Response: the error code and message, prominently', () => {
    renderDetail(failure, 'response');

    const error = screen.getByTestId('log-detail-error');
    expect(error.textContent).toContain('connection-refused');
    expect(error.textContent).toContain('Connection refused.');
  });

  it('Timing: the total only', () => {
    renderDetail(failure, 'timing');

    expect(screen.getByTestId('timings-total').textContent).toBe('total 3.0 ms');
    expect(screen.queryByTestId('timing-phases')).toBeNull();
  });

  it('Connection: URL and method, plus the peer subject a TLS message carries', () => {
    const tls: LogEntry = {
      kind: 'failure',
      failure: makeFailure({
        request: { url: 'https://self-signed.test/', method: 'GET', headers: {} },
        error: {
          code: 'tls-untrusted',
          message:
            'The server certificate for CN=self-signed.test is not trusted. Add its CA to the CA bundle, or turn on "Trust invalid certificates" for this endpoint.',
        },
      }),
    };
    renderDetail(tls, 'connection');

    const connection = screen.getByTestId('log-detail-connection');
    expect(connection.textContent).toContain('https://self-signed.test/');
    expect(connection.textContent).toContain('GET');
    expect(screen.getByTestId('log-detail-peer').textContent).toContain('CN=self-signed.test');

    cleanup();
    renderDetail(failure, 'connection');
    expect(screen.queryByTestId('log-detail-peer')).toBeNull();
  });
});

describe('LogDetail for a prepare-stage failure', () => {
  it('Response: says the request never went on the wire, and keeps the code', () => {
    renderDetail({ kind: 'failure', failure: makeFailure({ stage: 'prepare' }) }, 'response');
    const error = screen.getByTestId('log-detail-error').textContent;
    expect(error).toMatch(/never went on the wire/);
    expect(error).toContain('connection-refused');
  });

  it('Response: a send-stage failure carries no such note', () => {
    renderDetail(failure, 'response');
    expect(screen.getByTestId('log-detail-error').textContent).not.toMatch(/never went on the wire/);
  });

  it('the Timing tab says the connection was reused when connect and TLS are both absent', () => {
    const e = makeRestExchange();
    const entry = logExchange({
      ...e,
      http: { ...e.http, timings: { startedAt: e.http.timings.startedAt, totalMs: 12, ttfbMs: 10, downloadMs: 2 } },
    });
    renderDetail(entry, 'timing');
    expect(screen.getByText('Connection reused — no connect or TLS phase')).toBeDefined();
  });

  it('does not say so when a connect phase was measured', () => {
    const e = makeRestExchange();
    const entry = logExchange({ ...e, http: { ...e.http, timings: { ...e.http.timings, connectMs: 4 } } });
    renderDetail(entry, 'timing');
    expect(screen.queryByText(/Connection reused/)).toBeNull();
  });
});
