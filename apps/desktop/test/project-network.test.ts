// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rootCertificates } from 'node:tls';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences, WirebenchError, type Preferences } from '@wirebench/engine';
import {
  generateClientCert,
  generateClientPkcs12,
  generateTestCa,
  startTestSoapServer,
  type TestSoapServer,
} from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';

const PASSWORD = 'p12-password';

let server: TestSoapServer;

beforeAll(async () => {
  server = await startTestSoapServer();
});

afterAll(async () => {
  await server.close();
});

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wirebench-${prefix}-`));
  dirs.push(dir);
  return dir;
}

interface ServiceOptions {
  readonly preferences?: Preferences;
  readonly picks?: DialogPicks;
  readonly secrets?: { get(ref: string): Promise<string | undefined> };
  readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>;
}

function newService(options: ServiceOptions = {}): ProjectHost {
  return new ProjectHost(
    new EngineService(),
    {},
    undefined,
    undefined,
    options.secrets,
    { get: () => options.preferences ?? DEFAULT_PREFERENCES },
    options.picks,
    options.resolveSystemProxy,
  );
}

/** An opened project with one imported interface, and the id of its only request. */
async function openProject(service: ProjectHost): Promise<{ dir: string; requestId: string }> {
  const dir = tempDir('proj');
  await service.create({ dir, name: 'Demo' });
  const imported = await service.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
  await service.whenHydrated();
  return { dir, requestId: imported.project.requests[0]?.id as string };
}

describe('ProjectHost.proxyFor', () => {
  it('goes direct when no proxy is configured', async () => {
    const service = newService();
    expect(await service.proxyFor('https://api.test/soap')).toBeUndefined();
  });

  it('builds the manual proxy URL and resolves the password out of the secret store', async () => {
    const service = newService({
      preferences: mergePreferences({
        proxy: {
          mode: 'manual',
          host: 'proxy.corp.test',
          port: 8080,
          username: 'u',
          passwordRef: 'secret:1',
          excludes: [],
        },
      }),
      secrets: { get: () => Promise.resolve('proxy-pass') },
    });

    expect(await service.proxyFor('https://api.test/soap')).toEqual({
      url: 'http://proxy.corp.test:8080',
      auth: { username: 'u', password: 'proxy-pass' },
    });
  });

  it('bypasses the proxy for an excluded host', async () => {
    const service = newService({
      preferences: mergePreferences({
        proxy: { mode: 'manual', host: 'proxy.corp.test', port: 8080, excludes: ['*.internal.test'] },
      }),
    });

    expect(await service.proxyFor('https://api.test/soap')).toEqual({ url: 'http://proxy.corp.test:8080' });
    expect(await service.proxyFor('https://box.internal.test/soap')).toBeUndefined();
  });

  it('asks the injected system resolver, and does not ask it for an excluded host', async () => {
    const asked: string[] = [];
    const service = newService({
      preferences: mergePreferences({ proxy: { mode: 'system', excludes: ['localhost'] } }),
      resolveSystemProxy: (url) => {
        asked.push(url);
        return Promise.resolve('PROXY 10.0.0.1:3128');
      },
    });

    expect(await service.proxyFor('https://api.test/soap')).toEqual({ url: 'http://10.0.0.1:3128' });
    expect(await service.proxyFor('http://127.0.0.1:8080/soap')).toBeUndefined();
    expect(asked).toEqual(['https://api.test/soap']);
  });

  /**
   * undici's `ProxyAgent` cannot speak SOCKS. Going direct instead used to look like success
   * until the firewall dropped the connection, so the send now fails with a message naming the
   * scheme — the one case where a proxy the user configured is *not* silently ignored.
   */
  it('fails the send with proxy-unsupported when the system proxy is SOCKS', async () => {
    const service = newService({
      preferences: mergePreferences({ proxy: { mode: 'system', excludes: [] } }),
      resolveSystemProxy: () => Promise.resolve('SOCKS5 10.0.0.1:1080'),
    });
    const error = await service.proxyFor('https://api.test/soap').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WirebenchError);
    expect((error as WirebenchError).code).toBe('proxy-unsupported');
    expect((error as WirebenchError).message).toMatch(/SOCKS5/);
  });

  it('goes direct when the system says DIRECT', async () => {
    const service = newService({
      preferences: mergePreferences({ proxy: { mode: 'system', excludes: [] } }),
      resolveSystemProxy: () => Promise.resolve('DIRECT'),
    });
    expect(await service.proxyFor('https://api.test/soap')).toBeUndefined();
  });
});

describe('ProjectHost.tlsFor', () => {
  it('adds the CA bundle’s anchors when the path was picked this session', async () => {
    const ca = generateTestCa();
    const picks = new DialogPicks();
    const bundleDir = tempDir('ca');
    const bundlePath = join(bundleDir, 'corp-ca.pem');
    await writeFile(bundlePath, `# corporate roots\n${ca.certPem}\n${ca.certPem}`);
    picks.rememberRead(bundlePath);
    const service = newService({ preferences: mergePreferences({ ssl: { caBundlePath: bundlePath } }), picks });
    const { requestId } = await openProject(service);

    const tls = await service.tlsFor(requestId);

    // The default roots first, then the bundle's two anchors: the bundle adds, it does not replace.
    expect(tls?.ca).toHaveLength(rootCertificates.length + 2);
    expect(tls?.ca?.slice(0, rootCertificates.length)).toEqual([...rootCertificates]);
    expect(tls?.ca?.at(-1)).toContain('BEGIN CERTIFICATE');
    expect(tls?.rejectUnauthorized).toBeUndefined();
  });

  it('ignores a CA bundle the user never picked, leaving verification strict', async () => {
    const ca = generateTestCa();
    const bundlePath = join(tempDir('ca'), 'corp-ca.pem');
    await writeFile(bundlePath, ca.certPem);
    // No `DialogPicks` and the path is outside the project folder, so the read check refuses it.
    const service = newService({ preferences: mergePreferences({ ssl: { caBundlePath: bundlePath } }) });
    const { requestId } = await openProject(service);

    expect(await service.tlsFor(requestId)).toBeUndefined();
  });

  it('ignores a CA bundle that does not parse', async () => {
    const picks = new DialogPicks();
    const bundlePath = join(tempDir('ca'), 'junk.pem');
    await writeFile(bundlePath, 'this is not a certificate');
    picks.rememberRead(bundlePath);
    const service = newService({ preferences: mergePreferences({ ssl: { caBundlePath: bundlePath } }), picks });
    const { requestId } = await openProject(service);

    expect(await service.tlsFor(requestId)).toBeUndefined();
  });

  it('turns verification off only for an endpoint flagged trustInvalid', async () => {
    const service = newService();
    const { requestId } = await openProject(service);
    const iface = service.snapshot()?.interfaces[0];
    const interfaceId = iface?.id as string;
    const endpointId = iface?.endpoints[0]?.id as string;

    expect(await service.tlsFor(requestId)).toBeUndefined();

    await service.mutate({ kind: 'update-endpoint', interfaceId, endpointId, patch: { trustInvalid: true } });
    expect(await service.tlsFor(requestId)).toEqual({ rejectUnauthorized: false });

    // Turning it off removes the flag entirely rather than persisting an explicit `false`.
    await service.mutate({ kind: 'update-endpoint', interfaceId, endpointId, patch: { trustInvalid: false } });
    expect(await service.tlsFor(requestId)).toBeUndefined();
    expect(service.snapshot()?.interfaces[0]?.endpoints[0]?.trustInvalid).toBeUndefined();
  });

  it('falls back to the global client keystore when the request selects none', async () => {
    const ca = generateTestCa();
    // A mutable holder so the global preference can be flipped on the *same* open project,
    // which is what a user changing Preferences mid-session actually does.
    let preferences = DEFAULT_PREFERENCES;
    const service = new ProjectHost(
      new EngineService(),
      {},
      undefined,
      undefined,
      { get: () => Promise.resolve(PASSWORD) },
      { get: () => preferences },
    );
    const { dir, requestId } = await openProject(service);
    await writeFile(join(dir, 'global.p12'), generateClientPkcs12(ca, generateClientCert(ca), { password: PASSWORD }));
    const added = await service.mutate({
      kind: 'add-keystore',
      path: join(dir, 'global.p12'),
      passwordSecretRef: 'secret:1',
    });
    const keystoreId = added.createdKeystoreId as string;

    // Nothing selected anywhere: no identity.
    expect(await service.tlsFor(requestId)).toBeUndefined();

    preferences = mergePreferences({ ssl: { clientKeystoreRef: keystoreId } });
    const globalTls = await service.tlsFor(requestId);
    expect(globalTls?.cert).toContain('BEGIN CERTIFICATE');
    expect(globalTls?.key).toContain('BEGIN PRIVATE KEY');
    // A keystore is an identity, never a trust store.
    expect(globalTls?.ca).toBeUndefined();
  });

  it('fails loudly when the globally selected keystore is not in this project', async () => {
    const service = newService({ preferences: mergePreferences({ ssl: { clientKeystoreRef: 'ghost' } }) });
    const { requestId } = await openProject(service);

    await expect(service.tlsFor(requestId)).rejects.toThrow(/Preferences/);
  });
});
