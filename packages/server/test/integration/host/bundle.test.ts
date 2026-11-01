/**
 * The built host bundle (hosted edition spec §17.3) starts in a plain Node process and answers a call,
 * without loading a native module: the terminal's, serial's, security keys' and Kerberos's bindings are
 * loaded lazily by channels the server never registers, so a lazy import that became eager would break
 * the container image. The child refuses every native specifier and records any binding opened, so such a
 * regression fails here rather than in production. `global-setup.ts` builds the bundle first.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST_CLOSE, HOST_LIMITS } from '../../../src/host/errors.js';

const run = promisify(execFile);
const bundle = fileURLToPath(new URL('../../../dist/host/bundle.js', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'wirebench-host-bundle-'));
const USER = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Run as an ES module by the child: argv is [bundle URL, data dir, user id]. */
const CHILD = `
import { registerHooks } from 'node:module';
const [bundleUrl, dataDir, userId] = process.argv.slice(1);
const NATIVE = /^(@lydell\\/node-pty|@serialport\\/|node-hid$|kerberos$|cpu-features$)|\\.node$/;
const refused = [];
const opened = [];
registerHooks({
  resolve(specifier, context, next) {
    if (NATIVE.test(specifier)) {
      refused.push(specifier);
      throw Object.assign(new Error('native module refused: ' + specifier), { code: 'MODULE_NOT_FOUND' });
    }
    return next(specifier, context);
  },
});
const dlopen = process.dlopen;
process.dlopen = (module, filename, ...rest) => {
  opened.push(filename);
  return dlopen.call(process, module, filename, ...rest);
};
const { createServerHost, hostWire, runHostSocket } = await import(bundleUrl);
const host = await createServerHost({
  userId,
  scope: { tenantId: '00000000-0000-4000-8000-000000000001', slug: 'default' },
  dataDir,
  dataKey: Buffer.alloc(32, 7),
  egress: { denyPrivate: true },
  appVersion: '9.9.9-bundle-test',
});
let closed = false;
const caller = {
  id: 1,
  send: () => undefined,
  isClosed: () => closed,
  onReset: () => () => undefined,
  onClosed: () => () => undefined,
};
host.attach(caller);
const version = await host.serve(caller, { id: 7, channel: 'app.version', request: undefined });
const fsOpen = await host.serve(caller, { id: 8, channel: 'fs.openFile', request: {} });
const areas = await host.serve(caller, { id: 9, channel: 'app.areas', request: undefined });
const channels = host.channels();
// A socket is detached once it has closed, as Task 8's transport does.
closed = true;
await host.detach(1);
await host.dispose();
process.stdout.write(JSON.stringify({
  version, fsOpen, areas, refused, opened, hostWire, socketLoop: typeof runHostSocket,
  capabilities: host.capabilities, osTheme: host.osTheme, channelCount: channels.length,
  terminal: channels.filter((channel) => /^(terminal|localTerminal|serial|kerberos)\\./.test(channel)),
}));
process.exit(0);
`;

interface ChildReport {
  readonly version: { id: number; ok: boolean; value?: { version: string; electron: string; node: string } };
  readonly fsOpen: { id: number; ok: boolean; error?: { code: string } };
  readonly areas: { ok: boolean; value?: { enabled: string[]; localTerminal: boolean; serial: boolean } };
  readonly refused: string[];
  readonly opened: string[];
  readonly capabilities: string[];
  readonly osTheme: string;
  readonly channelCount: number;
  readonly terminal: string[];
  readonly hostWire: { close: unknown; limits: unknown };
  readonly socketLoop: string;
}

describe('the host bundle', () => {
  it('is built by the server build', () => {
    expect(existsSync(bundle)).toBe(true);
  });

  it('starts in plain Node without a native module and answers app.version', async () => {
    // A bare environment and a working directory outside the repository: only the bundle's own
    // location can resolve its externals, as in the image.
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '--eval', CHILD, pathToFileURL(bundle).href, dataDir, USER],
      { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 },
    );
    const report = JSON.parse(stdout) as ChildReport;
    expect(report.version).toEqual({
      id: 7,
      ok: true,
      value: { version: '9.9.9-bundle-test', electron: process.versions.node, node: process.versions.node },
    });
    expect(report.fsOpen).toMatchObject({ id: 8, ok: false, error: { code: 'host-capability-missing' } });
    expect(report.areas.value).toMatchObject({ localTerminal: false, serial: false });
    expect(report.areas.value?.enabled).not.toContain('ssh');
    expect(report.capabilities).toEqual(['send:public']);
    expect(report.osTheme).toBe('light');
    expect(report.channelCount).toBeGreaterThan(100);
    // The bindings the host loads lazily are never asked for; ssh2 tries its own two optional ones
    // (`cpu-features`, `sshcrypto.node`) inside a try/catch, refused here and absent in the image.
    expect(
      report.refused.filter((specifier) => /^(@lydell\/node-pty|@serialport\/|node-hid$|kerberos$)/.test(specifier)),
    ).toEqual([]);
    expect(
      report.refused.filter((specifier) => specifier !== 'cpu-features' && !specifier.endsWith('sshcrypto.node')),
    ).toEqual([]);
    expect(report.opened).toEqual([]);
    // The server's mirror of the shared socket's close codes and limits is the original, value for value,
    // and the bundle carries the loop the server runs its sockets on.
    expect(report.hostWire).toEqual({ close: HOST_CLOSE, limits: HOST_LIMITS });
    expect(report.socketLoop).toBe('function');
    // The host wrote its state into the user's checkout and nowhere else in the data directory.
    // Under its tenant (spec §19.6).
    expect(readdirSync(dataDir)).toEqual(['tenants']);
    expect(readdirSync(join(dataDir, 'tenants'))).toEqual([TENANT_ID]);
    expect(readdirSync(join(dataDir, 'tenants', TENANT_ID))).toEqual(['checkouts']);
    expect(readdirSync(join(dataDir, 'tenants', TENANT_ID, 'checkouts'))).toEqual([USER]);
  });
});
