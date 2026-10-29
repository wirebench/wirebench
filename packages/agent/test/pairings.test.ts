/**
 * The pairing store's file (`userData/agent-pairings.json`, version 1): written only once there is an
 * identity, the key sealed by the platform, read back by a second store over the same directory.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPairingStore, PAIRINGS_FILE } from '../src/pairings.js';
import { cleanUp, fakePlatform, ulidLike } from './helpers.js';

afterEach(cleanUp);

const pairing = (overrides: Partial<{ pairingId: string; port: number }> = {}) => ({
  pairingId: overrides.pairingId ?? ulidLike(),
  serverUrl: 'https://team.example.test',
  origin: 'https://team.example.test',
  email: 'ada@example.test',
  sshOptIn: false,
  createdAt: '2026-10-29T10:00:00.000Z',
  ...(overrides.port === undefined ? {} : { port: overrides.port }),
});

describe('openPairingStore', () => {
  it('writes nothing for an agent that never paired', async () => {
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    expect(store.list()).toEqual([]);
    expect(existsSync(join(platform.paths.userData(), PAIRINGS_FILE))).toBe(false);
  });

  it('round-trips the identity and the pairings through the platform, with the key sealed', async () => {
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    const { agentId, key } = await store.identity();
    const first = pairing({ port: 47_615 });
    const second = pairing();
    await store.add(first);
    await store.add(second);
    await store.setPort(second.pairingId, 47_616);

    const text = readFileSync(join(platform.paths.userData(), PAIRINGS_FILE), 'utf8');
    const file = JSON.parse(text) as { version: number; agentId: string; privateKeySealed: string };
    expect(file.version).toBe(1);
    expect(file.agentId).toBe(agentId);
    // Sealed by the platform: the PKCS8 text is not in the file, only what `encrypt` made of it.
    expect(text).not.toContain(key.sealable());
    expect(Buffer.from(file.privateKeySealed, 'base64').toString('utf8')).toMatch(/^sealed:/);
    expect(statSync(join(platform.paths.userData(), PAIRINGS_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(platform.paths.userData())).toEqual([PAIRINGS_FILE]);

    const again = await openPairingStore(fakePlatform(undefined, platform.paths.userData()));
    const reread = await again.identity();
    expect(reread.agentId).toBe(agentId);
    expect(reread.key.publicKey).toBe(key.publicKey);
    expect(reread.key.sign('m')).toBe(key.sign('m'));
    expect(again.list()).toEqual([first, { ...second, port: 47_616 }]);

    expect(await again.remove(first.pairingId)).toBe(true);
    expect(await again.remove(first.pairingId)).toBe(false);
    expect((await openPairingStore(platform)).list()).toEqual([{ ...second, port: 47_616 }]);
  });

  it('refuses a file it cannot read rather than replacing it', async () => {
    const platform = fakePlatform();
    writeFileSync(join(platform.paths.userData(), PAIRINGS_FILE), JSON.stringify({ version: 2 }));
    await expect(openPairingStore(platform)).rejects.toThrow(/not a pairings file/);
  });

  it('will not make a key on a platform that cannot keep it secret', async () => {
    const platform = fakePlatform();
    const store = await openPairingStore({ ...platform, secrets: { ...platform.secrets, available: () => false } });
    await expect(store.identity()).rejects.toThrow(/cannot keep the agent key secret/);
  });
});
