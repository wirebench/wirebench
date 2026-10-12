// @vitest-environment node
/**
 * Project-scoped workspace environments (#468) through `WorkspaceService`: every project resolves
 * its sends and runs under its own active environment (never a workspace-wide one), an environment
 * out of a project's scope is refused, removing a project cleans it out of the environments, an
 * import scopes the environments it adds, and moving a project leaves the target's scopes alone.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLocalState, loadWorkspace, workspaceDir } from '@wirebench/engine';
import type { RestApi } from '@wirebench/engine';
import { restApisOf } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { sendToEnvironments } from '../src/main/multi-env-send.js';
import { ExchangeRegistry, previewRest, type SendThroughEngineDeps } from '../src/main/send/exchange.js';
import { WorkspaceService } from '../src/main/workspace-service.js';

let root: string;

function newService(): WorkspaceService {
  return new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    trash: () => Promise.resolve(),
  });
}

/** The service as a send's dependencies see it: the router over every open project. */
function sendDeps(service: WorkspaceService): SendThroughEngineDeps {
  return {
    service: new EngineService(),
    registry: new ExchangeRegistry(),
    project: service,
  };
}

/** Where a send of `requestId` would go, resolved as the send resolves it. */
async function target(service: WorkspaceService, requestId: string): Promise<string | undefined> {
  const preview = await previewRest(sendDeps(service), requestId, undefined);
  return preview === undefined ? undefined : `${preview.input.baseUrl}${preview.input.request.url}`;
}

interface SeededProject {
  readonly id: string;
  readonly slug: string;
  readonly requestId: string;
  /** The `<projectSlug>/<apiSlug>` key a workspace environment overrides the API's base URL under. */
  readonly key: string;
}

/** Adds project `name` with one REST API (`https://<name>.default`) and one request at `/pets`. */
async function addRestProject(service: WorkspaceService, name: string): Promise<SeededProject> {
  const { projectId, workspace } = await service.addProject(name);
  const host = service.hostFor(projectId);
  await host.mutate({ kind: 'add-api', name: 'Pets', baseUrl: `https://${name.toLowerCase()}.default` });
  const api = restApisOf(host.model()!)[0] as RestApi;
  await host.mutate({ kind: 'add-rest-request', apiId: api.id });
  const requestId = (restApisOf(host.model()!)[0] as RestApi).requests[0]?.id as string;
  await host.mutate({ kind: 'update-rest-request', requestId, patch: { url: '/pets' } });
  await host.save();
  const slug = workspace.projects.find((project) => project.id === projectId)?.slug as string;
  return { id: projectId, slug, requestId, key: `${slug}/${api.slug}` };
}

/** Adds an environment overriding each project's API with `https://<project>.<name>`. */
async function addEnvironment(
  service: WorkspaceService,
  name: string,
  projects: readonly SeededProject[],
  scope?: string[],
): Promise<string> {
  const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name });
  const environmentId = createdEnvironmentId as string;
  await service.mutate({
    kind: 'update-workspace-environment',
    environmentId,
    patch: {
      endpoints: Object.fromEntries(projects.map((project) => [project.key, `https://${project.slug}.${name}`])),
      ...(scope !== undefined ? { projects: scope } : {}),
    },
  });
  return environmentId;
}

/** A workspace with projects Billing and CRM, each with one REST request. */
async function twoProjects(): Promise<{
  service: WorkspaceService;
  workspaceId: string;
  billing: SeededProject;
  crm: SeededProject;
}> {
  const service = newService();
  const created = await service.create('Scoped');
  const billing = await addRestProject(service, 'Billing');
  const crm = await addRestProject(service, 'CRM');
  return { service, workspaceId: created.id, billing, crm };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wirebench-scoped-envs-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sends resolve per project', () => {
  it('two projects resolve different URLs under different active environments', async () => {
    const { service, billing, crm } = await twoProjects();
    const dev = await addEnvironment(service, 'dev', [billing, crm]);
    const qa = await addEnvironment(service, 'qa', [billing, crm]);
    await service.setActiveEnvironment({ projectId: billing.id, environmentId: dev });
    await service.setActiveEnvironment({ projectId: crm.id, environmentId: qa });

    expect(await target(service, billing.requestId)).toBe(`https://${billing.slug}.dev/pets`);
    expect(await target(service, crm.requestId)).toBe(`https://${crm.slug}.qa/pets`);
    expect(service.runContextFor(billing.requestId)?.environmentId).toBe(dev);
    expect(service.runContextFor(crm.requestId)?.environmentId).toBe(qa);
    expect(service.sendEnvironments(billing.requestId).activeId).toBe(dev);
    expect(service.sendEnvironments(crm.requestId).activeId).toBe(qa);
    await service.close();
  });

  it('after a reopen, each project resolves its own environment from local.yaml with nothing set', async () => {
    const { service, workspaceId, billing, crm } = await twoProjects();
    const dev = await addEnvironment(service, 'dev', [billing, crm]);
    const qa = await addEnvironment(service, 'qa', [billing, crm]);
    await service.setActiveEnvironment({ projectId: billing.id, environmentId: dev });
    await service.setActiveEnvironment({ projectId: crm.id, environmentId: qa });
    await service.close();
    expect(await loadLocalState(workspaceDir(root, workspaceId))).toEqual({
      version: 3,
      activeEnvironments: { [billing.id]: dev, [crm.id]: qa },
    });

    const reopened = newService();
    const snapshot = await reopened.open(workspaceId);
    // The transitional workspace-wide id names nothing yet; resolution never reads it.
    expect(snapshot.activeEnvironmentId).toBeUndefined();
    expect(await target(reopened, billing.requestId)).toBe(`https://${billing.slug}.dev/pets`);
    expect(await target(reopened, crm.requestId)).toBe(`https://${crm.slug}.qa/pets`);
    expect(reopened.runContextFor(billing.requestId)?.environmentId).toBe(dev);
    expect(reopened.runContextFor(crm.requestId)?.environmentId).toBe(qa);
    await reopened.close();
  });

  it('a run captures its project’s active environment at its start', async () => {
    const { service, billing, crm } = await twoProjects();
    const dev = await addEnvironment(service, 'dev', [billing, crm]);
    const qa = await addEnvironment(service, 'qa', [billing, crm]);
    await service.setActiveEnvironment({ projectId: billing.id, environmentId: dev });

    // What the runner and the sequence runner hold for the whole run.
    const captured = service.runContextFor(billing.requestId);
    await service.setActiveEnvironment({ projectId: billing.id, environmentId: qa });
    await service.setActiveEnvironment({ projectId: crm.id, environmentId: dev });

    expect(captured?.environmentId).toBe(dev);
    expect(captured?.workspace?.workspace.activeEnvironmentId).toBe(dev);
    expect(service.runContextFor(billing.requestId)?.environmentId).toBe(qa);
    await service.close();
  });

  it('a project with no entry resolves under no environment, whatever another project picked', async () => {
    const { service, billing, crm } = await twoProjects();
    const dev = await addEnvironment(service, 'dev', [billing, crm]);
    await service.setActiveEnvironment({ projectId: crm.id, environmentId: dev });

    expect(await target(service, billing.requestId)).toBe('https://billing.default/pets');
    expect(service.runContextFor(billing.requestId)?.environmentId).toBeUndefined();
    await service.close();
  });
});

describe('an environment out of the project’s scope', () => {
  it('is not offered, and an explicit send under it is refused', async () => {
    const { service, billing, crm } = await twoProjects();
    const dev = await addEnvironment(service, 'dev', [billing, crm]);
    const crmOnly = await addEnvironment(service, 'crmonly', [billing, crm], [crm.id]);

    expect(service.sendEnvironments(billing.requestId).environments.map((environment) => environment.id)).toEqual([
      dev,
    ]);
    expect(service.sendEnvironments(crm.requestId).environments.map((environment) => environment.id)).toEqual([
      dev,
      crmOnly,
    ]);
    expect(() => service.runContextFor(billing.requestId, crmOnly)).toThrow(
      expect.objectContaining({ code: 'environment-out-of-scope' }),
    );
    await expect(previewRest(sendDeps(service), billing.requestId, undefined, crmOnly)).rejects.toThrow(
      expect.objectContaining({ code: 'environment-out-of-scope' }),
    );

    const deps = { project: service } as unknown as Pick<RequestChannelDeps, 'project'>;
    const response = await sendToEnvironments(sendDeps(service), deps, {
      batchId: 'scoped',
      requestId: billing.requestId,
      environmentIds: [crmOnly, 'no-such-env'],
    });
    expect(response.results).toEqual([
      expect.objectContaining({
        outcome: 'error',
        environmentId: crmOnly,
        environmentName: 'crmonly',
        code: 'environment-out-of-scope',
      }),
      expect.objectContaining({ outcome: 'error', environmentId: 'no-such-env', code: 'unknown-environment' }),
    ]);
    await service.close();
  });
});

describe('removing a project', () => {
  it('drops it from every scope, its endpoint keys and its active entry, keeping an emptied scope as []', async () => {
    const { service, workspaceId, billing, crm } = await twoProjects();
    const shared = await addEnvironment(service, 'shared', [billing, crm]);
    const both = await addEnvironment(service, 'both', [billing, crm], [billing.id, crm.id]);
    const billingOnly = await addEnvironment(service, 'billingonly', [billing, crm], [billing.id]);
    await service.setActiveEnvironment({ projectId: billing.id, environmentId: billingOnly });
    await service.setActiveEnvironment({ projectId: crm.id, environmentId: shared });

    const after = await service.removeProject(billing.id, { deleteFiles: false });

    const byId = (id: string) => after.environments.find((environment) => environment.id === id);
    expect(byId(shared)?.projects).toBeUndefined();
    expect(byId(both)?.projects).toEqual([crm.id]);
    expect(byId(billingOnly)?.projects).toEqual([]);
    for (const environment of after.environments) {
      expect(Object.keys(environment.endpoints)).toEqual([crm.key]);
    }
    expect(after.activeEnvironments).toEqual({ [crm.id]: shared });

    const dir = workspaceDir(root, workspaceId);
    const { workspace } = await loadWorkspace(dir);
    expect(workspace.environments.find((environment) => environment.id === billingOnly)?.projects).toEqual([]);
    expect(workspace.environments.find((environment) => environment.id === both)?.projects).toEqual([crm.id]);
    expect(workspace.environments.every((environment) => !(billing.key in environment.endpoints))).toBe(true);
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [crm.id]: shared } });
    await service.close();
  });

  it('moving a project to another workspace cleans the source and leaves the target’s scopes alone', async () => {
    const target = newService();
    const targetCreated = await target.create('Target');
    const { createdEnvironmentId } = await target.mutate({ kind: 'add-workspace-environment', name: 'Elsewhere' });
    await target.mutate({
      kind: 'update-workspace-environment',
      environmentId: createdEnvironmentId as string,
      patch: { projects: ['someone-else'] },
    });
    await target.mutate({ kind: 'add-workspace-environment', name: 'Everyone' });
    await target.close();
    const targetDir = workspaceDir(root, targetCreated.id);
    const before = (await loadWorkspace(targetDir)).workspace.environments;

    const { service, billing, crm } = await twoProjects();
    const scoped = await addEnvironment(service, 'scoped', [billing, crm], [billing.id, crm.id]);
    await service.moveProjectToWorkspace(billing.id, targetCreated.id);

    const afterTarget = await loadWorkspace(targetDir);
    expect(afterTarget.workspace.projects.map((project) => project.id)).toContain(billing.id);
    expect(afterTarget.workspace.environments).toEqual(before);
    expect(service.snapshot()?.environments.find((environment) => environment.id === scoped)?.projects).toEqual([
      crm.id,
    ]);
    await service.close();
  });
});

describe('ensureEnvironments for an import into a project', () => {
  it('adds a missing environment scoped to the project, and adds the project to a scoped one it reuses', async () => {
    const { service, billing, crm } = await twoProjects();
    const everyone = await addEnvironment(service, 'Everyone', []);
    const crmOnly = await addEnvironment(service, 'Sandbox', [], [crm.id]);

    await expect(service.ensureEnvironments(['everyone', 'sandbox', 'Fresh'], billing.id)).resolves.toEqual(['Fresh']);

    const environments = service.snapshot()?.environments ?? [];
    const byName = (name: string) => environments.find((environment) => environment.name === name);
    expect(byName('Everyone')?.id).toBe(everyone);
    expect(byName('Everyone')?.projects).toBeUndefined();
    expect(byName('Sandbox')?.id).toBe(crmOnly);
    expect(byName('Sandbox')?.projects).toEqual([crm.id, billing.id]);
    expect(byName('Fresh')?.projects).toEqual([billing.id]);

    // Running it again changes nothing: the project is already in every scope.
    await expect(service.ensureEnvironments(['Sandbox', 'Fresh'], billing.id)).resolves.toEqual([]);
    expect(service.snapshot()?.environments.find((environment) => environment.name === 'Sandbox')?.projects).toEqual([
      crm.id,
      billing.id,
    ]);
    await service.close();
  });
});
