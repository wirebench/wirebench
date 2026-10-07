// @vitest-environment node
/**
 * `certificates.check` end to end through the workspace: a project's REST endpoint is reached over
 * a real TLS handshake (resolved through an environment), its keystore is read from the project
 * folder, and the test certificates — valid for one day — come back as warnings.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestApi } from '@wirebench/engine';
import {
  generateClientCert,
  generateServerCert,
  generateTestCa,
  startTestSoapServer,
  type TestSoapServer,
} from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { registerCertificateChannels } from '../src/main/ipc/certificates.js';
import { WorkspaceService } from '../src/main/workspace-service.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
}));

let root: string;
let server: TestSoapServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-certs-'));
  const ca = generateTestCa();
  const leaf = generateServerCert(ca, { commonName: 'localhost', sans: ['localhost', '127.0.0.1'] });
  server = await startTestSoapServer({ tls: { cert: leaf.certPem, key: leaf.keyPem } });
});

afterEach(async () => {
  await server.close();
  handlers.clear();
  rmSync(root, { recursive: true, force: true });
});

async function workspaceWithEndpointAndKeystore(): Promise<{ service: WorkspaceService; projectId: string }> {
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    picks: new DialogPicks(),
    trash: () => Promise.resolve(),
  });
  await service.create('Workspace');
  const { projectId } = await service.addProject('Billing');
  const host = service.hostFor(projectId);
  // Reached only through an environment's property: the check expands under every environment.
  await host.mutate({ kind: 'add-api', name: 'Pets', baseUrl: '${petsUrl}' });
  await host.mutate({ kind: 'add-api', name: 'Plain', baseUrl: 'http://localhost:1' });
  // Inside a workspace the environments are the workspace's; this one is not even active.
  const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
  await service.mutate({
    kind: 'update-workspace-environment',
    environmentId: createdEnvironmentId as string,
    patch: { properties: { petsUrl: `https://localhost:${new URL(server.url).port}/pets` } },
  });
  expect((host.model()?.apis[0] as RestApi).baseUrl).toBe('${petsUrl}');

  const dir = host.runContextFor('')?.projectDir as string;
  const client = generateClientCert(generateTestCa());
  await mkdir(join(dir, 'certs'), { recursive: true });
  await writeFile(join(dir, 'certs', 'client.pem'), `${client.certPem}\n${client.keyPem}`);
  await host.mutate({ kind: 'add-keystore', path: join(dir, 'certs', 'client.pem'), name: 'Client' });
  return { service, projectId };
}

describe('certificates.check', () => {
  it('reads keystores without probing, and probes the resolved endpoints when asked', async () => {
    const { service, projectId } = await workspaceWithEndpointAndKeystore();
    registerCertificateChannels({
      project: service,
      preferences: { get: () => ({ ssl: { expiryWarningDays: 30 } }) as never },
    });
    type Response = Awaited<ReturnType<WorkspaceService['checkCertificates']>>;
    const check = async (probeEndpoints: boolean): Promise<Response> => {
      const result = (await handlers.get('certificates.check')?.({}, { probeEndpoints })) as {
        ok: boolean;
        value: Response;
      };
      expect(result.ok).toBe(true);
      return result.value;
    };

    const local = await check(false);
    expect(local.probedEndpoints).toBe(false);
    expect(local.warnDays).toBe(30);
    expect(local.certificates.map((cert) => cert.source)).toEqual(['keystore']);
    expect(local.certificates[0]).toMatchObject({ projectId, status: 'expiring', daysLeft: 1 });
    expect(local.certificates[0]?.where).toMatch(/^Client › /);

    const full = await check(true);
    const endpoint = full.certificates.filter((cert) => cert.source === 'endpoint');
    expect(endpoint[0]).toMatchObject({
      projectId,
      where: `localhost:${new URL(server.url).port}`,
      status: 'expiring',
    });
    expect(endpoint[0]?.subject).toContain('CN=localhost');
    expect(full.skipped).toEqual([]);
    // The handshake alone: nothing was sent to the endpoint.
    expect(server.requests).toHaveLength(0);
  });
});
