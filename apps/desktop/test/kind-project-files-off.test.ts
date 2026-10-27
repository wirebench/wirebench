// @vitest-environment node
/**
 * What REST and SOAP keep for the whole project (REST's webhook collection, SOAP's WS-Security
 * configurations) belongs to the kind: with the kind switched off it is neither loaded nor saved, its
 * folder shows as a placeholder rather than vanishing, a change to it is refused, and every save of a
 * change to another kind leaves its files byte for byte as they were.
 */
import { mkdtempSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectError } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { startupFeatures } from '../src/main/features/startup.js';
import { ProjectHost } from '../src/main/project-host.js';
import type { KindId } from '@wirebench/wire/kinds/kind-module';
import type { ProjectChange, ProjectWire } from '@wirebench/wire/wire-types';
import { testHooks } from './helpers/project-hooks.js';

/** Every file under `dir`, by path relative to it, with its bytes. */
async function filesUnder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path)] = (await readFile(path)).toString('base64');
  }
  return out;
}

/**
 * Opens `dir` with `off` switched off, tries `refused`, then makes and saves a change of every other
 * kind, and closes.
 */
async function changeEverythingElse(
  dir: string,
  off: KindId,
  refused: ProjectChange,
): Promise<{ readonly opened: ProjectWire; readonly error: unknown }> {
  const kindById = { soap: 'soap', rest: 'rest', grpc: 'grpc', websocket: 'websocket', mcp: 'mcp' } as const;
  const { enabledKinds, registry } = startupFeatures({
    preferences: { features: { [kindById[off]]: false, mcp: false } },
    isPackaged: true,
  });
  const host = new ProjectHost(new EngineService(), testHooks({ enabledKinds, registry }));
  const opened = await host.openProject(dir);
  const error = await host.mutate(refused).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  const grpc = await host.mutate({ kind: 'add-grpc-api', name: 'Greeter', target: 'localhost:50051' });
  await host.save({ reason: 'add-grpc-api' });
  await host.mutate({ kind: 'add-folder', apiId: grpc.createdId ?? '', name: 'Calls' });
  await host.save({ reason: 'add-folder' });
  await host.mutate({ kind: 'add-ws-api', name: 'Chat', url: 'wss://chat.test' });
  await host.save({ reason: 'add-ws-api' });
  if (off !== 'rest') {
    const api = await host.mutate({ kind: 'add-api', name: 'Shop', baseUrl: 'https://shop.test' });
    await host.save({ reason: 'add-api' });
    await host.mutate({ kind: 'add-rest-request', apiId: api.createdId ?? '', name: 'List' });
    await host.save({ reason: 'add-rest-request' });
  }
  await host.mutate({ kind: 'rename-project', name: 'Renamed' });
  await host.save({ reason: 'rename-project' });
  await host.close();
  return { opened, error };
}

describe('a kind switched off keeps its project-level files', () => {
  it('rest=off: the webhook collection is a placeholder, refused, and never rewritten', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'wirebench-rest-off-')), 'Hooks');
    const seed = new ProjectHost(new EngineService(), testHooks());
    await seed.create({ dir, name: 'Hooks' });
    await seed.mutate({ kind: 'ensure-webhooks' });
    await seed.mutate({ kind: 'add-webhook-folder', name: 'Orders' });
    await seed.mutate({ kind: 'add-webhook-request', name: 'Created' });
    await seed.save({ reason: 'seed' });
    await seed.close();
    const before = await filesUnder(join(dir, 'webhooks'));
    expect(Object.keys(before).length).toBeGreaterThan(0);

    const { opened, error } = await changeEverythingElse(dir, 'rest', { kind: 'add-webhook-folder', name: 'Refunds' });

    expect(opened.webhooks).toBeUndefined();
    expect(opened.unsupported).toEqual([
      { dir: 'webhooks', slug: 'webhooks', kind: 'rest', reason: 'feature-disabled', name: 'Webhooks' },
    ]);
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe('feature-disabled');
    expect(await filesUnder(join(dir, 'webhooks'))).toEqual(before);
  });

  it('soap=off: the WS-Security configurations are a placeholder, refused, and never rewritten', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'wirebench-soap-off-')), 'Secure');
    const seed = new ProjectHost(new EngineService(), testHooks());
    await seed.create({ dir, name: 'Secure' });
    await seed.mutate({ kind: 'add-wss-outgoing', name: 'Sign' });
    await seed.mutate({ kind: 'add-wss-incoming', name: 'Verify' });
    await seed.save({ reason: 'seed' });
    await seed.close();
    const before = await filesUnder(join(dir, 'wss'));
    expect(Object.keys(before).length).toBeGreaterThan(0);

    const { opened, error } = await changeEverythingElse(dir, 'soap', { kind: 'add-wss-outgoing', name: 'Encrypt' });

    expect(opened.wssOutgoing).toEqual([]);
    expect(opened.wssIncoming).toEqual([]);
    expect(opened.unsupported).toEqual([
      { dir: 'wss', slug: 'wss', kind: 'soap', reason: 'feature-disabled', name: 'WS-Security configurations' },
    ]);
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe('feature-disabled');
    expect(await filesUnder(join(dir, 'wss'))).toEqual(before);
  });
});
