/**
 * The hosted deployment recipe (hosted edition spec §21.5, ADR-0038): Traefik in front with one certificate for the
 * apex and the wildcard by DNS-01 at Hetzner, the server and PostgreSQL behind it with no published port; and, for
 * custom domains (§23.4), Traefik's HTTP provider polling the server's internal proxy listener and a second resolver
 * issuing by HTTP-01. Issuance itself needs a real domain, so it is a manual test
 * (`docs/manual-tests/2026-11-03-wildcard-certificate.md`, `2026-11-04-custom-domain.md`; the custom domain's flow also
 * runs against Pebble in `test/integration/custom-domains/pebble.test.ts`); this checks the files say what the spec
 * says.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const DIR = join(import.meta.dirname, '..', '..', 'deploy', 'hosted');
const run = promisify(execFile);

interface Service {
  readonly image: string;
  readonly command?: readonly string[];
  readonly environment?: Record<string, string>;
  readonly ports?: readonly string[];
  readonly secrets?: readonly string[];
}

interface Secret {
  readonly file?: string;
  readonly environment?: string;
}

async function compose(): Promise<{ services: Record<string, Service>; secrets: Record<string, Secret> }> {
  return parse(await readFile(join(DIR, 'compose.yaml'), 'utf8')) as never;
}

interface Router {
  readonly rule: string;
  readonly entryPoints: readonly string[];
  readonly tls: { readonly certResolver: string; readonly domains: readonly { main: string; sans: string[] }[] };
}

async function router(): Promise<Router> {
  const dynamic = parse(await readFile(join(DIR, 'dynamic.yaml'), 'utf8')) as {
    http: { routers: Record<string, Router> };
  };
  return dynamic.http.routers['wirebench']!;
}

/** What Traefik's templates make of the file for `domain`: `env` and sprig's `replace`, the two it uses. */
function rendered(text: string, domain: string): string {
  return text
    .replaceAll('{{ env "APP_DOMAIN" | replace "." "\\\\." }}', domain.replaceAll('.', '\\.'))
    .replaceAll('{{ env "APP_DOMAIN" }}', domain);
}

describe('the hosted deployment recipe', () => {
  it('publishes ports from Traefik only', async () => {
    const { services } = await compose();
    expect(Object.keys(services).sort()).toEqual(['db', 'server', 'traefik']);
    expect(services['traefik']!.ports).toEqual(['80:80', '443:443']);
    expect(services['server']!.ports).toBeUndefined();
    expect(services['db']!.ports).toBeUndefined();
  });

  it('runs the server in hosted mode behind the trusted proxy, with both names and a mail sender', async () => {
    const env = (await compose()).services['server']!.environment!;
    expect(env['WIREBENCH_SERVER_MODE']).toBe('hosted');
    expect(env['WIREBENCH_SERVER_TRUST_PROXY']).toBe('true');
    expect(env['WIREBENCH_SERVER_APP_DOMAIN']).toContain('${APP_DOMAIN');
    expect(env['WIREBENCH_SERVER_SITE_DOMAIN']).toContain('${SITE_DOMAIN');
    expect(env['WIREBENCH_SERVER_SMTP_URL']).toBeDefined();
    expect(env['WIREBENCH_SERVER_SMTP_FROM']).toBeDefined();
    expect(env['WIREBENCH_SERVER_DATABASE_URL']).toMatch(/^postgres:\/\/wirebench_app:/);
  });

  it('issues by DNS-01 with lego’s hetzner provider, the token read from a secret file', async () => {
    const { services, secrets } = await compose();
    const traefik = services['traefik']!;
    expect(traefik.image).toMatch(/^traefik:v3\.\d+\.\d+$/);
    expect(traefik.command).toContain('--certificatesresolvers.le.acme.dnschallenge.provider=hetzner');
    expect(traefik.environment!['HETZNER_API_TOKEN_FILE']).toBe('/run/secrets/hetzner_api_token');
    expect(traefik.environment!['HETZNER_API_TOKEN']).toBeUndefined();
    expect(traefik.secrets).toEqual(['hetzner_api_token']);
    expect(secrets['hetzner_api_token']!.file).toBe('./secrets/hetzner_api_token');
  });

  it('asks for one certificate: the apex as main and the wildcard as its SAN', async () => {
    const route = await router();
    expect(route.entryPoints).toEqual(['websecure']);
    expect(route.tls.certResolver).toBe('le');
    expect(
      route.tls.domains.map((d) => ({
        main: rendered(d.main, 'app.test'),
        sans: d.sans.map((s) => rendered(s, 'app.test')),
      })),
    ).toEqual([{ main: 'app.test', sans: ['*.app.test'] }]);
  });

  it('routes the apex and exactly one label under it, and nothing else', async () => {
    const rule = rendered((await router()).rule, 'app.test');
    expect(rule).toContain('Host(`app.test`)');
    const pattern = /HostRegexp\(`([^`]+)`\)/.exec(rule)![1]!;
    const regexp = new RegExp(pattern);
    for (const host of ['app.app.test', 'acme.app.test', 'acme-2.app.test']) expect(regexp.test(host), host).toBe(true);
    for (const host of ['a.b.app.test', 'acmeXapp.test', 'app.test.evil.test', 'evil.test'])
      expect(regexp.test(host), host).toBe(false);
  });

  it('polls the server’s proxy listener for the custom domains every 10 seconds, with the token', async () => {
    const command = (await compose()).services['traefik']!.command!;
    expect(command).toContain('--providers.http.endpoint=http://server:8081/proxy/traefik');
    expect(command).toContain('--providers.http.pollInterval=10s');
    // A provider header takes a value, not a file: compose puts the token in from `.env`.
    expect(command).toContain('--providers.http.headers.Authorization=Bearer ${PROXY_TOKEN:?set PROXY_TOKEN in .env}');
  });

  it('issues custom domains by HTTP-01 on the web entry point, with the first resolver’s storage, contact and CA', async () => {
    const command = (await compose()).services['traefik']!.command!;
    const value = (flag: string) => command.find((line) => line.startsWith(`${flag}=`))?.slice(flag.length + 1);
    expect(value('--certificatesresolvers.le-http.acme.httpchallenge.entrypoint')).toBe('web');
    for (const setting of ['email', 'storage', 'caserver']) {
      expect(value(`--certificatesresolvers.le-http.acme.${setting}`), setting).toBe(
        value(`--certificatesresolvers.le.acme.${setting}`),
      );
    }
    expect(command.some((line) => line.startsWith('--certificatesresolvers.le-http.acme.dnschallenge'))).toBe(false);
    // The challenge router takes precedence over the redirect, so the redirect stays.
    expect(command).toContain('--entrypoints.web.http.redirections.entrypoint.to=websecure');
  });

  it('gives the server the proxy listener, its token as a file secret and the proxy’s TLS address, publishing nothing', async () => {
    const { services, secrets } = await compose();
    const server = services['server']!;
    expect(server.environment!['WIREBENCH_SERVER_PROXY_LISTEN']).toBe('0.0.0.0:8081');
    expect(server.environment!['WIREBENCH_SERVER_PROXY_TOKEN_FILE']).toBe('/run/secrets/proxy_token');
    expect(server.environment!['WIREBENCH_SERVER_PROXY_TLS_ADDRESS']).toBe('traefik:443');
    expect(server.environment!['WIREBENCH_SERVER_PROXY_TLS_CA_FILE']).toBeUndefined();
    expect(server.secrets).toEqual(['proxy_token']);
    // One value in `.env` for both sides, so Traefik's header and the server's file cannot drift.
    expect(secrets['proxy_token']).toEqual({ environment: 'PROXY_TOKEN' });
    expect(server.ports).toBeUndefined();
    for (const [name, service] of Object.entries(services)) {
      for (const port of service.ports ?? []) expect(port, name).not.toMatch(/8081/);
    }
  });

  it('lists the proxy token in env.example as a placeholder only', async () => {
    const text = await readFile(join(DIR, 'env.example'), 'utf8');
    expect(text).toMatch(/^PROXY_TOKEN=$/m);
  });

  it('names no real domain', async () => {
    for (const file of ['compose.yaml', 'dynamic.yaml', 'env.example', 'README.md']) {
      const text = await readFile(join(DIR, file), 'utf8');
      expect(text, file).not.toMatch(/wirebench\.(co|com|io|dev|app|cloud)\b/);
    }
  });

  // Linux only: Docker Desktop on the Windows and macOS runners takes seconds just to answer `compose version`.
  it.runIf(process.platform === 'linux')(
    'is a valid compose file, where Docker Compose is installed',
    async () => {
      try {
        await run('docker', ['compose', 'version']);
      } catch {
        return;
      }
      const env = {
        ...process.env,
        APP_DOMAIN: 'app.test',
        SITE_DOMAIN: 'site.test',
        ACME_EMAIL: 'operator@site.test',
        POSTGRES_PASSWORD: 'p',
        WIREBENCH_APP_DB_PASSWORD: 'a',
        WIREBENCH_SECRETS_KEY: 'k',
        SMTP_URL: 'smtp://mail.site.test:587',
        SMTP_FROM: 'teams@site.test',
        PROXY_TOKEN: 't',
      };
      await expect(
        run('docker', ['compose', '-f', join(DIR, 'compose.yaml'), 'config', '--quiet'], { env }),
      ).resolves.toBeDefined();
    },
    30_000,
  );
});
