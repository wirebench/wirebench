import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareSend } from '../../../src/run/prepare.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { secretNeedsOf } from '../../../src/run/secret-needs.js';
import { selectRequests } from '../../../src/run/select.js';
import { envVariablesFor } from '../../../src/secrets/env-names.js';
import type { Project, WebhookSigning } from '../../../src/index.js';
import { hooksProject } from '../webhooks/fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'wb-signing-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIGNING: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef: 'ref-hooks',
  secretEnv: 'HOOKS_SIGNING',
};

function signed(signing: WebhookSigning = SIGNING): Project {
  const project = hooksProject();
  return { ...project, webhooks: { ...project.webhooks!, signing } };
}

const context = (project: Project, secrets: Record<string, string>): RunContext => ({
  project,
  projectDir: dir,
  overrides: {},
  getSecret: (ref) => Promise.resolve(secrets[ref]),
});

describe('runner signing (§5.2)', () => {
  it('selects webhook items with their effective signing', () => {
    const [ping] = selectRequests(signed(), ['Webhooks/Ping']).selected;
    expect(ping?.kind === 'rest' ? ping.signing : undefined).toEqual({ signing: SIGNING, from: 'collection' });
  });

  it('asks for the secret under its CI name', () => {
    const selected = selectRequests(signed(), ['Webhooks']).selected;
    expect(secretNeedsOf(selected, signed()).find((need) => need.ref === 'ref-hooks')).toEqual({
      ref: 'ref-hooks',
      envName: 'HOOKS_SIGNING',
      purpose: 'webhook signing secret (the Webhooks collection)',
      usedBy: ['Webhooks/Ping', 'Webhooks/Group/Inner'],
    });
  });

  it('reads exactly WIREBENCH_SECRET_<secretEnv> for a CI-name-only secret', () => {
    const project = signed({ mode: 'sign', scheme: SIGNING.scheme, secretEnv: 'HOOKS_SIGNING' });
    const selected = selectRequests(project, ['Webhooks']).selected;
    const need = secretNeedsOf(selected, project).find((candidate) => candidate.envName === 'HOOKS_SIGNING');
    expect(need).toMatchObject({ ref: 'webhook-signing:HOOKS_SIGNING', envName: 'HOOKS_SIGNING' });
    expect(envVariablesFor(need!)[0]).toBe('WIREBENCH_SECRET_HOOKS_SIGNING');
  });

  it('puts the resolved secret on the send input', async () => {
    const [ping] = selectRequests(signed(), ['Webhooks/Ping']).selected;
    const prepared = await prepareSend(ping!, context(signed(), { 'ref-hooks': 'abc123def456ghi789' }));
    expect(prepared.kind === 'rest' ? prepared.input.sign : undefined).toEqual({
      scheme: SIGNING.scheme,
      secret: 'abc123def456ghi789',
    });
  });

  it('refuses an item whose secret the run was not given', async () => {
    const [ping] = selectRequests(signed(), ['Webhooks/Ping']).selected;
    await expect(prepareSend(ping!, context(signed(), {}))).rejects.toMatchObject({
      code: 'webhook-signing-secret',
      message: 'Signing is set on the Webhooks collection but its secret is not set',
    });
  });

  it('adds nothing for an unsigned item', async () => {
    const [ping] = selectRequests(hooksProject(), ['Webhooks/Ping']).selected;
    const prepared = await prepareSend(ping!, context(hooksProject(), {}));
    expect(prepared.kind === 'rest' ? prepared.input.sign : 'x').toBeUndefined();
  });
});
