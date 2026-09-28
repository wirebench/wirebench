import { describe, expect, it } from 'vitest';
import { createApi, createProject, createRestRequest, createWebhookFolder } from '@wirebench/engine';
import {
  addWebhookFolder,
  addWebhookGroup,
  addWebhookRequest,
  ensureWebhooks,
  setWebhookFolderTarget,
  updateWebhooks,
} from '../src/main/project-webhook-mutations.js';
import {
  cloneRestRequest,
  removeApi,
  removeRestRequest,
  updateRestRequest,
} from '../src/main/project-rest-mutations.js';

const bare = () => createProject('P', { id: 'p1' });

describe('webhook mutations', () => {
  it('creates the collection once and seeds webhookTarget', () => {
    const once = ensureWebhooks(bare()).project;
    expect(once.webhooks?.target).toBe('${webhookTarget}');
    expect(once.properties['webhookTarget']).toBe('');
    const kept = ensureWebhooks({ ...once, properties: { webhookTarget: 'https://x.test' } }).project;
    expect(kept.properties['webhookTarget']).toBe('https://x.test');
  });

  it('adds requests and folders, creating the collection on the way', () => {
    const { project, createdId } = addWebhookRequest(bare(), {});
    expect(project.webhooks?.requests.map((r) => [r.id, r.name, r.method])).toEqual([[createdId, 'Webhook', 'POST']]);
    const folder = addWebhookFolder(project, { name: 'Group' });
    const inside = addWebhookRequest(folder.project, { parentId: folder.createdId });
    expect(inside.project.webhooks?.folders[0]?.requests).toHaveLength(1);
  });

  it('adds a request from a full draft', () => {
    const { project, createdId } = addWebhookRequest(bare(), {
      name: 'payment.succeeded',
      draft: {
        method: 'POST',
        url: '/payments',
        body: { kind: 'raw', language: 'json', text: '{"type":"payment.succeeded"}' },
      },
    });
    const request = project.webhooks?.requests.find((r) => r.id === createdId);
    expect([request?.name, request?.url, request?.body.kind]).toEqual(['payment.succeeded', '/payments', 'raw']);
  });

  it('sets and clears a folder target, and the collection target and auth', () => {
    const folder = addWebhookFolder(bare(), { name: 'G' });
    const set = setWebhookFolderTarget(folder.project, folder.createdId!, 'https://g.test').project;
    expect(set.webhooks?.folders[0]?.target).toBe('https://g.test');
    const cleared = setWebhookFolderTarget(set, folder.createdId!, null).project;
    expect(cleared.webhooks?.folders[0]?.target).toBeUndefined();
    const retarget = updateWebhooks(cleared, { target: 'https://all.test', auth: { type: 'none' } }).project;
    expect([retarget.webhooks?.target, retarget.webhooks?.auth]).toEqual(['https://all.test', { type: 'none' }]);
  });

  it('lets the REST mutations edit, clone and remove webhook items', () => {
    const { project, createdId } = addWebhookRequest(bare(), {});
    const renamed = updateRestRequest(project, createdId!, { name: 'Renamed' }).project;
    expect(renamed.webhooks?.requests[0]?.name).toBe('Renamed');
    const cloned = cloneRestRequest(renamed, createdId!).project;
    expect(cloned.webhooks?.requests).toHaveLength(2);
    const removed = removeRestRequest(cloned, createdId!).project;
    expect(removed.webhooks?.requests).toHaveLength(1);
  });

  it('adds an imported group and unlinks it when its API goes', () => {
    const withApi = { ...bare(), apis: [createApi('Petstore', { id: 'api-1' })] };
    const group = createWebhookFolder('Petstore', {
      id: 'g1',
      source: { apiId: 'api-1' },
      requests: [createRestRequest('newPet', { id: 'r1', hook: { kind: 'webhook', name: 'newPet' } })],
    });
    const grouped = addWebhookGroup(withApi, group).project;
    expect(grouped.webhooks?.folders[0]?.source).toEqual({ apiId: 'api-1' });
    const gone = removeApi(grouped, 'api-1').project;
    expect(gone.webhooks?.folders[0]?.source).toBeUndefined();
    expect(gone.webhooks?.folders[0]?.requests).toHaveLength(1);
  });

  it('gives a second imported group of the same name a unique slug', () => {
    const group = createWebhookFolder('Petstore', { id: 'g1', slug: 'petstore' });
    const twice = addWebhookGroup(addWebhookGroup(bare(), group).project, { ...group, id: 'g2' }).project;
    const slugs = twice.webhooks?.folders.map((f) => f.slug) ?? [];
    expect(slugs[0]).toBe('petstore');
    expect(new Set(slugs).size).toBe(2);
  });
});
