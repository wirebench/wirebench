/**
 * A custom name's certificate, end to end with no real ACME and no real DNS (hosted edition spec §23.4, §23.8):
 * Traefik with the recipe's own HTTP provider and `le-http` resolver flags, Pebble as the ACME server,
 * `pebble-challtestsrv` as Pebble's DNS (it maps the test name to Traefik's container), and the server's real proxy
 * listener, over a fake list of held names, on this machine. A name's router appears, Pebble issues by HTTP-01 through
 * the web entry point and its redirect to https, and the certificate probe sees the name.
 *
 * Traefik's image is the recipe's own, so the test runs what ships. It needs Docker and pulls three images, so it runs
 * only on CI (`CI` set) or with `WIREBENCH_SERVER_PEBBLE=1`, never with `WIREBENCH_SERVER_PEBBLE=0` (which wins on CI
 * too), and skips where Docker does not answer: a plain local `pnpm test` starts no containers. Traefik's version and
 * usage reporting are off, so nothing but the image pulls leaves the machine.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { certificateProbe } from '../../../src/custom-domains/probe.js';
import { buildProxyServer, PROXY_ROUTE, type ProxyTenancy } from '../../../src/custom-domains/proxy.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';

const run = promisify(execFile);
const RECIPE = join(import.meta.dirname, '..', '..', '..', 'deploy', 'hosted', 'compose.yaml');
const PEBBLE = 'ghcr.io/letsencrypt/pebble:2.10.1';
const CHALLTESTSRV = 'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1';
const NAME = 'app.customer.test';
const TOKEN = randomBytes(24).toString('base64url');
const TIMEOUT = 240_000;

const wanted = process.env.WIREBENCH_SERVER_PEBBLE;
async function dockerAnswers(): Promise<boolean> {
  if (wanted === '0' || (wanted !== '1' && (process.env.CI ?? '') === '')) return false;
  try {
    await run('docker', ['compose', 'version'], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
const enabled = await dockerAnswers();

/**
 * The recipe's Traefik: its image, and the flags this test keeps (the entry points, the HTTP provider and the `le-http`
 * resolver).
 */
async function recipeTraefik(endpoint: string): Promise<{ readonly image: string; readonly flags: string[] }> {
  const recipe = parse(await readFile(RECIPE, 'utf8')) as {
    services: { traefik: { image: string; command: string[] } };
  };
  const kept = recipe.services.traefik.command.filter(
    (flag) =>
      flag.startsWith('--entrypoints.') ||
      flag.startsWith('--providers.http.') ||
      flag.startsWith('--certificatesresolvers.le-http.'),
  );
  const flags = kept.map((flag) => {
    const [key] = flag.split('=', 1) as [string];
    switch (key) {
      case '--providers.http.endpoint':
        return `${key}=${endpoint}`;
      case '--providers.http.pollInterval':
        return `${key}=1s`;
      case '--certificatesresolvers.le-http.acme.email':
        return `${key}=operator@site.test`;
      case '--certificatesresolvers.le-http.acme.caserver':
        return `${key}=https://pebble:14000/dir`;
      default:
        if (key.startsWith('--providers.http.headers.')) return flag.replace(/\$\{PROXY_TOKEN[^}]*\}/, TOKEN);
        return flag;
    }
  });
  return { image: recipe.services.traefik.image, flags };
}

/** GETs `path` from Pebble's management interface, which serves Pebble's own test certificate. */
function pebbleManagement(port: number, path: string, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, ca, servername: 'localhost' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`pebble management ${path}: ${String(res.statusCode)}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * `fn`'s answer once it stops throwing: the containers take a moment to listen after `up -d`, and a registry may refuse
 * a pull for a moment (a rate limit's blip on CI).
 */
async function retried<T>(
  fn: () => Promise<T>,
  options: { readonly ms?: number; readonly tries?: number; readonly delayMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.ms ?? 60_000);
  for (let tried = 1; ; tried++) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() >= deadline || tried >= (options.tries ?? Infinity)) throw error;
      await new Promise((done) => setTimeout(done, options.delayMs ?? 500));
    }
  }
}

describe.runIf(enabled)('a custom name’s certificate through Traefik and Pebble (spec §23.4)', () => {
  const project = `wb-pebble-${randomBytes(4).toString('hex')}`;
  let dir: string;
  let stub: FastifyInstance;
  const held: string[] = [];
  const polls: string[] = [];
  const compose = (...args: string[]) =>
    run('docker', ['compose', '-p', project, '-f', join(dir, 'compose.yaml'), ...args], { maxBuffer: 16 << 20 });
  const port = async (service: string, inner: number): Promise<number> => {
    const { stdout } = await compose('port', service, String(inner));
    return Number(stdout.trim().split(':').pop());
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-pebble-'));
    // The proxy listener itself, over a fake list of held names; Traefik reaches it on the Docker host.
    const tenancy: ProxyTenancy = {
      forEachTenant: async (_job, fn) => {
        const scope = { tenantId: 't', slug: 't' } as unknown as TenantScope;
        const tx = { scope, query: () => Promise.resolve({ rows: held.map((host) => ({ host })), rowCount: 1 }) };
        await fn(tx as never, scope);
        return { served: 1, failed: [] };
      },
      reachable: () => Promise.resolve(),
    };
    stub = buildProxyServer({ tenancy, token: TOKEN, log: Fastify({ logger: false }).log, cacheMs: 0 });
    stub.addHook('onResponse', async (request, reply) => {
      polls.push(`${request.url} ${String(reply.statusCode)}`);
    });
    await stub.listen({ host: '0.0.0.0', port: 0 });
    const stubPort = (stub.server.address() as { port: number }).port;
    const traefik = await recipeTraefik(`http://host.docker.internal:${String(stubPort)}${PROXY_ROUTE}`);
    // Each image up to three times, 5 seconds apart: a registry's rate limit blips now and then on CI.
    for (const image of [PEBBLE, CHALLTESTSRV, traefik.image]) {
      await retried(() => run('docker', ['pull', '--quiet', image]), { ms: TIMEOUT, tries: 3, delayMs: 5_000 });
    }

    // Pebble's CA for its own API, which Traefik's ACME client must trust.
    const created = (await run('docker', ['create', PEBBLE])).stdout.trim();
    try {
      await run('docker', ['cp', `${created}:/test/certs/pebble.minica.pem`, join(dir, 'pebble.minica.pem')]);
    } finally {
      await run('docker', ['rm', created]);
    }
    // HTTP-01 on port 80, where Traefik's web entry point listens.
    await writeFile(
      join(dir, 'pebble.json'),
      JSON.stringify({
        pebble: {
          listenAddress: '0.0.0.0:14000',
          managementListenAddress: '0.0.0.0:15000',
          certificate: '/test/certs/localhost/cert.pem',
          privateKey: '/test/certs/localhost/key.pem',
          httpPort: 80,
          tlsPort: 443,
          ocspResponderURL: '',
          externalAccountBindingRequired: false,
        },
      }),
    );
    // What the recipe's file provider defines and the routers name: `wirebench@file` and `hsts@file`.
    await writeFile(
      join(dir, 'dynamic.yaml'),
      [
        'http:',
        '  middlewares:',
        '    hsts:',
        '      headers:',
        '        stsSeconds: 31536000',
        '  services:',
        '    wirebench:',
        '      loadBalancer:',
        '        servers:',
        '          - url: http://127.0.0.1:9',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'compose.yaml'),
      JSON.stringify({
        services: {
          challtestsrv: {
            image: CHALLTESTSRV,
            command: [
              '-defaultIPv4',
              '',
              '-defaultIPv6',
              '',
              '-http01',
              '',
              '-https01',
              '',
              '-tlsalpn01',
              '',
              '-doh',
              '',
            ],
            ports: ['127.0.0.1::8055'],
          },
          pebble: {
            image: PEBBLE,
            command: ['-config', '/config/pebble.json', '-dnsserver', 'challtestsrv:8053'],
            // No random waits before validating, and no deliberately rejected nonces.
            environment: { PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0' },
            volumes: [`${join(dir, 'pebble.json')}:/config/pebble.json:ro`],
            ports: ['127.0.0.1::15000'],
          },
          traefik: {
            image: traefik.image,
            command: [
              '--providers.file.filename=/etc/traefik/dynamic.yaml',
              '--global.checknewversion=false',
              '--global.sendanonymoususage=false',
              '--log.level=DEBUG',
              ...traefik.flags,
            ],
            environment: { LEGO_CA_CERTIFICATES: '/certs/pebble.minica.pem' },
            volumes: [
              `${join(dir, 'dynamic.yaml')}:/etc/traefik/dynamic.yaml:ro`,
              `${join(dir, 'pebble.minica.pem')}:/certs/pebble.minica.pem:ro`,
            ],
            tmpfs: ['/letsencrypt'],
            extra_hosts: ['host.docker.internal:host-gateway'],
            ports: ['127.0.0.1::443'],
          },
        },
      }),
    );
    await retried(() => compose('up', '-d'), { ms: TIMEOUT, tries: 2, delayMs: 5_000 });
  }, TIMEOUT);

  afterAll(async () => {
    if (dir !== undefined) {
      await compose('down', '-v', '--remove-orphans').catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
    await stub?.close();
  }, TIMEOUT);

  it(
    'issues the name by HTTP-01 once its router appears, and the probe then sees it',
    async () => {
      // Pebble's DNS answers the name with Traefik's address on the compose network.
      const { stdout: id } = await compose('ps', '-q', 'traefik');
      const { stdout: ip } = await run('docker', [
        'inspect',
        id.trim(),
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      ]);
      const management = await port('challtestsrv', 8055);
      await retried(async () => {
        const added = await fetch(`http://127.0.0.1:${String(management)}/add-a`, {
          method: 'POST',
          body: JSON.stringify({ host: `${NAME}.`, addresses: [ip.trim()] }),
        });
        if (added.status !== 200) throw new Error(`add-a answered ${String(added.status)}`);
      });

      const probe = certificateProbe({ host: '127.0.0.1', port: await port('traefik', 443), timeoutMs: 2_000 });
      // Before the router: Traefik answers with its own default certificate, which the probe refuses.
      expect((await probe(NAME)).verdict).not.toBe('ok');

      held.push(NAME);
      const minica = await readFile(join(dir, 'pebble.minica.pem'), 'utf8');
      const pebbleManagementPort = await port('pebble', 15000);
      const deadline = Date.now() + 120_000;
      let verdict = '';
      while (Date.now() < deadline) {
        // Pebble makes a new root each run; the probe trusts only it.
        const root = await retried(() => pebbleManagement(pebbleManagementPort, '/roots/0', minica));
        const pebbleProbe = certificateProbe({
          host: '127.0.0.1',
          port: await port('traefik', 443),
          ca: root,
          timeoutMs: 2_000,
        });
        verdict = (await pebbleProbe(NAME)).verdict;
        if (verdict === 'ok') break;
        await new Promise((done) => setTimeout(done, 1_000));
      }
      if (verdict !== 'ok') {
        const { stdout } = await compose('logs', '--no-color', 'traefik', 'pebble');
        throw new Error(`no certificate for ${NAME} within 120 s; probe said ${verdict}\n${stdout.slice(-6000)}`);
      }
      // Traefik polled with the token, and the system roots still refuse Pebble's certificate.
      expect(polls.some((line) => line === `${PROXY_ROUTE} 200`)).toBe(true);
      expect(polls.some((line) => line.endsWith(' 401'))).toBe(false);
      expect((await probe(NAME)).verdict).toBe('wrong');
    },
    TIMEOUT,
  );
});
