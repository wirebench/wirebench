import { describe, expect, it } from 'vitest';
import {
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
} from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { applyChange } from '../src/main/project-mutations.js';
import { toProjectWire } from '../src/main/project-wire.js';
import {
  cloneRestRequest,
  toEngineSigning,
  updateFolder,
  updateRestRequest,
} from '../src/main/project-rest-mutations.js';
import {
  setWebhookFolderSigning,
  setWebhookFolderTarget,
  updateWebhooks,
} from '../src/main/project-webhook-mutations.js';
import { withDraft } from '../src/main/send/draft.js';
import { projectChangeSchema, restRequestPatchSchema } from '../src/shared/wire-types.js';
import type { WebhookSigningWire } from '../src/shared/wire-types.js';

const HMAC: WebhookSigningWire = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};
const deps = { generate: () => Promise.reject(new Error('not needed')) };

function project(): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    containers: { rest: [createApi('Shop', { id: 'api-1', requests: [createRestRequest('List', { id: 'r1' })] })] },
    webhooks: createWebhookCollection({
      requests: [createRestRequest('Ping', { id: 'w1', method: 'POST' })],
      folders: [
        createWebhookFolder('Orders', {
          id: 'g1',
          requests: [createRestRequest('Paid', { id: 'w2', method: 'POST' })],
        }),
      ],
    }),
  };
}

describe('webhook signing in main (§5.1)', () => {
  it('sets and clears the collection, a folder and an item', () => {
    let p = updateWebhooks(project(), { signing: HMAC }).project;
    expect(p.webhooks?.signing).toEqual(HMAC);
    p = setWebhookFolderSigning(p, 'g1', { mode: 'none' }).project;
    expect(p.webhooks?.folders[0]?.signing).toEqual({ mode: 'none' });
    p = updateRestRequest(p, 'w2', { signing: HMAC }).project;
    expect(p.webhooks?.folders[0]?.requests[0]?.signing).toEqual(HMAC);
    p = updateRestRequest(p, 'w2', { signing: null }).project;
    expect(p.webhooks?.folders[0]?.requests[0]).not.toHaveProperty('signing');
    p = setWebhookFolderSigning(p, 'g1', null).project;
    expect(p.webhooks?.folders[0]).not.toHaveProperty('signing');
    p = updateWebhooks(p, { signing: null }).project;
    expect(p.webhooks).not.toHaveProperty('signing');
  });

  it('keeps signing through an unrelated patch and a clone', () => {
    let p = updateRestRequest(project(), 'w1', { signing: HMAC }).project;
    p = updateRestRequest(p, 'w1', { url: '/ping' }).project;
    expect(p.webhooks?.requests[0]?.signing).toEqual(HMAC);
    const cloned = cloneRestRequest(p, 'w1');
    expect(cloned.project.webhooks?.requests.find((r) => r.id === cloned.createdId)?.signing).toEqual(HMAC);
  });

  it('keeps a folder signing through a rename, a patch and a target change', () => {
    let p = setWebhookFolderSigning(project(), 'g1', HMAC).project;
    p = updateFolder(p, 'g1', { name: 'Orders v2' }).project;
    expect(p.webhooks?.folders[0]?.name).toBe('Orders v2');
    expect(p.webhooks?.folders[0]?.signing).toEqual(HMAC);
    p = updateFolder(p, 'g1', { description: 'paid orders' }).project;
    expect(p.webhooks?.folders[0]?.signing).toEqual(HMAC);
    p = setWebhookFolderTarget(p, 'g1', 'https://hooks.example.test').project;
    expect(p.webhooks?.folders[0]?.signing).toEqual(HMAC);
    p = setWebhookFolderSigning(p, 'g1', { mode: 'none' }).project;
    expect(p.webhooks?.folders[0]?.target).toBe('https://hooks.example.test');
  });

  it('refuses signing on an API request, and a scheme the engine refuses', () => {
    expect(() => updateRestRequest(project(), 'r1', { signing: HMAC })).toThrow(
      expect.objectContaining({ code: 'webhook-signing-not-webhook' }),
    );
    const bad: WebhookSigningWire = {
      ...HMAC,
      scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X Sig' },
    };
    expect(() => updateRestRequest(project(), 'w1', { signing: bad })).toThrow(
      expect.objectContaining({ code: 'webhook-signing-invalid' }),
    );
  });

  it('refuses a CI name the project file would not load', () => {
    for (const secretEnv of ['lower', '1ABC', 'HAS-DASH', 'HAS SPACE']) {
      expect(() => updateWebhooks(project(), { signing: { ...HMAC, secretEnv } })).toThrow(
        expect.objectContaining({ code: 'webhook-signing-invalid' }),
      );
      expect(() => setWebhookFolderSigning(project(), 'g1', { ...HMAC, secretEnv })).toThrow(
        expect.objectContaining({ code: 'webhook-signing-invalid' }),
      );
    }
    const withoutEnv: WebhookSigningWire = {
      mode: 'sign',
      scheme: HMAC.mode === 'sign' ? HMAC.scheme : { kind: 'standard', toleranceSec: 300 },
    };
    expect(updateWebhooks(project(), { signing: withoutEnv }).project.webhooks?.signing).toEqual(withoutEnv);
  });

  it('carries the change kinds through the wire and applyChange', async () => {
    expect(restRequestPatchSchema.parse({ signing: null })).toEqual({ signing: null });
    const change = projectChangeSchema.parse({ kind: 'set-webhook-folder-signing', folderId: 'g1', signing: HMAC });
    expect((await applyChange(project(), change, deps)).project.webhooks?.folders[0]?.signing).toEqual(HMAC);
    const collection = projectChangeSchema.parse({ kind: 'update-webhooks', patch: { signing: { mode: 'none' } } });
    expect((await applyChange(project(), collection, deps)).project.webhooks?.signing).toEqual({ mode: 'none' });
  });

  it('projects signing onto the collection, folder and request wires', () => {
    let p = updateWebhooks(project(), { signing: HMAC }).project;
    p = setWebhookFolderSigning(p, 'g1', { mode: 'none' }).project;
    p = updateRestRequest(p, 'w2', { signing: HMAC }).project;
    const wire = toProjectWire(p, { dir: '/tmp', dirty: false, problems: [], runtime: new Map() });
    expect(wire.webhooks?.signing).toEqual(HMAC);
    expect(wire.folders.find((f) => f.id === 'g1')?.signing).toEqual({ mode: 'none' });
    expect(wire.restRequests.find((r) => r.id === 'w2')?.signing).toEqual(HMAC);
    expect(wire.restRequests.find((r) => r.id === 'w1')).not.toHaveProperty('signing');
  });

  it('applies a draft signing for a send, and null drops it', () => {
    const saved = { ...createRestRequest('Ping', { id: 'w1' }), signing: toEngineSigning(HMAC) };
    expect(withDraft(saved, { signing: { mode: 'none' } }).signing).toEqual({ mode: 'none' });
    expect(withDraft(saved, { signing: null })).not.toHaveProperty('signing');
    expect(withDraft(saved, { url: '/x' }).signing).toEqual(HMAC);
  });
});
