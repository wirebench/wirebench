import { describe, expect, it } from 'vitest';
import {
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  effectiveSigning,
  signingAlong,
  signingSecretMissing,
  signingSecretRef,
  signingSourceLabel,
} from '../../../src/index.js';
import type { WebhookSigning } from '../../../src/index.js';

const hmac = (secretRef: string): WebhookSigning => ({
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef,
  secretEnv: 'ORDERS_SIGNING',
});

function collection(signing?: WebhookSigning) {
  return createWebhookCollection({
    ...(signing !== undefined ? { signing } : {}),
    requests: [
      createRestRequest('Ping', { id: 'r1' }),
      createRestRequest('Own', { id: 'r2', signing: { mode: 'none' } }),
    ],
    folders: [
      createWebhookFolder('Orders', {
        id: 'f1',
        signing: hmac('ref-orders'),
        folders: [createWebhookFolder('Inner', { id: 'f2', requests: [createRestRequest('Deep', { id: 'r3' })] })],
        requests: [createRestRequest('Paid', { id: 'r4', signing: hmac('ref-paid') })],
      }),
    ],
  });
}

describe('effectiveSigning (§5.1)', () => {
  it('is none by default when nothing is set anywhere', () => {
    expect(effectiveSigning(collection(), 'r1')).toEqual({ signing: { mode: 'none' }, from: 'default' });
    expect(effectiveSigning(collection(), 'missing')).toEqual({ signing: { mode: 'none' }, from: 'default' });
  });

  it('takes the item, then the nearest folder, then the collection', () => {
    const c = collection(hmac('ref-root'));
    expect(effectiveSigning(c, 'r1')).toEqual({ signing: hmac('ref-root'), from: 'collection' });
    expect(effectiveSigning(c, 'r2')).toEqual({ signing: { mode: 'none' }, from: 'item', fromName: 'Own' });
    expect(effectiveSigning(c, 'r3')).toEqual({ signing: hmac('ref-orders'), from: 'folder', fromName: 'Orders' });
    expect(effectiveSigning(c, 'r4')).toEqual({ signing: hmac('ref-paid'), from: 'item', fromName: 'Paid' });
  });

  it('resolves an edited copy of an item the same way', () => {
    const c = collection(hmac('ref-root'));
    const [orders] = c.folders;
    // `Paid` signs itself when saved; an unsigned copy of it under the same folder inherits the folder's.
    expect(signingAlong(c, [orders!], createRestRequest('Paid', { id: 'r4' }))).toEqual({
      signing: hmac('ref-orders'),
      from: 'folder',
      fromName: 'Orders',
    });
  });

  it('names where signing is set, and the secret a run reads', () => {
    const c = collection(hmac('ref-root'));
    expect(signingSourceLabel(effectiveSigning(c, 'r1'))).toBe('the Webhooks collection');
    expect(signingSourceLabel(effectiveSigning(c, 'r3'))).toBe('the folder “Orders”');
    expect(signingSourceLabel(effectiveSigning(c, 'r4'))).toBe('the item “Paid”');
    expect(signingSecretRef({ mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretRef: 'r' })).toBe(
      'r',
    );
    expect(
      signingSecretRef({ mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'CI_KEY' }),
    ).toBe('webhook-signing:CI_KEY');
    expect(signingSecretRef({ mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 } })).toBeUndefined();
    const error = signingSecretMissing(effectiveSigning(c, 'r3'));
    expect(error.code).toBe('webhook-signing-secret');
    expect(error.message).toBe('Signing is set on the folder “Orders” but its secret is not set');
  });

  it('keeps signing on a created request, folder and collection', () => {
    expect(createRestRequest('x', { signing: { mode: 'none' } }).signing).toEqual({ mode: 'none' });
    expect(createRestRequest('y').signing).toBeUndefined();
    expect(createWebhookFolder('F').signing).toBeUndefined();
    expect(createWebhookCollection().signing).toBeUndefined();
  });
});
