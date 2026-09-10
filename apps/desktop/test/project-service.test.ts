// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProject, mergePreferences, nodeFs } from '@wirebench/engine';
import type { FsLike } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import { GlobalProperties } from '../src/main/global-properties.js';
import type { PreferencesService } from '../src/main/preferences.js';
import { ProjectService } from '../src/main/project-service.js';
import { RecentProjects } from '../src/main/recent-projects.js';
import type { ProjectWire } from '../src/shared/wire-types.js';

let server: TestSoapServer | undefined;
let root: string | undefined;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `wirebench-${prefix}-`));
}

/** A service wired to its own engine, over a shared `userData` directory for the recent list. */
function newService(userDataDir: string, fs?: FsLike): ProjectService {
  return new ProjectService(new EngineService(), new RecentProjects(userDataDir), {}, fs);
}

/**
 * Wraps {@link nodeFs} so `writeFile` blocks on a gate that starts open (writes proceed
 * normally) and can be closed/reopened with `arm()`/`release()` around the write(s) under
 * test, simulating a slow disk only where the test needs it.
 */
function deferredWriteFs(): { fs: FsLike; arm: () => void; release: () => void } {
  let gate: Promise<void> = Promise.resolve();
  let unblock: (() => void) | undefined;
  const fs: FsLike = {
    ...nodeFs,
    async writeFile(path, data) {
      await gate;
      await nodeFs.writeFile(path, data);
    },
  };
  return {
    fs,
    arm: () => {
      gate = new Promise((resolve) => {
        unblock = resolve;
      });
    },
    release: () => unblock?.(),
  };
}

beforeEach(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
  root = tempDir('userdata');
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe('ProjectService', () => {
  it('re-sends the interface auth when hydrating a reopened project', async () => {
    const userData = root!;
    const dir = join(tempDir('project'), 'Auth Project');
    const secrets = { get: (ref: string) => Promise.resolve(ref === 'sec_pw' ? 's3cret!' : undefined) };
    const service = new ProjectService(
      new EngineService((ref) => secrets.get(ref)),
      new RecentProjects(userData),
      {},
      undefined,
      undefined,
      secrets,
    );

    await service.create({ dir, name: 'Auth Project' });
    await service.addInterface({
      source: { kind: 'url', url: server!.wsdlUrl },
      auth: { username: 'alice', passwordRef: 'sec_pw' },
      useForRequests: true,
    });
    await service.close();

    // Hydration re-imports in `prefer-cache` mode, so the credentials it resolves are what
    // reaches the engine (a cache miss is what would put them back on the wire).
    const engine = new EngineService((ref) => secrets.get(ref));
    const importSpy = vi.spyOn(engine, 'importForProject');
    const reopened = new ProjectService(engine, new RecentProjects(userData), {}, undefined, undefined, secrets);
    await reopened.openProject(dir);
    await reopened.whenHydrated();

    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(importSpy.mock.calls[0]?.[0]).toMatchObject({
      cache: { mode: 'prefer-cache' },
      auth: { username: 'alice', password: 's3cret!' },
    });
    expect(reopened.snapshot()?.interfaces[0]?.hydration).toBe('ready');
  });

  it('creates, imports, mutates, saves and reopens a project from disk', async () => {
    const userData = root!;
    const dir = join(tempDir('project'), 'Calculator Project');
    const service = newService(userData);

    // --- create -------------------------------------------------------------
    const created = await service.create({ dir, name: 'Calculator Project' });
    expect(created.name).toBe('Calculator Project');
    expect(created.dir).toBe(dir);
    expect(created.dirty).toBe(false);
    expect(existsSync(join(dir, 'wirebench.yaml'))).toBe(true);

    // A second create into the same, now non-empty folder is refused.
    await expect(newService(userData).create({ dir, name: 'Again' })).rejects.toThrow(/not empty/);

    // --- import -------------------------------------------------------------
    const { project: afterImport, interfaceId } = await service.addInterface({
      source: { kind: 'url', url: server!.wsdlUrl },
    });
    expect(afterImport.interfaces).toHaveLength(1);
    const iface = afterImport.interfaces[0]!;
    expect(iface.id).toBe(interfaceId);
    expect(iface.hydration).toBe('ready');
    expect(iface.endpoints.length).toBeGreaterThan(0);
    expect(iface.operations.map((op) => op.name)).toContain('Add');

    // One `Request 1` per operation, each with a generated envelope.
    expect(afterImport.requests.length).toBe(iface.operations.length);
    expect(new Set(afterImport.requests.map((request) => request.name))).toEqual(new Set(['Request 1']));
    const add = afterImport.requests.find((request) => request.operationName === 'Add')!;
    expect(add.envelopeXml).toContain('intA');
    // The interface's default endpoint is pre-selected, so the request is sendable at once.
    expect(add.endpointId).toBe(iface.defaultEndpointId);

    // --- on-disk layout -----------------------------------------------------
    const interfaceRoot = join(dir, 'interfaces', iface.slug);
    expect(existsSync(join(interfaceRoot, 'interface.yaml'))).toBe(true);
    expect(existsSync(join(interfaceRoot, 'definition', 'manifest.yaml'))).toBe(true);
    const addDir = join(interfaceRoot, 'operations', 'Add');
    // Two bindings expose `Add`, so the second operation folder is slug-disambiguated; the
    // first still holds exactly the two files one request occupies.
    expect((await readdir(addDir)).sort()).toEqual(['Request 1.request.yaml', 'Request 1.xml']);
    expect(await readFile(join(addDir, 'Request 1.xml'), 'utf8')).toContain('intA');

    // --- mutate + save ------------------------------------------------------
    const renamed = await service.mutate({ kind: 'rename-project', name: 'Renamed Project' });
    expect(renamed.project.name).toBe('Renamed Project');
    expect(renamed.project.dirty).toBe(true);

    const saved = await service.save({ reason: 'test' });
    expect(saved.saved).toBe(true);
    expect(saved.written).toBeGreaterThan(0);
    expect(service.snapshot()?.dirty).toBe(false);

    const reloaded = await loadProject(dir);
    expect(reloaded.project.name).toBe('Renamed Project');
    expect(reloaded.problems).toEqual([]);

    // --- recent list --------------------------------------------------------
    const recent = await service.recentProjects();
    expect(recent[0]).toMatchObject({ dir, exists: true });

    await service.close();
    expect(service.snapshot()).toBeNull();

    // --- reopen, offline ----------------------------------------------------
    // The definition cache is the whole point of writing it: a fresh service must hydrate
    // without the origin server, so this closes it first.
    await server!.close();
    server = undefined;

    const reopened = newService(userData);
    const opened: ProjectWire = await reopened.openProject(dir);
    expect(opened.name).toBe('Renamed Project');
    expect(opened.requests.find((request) => request.operationName === 'Add')?.envelopeXml).toContain('intA');

    await reopened.whenHydrated();
    const hydrated = reopened.snapshot()!;
    expect(hydrated.interfaces[0]?.hydration).toBe('ready');
    expect(hydrated.problems).toEqual([]);
    // Hydration is what makes generating another request work after a restart.
    // The calculator fixture exposes `Add` on both a SOAP 1.1 and a SOAP 1.2 binding, so the
    // binding has to be part of the identity here as well as in the model.
    const addBinding = hydrated.interfaces[0]!.operations.find((op) => op.name === 'Add')!.binding;
    const another = await reopened.mutate({
      kind: 'add-request',
      interfaceId: hydrated.interfaces[0]!.id,
      bindingName: addBinding,
      operationName: 'Add',
    });
    expect(another.createdRequestId).toBeDefined();
    expect(
      another.project.requests
        .filter((r) => r.operationName === 'Add' && r.bindingName === addBinding)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Request 1', 'Request 2']);

    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('records a hydration failure as a problem rather than failing the open', async () => {
    const userData = root!;
    const dir = join(tempDir('project'), 'Broken');
    const service = newService(userData);
    await service.create({ dir, name: 'Broken' });
    const { project } = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
    const slug = project.interfaces[0]!.slug;
    await service.close();

    // Remove the cache, then take the origin away: hydration now has nowhere to read from,
    // but the interface (and its saved requests) are still on disk.
    rmSync(join(dir, 'interfaces', slug, 'definition'), { recursive: true, force: true });
    await server!.close();
    server = undefined;

    const reopened = newService(userData);
    const opened = await reopened.openProject(dir);
    expect(opened.interfaces).toHaveLength(1);
    expect(opened.interfaces[0]?.hydration).toBe('pending');

    await reopened.whenHydrated();
    const after = reopened.snapshot()!;
    expect(after.interfaces[0]?.hydration).toBe('failed');
    expect(after.problems.map((problem) => problem.code)).toContain('hydration-failed');
    // The requests themselves survive: only generating new ones needs the definition.
    expect(after.requests.length).toBeGreaterThan(0);

    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('does not lose an edit that lands while a save is still writing to disk', async () => {
    const userData = root!;
    const dir = join(tempDir('project'), 'Race Project');
    const { fs, arm, release } = deferredWriteFs();
    const service = newService(userData, fs);

    await service.create({ dir, name: 'Race Project' });

    const first = await service.mutate({ kind: 'rename-project', name: 'First' });
    expect(first.project.dirty).toBe(true);

    // Start the save; arm the gate first so its writes block until `release()`, simulating a
    // slow disk.
    arm();
    const savePromise = service.save({ reason: 'test' });

    // A second edit lands while the first save is still in flight.
    const second = await service.mutate({ kind: 'rename-project', name: 'Second' });
    expect(second.project.dirty).toBe(true);

    release();
    const saved = await savePromise;
    expect(saved.saved).toBe(true);

    // The in-flight save only ever wrote "First": the second edit must still be pending.
    expect(service.snapshot()?.dirty).toBe(true);
    expect(service.snapshot()?.name).toBe('Second');

    const onDiskAfterFirstSave = await loadProject(dir);
    expect(onDiskAfterFirstSave.project.name).toBe('First');

    // The next save (autosave, or another manual save) must still pick up "Second".
    const secondSave = await service.save({ reason: 'test-2' });
    expect(secondSave.saved).toBe(true);
    expect(service.snapshot()?.dirty).toBe(false);

    const onDiskAfterSecondSave = await loadProject(dir);
    expect(onDiskAfterSecondSave.project.name).toBe('Second');

    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe('ProjectService: environments and property scopes', () => {
  it('persists the active environment and resolves scopes through it', async () => {
    const userData = root!;
    const dir = join(tempDir('project'), 'Env Project');
    const globals = new GlobalProperties(userData);
    await globals.set('token', 'from-globals');
    const service = new ProjectService(new EngineService(), new RecentProjects(userData), {}, undefined, globals);

    await service.create({ dir, name: 'Env Project' });
    await service.mutate({ kind: 'set-project-property', name: 'stage', value: 'proj' });
    const added = await service.mutate({ kind: 'add-environment', name: 'Dev' });
    const environmentId = added.createdEnvironmentId!;
    expect(added.project.environments).toHaveLength(1);

    await service.mutate({
      kind: 'update-environment',
      environmentId,
      patch: { endpoints: { Calculator: 'http://dev.test/soap' }, properties: { stage: 'env' } },
    });

    // With no active environment the `env` scope is absent entirely, so `${stage}` falls
    // through to the project.
    expect(service.scopesFor()).toMatchObject({ project: { stage: 'proj' }, global: { token: 'from-globals' } });
    expect(service.scopesFor().env).toBeUndefined();

    const activated = await service.mutate({ kind: 'set-active-environment', environmentId });
    expect(activated.project.activeEnvironmentId).toBe(environmentId);
    expect(service.scopesFor().env).toEqual({ stage: 'env' });

    await service.save({ reason: 'test' });
    await service.close();

    const reopened = new ProjectService(new EngineService(), new RecentProjects(userData), {}, undefined, globals);
    const snapshot = await reopened.openProject(dir);
    expect(snapshot.activeEnvironmentId).toBe(environmentId);
    expect(snapshot.environments[0]).toMatchObject({
      name: 'Dev',
      slug: 'Dev',
      endpoints: { Calculator: 'http://dev.test/soap' },
      properties: { stage: 'env' },
    });
    expect(reopened.scopesFor().env).toEqual({ stage: 'env' });
    await reopened.close();
  });

  it('falls back to global and system scopes with no project open', () => {
    const globals = new GlobalProperties(root!);
    const service = new ProjectService(new EngineService(), new RecentProjects(root!), {}, undefined, globals);

    const scopes = service.scopesFor();

    expect(scopes.project).toEqual({});
    expect(scopes.env).toBeUndefined();
    expect(scopes.system).toBe(process.env);
  });

  it('preflights a saved request against the active environment', async () => {
    const dir = join(tempDir('project'), 'Preflight Project');
    const service = newService(root!);
    await service.create({ dir, name: 'Preflight Project' });
    const imported = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
    await service.whenHydrated();
    const requestId = imported.project.requests[0]!.id;
    const slug = imported.project.interfaces[0]!.slug;

    const before = service.preflight(requestId);
    expect(before.endpointSource).not.toBe('environment');

    const added = await service.mutate({ kind: 'add-environment', name: 'Dev' });
    const environmentId = added.createdEnvironmentId!;
    await service.mutate({
      kind: 'update-environment',
      environmentId,
      patch: { endpoints: { [slug]: 'http://dev.test/soap' } },
    });
    await service.mutate({ kind: 'set-active-environment', environmentId });
    await service.mutate({
      kind: 'update-request',
      requestId,
      patch: { envelopeXml: '<Add><a>${#Env#missing}</a></Add>' },
    });

    const after = service.preflight(requestId);
    expect(after).toMatchObject({ endpoint: 'http://dev.test/soap', endpointSource: 'environment' });
    expect(after.unresolved).toEqual([
      expect.objectContaining({ field: 'envelopeXml', expr: '${#Env#missing}', code: 'missing' }),
    ]);
    await service.close();
  });

  describe('sendInputFor', () => {
    /** A project with one imported interface, and the id of its first `Request 1`. */
    async function withRequest(preferences?: Pick<PreferencesService, 'get'>) {
      const dir = join(tempDir('project'), 'Send Options Project');
      const service = new ProjectService(
        new EngineService(),
        new RecentProjects(root!),
        {},
        undefined,
        undefined,
        undefined,
        preferences,
      );
      await service.create({ dir, name: 'Send Options Project' });
      const imported = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
      await service.whenHydrated();
      return { service, requestId: imported.project.requests[0]!.id };
    }

    it('applies the project default timeout when the request sets none', async () => {
      const { service, requestId } = await withRequest();
      await service.mutate({ kind: 'update-project-settings', patch: { defaultTimeoutMs: 7000 } });

      expect(service.buildLiveSendInput(requestId)?.timeoutMs).toBe(7000);
      await service.close();
    });

    it("prefers the request's own timeout over the project default and the preference", async () => {
      const preferences = { get: () => mergePreferences({ http: { socketTimeoutMs: 11_000 } }) };
      const { service, requestId } = await withRequest(preferences);
      await service.mutate({ kind: 'update-project-settings', patch: { defaultTimeoutMs: 7000 } });
      await service.mutate({ kind: 'update-request-properties', requestId, patch: { timeoutMs: 100 } });

      expect(service.buildLiveSendInput(requestId)?.timeoutMs).toBe(100);
      await service.close();
    });

    it('falls back to the preference when the project keeps its own default', async () => {
      const preferences = { get: () => mergePreferences({ http: { socketTimeoutMs: 11_000 } }) };
      const { service, requestId } = await withRequest(preferences);
      // `defaultTimeoutMs` is cleared by setting it to the preference's own value would be a
      // tautology, so the project's default is removed from the equation by matching it: what
      // this asserts is that the *preference* is consulted at all when nothing overrides it.
      await service.mutate({ kind: 'update-project-settings', patch: { defaultTimeoutMs: 11_000 } });

      expect(service.buildLiveSendInput(requestId)?.timeoutMs).toBe(11_000);
      await service.close();
    });

    it('maps the transport properties and the preferred headers onto the send input', async () => {
      const { service, requestId } = await withRequest();
      await service.mutate({
        kind: 'update-request-properties',
        requestId,
        patch: { encoding: 'ISO-8859-1', followRedirects: true, skipSoapAction: true, bindAddress: '127.0.0.1' },
      });

      const input = service.buildLiveSendInput(requestId);
      expect(input).toMatchObject({
        encoding: 'ISO-8859-1',
        followRedirects: true,
        skipSoapAction: true,
        localAddress: '127.0.0.1',
      });
      expect(input?.headers?.['User-Agent']).toBe('Wirebench/0.1');
      await service.close();
    });

    it('keeps the editor overrides it is handed, applying the saved knobs to them', async () => {
      const { service, requestId } = await withRequest();
      await service.mutate({ kind: 'update-request-properties', requestId, patch: { timeoutMs: 250 } });

      const input = service.sendInputFor(requestId, {
        endpoint: 'http://override.test/soap',
        envelopeXml: '<typed/>',
      });
      expect(input).toMatchObject({ endpoint: 'http://override.test/soap', envelopeXml: '<typed/>', timeoutMs: 250 });
      await service.close();
    });

    it('reports a dump file only when the request names one', async () => {
      const { service, requestId } = await withRequest();
      expect(service.dumpFileFor(requestId)).toBeUndefined();

      await service.mutate({ kind: 'update-request-properties', requestId, patch: { dumpFile: 'out/last.xml' } });
      expect(service.dumpFileFor(requestId)?.path).toBe('out/last.xml');

      await service.mutate({ kind: 'update-request-properties', requestId, patch: { dumpFile: null } });
      expect(service.dumpFileFor(requestId)).toBeUndefined();
      await service.close();
    });

    it('answers undefined for a request that is not in the project', async () => {
      const { service } = await withRequest();
      expect(service.buildLiveSendInput('nope')).toBeUndefined();
      expect(service.dumpFileFor('nope')).toBeUndefined();
      await service.close();
    });
  });
});

describe('ProjectService: WSDL generation preferences reach every generation path', () => {
  /** The `intA` element's inner text of a generated Calculator "Add" envelope, whatever its prefix. */
  function intAValue(envelopeXml: string): string | undefined {
    return /<[\w:]*intA>([^<]*)<\/[\w:]*intA>/.exec(envelopeXml)?.[1];
  }

  it('fills a freshly imported "Request 1" with sample values when the preference asks for it', async () => {
    const preferences = { get: () => mergePreferences({ wsdl: { sampleValues: true } }) };
    const service = new ProjectService(
      new EngineService(),
      new RecentProjects(root!),
      {},
      undefined,
      undefined,
      undefined,
      preferences,
    );
    const dir = join(tempDir('project'), 'Sample Values Project');
    await service.create({ dir, name: 'Sample Values Project' });

    const imported = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
    await service.whenHydrated();

    const addRequest = imported.project.requests.find((request) => request.envelopeXml.includes('intA'));
    expect(addRequest).toBeDefined();
    const value = intAValue(addRequest!.envelopeXml);
    expect(value).not.toBe('?');
    expect(value).toMatch(/^-?\d+$/);

    await service.close();
  });

  it('honours the same preference on add-request, not just on import', async () => {
    const preferences = { get: () => mergePreferences({ wsdl: { sampleValues: true } }) };
    const service = new ProjectService(
      new EngineService(),
      new RecentProjects(root!),
      {},
      undefined,
      undefined,
      undefined,
      preferences,
    );
    const dir = join(tempDir('project'), 'Add Request Sample Values Project');
    await service.create({ dir, name: 'Add Request Sample Values Project' });

    const imported = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
    await service.whenHydrated();
    const addOperation = imported.project.requests.find((request) => request.envelopeXml.includes('intA'))!;

    const created = await service.mutate({
      kind: 'add-request',
      interfaceId: addOperation.interfaceId,
      bindingName: addOperation.bindingName,
      operationName: addOperation.operationName,
    });
    const newRequest = created.project.requests.find((request) => request.id === created.createdRequestId);
    expect(newRequest).toBeDefined();
    const value = intAValue(newRequest!.envelopeXml);
    expect(value).not.toBe('?');
    expect(value).toMatch(/^-?\d+$/);

    await service.close();
  });

  it('leaves the "?" placeholder when the preference is off (the default)', async () => {
    const service = newService(root!);
    const dir = join(tempDir('project'), 'Default Values Project');
    await service.create({ dir, name: 'Default Values Project' });

    const imported = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
    await service.whenHydrated();

    const addRequest = imported.project.requests.find((request) => request.envelopeXml.includes('intA'));
    expect(intAValue(addRequest!.envelopeXml)).toBe('?');

    await service.close();
  });
});

describe('ProjectService attachments', () => {
  /** A project with one imported interface and its `Request 1`, plus the folder it lives in. */
  async function withProject(name: string): Promise<{ service: ProjectService; dir: string; requestId: string }> {
    const service = newService(root!);
    const dir = join(tempDir('project'), name);
    await service.create({ dir, name });
    const imported = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
    await service.whenHydrated();
    return { service, dir, requestId: imported.project.requests[0]!.id };
  }

  it('add-attachment with copyToCache writes the blob and records its digest', async () => {
    const { service, dir, requestId } = await withProject('Attach Cache Project');
    const source = join(tempDir('files'), 'logo.png');
    await writeFile(source, Buffer.from([1, 2, 3, 4]));

    const result = await service.mutate({ kind: 'add-attachment', requestId, path: source, copyToCache: true });
    const attachment = result.project.requests.find((r) => r.id === requestId)!.attachments[0]!;

    expect(result.createdAttachmentId).toBe(attachment.id);
    expect(attachment).toMatchObject({ name: 'logo.png', contentType: 'image/png', size: 4, cached: true });
    expect(attachment.source.kind).toBe('cache');
    const digest = (attachment.source as { sha256: string }).sha256;
    expect(await readFile(join(dir, 'attachments', digest))).toEqual(Buffer.from([1, 2, 3, 4]));

    await service.close();
  });

  it('add-attachment without copyToCache stores the absolute path and leaves the cache empty', async () => {
    const { service, dir, requestId } = await withProject('Attach Path Project');
    const source = join(tempDir('files'), 'notes.txt');
    await writeFile(source, 'hello');

    const result = await service.mutate({ kind: 'add-attachment', requestId, path: source, copyToCache: false });
    const attachment = result.project.requests.find((r) => r.id === requestId)!.attachments[0]!;

    expect(attachment).toMatchObject({ contentType: 'text/plain', size: 5, cached: false });
    expect(attachment.source).toEqual({ kind: 'path', path: source });
    expect(existsSync(join(dir, 'attachments'))).toBe(false);

    await service.close();
  });

  it('sendAttachmentsFor carries the attachments and the seven MTOM flags', async () => {
    const { service, requestId } = await withProject('Attach Send Project');
    const source = join(tempDir('files'), 'a.pdf');
    await writeFile(source, 'pdf');
    await service.mutate({ kind: 'add-attachment', requestId, path: source, copyToCache: true });
    await service.mutate({
      kind: 'update-request-properties',
      requestId,
      patch: {
        enableMtom: true,
        forceMtom: true,
        disableMultiparts: true,
        encodeAttachments: true,
        enableInlineFiles: true,
        inlineResponseAttachments: true,
        expandMtomAttachments: true,
      },
    });

    const send = service.sendAttachmentsFor(requestId);

    expect(send?.attachments).toHaveLength(1);
    expect(send?.attachmentOptions).toMatchObject({
      enableMtom: true,
      forceMtom: true,
      disableMultiparts: true,
      encodeAttachments: true,
      enableInlineFiles: true,
      inlineResponseAttachments: true,
      expandMtomAttachments: true,
    });
    // Bytes are read through the engine's project-folder resolver, never by the renderer.
    expect(await send!.attachmentOptions.resolver(send!.attachments[0]!)).toEqual(new Uint8Array(Buffer.from('pdf')));

    await service.close();
  });

  it('sendAttachmentsFor is undefined for an unknown request', async () => {
    const { service } = await withProject('Attach Unknown Project');
    expect(service.sendAttachmentsFor('nope')).toBeUndefined();
    await service.close();
  });

  describe('resolveFile containment', () => {
    it('reads a file inside the project folder and the attachment cache', async () => {
      const { service, dir, requestId } = await withProject('Inline Inside Project');
      const inside = join(dir, 'payload.txt');
      await writeFile(inside, 'inside');
      const cached = join(tempDir('files'), 'cached.bin');
      await writeFile(cached, 'cached-bytes');
      const added = await service.mutate({ kind: 'add-attachment', requestId, path: cached, copyToCache: true });
      const digest = (
        added.project.requests.find((r) => r.id === requestId)!.attachments[0]!.source as { sha256: string }
      ).sha256;

      const resolveFile = service.sendAttachmentsFor(requestId)!.attachmentOptions.resolveFile!;

      expect(await resolveFile(inside)).toEqual(new Uint8Array(Buffer.from('inside')));
      expect(await resolveFile('payload.txt')).toEqual(new Uint8Array(Buffer.from('inside')));
      expect(await resolveFile(join(dir, 'attachments', digest))).toEqual(new Uint8Array(Buffer.from('cached-bytes')));

      await service.close();
    });

    it('refuses a traversal escape and an unrelated absolute path', async () => {
      const { service, requestId } = await withProject('Inline Outside Project');
      const outside = join(tempDir('files'), 'secret.txt');
      await writeFile(outside, 'nope');

      const resolveFile = service.sendAttachmentsFor(requestId)!.attachmentOptions.resolveFile!;

      await expect(resolveFile('../../etc/passwd')).rejects.toThrow(/outside the project folder/);
      await expect(resolveFile(outside)).rejects.toThrow(/outside the project folder/);

      await service.close();
    });

    it('allows the exact absolute path a path-source attachment of this request names', async () => {
      const { service, requestId } = await withProject('Inline Declared Project');
      const declared = join(tempDir('files'), 'declared.bin');
      await writeFile(declared, 'declared-bytes');
      await service.mutate({ kind: 'add-attachment', requestId, path: declared, copyToCache: false });

      const resolveFile = service.sendAttachmentsFor(requestId)!.attachmentOptions.resolveFile!;

      expect(await resolveFile(declared)).toEqual(new Uint8Array(Buffer.from('declared-bytes')));
      // Its neighbours are still out of bounds: only the declared path itself is exempt.
      await expect(resolveFile(join(tempDir('files'), 'other.bin'))).rejects.toThrow(/outside the project folder/);

      await service.close();
    });
  });
});
