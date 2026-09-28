// @vitest-environment node
/**
 * `ProjectHost` sending a webhook item: `restSend` routes an id the APIs do not hold to the webhook
 * collection, `restMeta` names it for History, `restAuthOf` answers for the collection, and the
 * contract checker never runs for it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { webhookCollectionId } from '../src/main/webhook-ids.js';

let dir: string;
let host: ProjectHost;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-host-webhook-'));
  host = new ProjectHost(
    new EngineService(),
    { newestRest: () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    new DialogPicks(),
  );
  await host.create({ dir: join(dir, 'project'), name: 'Hooks' });
});

afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A collection with one folder holding one item, and the target set through its property. */
async function webhookItem(): Promise<{ projectId: string; requestId: string }> {
  await host.mutate({ kind: 'ensure-webhooks' });
  await host.mutate({ kind: 'set-project-property', name: 'webhookTarget', value: 'https://receiver.test/in' });
  await host.mutate({ kind: 'update-webhooks', patch: { auth: { type: 'bearer', tokenRef: 'abc123def456ghi789' } } });
  await host.mutate({ kind: 'add-webhook-folder', name: 'Orders' });
  const folderId = host.model()?.webhooks?.folders[0]?.id as string;
  await host.mutate({
    kind: 'add-webhook-request',
    parentId: folderId,
    name: 'Paid',
    draft: { method: 'POST', url: '/paid' },
  });
  const project = host.model();
  return { projectId: project?.id as string, requestId: project?.webhooks?.folders[0]?.requests[0]?.id as string };
}

describe('ProjectHost sending a webhook item', () => {
  it('resolves the send against the collection target, with the collection credentials', async () => {
    const { requestId } = await webhookItem();
    const resolution = host.restSend(requestId);
    expect(resolution?.input.baseUrl).toBe('https://receiver.test/in');
    expect(resolution?.input.request.url).toBe('/paid');
    expect(resolution?.baseUrlSource).toBe('target');
    expect(resolution?.auth).toMatchObject({ type: 'bearer', tokenRef: 'abc123def456ghi789' });
  });

  it('refuses a target left empty', async () => {
    const { requestId } = await webhookItem();
    await host.mutate({ kind: 'set-project-property', name: 'webhookTarget', value: '' });
    expect(() => host.restSend(requestId)).toThrow(expect.objectContaining({ code: 'webhook-target-missing' }));
  });

  it('names the item for History and never checks it against a contract', async () => {
    const { projectId, requestId } = await webhookItem();
    expect(host.restMeta(requestId)).toEqual({ requestName: 'Paid', apiName: 'Webhooks', folderPath: 'Orders' });
    expect(host.restContractFor(requestId, { method: 'POST', url: 'https://receiver.test/in/paid' })).toBeUndefined();
    expect(host.restAuthOf(webhookCollectionId(projectId))).toMatchObject({ type: 'bearer' });
  });
});
