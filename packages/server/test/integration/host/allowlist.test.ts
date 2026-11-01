/**
 * Every channel of the registry is classified as served or refused on the server host (hosted edition
 * spec §3.10), so a channel added later is never served before someone decides it may be. The names come
 * from the list the desktop's own test pins against `@wirebench/wire`'s registry, and from a real host
 * built from the bundle (`global-setup.ts` builds it), so neither can drift from what is checked here.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  channelGroup,
  classifyChannel,
  isServedChannel,
  REFUSED_CHANNELS,
  REFUSED_GROUPS,
  SERVED_GROUPS,
} from '../../../src/host/allowlist.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { loadHostRuntime } from '../../../src/host/host-runtime.js';

const PINNED = new URL('../../../../../apps/desktop/test/fixtures/ipc-names.json', import.meta.url);

async function registry(): Promise<string[]> {
  const pinned = JSON.parse(await readFile(PINNED, 'utf8')) as { readonly channels: readonly string[] };
  return [...pinned.channels];
}

describe('the server host allowlist (§3.10)', () => {
  it('classifies every registry channel as served or refused', async () => {
    const unclassified = (await registry()).filter((channel) => classifyChannel(channel) === undefined);
    expect(unclassified).toEqual([]);
  });

  it('names only real groups and channels, and no group twice', async () => {
    const channels = await registry();
    const groups = new Set(channels.map(channelGroup));
    expect([...SERVED_GROUPS].filter((group) => !groups.has(group))).toEqual([]);
    expect([...REFUSED_GROUPS].filter((group) => !groups.has(group))).toEqual([]);
    expect([...SERVED_GROUPS].filter((group) => REFUSED_GROUPS.has(group))).toEqual([]);
    for (const channel of Object.keys(REFUSED_CHANNELS)) {
      expect(channels, channel).toContain(channel);
      // A single refusal only means something inside a served group.
      expect(SERVED_GROUPS.has(channelGroup(channel)), channel).toBe(true);
    }
  });

  it('refuses the rows that need a machine, and the desktop sign-in flows', async () => {
    const channels = await registry();
    const refusedGroups = [
      'fs',
      'dialogs',
      'git',
      'keystores',
      'ssl',
      'secretSources',
      'mock',
      'plugins',
      'localTerminal',
      'ssh',
      'sftp',
      'forward',
      'terminalShare',
      'appLock',
    ];
    for (const channel of channels.filter((one) => refusedGroups.includes(channelGroup(one)))) {
      expect(isServedChannel(channel), channel).toBe(false);
    }
    for (const channel of [
      'account.startOidc',
      'account.startSaml',
      'account.signInLocal',
      'account.acceptInvitation',
      'app.checkForUpdates',
      'app.mcpApprove',
      'workspace.create',
      'workspace.join',
      'wsi.exportHtml',
      // Decision 5 and ADR-0004: no team-secret key on the server host, and no value shown in a frame.
      'teamSecrets.turnOn',
      'teamSecrets.requestAccess',
      'teamSecrets.approve',
      'secrets.setShowSecrets',
    ]) {
      expect(isServedChannel(channel), channel).toBe(false);
    }
    for (const channel of [
      'app.version',
      'workspace.joinFromServer',
      'request.sendRest',
      'secrets.set',
      'sync.pull',
      'team.list',
      'account.list',
      'account.signOut',
      'oauth2.fetchToken',
      'api.importOpenApi',
      'certificates.check',
      'teamSecrets.status',
      'secrets.getShowSecrets',
    ]) {
      expect(isServedChannel(channel), channel).toBe(true);
    }
  });

  it('serves the save-time secret scan, every channel of it, since a save and a commit go through it', async () => {
    const scan = (await registry()).filter((channel) => channelGroup(channel) === 'secretScan');
    expect(scan.sort()).toEqual([
      'secretScan.hold',
      'secretScan.keep',
      'secretScan.move',
      'secretScan.release',
      'secretScan.scan',
      'secretScan.setValue',
      'secretScan.tokens',
    ]);
    for (const channel of scan) expect(isServedChannel(channel), channel).toBe(true);
  });

  it('classifies every channel a real server host registers', async () => {
    const createServerHost = await loadHostRuntime({ browserClient: true });
    const dataDir = await mkdtemp(join(tmpdir(), 'wb-host-allowlist-'));
    try {
      const host = await createServerHost!({
        userId: '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA',
        scope: scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' }),
        dataDir,
        dataKey: Buffer.alloc(32, 1),
        egress: { denyPrivate: true },
        appVersion: '0.0.0-test',
      });
      const channels = await registry();
      const registered = host.channels();
      expect(registered.filter((channel) => !channels.includes(channel))).toEqual([]);
      expect(registered.filter((channel) => classifyChannel(channel) === undefined)).toEqual([]);
      await host.dispose();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
