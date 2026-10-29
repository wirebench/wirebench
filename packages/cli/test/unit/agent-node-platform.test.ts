/**
 * The headless agent's folder and key (hosted edition spec §18.6): made `0700` and `0600` on the first run,
 * and refused at start-up when either is open to other accounts, with the `chmod` that fixes it.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_KEY_FILE,
  agentHome,
  createAgentPlatform,
  openAgentHome,
  seal,
  unseal,
} from '../../src/agent/node-platform.js';
import { readRunStatus, writeRunStatus } from '../../src/agent/status-file.js';
import { parseAgent } from '../../src/args-agent.js';

const posix = process.platform !== 'win32';
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-cli-agent-'));
  made.push(dir);
  return dir;
}

describe('the agent folder', () => {
  it('is $WIREBENCH_AGENT_HOME, else ~/.wirebench/agent', () => {
    expect(agentHome({ WIREBENCH_AGENT_HOME: '/x/agent' }, '/home/ada')).toBe('/x/agent');
    expect(agentHome({}, '/home/ada')).toBe(join('/home/ada', '.wirebench', 'agent'));
  });

  it.runIf(posix)('is made 0700 with a 0600 key of 32 bytes on the first run, and the key is kept', async () => {
    const home = join(await scratch(), 'nested', 'agent');
    const key = await openAgentHome(home);
    expect(key).toHaveLength(32);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, AGENT_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect(await openAgentHome(home)).toEqual(key);
  });

  it.runIf(posix)('refuses a key file other accounts can read, saying how to fix it', async () => {
    const home = join(await scratch(), 'agent');
    await openAgentHome(home);
    const keyPath = join(home, AGENT_KEY_FILE);
    await chmod(keyPath, 0o644);
    await expect(openAgentHome(home)).rejects.toThrow(`Run: chmod 600 ${keyPath}`);
    await chmod(keyPath, 0o600);
    await expect(openAgentHome(home)).resolves.toHaveLength(32);
  });

  it.runIf(posix)('refuses a folder open to the group, saying how to fix it', async () => {
    const home = join(await scratch(), 'agent');
    await openAgentHome(home);
    await chmod(home, 0o750);
    await expect(openAgentHome(home)).rejects.toThrow(`Run: chmod 700 ${home}`);
  });

  it.runIf(posix)('refuses a link in the key’s place, and a key of the wrong length', async () => {
    const home = join(await scratch(), 'agent');
    await openAgentHome(home);
    const keyPath = join(home, AGENT_KEY_FILE);
    const elsewhere = join(await scratch(), 'other.key');
    await writeFile(elsewhere, Buffer.alloc(32, 1), { mode: 0o600 });
    await rm(keyPath);
    await symlink(elsewhere, keyPath);
    await expect(openAgentHome(home)).rejects.toThrow('is a link');
    await rm(keyPath);
    await writeFile(keyPath, 'short', { mode: 0o600 });
    await expect(openAgentHome(home)).rejects.toThrow('not a key this agent wrote');
  });

  it('skips the mode check on Windows, where the folder’s ACL protects it', async () => {
    const home = join(await scratch(), 'agent');
    await openAgentHome(home);
    if (posix) await chmod(join(home, AGENT_KEY_FILE), 0o644);
    await expect(openAgentHome(home, 'win32')).resolves.toHaveLength(32);
  });
});

describe('the agent key, made', () => {
  it('once by two runs at the same time: both read the one key, and no temporary file is left', async () => {
    const home = join(await scratch(), 'agent');
    const [one, two] = await Promise.all([openAgentHome(home), openAgentHome(home)]);
    expect(one).toEqual(two);
    expect(await readdir(home)).toEqual([AGENT_KEY_FILE]);
  });

  it('refuses an empty key file, saying to delete it', async () => {
    const home = join(await scratch(), 'agent');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, AGENT_KEY_FILE), '', { mode: 0o600 });
    await expect(openAgentHome(home)).rejects.toThrow('delete it and start the agent again');
  });
});

describe('the run status file', () => {
  it.runIf(posix && process.getuid?.() !== 0)('counts a pid of another account (EPERM) as not running', async () => {
    const home = await scratch();
    await writeRunStatus(home, { pid: 1, port: 47_615 });
    expect(await readRunStatus(home)).toBeUndefined();
    await writeRunStatus(home, { pid: process.pid, port: 47_615 });
    expect(await readRunStatus(home)).toEqual({ pid: process.pid, port: 47_615 });
  });
});

describe('the agent platform', () => {
  it('sends to loopback and link-local directly, whatever the proxy variables say', async () => {
    const platform = createAgentPlatform({
      home: '/agent',
      key: Buffer.alloc(32),
      version: '1.2.3',
      kerberos: false,
      env: {
        HTTPS_PROXY: 'http://proxy.example.test:3128',
        HTTP_PROXY: 'http://proxy.example.test:3128',
        NO_PROXY: '',
      },
    });
    for (const target of [
      'http://localhost:8080/',
      'https://api.localhost/x',
      'http://127.0.0.5/',
      'http://[::1]:3000/',
      'http://169.254.169.254/latest',
      'http://[fe80::1]/',
    ]) {
      expect(await platform.proxy.resolve(target), target).toBe('DIRECT');
    }
    expect(await platform.proxy.resolve('http://api.example.test/')).toBe('PROXY proxy.example.test:3128');
  });

  it('seals with AES-256-GCM under the key, and refuses a box sealed under another', () => {
    const key = Buffer.alloc(32, 3);
    const sealed = seal(key, 'the private key');
    expect(sealed.toString('utf8')).not.toContain('the private key');
    expect(unseal(key, sealed)).toBe('the private key');
    expect(() => unseal(Buffer.alloc(32, 4), sealed)).toThrow();
  });

  it('declares send, secret sources, and Kerberos only when the binding loads; reads proxies from the environment', async () => {
    const base = { home: '/agent', key: Buffer.alloc(32), version: '1.2.3' };
    const without = createAgentPlatform({ ...base, kerberos: false, env: {} });
    expect([...without.capabilities]).toEqual(['send:private', 'send:public', 'secret-sources']);
    expect(without.app.version()).toBe('1.2.3');
    expect(without.paths.temp()).toBe(tmpdir());
    expect(await without.proxy.resolve('https://api.example.test/')).toBe('DIRECT');
    const proxied = createAgentPlatform({
      ...base,
      kerberos: true,
      env: { HTTPS_PROXY: 'http://proxy.example.test:3128', NO_PROXY: 'internal.test' },
    });
    expect(proxied.capabilities.has('kerberos')).toBe(true);
    expect(await proxied.proxy.resolve('https://api.example.test/')).toBe('PROXY proxy.example.test:3128');
    expect(await proxied.proxy.resolve('https://svc.internal.test/')).toBe('DIRECT');
  });

  it('reads the key it wrote back as it was written', async () => {
    const home = join(await scratch(), 'agent');
    const key = await openAgentHome(home);
    expect(await readFile(join(home, AGENT_KEY_FILE))).toEqual(key);
  });
});

describe('wirebench agent arguments', () => {
  it('parses each subcommand and refuses what does not belong', () => {
    expect(parseAgent([])).toEqual({ command: 'agent-run' });
    expect(parseAgent(['pair', 'ABC234', '--server', 'https://wb.test'])).toEqual({
      command: 'agent-pair',
      code: 'ABC234',
      server: 'https://wb.test',
    });
    // No SSH opt-in in slice 3: nothing serves SSH, and the version that does asks for it then.
    expect(() => parseAgent(['pair', 'ABC234', '--server', 'https://wb.test', '--ssh'])).toThrow(/ssh/);
    expect(parseAgent(['unpair'])).toEqual({ command: 'agent-unpair', local: false });
    expect(parseAgent(['unpair', '--local', '--server', 'https://wb.test'])).toEqual({
      command: 'agent-unpair',
      local: true,
      server: 'https://wb.test',
    });
    expect(() => parseAgent(['status', '--local'])).toThrow('--local applies to wirebench agent unpair only');
    expect(parseAgent(['allow-env', 'A', 'B'])).toEqual({ command: 'agent-allow-env', names: ['A', 'B'] });
    expect(parseAgent(['--help'])).toEqual({ command: 'help', topic: 'agent' });
    expect(() => parseAgent(['pair', 'ABC234'])).toThrow('--server <url> is required');
    expect(() => parseAgent(['allow-env'])).toThrow('at least one name');
    expect(() => parseAgent(['nope'])).toThrow('unknown subcommand');
  });
});
