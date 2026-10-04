import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import type { Project, WebhookSigning } from '../../../src/index.js';
import { tempProjectDir } from './fixture.js';

const HMAC: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature', prefix: 'sha256=' },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};
const STANDARD: WebhookSigning = { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'HOOKS' };
const TIMESTAMPED: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'timestamped', header: 'X-Signature', toleranceSec: 120 },
  secretRef: 'ref-paid',
};

function signedProject(): Project {
  return {
    ...createProject('Hooks', { id: 'p1' }),
    properties: { webhookTarget: '' },
    webhooks: createWebhookCollection({
      signing: STANDARD,
      requests: [
        createRestRequest('Ping', { id: 'r1', slug: 'ping', method: 'POST', url: '/ping', signing: { mode: 'none' } }),
      ],
      folders: [
        createWebhookFolder('Orders', {
          id: 'f1',
          slug: 'orders',
          signing: HMAC,
          requests: [
            createRestRequest('Paid', { id: 'r2', slug: 'paid', method: 'POST', url: '/paid', signing: TIMESTAMPED }),
          ],
        }),
      ],
    }),
  };
}

describe('signing in the webhooks/ tree (§5.1)', () => {
  it('is saved at format 7', () => {
    expect(FORMAT_VERSION).toBe(7);
  });

  it('writes signing at every level, references only', () => {
    const files = projectFiles(signedProject());
    expect(files.get('webhooks/webhooks.yaml')).toContain('kind: standard');
    expect(files.get('webhooks/requests/orders/folder.yaml')).toContain('secretEnv: ORDERS_SIGNING');
    expect(files.get('webhooks/requests/orders/folder.yaml')).toContain('prefix: sha256=');
    expect(files.get('webhooks/requests/ping.request.yaml')).toContain('mode: none');
    expect(files.get('webhooks/requests/orders/paid.request.yaml')).toContain('toleranceSec: 120');
  });

  it('round-trips, byte-stable', async () => {
    const dir = await tempProjectDir();
    await saveProject(signedProject(), dir);
    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(project.webhooks).toEqual(signedProject().webhooks);
    const again = await saveProject(project, dir);
    expect(again.written).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses signing on a request under apis/', async () => {
    const dir = await tempProjectDir();
    await saveProject(createProject('Plain', { id: 'p3' }), dir);
    await mkdir(join(dir, 'apis/a/requests'), { recursive: true });
    await writeFile(join(dir, 'apis/a/api.yaml'), 'kind: rest\nid: a1\nname: A\norder: 0\nbaseUrl: ""\n');
    await writeFile(
      join(dir, 'apis/a/requests/x.request.yaml'),
      'kind: rest\nid: x1\nname: X\norder: 0\nmethod: GET\nurl: /\nsigning: { mode: none }\n',
    );
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-file-invalid' });
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a plaintext secret in a signing block', async () => {
    const dir = await tempProjectDir();
    await saveProject(signedProject(), dir);
    const file = join(dir, 'webhooks/webhooks.yaml');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('mode: sign', 'mode: sign\n  secret: abc123def456ghi789'));
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-file-invalid' });
    await rm(dir, { recursive: true, force: true });
  });
});
