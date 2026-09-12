// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspace } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';

/** What the next folder picker answers; `undefined` is a cancelled dialog. */
let folderPick: string | undefined;

vi.mock('electron', () => ({
  // The e2e dialog overrides are honoured only in an unpackaged run.
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: {
    showOpenDialog: () =>
      Promise.resolve(
        folderPick === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folderPick] },
      ),
  },
}));

/** The interface's WSDL is served by `primary`; `secondary` is what an environment redirects to. */
let primary: TestSoapServer;
let secondary: TestSoapServer;
let root: string;
let picks: DialogPicks;
let engine: EngineService;

/** A stand-in for a `WebContents`; the picker only ever uses it to find the parent window. */
const SENDER = {} as Parameters<WorkspaceService['linkProject']>[0];

function newService(overrides: Partial<WorkspaceServiceDeps> = {}): WorkspaceService {
  return new WorkspaceService({
    userDataDir: root,
    engine,
    history: new HistoryService(root),
    picks,
    trash: () => Promise.resolve(),
    ...overrides,
  });
}

/** POST requests only: the WSDL import itself is a GET, and never a send. */
function posts(server: TestSoapServer): readonly { body: Buffer }[] {
  return server.requests.filter((request) => request.method === 'POST');
}

/**
 * A workspace with one internal project named `Calc`, the calculator interface imported into
 * it from {@link primary}.
 */
async function workspaceWithCalculator(): Promise<{
  service: WorkspaceService;
  projectId: string;
  requestId: string;
  interfaceSlug: string;
}> {
  const service = newService();
  await service.create('Workspace');
  const { projectId } = await service.addProject('Calc');
  const host = service.hostFor(projectId);
  await host.addInterface({ source: { kind: 'url', url: primary.wsdlUrl } });
  await host.whenHydrated();
  const project = host.snapshot();
  return {
    service,
    projectId,
    requestId: project?.requests[0]?.id as string,
    interfaceSlug: project?.interfaces[0]?.slug as string,
  };
}

/** Sends `requestId` exactly as `request.send` would: the host's input, the host's scopes. */
async function sendThroughHost(service: WorkspaceService, projectId: string, requestId: string): Promise<void> {
  const host = service.hostFor(projectId);
  const input = host.sendInputFor(requestId);
  if (input === undefined) {
    throw new Error('the host resolved no send input');
  }
  await engine.send({ sendId: `send-${requestId}`, requestId, input }, { scopes: host.scopesFor() });
}

/** A standalone project folder with its own `dev` environment, ready to be linked. */
async function seedLinkedProject(name: string, properties: Record<string, string>): Promise<string> {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'wirebench-linked-'))), name);
  const host = new ProjectHost(engine);
  await host.create({ dir, name });
  await host.addInterface({ source: { kind: 'url', url: primary.wsdlUrl } });
  await host.whenHydrated();
  const added = await host.mutate({ kind: 'add-environment', name: 'dev' });
  const environmentId = added.project.environments.find((environment) => environment.slug === 'dev')?.id as string;
  await host.mutate({ kind: 'update-environment', environmentId, patch: { properties } });
  await host.save();
  await host.close();
  return dir;
}

beforeEach(async () => {
  [primary, secondary] = await Promise.all([
    startTestSoapServer({ fixture: 'calculator' }),
    startTestSoapServer({ fixture: 'calculator' }),
  ]);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wirebench-environments-')));
  picks = new DialogPicks();
  engine = new EngineService();
  folderPick = undefined;
});

afterEach(async () => {
  await Promise.all([primary.close(), secondary.close()]);
  rmSync(root, { recursive: true, force: true });
});

describe('workspace environment routing', () => {
  it('sends to the environment endpoint override rather than the interface default', async () => {
    const { service, projectId, requestId, interfaceSlug } = await workspaceWithCalculator();
    const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
    const environmentId = createdEnvironmentId as string;
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId,
      patch: { endpoints: { [`Calc/${interfaceSlug}`]: `${secondary.url}/soap` } },
    });

    // Nothing is redirected until the environment is actually active.
    expect(service.hostFor(projectId).sendInputFor(requestId)?.endpoint).toBe(`${primary.url}/soap`);

    await service.setActiveEnvironment(environmentId);
    expect(service.hostFor(projectId).sendInputFor(requestId)?.endpoint).toBe(`${secondary.url}/soap`);
    expect(service.hostFor(projectId).preflight(requestId).endpointSource).toBe('workspace-environment');

    await sendThroughHost(service, projectId, requestId);

    expect(posts(secondary)).toHaveLength(1);
    expect(posts(primary)).toHaveLength(0);

    await service.close();
  }, 60_000);

  it("lets a linked project's own dev environment win over the workspace's for the same property", async () => {
    const { service, requestId } = await workspaceWithCalculator();
    folderPick = await seedLinkedProject('Linked', { region: 'us-east' });
    const workspace = await service.linkProject(SENDER);
    const linkedId = workspace?.projects.find((project) => project.source === 'linked')?.id as string;

    const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
    const environmentId = createdEnvironmentId as string;
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId,
      patch: { properties: { region: 'emea' } },
    });
    await service.setActiveEnvironment(environmentId);

    const linkedRequestId = service.projectSnapshot(linkedId)?.requests[0]?.id as string;
    expect(service.scopesFor(linkedRequestId).env?.region).toBe('us-east');
    // The internal project has no environments of its own, so it sees the workspace's value.
    expect(service.scopesFor(requestId).env?.region).toBe('emea');

    await service.close();
  }, 60_000);
});

describe('workspace properties', () => {
  it('expands ${#Workspace#region} in a header and reports ${#Workspace#missing} in the preflight', async () => {
    const { service, projectId, requestId, interfaceSlug } = await workspaceWithCalculator();
    await service.mutate({ kind: 'set-workspace-property', name: 'region', value: 'emea' });
    const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: createdEnvironmentId as string,
      patch: { endpoints: { [`Calc/${interfaceSlug}`]: `${secondary.url}/soap` } },
    });
    await service.setActiveEnvironment(createdEnvironmentId as string);

    const host = service.hostFor(projectId);
    await host.mutate({
      kind: 'update-request',
      requestId,
      patch: {
        headers: [
          { name: 'X-Region', value: '${#Workspace#region}' },
          { name: 'X-Missing', value: '${#Workspace#missing}' },
        ],
      },
    });

    expect(host.scopesFor().workspace).toEqual({ region: 'emea' });
    expect(host.preflight(requestId).unresolved.map((ref) => ref.expr)).toEqual(['${#Workspace#missing}']);

    await sendThroughHost(service, projectId, requestId);

    expect(secondary.requests.at(-1)?.headers['x-region']).toBe('emea');

    await service.close();
  }, 60_000);
});

describe('workspace environment disabled properties', () => {
  it('a disabled workspace-env property falls through to the workspace value on the next send', async () => {
    const { service, projectId, requestId, interfaceSlug } = await workspaceWithCalculator();
    await service.mutate({ kind: 'set-workspace-property', name: 'region', value: 'emea' });
    const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
    const environmentId = createdEnvironmentId as string;
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId,
      patch: { properties: { region: 'us' }, endpoints: { [`Calc/${interfaceSlug}`]: `${secondary.url}/soap` } },
    });
    await service.setActiveEnvironment(environmentId);

    const host = service.hostFor(projectId);
    await host.mutate({
      kind: 'update-request',
      requestId,
      patch: { headers: [{ name: 'X-Region', value: '${region}' }] },
    });

    expect(host.scopesFor().env).toEqual({ region: 'us' });
    await sendThroughHost(service, projectId, requestId);
    expect(secondary.requests.at(-1)?.headers['x-region']).toBe('us');

    // Disabling the env-level property (whole-list replace, like `properties`/`endpoints`)
    // removes it from `env`, so the shorthand falls through to the workspace's own value.
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId,
      patch: { disabled: ['region'] },
    });

    expect(host.scopesFor().env).toEqual({});
    await sendThroughHost(service, projectId, requestId);
    expect(secondary.requests.at(-1)?.headers['x-region']).toBe('emea');

    // Re-enabling (sending the empty list back) restores the env-level value.
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId,
      patch: { disabled: [] },
    });
    expect(host.scopesFor().env).toEqual({ region: 'us' });

    await service.close();
  }, 60_000);

  it('a disabled workspace property is excluded from the workspace scope', async () => {
    const { service, requestId } = await workspaceWithCalculator();
    await service.mutate({ kind: 'set-workspace-property', name: 'region', value: 'emea' });
    await service.mutate({ kind: 'set-workspace-property-enabled', name: 'region', enabled: false });

    expect(service.scopesFor(requestId).workspace).toEqual({});

    await service.mutate({ kind: 'set-workspace-property-enabled', name: 'region', enabled: true });
    expect(service.scopesFor(requestId).workspace).toEqual({ region: 'emea' });

    await service.close();
  }, 60_000);
});

describe('WorkspaceService.mutate and setActiveEnvironment', () => {
  it('round-trips every change through disk', async () => {
    const { service } = await workspaceWithCalculator();

    await service.mutate({ kind: 'rename-workspace', name: 'Renamed' });
    await service.mutate({ kind: 'set-workspace-property', name: 'region', value: 'emea' });
    await service.mutate({ kind: 'set-workspace-property', name: 'tier', value: 'gold' });
    await service.mutate({ kind: 'remove-workspace-property', name: 'tier' });
    const dev = (await service.mutate({ kind: 'add-workspace-environment', name: 'dev' })).createdEnvironmentId;
    const prod = (await service.mutate({ kind: 'add-workspace-environment', name: 'prod' })).createdEnvironmentId;
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: dev as string,
      patch: {
        name: 'Development',
        properties: { region: 'us' },
        endpoints: { 'Calc/calculator': 'http://x.test' },
        disabled: [],
      },
    });
    await service.setActiveEnvironment(dev as string);

    const dir = service.snapshot()?.dir as string;
    const reload = async (): Promise<Awaited<ReturnType<typeof loadWorkspace>>['workspace']> =>
      (await loadWorkspace(dir)).workspace;

    const saved = await reload();
    expect(saved.name).toBe('Renamed');
    expect(saved.properties).toEqual({ region: 'emea' });
    expect(saved.activeEnvironmentId).toBe(dev);
    expect(saved.environments.map((environment) => environment.name)).toEqual(['Development', 'prod']);
    expect(saved.environments[0]).toMatchObject({
      slug: 'dev',
      properties: { region: 'us' },
      endpoints: { 'Calc/calculator': 'http://x.test' },
    });

    // A patch replaces the whole map, so a key left out of it is gone.
    await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: dev as string,
      patch: { properties: {} },
    });
    expect((await reload()).environments[0]?.properties).toEqual({});

    // Removing the active environment clears the pointer rather than dangling it.
    await service.mutate({ kind: 'remove-workspace-environment', environmentId: dev as string });
    const afterRemoval = await reload();
    expect(afterRemoval.activeEnvironmentId).toBeUndefined();
    expect(afterRemoval.environments.map((environment) => environment.id)).toEqual([prod]);

    await service.setActiveEnvironment(prod as string);
    expect((await reload()).activeEnvironmentId).toBe(prod);
    await service.setActiveEnvironment(null);
    expect((await reload()).activeEnvironmentId).toBeUndefined();

    await service.close();
  }, 60_000);

  it('refuses a change that names an environment the workspace does not have', async () => {
    const { service } = await workspaceWithCalculator();

    await expect(service.setActiveEnvironment('01JNOTANENV')).rejects.toThrow(/No environment with id/);
    await expect(
      service.mutate({ kind: 'remove-workspace-environment', environmentId: '01JNOTANENV' }),
    ).rejects.toThrow(/No environment with id/);

    await service.close();
  }, 60_000);
});
