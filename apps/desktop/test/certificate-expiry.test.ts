// @vitest-environment node
/**
 * The workspace certificate check's judging and probing order, with a stubbed probe: what is a
 * warning, what is skipped, and that an endpoint is reached once however many projects name it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProject, type PropertyScopes, type SslInfo } from '@wirebench/engine';
import {
  checkCertificates,
  endpointCandidates,
  resolveEndpointTargets,
  type CertificateCheckInput,
  type EndpointTarget,
} from '../src/main/certificate-expiry.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const inDays = (days: number): string => new Date(NOW + days * DAY).toISOString();

function chain(...validTo: string[]): SslInfo {
  return {
    peerChain: validTo.map((date, index) => ({
      subject: `CN=cert-${String(index)}`,
      issuer: 'CN=issuer',
      validFrom: inDays(-365),
      validTo: date,
      sans: [],
      fingerprint256: String(index).padStart(64, '0'),
    })),
  };
}

const target = (host: string, port = 443): EndpointTarget => ({ host, port, url: `https://${host}:${String(port)}/` });

function input(overrides: Partial<CertificateCheckInput>): CertificateCheckInput {
  return {
    sources: [],
    caBundle: [],
    warnDays: 30,
    probeEndpoints: true,
    probe: () => Promise.reject(new Error('not expected')),
    now: NOW,
    ...overrides,
  };
}

describe('endpointCandidates', () => {
  it('collects every place a project names an endpoint, leaving plaintext gRPC out', () => {
    const base = createProject('Demo');
    const project = {
      ...base,
      interfaces: [{ endpoints: [{ url: 'https://soap.example/svc' }] }],
      environments: [{ endpoints: { calc: 'https://soap.dev.example/svc' } }],
      apis: [
        {
          baseUrl: '${base}',
          servers: [{ url: 'https://servers.example' }],
          folders: [{ folders: [], requests: [{ url: 'https://absolute.example/x' }] }],
          requests: [{ url: '/relative' }],
        },
      ],
      grpcApis: [
        { target: 'grpc.example:443', tls: true },
        { target: 'localhost:50051', tls: false },
        { target: 'https://grpc-url.example', tls: false },
      ],
      wsApis: [{ url: 'wss://ws.example/feed', folders: [], requests: [{ url: '/sub' }] }],
    } as unknown as Parameters<typeof endpointCandidates>[0];

    expect(endpointCandidates(project, ['https://workspace.example', 'https://soap.example/svc'])).toEqual([
      'https://soap.example/svc',
      'https://soap.dev.example/svc',
      '${base}',
      'https://servers.example',
      'https://absolute.example/x',
      'grpcs://grpc.example:443',
      'https://grpc-url.example',
      'wss://ws.example/feed',
      'https://workspace.example',
    ]);
  });
});

describe('resolveEndpointTargets', () => {
  const scopes = (properties: Record<string, string>): PropertyScopes => ({
    project: properties,
    global: {},
    system: {},
  });

  it('expands under every environment, keeping one target per host and port', () => {
    const targets = resolveEndpointTargets(
      ['${base}/svc', 'https://a.example/other', 'http://plain.example', '${missing}/x'],
      [scopes({ base: 'https://a.example' }), scopes({ base: 'https://b.example:8443' })],
    );

    expect(targets).toEqual([
      { host: 'a.example', port: 443, url: 'https://a.example/svc' },
      { host: 'b.example', port: 8443, url: 'https://b.example:8443/svc' },
    ]);
  });
});

describe('checkCertificates', () => {
  it('judges keystores and the CA bundle without touching the network unless asked', async () => {
    const probe = vi.fn();
    const result = await checkCertificates(
      input({
        probeEndpoints: false,
        probe,
        caBundle: [{ subject: 'CN=corp root', issuer: 'CN=corp root', validTo: inDays(400), fingerprint256: 'a' }],
        sources: [
          {
            projectId: 'p1',
            endpoints: [target('a.example')],
            keystores: [
              {
                name: 'Client',
                certificates: [
                  { alias: 'client', subject: 'CN=client', issuer: 'CN=ca', validTo: inDays(10), fingerprint256: 'b' },
                ],
              },
              { name: 'Broken', error: 'The keystore password is wrong.' },
            ],
          },
        ],
      }),
    );

    expect(probe).not.toHaveBeenCalled();
    expect(result.probedEndpoints).toBe(false);
    expect(result.certificates).toEqual([
      expect.objectContaining({ source: 'ca-bundle', where: 'CA bundle', status: 'ok', daysLeft: 400 }),
      expect.objectContaining({
        source: 'keystore',
        projectId: 'p1',
        where: 'Client › client',
        status: 'expiring',
        daysLeft: 10,
      }),
    ]);
    expect(result.skipped).toEqual([
      { source: 'keystore', projectId: 'p1', where: 'Broken', message: 'The keystore password is wrong.' },
    ]);
  });

  it('probes each endpoint once, judges its whole chain, and reports one that does not answer', async () => {
    const probe = vi.fn((_projectId: string, endpoint: EndpointTarget) =>
      endpoint.host === 'down.example'
        ? Promise.reject(new Error('connect ECONNREFUSED'))
        : Promise.resolve(chain(inDays(-2), inDays(5000))),
    );
    const result = await checkCertificates(
      input({
        probe,
        sources: [
          { projectId: 'p1', endpoints: [target('a.example'), target('down.example')], keystores: [] },
          { projectId: 'p2', endpoints: [target('A.example')], keystores: [] },
        ],
      }),
    );

    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.certificates).toEqual([
      expect.objectContaining({ source: 'endpoint', projectId: 'p1', where: 'a.example:443', status: 'expired' }),
      expect.objectContaining({ source: 'endpoint', projectId: 'p1', where: 'a.example:443', status: 'ok' }),
    ]);
    expect(result.skipped).toEqual([
      { source: 'endpoint', projectId: 'p1', where: 'down.example:443', message: 'connect ECONNREFUSED' },
    ]);
  });

  it('reports an endpoint whose chain does not verify as untrusted, with the reason', async () => {
    const expired = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
    const result = await checkCertificates(
      input({
        probe: () => Promise.reject(expired),
        sources: [{ projectId: 'p1', endpoints: [target('old.example')], keystores: [] }],
      }),
    );

    expect(result.untrusted).toEqual([
      { projectId: 'p1', where: 'old.example:443', code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.certificates).toEqual([]);
  });

  it('keeps at most `concurrency` handshakes in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const probe = async (): Promise<SslInfo> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return chain(inDays(100));
    };
    const endpoints = Array.from({ length: 9 }, (_, index) => target(`h${String(index)}.example`));

    const result = await checkCertificates(
      input({ probe, concurrency: 3, sources: [{ projectId: 'p', endpoints, keystores: [] }] }),
    );

    expect(peak).toBe(3);
    expect(result.certificates.map((cert) => cert.where)).toEqual(endpoints.map((e) => `${e.host}:443`));
  });

  it('names an IPv6 endpoint in brackets', async () => {
    const result = await checkCertificates(
      input({
        probe: () => Promise.resolve(chain(inDays(1))),
        sources: [
          { projectId: 'p', endpoints: [{ host: '::1', port: 8443, url: 'https://[::1]:8443/' }], keystores: [] },
        ],
      }),
    );

    expect(result.certificates[0]?.where).toBe('[::1]:8443');
  });
});
