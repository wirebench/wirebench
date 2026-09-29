import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBHOOK_TARGET,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  effectiveTarget,
  findWebhookRequest,
  hookKey,
  webhookFolders,
  webhookPath,
  webhookRequests,
} from '../../../src/index.js';

function collection() {
  const inner = createWebhookFolder('Inner', {
    id: 'f2',
    requests: [createRestRequest('Deep', { id: 'r3', method: 'POST', url: '/deep' })],
  });
  const group = createWebhookFolder('Petstore API', {
    id: 'f1',
    target: '${petstoreTarget}',
    source: { apiId: 'api-1' },
    folders: [inner],
    requests: [
      createRestRequest('newPet', {
        id: 'r2',
        method: 'POST',
        url: '/newPet',
        hook: { kind: 'webhook', name: 'newPet' },
      }),
    ],
  });
  return createWebhookCollection({
    folders: [group],
    requests: [createRestRequest('order.created', { id: 'r1', method: 'POST', url: '/orders' })],
  });
}

describe('webhook collection', () => {
  it('defaults its target to the webhookTarget property', () => {
    expect(createWebhookCollection().target).toBe(DEFAULT_WEBHOOK_TARGET);
    expect(DEFAULT_WEBHOOK_TARGET).toBe('${webhookTarget}');
  });

  it('walks requests and folders depth-first', () => {
    const c = collection();
    expect(webhookRequests(c).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(webhookFolders(c).map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(findWebhookRequest(c, 'r3')?.name).toBe('Deep');
    expect(findWebhookRequest(c, 'nope')).toBeUndefined();
  });

  it('resolves the target from the nearest folder that sets one', () => {
    const c = collection();
    expect(effectiveTarget(c, webhookPath(c, 'r1')!.chain)).toBe('${webhookTarget}');
    expect(effectiveTarget(c, webhookPath(c, 'r2')!.chain)).toBe('${petstoreTarget}');
    // f2 sets none, so f1's wins.
    expect(effectiveTarget(c, webhookPath(c, 'r3')!.chain)).toBe('${petstoreTarget}');
  });

  it('keeps the hook link on a created request', () => {
    const request = createRestRequest('x', { hook: { kind: 'webhook', name: 'x' } });
    expect(request.hook).toEqual({ kind: 'webhook', name: 'x' });
    expect(createRestRequest('y').hook).toBeUndefined();
  });

  it('keys hooks by kind, name and method, never by the expression', () => {
    expect(hookKey({ kind: 'webhook', name: 'newPet' }, 'POST')).toBe('webhook newPet post');
    expect(
      hookKey({ kind: 'callback', operation: 'post /subscriptions', name: 'onPetEvent', expression: '{$url}' }, 'post'),
    ).toBe('callback post /subscriptions onPetEvent post');
  });
});
