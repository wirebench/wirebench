/**
 * The certificate probe (hosted edition spec §23.4) against a local TLS server, with a test CA made in the test: a
 * certificate for the name passes; another name's, an untrusted one, a self-signed one or an expired one is `wrong`;
 * no answer at all is `missing`, within the timeout. No real domain and no real CA: every name is under `.test`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type ServerConfig } from '../../../src/config.js';
import type { ProbeResult } from '../../../src/custom-domains/job.js';
import { certificateProbe, probeFromConfig } from '../../../src/custom-domains/probe.js';
import {
  generateSecondTestCa,
  generateServerCert,
  generateTestCa,
  type TestCertificate,
} from '../../../../engine/test/helpers/test-certs.js';
import { silentListener } from '../../helpers/forward-receivers.js';
import { freePort } from '../../helpers/net.js';

const NAME = 'app.customer.test';
const HOUR = 3_600_000;

let servers: Server[] = [];
let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
  for (const close of closers) await close();
  servers = [];
  closers = [];
});

/** A TLS server on loopback that presents `certificate` for every name. */
async function proxy(certificate: TestCertificate): Promise<number> {
  const server = createServer({ cert: certificate.certPem, key: certificate.keyPem }, (socket) => {
    socket.on('error', () => undefined);
    socket.end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return (server.address() as { port: number }).port;
}

/** A verdict and the words of its message. */
function expectVerdict(result: ProbeResult, verdict: ProbeResult['verdict'], message: RegExp): void {
  expect(result.verdict).toBe(verdict);
  expect(result.message).toMatch(message);
}

describe('the certificate probe', () => {
  const ca = generateTestCa();
  const probeAt = (port: number, roots: { readonly ca: string } | 'system' = { ca: ca.certPem }) =>
    certificateProbe({ host: '127.0.0.1', port, ...(roots !== 'system' ? roots : {}), timeoutMs: 500 });

  it('passes a certificate for the name that the roots trust', async () => {
    const port = await proxy(generateServerCert(ca, { commonName: NAME, sans: [NAME] }));
    expectVerdict(await probeAt(port)(NAME), 'ok', /./);
  });

  it('passes a wildcard that covers the name', async () => {
    const port = await proxy(generateServerCert(ca, { commonName: '*.customer.test', sans: ['*.customer.test'] }));
    expect((await probeAt(port)(NAME)).verdict).toBe('ok');
  });

  it('fails another name’s certificate', async () => {
    const port = await proxy(
      generateServerCert(ca, { commonName: 'other.customer.test', sans: ['other.customer.test'] }),
    );
    expectVerdict(await probeAt(port)(NAME), 'wrong', /does not cover/);
  });

  it('fails a certificate from a CA the roots do not hold, and a self-signed one', async () => {
    const other = generateSecondTestCa();
    const untrusted = await proxy(generateServerCert(other, { commonName: NAME, sans: [NAME] }));
    expect((await probeAt(untrusted)(NAME)).verdict).toBe('wrong');
    const selfSigned = await proxy(other);
    expectVerdict(await probeAt(selfSigned)(NAME), 'wrong', /not trusted/);
  });

  it('fails an expired certificate', async () => {
    const port = await proxy(generateServerCert(ca, { commonName: NAME, sans: [NAME], validityMs: -HOUR / 2 }));
    expectVerdict(await probeAt(port)(NAME), 'wrong', /CERT_HAS_EXPIRED/);
  });

  it('verifies against the system roots when no CA is given, which a test CA is not among', async () => {
    const port = await proxy(generateServerCert(ca, { commonName: NAME, sans: [NAME] }));
    expect((await probeAt(port, 'system')(NAME)).verdict).toBe('wrong');
  });

  it('is missing on a closed port', async () => {
    const port = await freePort();
    expectVerdict(await probeAt(port)(NAME), 'missing', /ECONNREFUSED/);
  });

  it('is missing when the proxy never answers the handshake, within the timeout', async () => {
    const silent = await silentListener();
    closers.push(() => silent.close());
    const started = Date.now();
    expectVerdict(await probeAt(silent.port)(NAME), 'missing', /did not answer/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('sends the name as SNI', async () => {
    const seen: string[] = [];
    const leaf = generateServerCert(ca, { commonName: NAME, sans: [NAME] });
    const server = createServer({
      SNICallback: (servername, done) => {
        seen.push(servername);
        done(null, undefined);
      },
      cert: leaf.certPem,
      key: leaf.keyPem,
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    await probeAt((server.address() as { port: number }).port)(NAME);
    expect(seen).toEqual([NAME]);
  });
});

describe('the probe’s configuration', () => {
  const required = {
    WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.test',
  };
  const problemsOf = (env: Record<string, string>): readonly string[] => {
    try {
      loadConfig({ ...required, ...env }, '0.0.0');
    } catch (error) {
      if (error instanceof ConfigError) return error.problems.map((problem) => problem.variable);
      throw error;
    }
    return [];
  };

  it('reads the proxy’s TLS address and the CA file', () => {
    const config = loadConfig(
      {
        ...required,
        WIREBENCH_SERVER_PROXY_TLS_ADDRESS: 'traefik:443',
        WIREBENCH_SERVER_PROXY_TLS_CA_FILE: '/run/pebble-root.pem',
      },
      '0.0.0',
    );
    expect(config.proxyTlsAddress).toBe('traefik:443');
    expect(config.proxyTlsCaFile).toBe('/run/pebble-root.pem');
    expect(loadConfig(required, '0.0.0').proxyTlsAddress).toBeUndefined();
  });

  it('refuses an address that is not host:port, and a CA file without an address', () => {
    expect(problemsOf({ WIREBENCH_SERVER_PROXY_TLS_ADDRESS: 'https://traefik' })).toEqual([
      'WIREBENCH_SERVER_PROXY_TLS_ADDRESS',
    ]);
    expect(problemsOf({ WIREBENCH_SERVER_PROXY_TLS_CA_FILE: '/ca.pem' })).toEqual([
      'WIREBENCH_SERVER_PROXY_TLS_CA_FILE',
    ]);
  });
});

describe('the probe from the configuration', () => {
  const hosted = (extra: Partial<ServerConfig>) => ({ mode: 'hosted' as const, ...extra });

  it('is none without the TLS address, and none self-hosted', async () => {
    expect(await probeFromConfig(hosted({}))).toBeUndefined();
    expect(await probeFromConfig({ mode: 'self-hosted', proxyTlsAddress: 'traefik:443' })).toBeUndefined();
  });

  it('reads the CA file, and refuses one it cannot read', async () => {
    const ca = generateTestCa();
    const dir = await mkdtemp(join(tmpdir(), 'wb-probe-'));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'ca.pem'), ca.certPem);
    const port = await proxy(generateServerCert(ca, { commonName: NAME, sans: [NAME] }));
    const probe = await probeFromConfig(
      hosted({ proxyTlsAddress: `127.0.0.1:${String(port)}`, proxyTlsCaFile: join(dir, 'ca.pem') }),
    );
    expect((await probe!(NAME)).verdict).toBe('ok');
    await expect(
      probeFromConfig(hosted({ proxyTlsAddress: 'traefik:443', proxyTlsCaFile: join(dir, 'missing.pem') })),
    ).rejects.toThrow(/WIREBENCH_SERVER_PROXY_TLS_CA_FILE cannot be read/);
  });
});
