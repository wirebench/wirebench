import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCertificateCheck,
  certificateCheckSummary,
  certificateMessage,
  checkCertificateExpiry,
  subscribeToCertificateExpiry,
} from '../../src/renderer/state/certificate-expiry.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { CertificateFindingWire, CertificatesCheckResponse } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

function finding(overrides: Partial<CertificateFindingWire>): CertificateFindingWire {
  return {
    source: 'keystore',
    projectId: 'p1',
    where: 'Client › client',
    subject: 'CN=client',
    validTo: '2026-10-17T12:00:00.000Z',
    status: 'expiring',
    daysLeft: 10,
    ...overrides,
  };
}

function response(overrides: Partial<CertificatesCheckResponse>): CertificatesCheckResponse {
  return { warnDays: 30, certificates: [], skipped: [], untrusted: [], probedEndpoints: false, ...overrides };
}

describe('certificate expiry problems', () => {
  beforeEach(() => {
    useProblemsStore.setState({ items: [] });
  });

  it('words a finding by how long it has left, or how long ago it ran out', () => {
    expect(certificateMessage(finding({}))).toBe('Certificate CN=client expires in 10 days (2026-10-17).');
    expect(certificateMessage(finding({ daysLeft: 1 }))).toContain('expires in 1 day ');
    expect(certificateMessage(finding({ status: 'expired', daysLeft: -3, validTo: '2026-10-04T00:00:00.000Z' }))).toBe(
      'Certificate CN=client expired 3 days ago (2026-10-04).',
    );
    expect(certificateMessage(finding({ status: 'expired', daysLeft: 0 }))).toContain('expired today');
  });

  it('reports expired certificates as errors and expiring ones as warnings, leaving fine ones out', () => {
    applyCertificateCheck(
      response({
        certificates: [
          finding({}),
          finding({ where: 'Old › old', status: 'expired', daysLeft: -1 }),
          finding({ where: 'Fine › fine', status: 'ok', daysLeft: 300 }),
        ],
      }),
    );

    const items = useProblemsStore.getState().items;
    expect(items.map((item) => [item.source, item.severity, item.problem.location, item.problem.source])).toEqual([
      ['certificate', 'warning', 'Client › client', 'keystore'],
      ['certificate', 'error', 'Old › old', 'keystore'],
    ]);
  });

  it('reports an endpoint whose chain does not verify as an error, naming an expired one plainly', () => {
    applyCertificateCheck(
      response({
        probedEndpoints: true,
        untrusted: [
          { where: 'old.example:443', code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' },
          { where: 'self.example:443', code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed' },
        ],
      }),
    );

    expect(
      useProblemsStore.getState().items.map((item) => [item.severity, item.problem.source, item.problem.message]),
    ).toEqual([
      ['error', 'endpoint', 'The certificate old.example:443 presents has expired.'],
      ['error', 'endpoint', 'The certificate self.example:443 presents does not verify (SELF_SIGNED_CERT_IN_CHAIN).'],
    ]);
    // A local re-check keeps them: only a probe can say they are fixed.
    applyCertificateCheck(response({}));
    expect(useProblemsStore.getState().items).toHaveLength(2);
  });

  it('keeps the last endpoint findings through a local re-check, and replaces them on the next probe', () => {
    useProblemsStore.getState().add([
      {
        groupId: 'other',
        source: 'send',
        severity: 'error',
        problem: { code: 'x', message: 'unrelated' },
      },
    ]);
    applyCertificateCheck(
      response({
        probedEndpoints: true,
        certificates: [finding({ source: 'endpoint', where: 'api.example:443' }), finding({})],
      }),
    );

    applyCertificateCheck(response({ certificates: [] }));
    expect(useProblemsStore.getState().items.map((item) => item.problem.location ?? item.problem.message)).toEqual([
      'unrelated',
      'api.example:443',
    ]);

    applyCertificateCheck(response({ probedEndpoints: true, certificates: [] }));
    expect(useProblemsStore.getState().items.map((item) => item.problem.message)).toEqual(['unrelated']);
  });

  it('sums a check up, naming what could not be checked', () => {
    expect(certificateCheckSummary(response({}))).toBe('No certificate expires within 30 days.');
    expect(
      certificateCheckSummary(
        response({
          certificates: [finding({}), finding({ status: 'expired', daysLeft: -1 })],
          skipped: [{ source: 'endpoint', where: 'down.example:443', message: 'ECONNREFUSED' }],
          untrusted: [{ where: 'old.example:443', code: 'CERT_HAS_EXPIRED', message: 'expired' }],
        }),
      ),
    ).toBe(
      '1 certificate expired, 1 certificate expiring within 30 days, 1 endpoint not verifying. ' +
        'Could not check 1 item: down.example:443.',
    );
  });
});

describe('the automatic check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useProblemsStore.setState({ items: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads keystores only, once at the start and again after the projects change', async () => {
    const check = vi.fn().mockResolvedValue({
      ok: true,
      value: response({ certificates: [finding({})] }),
    });
    installWirebenchApi({ certificates: { check } });

    const off = subscribeToCertificateExpiry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenLastCalledWith({ probeEndpoints: false });
    expect(useProblemsStore.getState().items).toHaveLength(1);

    useProjectStore.setState({ keystores: [] });
    const { preferences } = usePreferencesStore.getState();
    usePreferencesStore.setState({
      preferences: { ...preferences, ssl: { ...preferences.ssl, expiryWarningDays: 7 } },
    });
    await vi.advanceTimersByTimeAsync(1000);
    // Both changes inside one debounce window: one check.
    expect(check).toHaveBeenCalledTimes(2);

    off();
    usePreferencesStore.setState({ preferences });
  });

  it('stays quiet when a background check fails', async () => {
    installWirebenchApi({
      certificates: { check: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'boom' } }) },
    });

    expect(await checkCertificateExpiry(false)).toBeUndefined();
    expect(useProblemsStore.getState().items).toEqual([]);
  });
});
