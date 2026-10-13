// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { SshConnectError, parseHostsFile } from '@wirebench/ssh';
import type { KnownHostEntry } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { REFUSAL_TTL_MS, RefusalStore, createSshConnector } from '../src/main/ssh-connect.js';
import { SshService } from '../src/main/ssh-service.js';
import type { SshListHostsResponse } from '../src/shared/ssh-wire.js';

const FILE = parseHostsFile(
  [
    'version: 1',
    'hosts:',
    "  - { id: bastion, name: bastion, address: 10.0.0.9, ssh: { user: jump, auth: { password: '${secret:jump_pw}' } } }",
    "  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, jump: bastion, auth: { password: '${secret:a_pw}' } } }",
    '',
  ].join('\n'),
);
const KEY: KnownHostEntry = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };
const HOP = { address: '10.0.0.1', port: 22 };

const sender = (id: number) => ({ id, isDestroyed: () => false, on: vi.fn(), once: vi.fn() }) as unknown as WebContents;

function make(opts: { secrets?: Record<string, string>; known?: KnownHostEntry[]; now?: () => number } = {}) {
  const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'wb-connect-')), 'ssh-known-hosts.json');
  if (opts.known) writeFileSync(knownHostsFile, JSON.stringify(opts.known));
  const secrets = opts.secrets ?? { jump_pw: 'jpw', a_pw: 'apw' };
  const deps = {
    hosts: () => ({
      current: () => FILE,
      list: (): Promise<SshListHostsResponse> =>
        Promise.resolve({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] }),
    }),
    secretsFor: () => (ref: string) => Promise.resolve(ref.startsWith('secret:') ? secrets[ref.slice(7)] : undefined),
    knownHostsFile,
    agentSocket: () => undefined,
  };
  const refusals = new RefusalStore(opts.now);
  const connector = createSshConnector({ ...deps, refusals });
  return { connector, refusals, deps, knownHostsFile };
}

describe('createSshConnector', () => {
  it('a host behind a jump yields two hops in order, each with its own credentials', async () => {
    const { connector } = make();
    const hops = await connector.prepareHops(sender(1), 'a');
    expect(hops.map((h) => [h.address, h.user, h.auth])).toEqual([
      ['10.0.0.9', 'jump', { kind: 'password', password: 'jpw' }],
      ['10.0.0.1', 'me', { kind: 'password', password: 'apw' }],
    ]);
  });

  it('a missing secret is secret-missing with its name', async () => {
    const { connector } = make({ secrets: { jump_pw: 'jpw' } });
    await expect(connector.prepareHops(sender(1), 'a')).rejects.toMatchObject({
      code: 'secret-missing',
      details: { name: 'a_pw' },
    });
  });

  it('reads no secret once the connect is abandoned', async () => {
    const { connector } = make();
    await expect(connector.prepareHops(sender(1), 'a', () => true)).rejects.toMatchObject({
      code: 'ssh-session-closed',
    });
  });

  it('an unknown key is refused and recorded for that sender only', async () => {
    const { connector, refusals } = make();
    const verify = await connector.verifierFor(sender(1));
    expect(await verify(HOP, KEY)).toBe('reject');
    expect(refusals.of(1)).toMatchObject([{ ...KEY, kind: 'new' }]);
    expect(refusals.of(2)).toEqual([]);
    const error = connector.refusalError(sender(1), new SshConnectError('ssh-host-key-new', 'untrusted', { ...KEY }));
    expect(error).toMatchObject({ name: 'WirebenchError', code: 'ssh-host-key-new', details: KEY });
  });

  it('a known key is accepted and records nothing', async () => {
    const { connector, refusals } = make({ known: [KEY] });
    expect(await (await connector.verifierFor(sender(1)))(HOP, KEY)).toBe('accept');
    expect(refusals.of(1)).toEqual([]);
  });

  it('a changed key comes back as ssh-host-key-changed with the stored fingerprint', async () => {
    const { connector, refusals } = make({ known: [{ ...KEY, fingerprint: 'SHA256:old' }] });
    expect(await (await connector.verifierFor(sender(1)))(HOP, KEY)).toBe('reject');
    expect(refusals.of(1)).toMatchObject([{ ...KEY, kind: 'changed', previous: 'SHA256:old' }]);
    const error = connector.refusalError(sender(1), new SshConnectError('ssh-host-key-new', 'untrusted', { ...KEY }));
    expect(error).toMatchObject({ code: 'ssh-host-key-changed', details: { ...KEY, previous: 'SHA256:old' } });
  });

  it('a verifier made before the window forgot keeps no refusal', async () => {
    const { connector, refusals } = make();
    const verify = await connector.verifierFor(sender(1));
    connector.forget(sender(1));
    expect(await verify(HOP, KEY)).toBe('reject');
    expect(refusals.of(1)).toEqual([]);
  });

  it('a refusal expires after the TTL', async () => {
    let now = 0;
    const { connector, refusals } = make({ now: () => now });
    await (
      await connector.verifierFor(sender(1))
    )(HOP, KEY);
    now = REFUSAL_TTL_MS + 1;
    expect(refusals.of(1)).toEqual([]);
  });

  it('one store serves both services: ssh.trust records a key another connector refused, for that window only', async () => {
    const { connector, refusals, deps } = make();
    const ssh = new SshService({
      ...deps,
      hostOsFile: join(mkdtempSync(join(tmpdir(), 'wb-connect-os-')), 'ssh-host-os.json'),
      emit: vi.fn(),
      snippets: () => ({ current: () => undefined, list: vi.fn() }),
      refusals,
      connector,
    });
    await (
      await connector.verifierFor(sender(1))
    )(HOP, KEY);
    await expect(ssh.trust(sender(2), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
    await ssh.trust(sender(1), { ...KEY, replace: false });
    expect(await ssh.knownHosts()).toEqual([KEY]);
    expect(refusals.of(1)).toEqual([]);
  });
});
