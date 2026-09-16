import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SslInspector } from '../../src/renderer/features/request-editor/inspectors/ssl-inspector.js';
import { makeExchange } from '../mocks/exchange-fixtures.js';
import type { ExchangeSummary, SslInfoWire } from '../../src/shared/wire-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function tlsInfo(overrides: Partial<SslInfoWire> = {}): SslInfoWire {
  return {
    protocol: 'TLSv1.3',
    cipher: 'TLS_AES_256_GCM_SHA384',
    authorized: true,
    servername: 'example.test',
    alpn: 'http/1.1',
    peerChain: [
      {
        subject: 'CN=example.test, O=Example',
        issuer: 'CN=Example CA',
        validFrom: new Date(Date.now() - DAY_MS).toISOString(),
        validTo: new Date(Date.now() + 10 * DAY_MS).toISOString(),
        serialNumber: '01',
        sans: ['example.test', '127.0.0.1'],
        fingerprint256: 'ab'.repeat(32),
      },
      {
        subject: 'CN=Example CA',
        issuer: 'CN=Example CA',
        validFrom: new Date(Date.now() - DAY_MS).toISOString(),
        validTo: new Date(Date.now() + 100 * DAY_MS).toISOString(),
        sans: [],
        fingerprint256: 'cd'.repeat(32),
        isCA: true,
      },
    ],
    ...overrides,
  };
}

function withTls(tls?: SslInfoWire): ExchangeSummary {
  const base = makeExchange();
  return makeExchange({ http: { ...base.http, ...(tls !== undefined ? { tls } : {}) } });
}

function renderInspector(exchange?: ExchangeSummary): void {
  render(<SslInspector http={exchange?.http} />);
}

describe('SslInspector', () => {
  afterEach(() => {
    cleanup();
  });

  it('invites a send before the first exchange', () => {
    renderInspector(undefined);
    expect(screen.getByText(/No exchange yet/i)).toBeDefined();
  });

  it('says so when the exchange was plain HTTP', () => {
    renderInspector(withTls(undefined));
    expect(screen.getByText(/No TLS — plain HTTP/i)).toBeDefined();
  });

  it('shows the negotiated protocol, cipher, ALPN and SNI', () => {
    renderInspector(withTls(tlsInfo()));

    expect(screen.getByText('TLSv1.3')).toBeDefined();
    expect(screen.getByText('TLS_AES_256_GCM_SHA384')).toBeDefined();
    expect(screen.getByText('http/1.1')).toBeDefined();
    expect(screen.getByText('example.test')).toBeDefined();
  });

  it('marks a verified chain trusted and an unverified one, with its reason, not', () => {
    renderInspector(withTls(tlsInfo()));
    expect(screen.getByTestId('ssl-authorized').textContent).toContain('Trusted');
    cleanup();

    renderInspector(withTls(tlsInfo({ authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' })));
    expect(screen.getByTestId('ssl-authorized').textContent).toContain('Not trusted');
    expect(screen.getByText('SELF_SIGNED_CERT_IN_CHAIN')).toBeDefined();
  });

  it('renders one card per chain certificate, leaf first', () => {
    renderInspector(withTls(tlsInfo()));

    const cards = screen.getAllByTestId('ssl-cert-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('CN=example.test, O=Example');
    expect(cards[1]?.textContent).toContain('CN=Example CA');
  });

  it('counts the days until a certificate expires', () => {
    renderInspector(withTls(tlsInfo()));
    expect(screen.getByText(/expires in 10 days/i)).toBeDefined();
  });

  it('badges an already-expired certificate', () => {
    const info = tlsInfo();
    const leaf = info.peerChain[0]!;
    renderInspector(
      withTls({ ...info, peerChain: [{ ...leaf, validTo: new Date(Date.now() - DAY_MS).toISOString() }] }),
    );

    expect(screen.getByText(/expired/i)).toBeDefined();
  });

  it('lists the SANs and copies the fingerprint', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderInspector(withTls(tlsInfo()));

    expect(screen.getByText(/example\.test, 127\.0\.0\.1/)).toBeDefined();

    await userEvent.click(screen.getAllByRole('button', { name: /Copy fingerprint/ })[0]!);
    expect(writeText).toHaveBeenCalledWith('ab'.repeat(32));
  });
});
