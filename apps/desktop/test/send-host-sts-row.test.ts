// @vitest-environment node
/**
 * The STS exchange a send makes first, as its own HTTP Log row: marked `sts`, linked to the send by
 * `causedBy`, redacted like any SOAP row (an assertion's signature value is masked), and only when
 * the token service was actually asked — a cached token makes no row.
 */
import { describe, expect, it, vi } from 'vitest';
import { createIssuedTokenSource, createWssContext } from '@wirebench/engine';
import type { HttpExchange, IssuedToken, IssuedTokenTarget, WssIssuedTokenEntry } from '@wirebench/engine';
import type { LogEntryWire } from '../src/shared/wire-types.js';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

const { desktopSendHost } = await import('../src/main/send/host.js');
const { IssuedTokensService } = await import('../src/main/issued-tokens.js');

type DesktopSendDeps = import('../src/main/send/host.js').DesktopSendDeps;
type DesktopSend = import('../src/main/send/host.js').DesktopSend;

const SIGNATURE_VALUE = 'c2lnbmF0dXJlLWJ5LXRoZS10b2tlbi1zZXJ2aWNl';
const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_issued" Version="2.0">' +
  '<saml2:Issuer>urn:sts</saml2:Issuer>' +
  '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">' +
  `<ds:SignatureValue>${SIGNATURE_VALUE}</ds:SignatureValue></ds:Signature></saml2:Assertion>`;
const RSTR =
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>' +
  '<wst:RequestSecurityTokenResponseCollection xmlns:wst="http://docs.oasis-open.org/ws-sx/ws-trust/200512">' +
  `<wst:RequestSecurityTokenResponse><wst:RequestedSecurityToken>${ASSERTION}</wst:RequestedSecurityToken>` +
  '</wst:RequestSecurityTokenResponse></wst:RequestSecurityTokenResponseCollection></s:Body></s:Envelope>';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const fakeExchange: HttpExchange = {
  request: { url: 'https://sts.test/issue', method: 'POST', headers: { 'content-type': 'application/soap+xml' } },
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/soap+xml' },
  rawHeaders: [['content-type', 'application/soap+xml']],
  body: bytes(RSTR),
  rawBody: bytes(RSTR),
  httpVersion: '1.1',
  truncated: false,
  timings: { startedAt: '2026-10-05T10:00:00.000Z', totalMs: 42 },
  rawRequest: bytes('POST /issue HTTP/1.1\r\nhost: sts.test\r\ncontent-type: application/soap+xml\r\n\r\n<rst/>'),
  rawResponse: bytes(`HTTP/1.1 200 OK\r\ncontent-type: application/soap+xml\r\n\r\n${RSTR}`),
  redirects: [],
};

const entry: WssIssuedTokenEntry = {
  kind: 'issued-token',
  stsUrl: 'https://sts.test/issue',
  soapVersion: '1.2',
  trustVersion: '1.3',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
  requestedLifetimeSeconds: 0,
};
const target: IssuedTokenTarget = { endpointUrl: 'https://svc.test/x', expand: (text) => text };
const send: DesktopSend = { sendId: 'send-7', requestId: 'r1', projectId: 'p1' };

function issued(): IssuedToken {
  return {
    assertionXml: ASSERTION,
    samlVersion: '2.0',
    keyType: 'bearer',
    expiresAt: new Date(Date.now() + 3_600_000),
    stsHost: 'sts.test',
    cacheKey: '',
  };
}

async function hostWith(show = false) {
  const rows: LogEntryWire[] = [];
  const asked: HttpExchange[] = [];
  const request = vi.fn(
    (
      _entry: WssIssuedTokenEntry,
      _target: IssuedTokenTarget,
      deps: { onExchange?: (exchange: HttpExchange) => void },
    ) => {
      deps.onExchange?.(fakeExchange);
      return Promise.resolve(issued());
    },
  );
  const issuedTokens = new IssuedTokensService(
    () => Promise.reject(new Error('not used')),
    createIssuedTokenSource({ request }),
  );
  const deps: DesktopSendDeps = {
    project: {} as DesktopSendDeps['project'],
    service: {} as DesktopSendDeps['service'],
    issuedTokens,
    showSecrets: { get: () => show },
    onExchange: (row) => rows.push(row),
  };
  const host = await desktopSendHost(deps, send);
  const trustDeps = { ctx: createWssContext(), onExchange: (exchange: HttpExchange) => asked.push(exchange) };
  return { host, rows, asked, request, trustDeps };
}

const textOf = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');

describe('the STS log row', () => {
  it('writes one row marked sts, caused by the send, with the signature value masked', async () => {
    const { host, rows, trustDeps } = await hostWith();
    await host.issuedTokens!.get(entry, target, trustDeps);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    if (row.kind !== 'exchange' || !('auxiliary' in row.exchange)) throw new Error('not an STS row');
    expect(row.requestId).toBe('r1');
    expect(row.exchange.auxiliary).toBe('sts');
    expect(row.exchange.causedBy).toBe('send-7');
    expect(row.exchange.sendId).not.toBe('send-7');
    expect(row.exchange.durationMs).toBe(42);
    const http = row.exchange.http;
    for (const text of [textOf(http.bodyBase64), textOf(http.rawBodyBase64), textOf(http.rawResponseBase64)]) {
      expect(text).toContain('&lt;redacted&gt;');
      expect(text).not.toContain(SIGNATURE_VALUE);
    }
  });

  it('keeps the signature value with show-secrets on', async () => {
    const { host, rows, trustDeps } = await hostWith(true);
    await host.issuedTokens!.get(entry, target, trustDeps);
    const row = rows[0]!;
    if (row.kind !== 'exchange' || !('http' in row.exchange)) throw new Error('not an exchange row');
    expect(textOf(row.exchange.http.bodyBase64)).toContain(SIGNATURE_VALUE);
  });

  it("still tells the engine's own listener of the exchange", async () => {
    const { host, asked, trustDeps } = await hostWith();
    await host.issuedTokens!.get(entry, target, trustDeps);
    expect(asked).toEqual([fakeExchange]);
  });

  it('makes no row for a cached token', async () => {
    const { host, rows, request, trustDeps } = await hostWith();
    await host.issuedTokens!.get(entry, target, trustDeps);
    await host.issuedTokens!.get(entry, target, trustDeps);
    expect(request).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('lends no issued-token source without the service', async () => {
    const host = await desktopSendHost(
      { project: {} as DesktopSendDeps['project'], service: {} as DesktopSendDeps['service'] },
      send,
    );
    expect(host.issuedTokens).toBeUndefined();
  });
});
