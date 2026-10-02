// @vitest-environment node
/**
 * A webhook item's signing as a send resolves it (§5.2): the effective signing climbs item → folder →
 * collection, an unsaved draft included. Reading its secret, refusing rather than sending unsigned,
 * and never asking the keychain for a CI-only name (R7) are a send's: send-exchange-rest.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createProject, createRestRequest, createWebhookCollection, createWebhookFolder } from '@wirebench/engine';
import type { Project, WebhookSigning } from '@wirebench/engine';
import { previewRest } from '../src/main/send/exchange.js';
import type { RestRequestPatchWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

const SIGNING: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'standard', toleranceSec: 300 },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};

function project(signing?: WebhookSigning): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    webhooks: createWebhookCollection({
      target: 'https://receiver.test/hooks',
      folders: [
        createWebhookFolder('Orders', {
          id: 'g1',
          ...(signing !== undefined ? { signing } : {}),
          requests: [createRestRequest('Paid', { id: 'w1', method: 'POST', url: '/paid' })],
        }),
      ],
    }),
  };
}

/** The signing a send of `w1` would sign with: undefined when it signs nothing. */
const signingOf = async (p: Project, draft?: RestRequestPatchWire) => {
  const signing = (await previewRest(sendDepsFor(p), 'w1', draft))!.item.signing;
  return signing?.signing.mode === 'sign' ? signing : undefined;
};

describe('signing a webhook send (§5.2)', () => {
  it('reports the effective signing, drafts included, and nothing when it is none', async () => {
    expect(await signingOf(project(SIGNING))).toEqual({ signing: SIGNING, from: 'folder', fromName: 'Orders' });
    expect(await signingOf(project())).toBeUndefined();
    expect(await signingOf(project(SIGNING), { signing: { mode: 'none' } })).toBeUndefined();
  });
});
