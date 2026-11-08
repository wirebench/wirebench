// @vitest-environment node
/**
 * `attach`'s reopen (#879): `reopenLast` reopens the last workspace, and `reopenWhen` decides at the
 * moment of the reopen whether it happens. The server's browser tabs pass it to wait for a reloaded tab's
 * old socket, and to leave a second tab at the picker.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../../src/host/create-host.js';
import { serveCall } from '../../src/host/serve-call.js';
import { createFakePlatform, fakeCaller } from '../helpers/fake-platform.js';

const hosts: Host[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function hostWithLastWorkspace(): Promise<{ host: Host; workspaceId: string }> {
  const userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'wirebench-reopen-')));
  dirs.push(userData);
  const first = await createHost(createFakePlatform({ userData }));
  const caller = fakeCaller(1);
  first.attach(caller);
  const created = (await serveCall(first, caller, {
    id: 1,
    channel: 'workspace.create',
    request: { name: 'Last' },
  })) as {
    value: { workspace: { id: string } };
  };
  await first.shutdown();
  const host = await createHost(createFakePlatform({ userData }));
  hosts.push(host);
  return { host, workspaceId: created.value.workspace.id };
}

async function openWorkspaceId(host: Host, id: number): Promise<string | null> {
  const caller = fakeCaller(id);
  const reply = (await serveCall(host, caller, { id: 1, channel: 'workspace.snapshot', request: undefined })) as {
    value: { workspace: { id: string } | null };
  };
  return reply.value.workspace?.id ?? null;
}

describe('attach reopens the last workspace', () => {
  it('reopens it when reopenWhen answers true, after waiting for it', async () => {
    const { host, workspaceId } = await hostWithLastWorkspace();
    let release: (value: boolean) => void = () => undefined;
    const asked = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    host.attach(fakeCaller(2), { reopenLast: true, reopenWhen: () => asked });
    const snapshot = openWorkspaceId(host, 2);
    release(true);
    expect(await snapshot).toBe(workspaceId);
  });

  it('stays at the picker when reopenWhen answers false or fails', async () => {
    const { host } = await hostWithLastWorkspace();
    host.attach(fakeCaller(2), { reopenLast: true, reopenWhen: () => Promise.resolve(false) });
    host.attach(fakeCaller(3), { reopenLast: true, reopenWhen: () => Promise.reject(new Error('gone')) });
    expect(await openWorkspaceId(host, 2)).toBeNull();
    expect(await openWorkspaceId(host, 3)).toBeNull();
  });

  it('reopens without reopenWhen, as the desktop does', async () => {
    const { host, workspaceId } = await hostWithLastWorkspace();
    host.attach(fakeCaller(2), { reopenLast: true });
    expect(await openWorkspaceId(host, 2)).toBe(workspaceId);
  });
});
