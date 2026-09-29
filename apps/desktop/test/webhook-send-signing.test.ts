import { describe, expect, it } from 'vitest';
import { createProject, createRestRequest, createWebhookCollection, createWebhookFolder } from '@wirebench/engine';
import type { Project, PropertyScopes, WebhookSigning } from '@wirebench/engine';
import { resolveWebhookSend, webhookSignFor } from '../src/main/webhook-send.js';

const scopes: PropertyScopes = { project: {}, global: {}, system: {} };
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

const resolve = (p: Project, draft?: Parameters<typeof resolveWebhookSend>[0]['draft']) =>
  resolveWebhookSend({
    project: p,
    projectId: 'p1',
    requestId: 'w1',
    scopes,
    newest: () => undefined,
    ...(draft ? { draft } : {}),
  })!;

describe('signing a webhook send (§5.2)', () => {
  it('reports the effective signing, drafts included, and nothing when it is none', () => {
    expect(resolve(project(SIGNING)).webhookSigning).toEqual({ signing: SIGNING, from: 'folder', fromName: 'Orders' });
    expect(resolve(project()).webhookSigning).toBeUndefined();
    expect(resolve(project(SIGNING), { signing: { mode: 'none' } }).webhookSigning).toBeUndefined();
  });

  it('reads the secret from the keychain lookup auth uses', async () => {
    const effective = resolve(project(SIGNING)).webhookSigning;
    const secrets: Record<string, string> = { 'ref-orders': 'abc123def456ghi789' };
    await expect(webhookSignFor(effective, (ref) => Promise.resolve(secrets[ref]))).resolves.toEqual({
      scheme: SIGNING.scheme,
      secret: 'abc123def456ghi789',
    });
    await expect(webhookSignFor(undefined, () => Promise.resolve(undefined))).resolves.toBeUndefined();
  });

  it('refuses rather than send unsigned', async () => {
    const effective = resolve(project(SIGNING)).webhookSigning;
    await expect(webhookSignFor(effective, () => Promise.resolve(undefined))).rejects.toMatchObject({
      code: 'webhook-signing-secret',
      message: 'Signing is set on the folder “Orders” but its secret is not set',
    });
  });

  it('never asks the keychain for a CI-only name: the desktop refuses instead (R7)', async () => {
    const ciOnly: WebhookSigning = { mode: 'sign', scheme: SIGNING.scheme, secretEnv: 'ORDERS_SIGNING' };
    const effective = resolve(project(ciOnly)).webhookSigning;
    const asked: string[] = [];
    await expect(
      webhookSignFor(effective, (ref) => {
        asked.push(ref);
        return Promise.resolve('abc123def456ghi789');
      }),
    ).rejects.toMatchObject({ code: 'webhook-signing-secret' });
    expect(asked).toEqual([]);
  });
});
