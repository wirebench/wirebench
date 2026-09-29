import { describe, expect, it } from 'vitest';
import { envVariablesFor, SIGNING_PSEUDO_REF_PREFIX } from '../../../src/secrets/env-names.js';
import { effectiveSigning, signingSecretMissing, signingSecretRef } from '../../../src/webhooks/model.js';
import { createRestRequest, createWebhookCollection } from '../../../src/index.js';

describe('the CI variable for a signing secret (§5.2)', () => {
  it('reads only WIREBENCH_SECRET_<secretEnv> for a CI-only secret', () => {
    const ref = signingSecretRef({
      mode: 'sign',
      scheme: { kind: 'standard', toleranceSec: 300 },
      secretEnv: 'HOOKS_SIGNING',
    });
    expect(ref).toBe(`${SIGNING_PSEUDO_REF_PREFIX}HOOKS_SIGNING`);
    expect(envVariablesFor({ ref: ref!, envName: 'HOOKS_SIGNING' })).toEqual(['WIREBENCH_SECRET_HOOKS_SIGNING']);
    expect(envVariablesFor({ ref: 'ref-hooks', envName: 'HOOKS_SIGNING' })).toEqual([
      'WIREBENCH_SECRET_HOOKS_SIGNING',
      'WIREBENCH_SECRET_REF_HOOKS',
    ]);
  });

  it('carries the ref on the refusal, for the CLI to name the variable', () => {
    const collection = createWebhookCollection({
      signing: { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'HOOKS_SIGNING' },
      requests: [createRestRequest('Ping', { id: 'w1' })],
    });
    const error = signingSecretMissing(effectiveSigning(collection, 'w1'), 'webhook-signing:HOOKS_SIGNING');
    expect(error.details).toEqual({ from: 'collection', ref: 'webhook-signing:HOOKS_SIGNING' });
  });
});
