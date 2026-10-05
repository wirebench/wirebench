import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  loadProject,
  projectFiles,
  saveProject,
} from '../../../src/index.js';
import type { Project } from '../../../src/index.js';
import { tempProjectDir } from './fixture.js';

function webhookProject(): Project {
  return {
    ...createProject('Hooks', { id: 'p1' }),
    properties: { webhookTarget: '' },
    webhooks: createWebhookCollection({
      target: '${webhookTarget}',
      requests: [
        createRestRequest('order.created', {
          id: 'r1',
          slug: 'order-created',
          method: 'POST',
          url: '/orders',
          body: { kind: 'raw', language: 'json', text: '{ "event": "order.created" }' },
        }),
      ],
      folders: [
        createWebhookFolder('Petstore API', {
          id: 'f1',
          slug: 'petstore-api',
          target: '${petstoreTarget}',
          source: { apiId: 'api-1' },
          requests: [
            createRestRequest('newPet', {
              id: 'r2',
              slug: 'new-pet',
              method: 'POST',
              url: '/newPet',
              hook: { kind: 'webhook', name: 'newPet' },
            }),
            createRestRequest('onPetEvent', {
              id: 'r3',
              slug: 'on-pet-event',
              method: 'POST',
              url: '/onPetEvent',
              hook: {
                kind: 'callback',
                operation: 'post /subscriptions',
                name: 'onPetEvent',
                expression: '{$request.body#/callbackUrl}',
              },
            }),
          ],
        }),
      ],
    }),
  };
}

describe('the webhooks/ tree', () => {
  it('is saved at format 8', () => {
    expect(FORMAT_VERSION).toBe(8);
  });

  it('writes webhooks.yaml and a request tree beside it', () => {
    const files = projectFiles(webhookProject());
    expect([...files.keys()].filter((key) => key.startsWith('webhooks/')).sort()).toEqual([
      'webhooks/requests/order-created.body.json',
      'webhooks/requests/order-created.request.yaml',
      'webhooks/requests/petstore-api/folder.yaml',
      'webhooks/requests/petstore-api/new-pet.request.yaml',
      'webhooks/requests/petstore-api/on-pet-event.request.yaml',
      'webhooks/webhooks.yaml',
    ]);
    expect(files.get('webhooks/webhooks.yaml')).toContain('${webhookTarget}');
    expect(files.get('webhooks/requests/petstore-api/folder.yaml')).toContain('apiId: api-1');
    expect(files.get('webhooks/requests/petstore-api/new-pet.request.yaml')).toContain('kind: webhook');
  });

  it('writes nothing under webhooks/ for a project without a collection', () => {
    const files = projectFiles(createProject('Plain', { id: 'p2' }));
    expect([...files.keys()].some((key) => key.startsWith('webhooks/'))).toBe(false);
  });

  it('round-trips, byte-stable', async () => {
    const dir = await tempProjectDir();
    await saveProject(webhookProject(), dir);
    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(project.webhooks).toEqual(webhookProject().webhooks);
    const again = await saveProject(project, dir);
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the files when the collection goes', async () => {
    const dir = await tempProjectDir();
    await saveProject(webhookProject(), dir);
    const { webhooks, ...rest } = webhookProject();
    void webhooks;
    const result = await saveProject(rest, dir);
    expect(
      [
        'webhooks/requests/order-created.body.json',
        'webhooks/requests/order-created.request.yaml',
        'webhooks/requests/petstore-api/folder.yaml',
        'webhooks/requests/petstore-api/new-pet.request.yaml',
        'webhooks/requests/petstore-api/on-pet-event.request.yaml',
        'webhooks/webhooks.yaml',
      ].every((file) => result.removed.includes(file)),
    ).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves a webhooks/requests tree alone when there is no webhooks.yaml', async () => {
    const dir = await tempProjectDir();
    await saveProject(createProject('Plain', { id: 'p4' }), dir);
    await mkdir(join(dir, 'webhooks/requests'), { recursive: true });
    await writeFile(join(dir, 'webhooks/requests/stray.request.yaml'), 'kind: rest\n');
    const result = await saveProject(createProject('Plain', { id: 'p4' }), dir);
    expect(result.removed).not.toContain('webhooks/requests/stray.request.yaml');
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a hook on a request under apis/', async () => {
    const dir = await tempProjectDir();
    await saveProject(createProject('Plain', { id: 'p3' }), dir);
    await mkdir(join(dir, 'apis/a/requests'), { recursive: true });
    await writeFile(join(dir, 'apis/a/api.yaml'), 'kind: rest\nid: a1\nname: A\norder: 0\nbaseUrl: ""\n');
    await writeFile(
      join(dir, 'apis/a/requests/x.request.yaml'),
      'kind: rest\nid: x1\nname: X\norder: 0\nmethod: GET\nurl: /\nhook: { kind: webhook, name: x }\n',
    );
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-file-invalid' });
    await rm(dir, { recursive: true, force: true });
  });
});
