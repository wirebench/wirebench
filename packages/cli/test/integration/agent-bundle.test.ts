/**
 * The built agent bundle (hosted edition spec §18.6) starts in a plain Node process with no native module,
 * pairs, and serves a paired tab over a real socket: `agent.hello`, and `team-secret-needs-approval` for a
 * send that reads a team secret, which the headless agent cannot hold (§18.5). The terminal's, serial's and
 * security keys' bindings are loaded lazily by channels the agent never serves, and Kerberos only when
 * present: the child refuses every native specifier and records any binding opened, so a lazy import that
 * became eager fails here. `global-setup.ts` builds the bundle first.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakePairingServer } from './agent-fake-server.js';

const execFileAsync = promisify(execFile);
const bundle = fileURLToPath(new URL('../../dist/agent/bundle.js', import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Run as an ES module by the child: argv is [bundle URL, agent home, server URL, code, port]. */
const CHILD = `
import { registerHooks } from 'node:module';
const [bundleUrl, home, serverUrl, code, portText] = process.argv.slice(1);
const port = Number(portText);
const NATIVE = /^(@lydell\\/node-pty|@serialport\\/|node-hid$|kerberos(\\/|$)|cpu-features$)|\\.node$/;
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
const { pairAgent, startHeadlessAgent, agentStatus } = await import(bundleUrl);
const input = { home, env: {}, version: '9.9.9-bundle-test' };
const paired = await pairAgent({ ...input, code, serverUrl, sshOptIn: false, port });
const agent = await startHeadlessAgent({ ...input, ports: [port] });
const nonce = await (await fetch(serverUrl + '/test/nonce?pairing=' + paired.pairingId)).text();
const ws = new WebSocket('ws://127.0.0.1:' + port + '/host', { headers: { origin: serverUrl } });
const frames = [];
const waiters = [];
ws.onmessage = (event) => {
  frames.push(JSON.parse(event.data));
  waiters.splice(0).forEach((wake) => wake());
};
let taken = 0;
const next = async () => {
  while (frames.length <= taken) await new Promise((resolve) => waiters.push(resolve));
  return frames[taken++];
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.send(JSON.stringify({ type: 'auth', pairingId: paired.pairingId, nonce }));
const hello = await next();
ws.send(JSON.stringify({ id: 1, channel: 'agent.hello' }));
const agentHello = await next();
const bundle = {
  version: 1, kind: 'rest', workspaceId: 'ws-1', itemId: 'r1', files: [], secretNames: ['TEAM_TOKEN'],
  systemNames: [], teamSecrets: [],
};
ws.send(JSON.stringify({ id: 2, channel: 'agent.send', request: { sendId: 's1', bundle } }));
const teamSend = await next();
ws.send(JSON.stringify({ id: 3, channel: 'fs.openText', request: {} }));
const hostChannel = await next();
ws.close();
const status = await agentStatus(input);
await agent.close();
process.stdout.write(JSON.stringify({
  paired, port: agent.port, capabilities: agent.capabilities, hello, agentHello, teamSend, hostChannel,
  pairings: status.pairings.length, refused, opened,
}));
process.exit(0);
`;

interface ChildReport {
  readonly paired: { readonly pairingId: string; readonly origin: string };
  readonly port: number;
  readonly capabilities: string[];
  readonly hello: unknown;
  readonly agentHello: unknown;
  readonly teamSend: { readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } };
  readonly hostChannel: unknown;
  readonly pairings: number;
  readonly refused: string[];
  readonly opened: string[];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('the agent bundle', () => {
  it('pairs and answers agent.hello in plain Node without a native module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-agent-bundle-'));
    const server = await startFakePairingServer();
    cleanups.push(
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
    );
    const port = await freePort();
    // A bare environment and a working directory outside the repository: only the bundle's own location
    // resolves its externals, as in the published package.
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        CHILD,
        pathToFileURL(bundle).href,
        join(dir, 'agent'),
        server.url,
        server.code,
        String(port),
      ],
      { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 },
    );
    const report = JSON.parse(stdout) as ChildReport;
    expect(report.paired.origin).toBe(server.url);
    expect(report.port).toBe(port);
    // Kerberos is refused in the child, so the agent does not offer it.
    expect(report.capabilities).toEqual(['send:private', 'send:public', 'secret-sources']);
    expect(report.hello).toEqual({
      type: 'hello',
      host: 'agent',
      capabilities: ['send:private', 'send:public'],
      sshOptIn: false,
    });
    expect(report.agentHello).toEqual({
      id: 1,
      ok: true,
      value: { capabilities: ['send:private', 'send:public'], version: '9.9.9-bundle-test', sshOptIn: false },
    });
    expect(report.teamSend).toMatchObject({ ok: false, error: { code: 'team-secret-needs-approval' } });
    expect(report.teamSend.error?.message).toContain('desktop app');
    expect(report.hostChannel).toMatchObject({ id: 3, ok: false, error: { code: 'host-capability-missing' } });
    expect(server.signed.filter((one) => one.path.endsWith('/redeem'))).toEqual([
      { method: 'POST', path: '/api/v1/agent/nonces/redeem', ok: true },
    ]);
    expect(report.pairings).toBe(1);
    // Only the optional loads made inside a try: Kerberos's probe (its binding, when the package is
    // installed), and ssh2's own two.
    const optional = (specifier: string): boolean =>
      /^kerberos(\/|$)|[\\/]kerberos\.node$/.test(specifier) ||
      specifier === 'cpu-features' ||
      specifier.endsWith('sshcrypto.node');
    expect(report.refused.filter((specifier) => !optional(specifier))).toEqual([]);
    expect(report.opened).toEqual([]);
  });
});
