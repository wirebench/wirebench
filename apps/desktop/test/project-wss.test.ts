// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import {
  addWssIncoming,
  addWssOutgoing,
  removeWssIncoming,
  removeWssOutgoing,
  updateWssIncoming,
  updateWssOutgoing,
} from '../src/main/project-wss-mutations.js';
import { ProjectService } from '../src/main/project-service.js';
import { RecentProjects } from '../src/main/recent-projects.js';
import type { Project } from '@wirebench/engine';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wirebench-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function newService(secrets?: { get(ref: string): Promise<string | undefined> }): ProjectService {
  return new ProjectService(new EngineService(), new RecentProjects(tempDir('ud')), {}, undefined, undefined, secrets);
}

/** A project with one request, so the ref-clearing and send paths have something to point at. */
function projectWithRequest(base: Project, wssOutgoingRef?: string, wssIncomingRef?: string): Project {
  return {
    ...base,
    interfaces: [
      {
        kind: 'soap' as const,
        id: 'i1',
        name: 'I',
        slug: 'i',
        order: 0,
        definitionUrl: 'http://x',
        cacheDefinition: true,
        targetNamespace: '',
        endpoints: [],
        wsa: { enabled: false, version: '2005/08' as const },
        operations: [
          {
            name: 'Op',
            bindingName: 'B',
            slug: 'op',
            order: 0,
            requests: [
              {
                id: 'r1',
                name: 'Request 1',
                slug: 'request-1',
                order: 0,
                envelopeXml: '<x/>',
                soapVersion: '1.1' as const,
                headers: [],
                attachments: [],
                ...(wssOutgoingRef !== undefined ? { wssOutgoingRef } : {}),
                ...(wssIncomingRef !== undefined ? { wssIncomingRef } : {}),
                properties: { encoding: 'UTF-8' },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as Project;
}

describe('outgoing WS-Security mutations', () => {
  const base = createProject('Demo');

  it('creates a configuration with a unique default name and an id-based file', () => {
    const first = addWssOutgoing(base, {});
    expect(first.project.wss.outgoing[0]?.name).toBe('Outgoing WSS');
    expect(first.project.wss.outgoing[0]?.file).toBe(`wss/outgoing/${first.configId}.yaml`);
    const second = addWssOutgoing(first.project, {});
    expect(second.project.wss.outgoing[1]?.name).toBe('Outgoing WSS 2');
    expect(addWssOutgoing(base, { name: '  Gateway ' }).project.wss.outgoing[0]?.name).toBe('Gateway');
  });

  it('patches fields and replaces the entry list', () => {
    const { project, configId } = addWssOutgoing(base, {});
    const patched = updateWssOutgoing(project, configId, {
      name: 'Gateway',
      actor: 'gw',
      mustUnderstand: true,
      defaultPasswordRef: 'secret:pw',
      entries: [
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        { kind: 'username-token', username: 'bob', passwordType: 'digest', addNonce: true, addCreated: true },
      ],
    });
    expect(patched.wss.outgoing[0]?.document).toMatchObject({
      name: 'Gateway',
      actor: 'gw',
      mustUnderstand: true,
      defaultPasswordRef: 'secret:pw',
    });
    const cleared = updateWssOutgoing(patched, configId, { actor: null, defaultPasswordRef: null, entries: [] });
    expect(cleared.wss.outgoing[0]?.document['actor']).toBeUndefined();
    expect(cleared.wss.outgoing[0]?.document['defaultPasswordRef']).toBeUndefined();
    expect(cleared.wss.outgoing[0]?.document['entries']).toEqual([]);
  });

  it('reports an unknown id', () => {
    expect(() => updateWssOutgoing(base, 'nope', { name: 'x' })).toThrow(/No outgoing WS-Security/);
    expect(() => removeWssOutgoing(base, 'nope')).toThrow(/No outgoing WS-Security/);
  });

  it('clears wssOutgoingRef on every request that selected the removed configuration', () => {
    const { project, configId } = addWssOutgoing(base, {});
    const removed = removeWssOutgoing(projectWithRequest(project, configId), configId);
    expect(removed.wss.outgoing).toHaveLength(0);
    expect(removed.interfaces[0]?.operations[0]?.requests[0]?.wssOutgoingRef).toBeUndefined();
  });
});

describe('ProjectService WS-Security', () => {
  async function openWithConfig(secretRef = 'secret:pw'): Promise<{
    service: ProjectService;
    dir: string;
    requestId: string;
    configId: string;
  }> {
    const dir = tempDir('proj');
    const service = newService({ get: (ref) => Promise.resolve(ref === secretRef ? 'hunter2' : undefined) });
    await service.create({ dir, name: 'Demo' });
    const open = (service as unknown as { open: { project: Project } }).open;
    const added = addWssOutgoing(open.project, { name: 'Gateway' });
    open.project = projectWithRequest(added.project);
    const patched = await service.mutate({
      kind: 'update-wss-outgoing',
      configId: added.configId,
      patch: {
        mustUnderstand: true,
        entries: [
          { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
          {
            kind: 'username-token',
            username: 'bob',
            passwordRef: secretRef,
            passwordType: 'digest',
            addNonce: true,
            addCreated: true,
          },
        ],
      },
    });
    expect(patched.project.wssOutgoing[0]?.entries).toHaveLength(2);
    await service.mutate({
      kind: 'update-request',
      requestId: 'r1',
      patch: { wssOutgoingRef: added.configId },
    });
    return { service, dir, requestId: 'r1', configId: added.configId };
  }

  it('mirrors configurations and the request ref onto the wire', async () => {
    const { service } = await openWithConfig();
    const snapshot = service.snapshot();
    expect(snapshot?.wssOutgoing[0]).toMatchObject({ name: 'Gateway', mustUnderstand: true });
    expect(snapshot?.requests[0]?.wssOutgoingRef).toBeDefined();
    // The password itself never reaches the wire, only its reference.
    expect(JSON.stringify(snapshot?.wssOutgoing)).not.toContain('hunter2');
  });

  it('builds the send-time WS-Security input, resolving the password inside main', async () => {
    const { service, requestId } = await openWithConfig();
    const wss = await service.wssFor(requestId);
    expect(wss?.outgoing?.entries).toHaveLength(2);
    expect(await wss?.ctx.secrets('secret:pw')).toBe('hunter2');
  });

  it('refuses to send when the selected configuration is gone', async () => {
    const { service, requestId, configId } = await openWithConfig();
    await service.mutate({ kind: 'remove-wss-outgoing', configId });
    // The reducer clears the ref, so re-point the request at the now-missing id.
    const open = (service as unknown as { open: { project: Project } }).open;
    open.project = projectWithRequest(open.project, configId);
    await expect(service.wssFor(requestId)).rejects.toThrow(/no longer has/);
  });

  it('applies, previews and removes the header on the editor text', async () => {
    const { service, requestId } = await openWithConfig();
    const envelope =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
    const applied = await service.previewOutgoingWss(requestId, envelope);
    expect(applied).toContain('wsse:Security');
    expect(applied).toContain('wsu:Timestamp');
    expect(service.removeOutgoingWssFrom(requestId, applied)).toBe(envelope);

    const inserted = await service.insertWssEntry(
      requestId,
      { kind: 'timestamp', timeToLiveSeconds: 60, millisecondPrecision: true },
      envelope,
    );
    expect(inserted).toContain('<wsu:Expires>');
  });

  it('writes the configuration to wss/outgoing/<id>.yaml with a passwordRef and no password', async () => {
    const { service, dir, configId } = await openWithConfig();
    await service.save();
    const yaml = await readFile(join(dir, 'wss', 'outgoing', `${configId}.yaml`), 'utf8');
    expect(yaml).toContain('passwordRef: secret:pw');
    expect(yaml).not.toContain('hunter2');
  });
});

describe('incoming WS-Security mutations', () => {
  const base = createProject('Demo');

  it("creates a configuration with this build's defaults and an id-based file", () => {
    const first = addWssIncoming(base, {});
    expect(first.project.wss.incoming[0]?.name).toBe('Incoming WSS');
    expect(first.project.wss.incoming[0]?.file).toBe(`wss/incoming/${first.configId}.yaml`);
    expect(first.project.wss.incoming[0]?.document).toMatchObject({
      requireSignature: false,
      requireTimestamp: false,
      timestampSkewSeconds: 300,
      verifyChain: true,
    });
    expect(addWssIncoming(first.project, {}).project.wss.incoming[1]?.name).toBe('Incoming WSS 2');
    expect(addWssIncoming(base, { name: '  Gateway ' }).project.wss.incoming[0]?.name).toBe('Gateway');
  });

  it('patches fields and clears the optional refs', () => {
    const { project, configId } = addWssIncoming(base, {});
    const patched = updateWssIncoming(project, configId, {
      name: 'Gateway in',
      decryptKeystoreRef: 'k1',
      decryptAlias: 'client',
      decryptKeyPasswordRef: 'secret:key',
      signatureKeystoreRef: 'trust',
      requireSignature: true,
      timestampSkewSeconds: 60,
      verifyChain: false,
    });
    expect(patched.wss.incoming[0]?.document).toMatchObject({
      name: 'Gateway in',
      decryptKeystoreRef: 'k1',
      decryptAlias: 'client',
      decryptKeyPasswordRef: 'secret:key',
      signatureKeystoreRef: 'trust',
      requireSignature: true,
      timestampSkewSeconds: 60,
      verifyChain: false,
    });
    const cleared = updateWssIncoming(patched, configId, {
      decryptKeystoreRef: null,
      decryptAlias: null,
      decryptKeyPasswordRef: null,
      signatureKeystoreRef: '',
    });
    for (const key of ['decryptKeystoreRef', 'decryptAlias', 'decryptKeyPasswordRef', 'signatureKeystoreRef']) {
      expect(cleared.wss.incoming[0]?.document[key]).toBeUndefined();
    }
  });

  it('reports an unknown id', () => {
    expect(() => updateWssIncoming(base, 'nope', { name: 'x' })).toThrow(/No incoming WS-Security/);
    expect(() => removeWssIncoming(base, 'nope')).toThrow(/No incoming WS-Security/);
  });

  it('clears wssIncomingRef on every request that selected the removed configuration', () => {
    const { project, configId } = addWssIncoming(base, {});
    const removed = removeWssIncoming(projectWithRequest(project, undefined, configId), configId);
    expect(removed.wss.incoming).toHaveLength(0);
    expect(removed.interfaces[0]?.operations[0]?.requests[0]?.wssIncomingRef).toBeUndefined();
  });
});

describe('ProjectService incoming WS-Security', () => {
  it('mirrors the configuration and builds a send input for a request that selects only it', async () => {
    const dir = tempDir('proj');
    const service = newService();
    await service.create({ dir, name: 'Demo' });
    const open = (service as unknown as { open: { project: Project } }).open;
    const added = addWssIncoming(open.project, { name: 'Gateway in' });
    open.project = projectWithRequest(added.project);
    await service.mutate({
      kind: 'update-wss-incoming',
      configId: added.configId,
      patch: { signatureKeystoreRef: 'trust', requireSignature: true },
    });
    const { project } = await service.mutate({
      kind: 'update-request',
      requestId: 'r1',
      patch: { wssIncomingRef: added.configId },
    });
    expect(project.wssIncoming[0]).toMatchObject({ name: 'Gateway in', requireSignature: true });
    expect(project.requests[0]?.wssIncomingRef).toBe(added.configId);

    const wss = await service.wssFor('r1');
    expect(wss?.outgoing).toBeUndefined();
    expect(wss?.incoming).toMatchObject({ signatureKeystoreRef: 'trust', requireSignature: true });

    await service.save();
    const yaml = await readFile(join(dir, 'wss', 'incoming', `${added.configId}.yaml`), 'utf8');
    expect(yaml).toContain('signatureKeystoreRef: trust');
  });

  it('refuses to send when the selected incoming configuration is gone', async () => {
    const dir = tempDir('proj');
    const service = newService();
    await service.create({ dir, name: 'Demo' });
    const open = (service as unknown as { open: { project: Project } }).open;
    open.project = projectWithRequest(open.project, undefined, 'gone');
    await expect(service.wssFor('r1')).rejects.toThrow(/no longer has/);
  });
});
