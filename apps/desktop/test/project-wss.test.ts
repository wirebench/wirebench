// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, toWssOutgoingConfig } from '@wirebench/engine';
import { wssEntryWireSchema, type WssEntryWire } from '../src/shared/wire-types.js';
import { EngineService } from '../src/main/engine-service.js';
import {
  addWssIncoming,
  addWssOutgoing,
  removeWssIncoming,
  removeWssOutgoing,
  updateWssIncoming,
  updateWssOutgoing,
} from '../src/main/project-wss-mutations.js';
import { ProjectHost } from '../src/main/project-host.js';
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

function newService(secrets?: { get(ref: string): Promise<string | undefined> }): ProjectHost {
  return new ProjectHost(new EngineService(), {}, undefined, undefined, secrets);
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
                assertions: [],
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

describe('ProjectHost WS-Security', () => {
  async function openWithConfig(secretRef = 'secret:pw'): Promise<{
    service: ProjectHost;
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

  describe('an entry kind this build does not know (#259)', () => {
    const future = {
      kind: 'x509-thumbprint-binding',
      thumbprint: 'ab:cd',
      nested: { keep: [1, 2, { deep: true }] },
    };

    async function openWithFuture(): Promise<{ service: ProjectHost; configId: string }> {
      const dir = tempDir('proj');
      const service = newService();
      await service.create({ dir, name: 'Demo' });
      const added = await service.mutate({ kind: 'add-wss-outgoing', name: 'Future' });
      const configId = added.createdWssOutgoingId as string;
      const open = (service as unknown as { open: { project: Project } }).open;
      open.project = {
        ...open.project,
        wss: {
          ...open.project.wss,
          outgoing: open.project.wss.outgoing.map((ref) =>
            ref.id === configId
              ? {
                  ...ref,
                  document: {
                    ...ref.document,
                    entries: [
                      { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
                      future,
                      { kind: 'signature', keystoreRef: 'k', signatureAlgorithm: 'rsa-sha512' },
                    ],
                  },
                }
              : ref,
          ),
        },
      };
      return { service, configId };
    }

    function storedEntries(service: ProjectHost, configId: string): unknown {
      const open = (service as unknown as { open: { project: Project } }).open;
      return open.project.wss.outgoing.find((ref) => ref.id === configId)?.document['entries'];
    }

    it('mirrors it as an opaque entry, and a malformed known kind the same way', async () => {
      const { service, configId } = await openWithFuture();
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      expect(wire?.entries[1]).toMatchObject({
        kind: 'unknown',
        originalKind: 'x509-thumbprint-binding',
        index: 1,
        unreadable: false,
      });
      expect(wire?.entries[2]).toMatchObject({
        kind: 'unknown',
        originalKind: 'signature',
        index: 2,
        unreadable: true,
      });
    });

    it('keeps it byte-identical through an edit of the rest of the configuration', async () => {
      const { service, configId } = await openWithFuture();
      const before = JSON.stringify(storedEntries(service, configId));
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      const entries = (wire?.entries ?? []).map((entry) =>
        entry.kind === 'timestamp' ? { ...entry, timeToLiveSeconds: 60 } : entry,
      );
      await service.mutate({ kind: 'update-wss-outgoing', configId, patch: { name: 'Renamed', entries } });
      const after = storedEntries(service, configId) as unknown[];
      expect(JSON.stringify(after[1])).toBe(JSON.stringify(future));
      expect(after[2]).toEqual({ kind: 'signature', keystoreRef: 'k', signatureAlgorithm: 'rsa-sha512' });
      expect(after[0]).toMatchObject({ timeToLiveSeconds: 60 });
      expect(JSON.stringify(storedEntries(service, configId))).not.toBe(before);
    });

    it('follows it when the editor reorders, and drops it when the editor removes it', async () => {
      const { service, configId } = await openWithFuture();
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      const [first, second, third] = wire?.entries ?? [];
      await service.mutate({
        kind: 'update-wss-outgoing',
        configId,
        patch: { entries: [second, third, first] as WssEntryWire[] },
      });
      const reordered = storedEntries(service, configId) as unknown[];
      expect(reordered[0]).toEqual(future);
      expect(reordered[2]).toMatchObject({ kind: 'timestamp' });
      const again = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      await service.mutate({
        kind: 'update-wss-outgoing',
        configId,
        patch: { entries: (again?.entries ?? []).filter((entry) => entry.kind !== 'unknown') },
      });
      expect(storedEntries(service, configId)).toEqual([
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
      ]);
    });

    it('refuses an opaque entry whose stored counterpart is gone or changed', async () => {
      const { service, configId } = await openWithFuture();
      await expect(
        service.mutate({
          kind: 'update-wss-outgoing',
          configId,
          patch: {
            entries: [{ kind: 'unknown', originalKind: 'other', index: 1, fingerprint: 'x', unreadable: false }],
          },
        }),
      ).rejects.toThrow(/changed/);
      await expect(
        service.mutate({
          kind: 'update-wss-outgoing',
          configId,
          patch: { entries: [{ kind: 'unknown', originalKind: 'x', index: 9, fingerprint: 'x', unreadable: false }] },
        }),
      ).rejects.toThrow(/changed/);
    });

    function setStored(service: ProjectHost, configId: string, entries: unknown[]): void {
      const open = (service as unknown as { open: { project: Project } }).open;
      open.project = {
        ...open.project,
        wss: {
          ...open.project.wss,
          outgoing: open.project.wss.outgoing.map((ref) =>
            ref.id === configId ? { ...ref, document: { ...ref.document, entries } } : ref,
          ),
        },
      };
    }

    function wireOf(service: ProjectHost, configId: string): WssEntryWire[] {
      return [...(service.snapshot()?.wssOutgoing.find((config) => config.id === configId)?.entries ?? [])];
    }

    const twinA = { kind: 'future-binding', value: 'a' };
    const twinB = { kind: 'future-binding', value: 'b' };

    it('refuses a stale resend after a reorder, even when two opaque entries share a kind', async () => {
      const { service, configId } = await openWithFuture();
      setStored(service, configId, [twinA, twinB]);
      const stale = wireOf(service, configId);
      await service.mutate({
        kind: 'update-wss-outgoing',
        configId,
        patch: { entries: [stale[1], stale[0]] as WssEntryWire[] },
      });
      expect(storedEntries(service, configId)).toEqual([twinB, twinA]);
      await expect(
        service.mutate({ kind: 'update-wss-outgoing', configId, patch: { entries: stale } }),
      ).rejects.toThrow(/changed/);
      expect(storedEntries(service, configId)).toEqual([twinB, twinA]);
    });

    it('refuses a stale resend after a remove, so the removed entry does not come back', async () => {
      const { service, configId } = await openWithFuture();
      setStored(service, configId, [twinA, twinB]);
      const stale = wireOf(service, configId);
      await service.mutate({
        kind: 'update-wss-outgoing',
        configId,
        patch: { entries: [stale[1]] as WssEntryWire[] },
      });
      expect(storedEntries(service, configId)).toEqual([twinB]);
      await expect(
        service.mutate({ kind: 'update-wss-outgoing', configId, patch: { entries: stale } }),
      ).rejects.toThrow(/changed/);
      expect(storedEntries(service, configId)).toEqual([twinB]);
    });

    it('handles a known entry inserted beside an opaque one, and refuses a mirror the insert made stale', async () => {
      const { service, configId } = await openWithFuture();
      setStored(service, configId, [twinA]);
      const stale = wireOf(service, configId);
      const timestamp = { kind: 'timestamp', timeToLiveSeconds: 5, millisecondPrecision: false } as const;
      // The opaque entry keeps its place when a known one is added after it.
      await service.mutate({
        kind: 'update-wss-outgoing',
        configId,
        patch: { entries: [...stale, timestamp] },
      });
      expect(storedEntries(service, configId)).toEqual([twinA, timestamp]);
      // A teammate's insert in front shifts it; the old mirror must not overwrite what is there.
      setStored(service, configId, [timestamp, twinA]);
      await expect(
        service.mutate({ kind: 'update-wss-outgoing', configId, patch: { entries: stale } }),
      ).rejects.toThrow(/changed/);
      expect(storedEntries(service, configId)).toEqual([timestamp, twinA]);
    });

    it('labels a malformed known kind as unreadable rather than newer', async () => {
      const { service, configId } = await openWithFuture();
      setStored(service, configId, [{ kind: 'saml-token', source: 'xml', xml: '<a/>', file: 'a.xml' }]);
      expect(wireOf(service, configId)[0]).toMatchObject({
        kind: 'unknown',
        originalKind: 'saml-token',
        unreadable: true,
      });
    });

    it('writes the unknown entry to wss/outgoing/<id>.yaml and reads it back unchanged', async () => {
      const { service, configId } = await openWithFuture();
      const dir = (service as unknown as { open: { dir: string } }).open.dir;
      const wire = wireOf(service, configId);
      await service.mutate({
        kind: 'update-wss-outgoing',
        configId,
        patch: { name: 'Renamed', entries: wire },
      });
      await service.save();
      const file = join(dir, 'wss', 'outgoing', `${configId}.yaml`);
      const first = await readFile(file, 'utf8');
      const reopened = newService();
      await reopened.openProject(dir);
      const doc = (reopened as unknown as { open: { project: Project } }).open.project.wss.outgoing.find(
        (ref) => ref.id === configId,
      )?.document['entries'] as unknown[];
      // The YAML writer orders keys, so compare the content, then require a stable second save.
      expect(doc[1]).toEqual(future);
      expect(first).toContain('x509-thumbprint-binding');
      expect(first).toContain('thumbprint: ab:cd');
      await reopened.save();
      expect(await readFile(file, 'utf8')).toBe(first);
    });

    it('fails a send or preview of such a configuration with wss-entry-unsupported', async () => {
      const { service, configId } = await openWithFuture();
      const open = (service as unknown as { open: { project: Project } }).open;
      open.project = projectWithRequest(open.project, configId);
      await expect(
        service.previewOutgoingWss(
          'r1',
          '<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/"><e:Body/></e:Envelope>',
        ),
      ).rejects.toMatchObject({ code: 'wss-entry-unsupported' });
    });
  });

  describe('a known entry kind carrying fields a newer build added (#283)', () => {
    const signature = {
      kind: 'signature',
      keystoreRef: 'k',
      signatureAlgorithm: 'rsa-sha256',
      futureField: { keep: [1, 2, { deep: true }] },
      parts: [{ name: 'Body', namespace: 'urn:x', encode: 'Content', futurePartField: 'p' }],
    };

    async function openWith(entries: unknown[]): Promise<{ service: ProjectHost; configId: string }> {
      const dir = tempDir('proj');
      const service = newService();
      await service.create({ dir, name: 'Demo' });
      const added = await service.mutate({ kind: 'add-wss-outgoing', name: 'Future' });
      const configId = added.createdWssOutgoingId as string;
      const open = (service as unknown as { open: { project: Project } }).open;
      open.project = {
        ...open.project,
        wss: {
          ...open.project.wss,
          outgoing: open.project.wss.outgoing.map((ref) =>
            ref.id === configId ? { ...ref, document: { ...ref.document, entries } } : ref,
          ),
        },
      };
      return { service, configId };
    }

    function storedEntries(service: ProjectHost, configId: string): unknown[] {
      const open = (service as unknown as { open: { project: Project } }).open;
      return open.project.wss.outgoing.find((ref) => ref.id === configId)?.document['entries'] as unknown[];
    }

    it('mirrors it as an opaque entry that needs a newer version', async () => {
      const { service, configId } = await openWith([
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        signature,
      ]);
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      expect(wire?.entries[0]).toMatchObject({ kind: 'timestamp' });
      expect(wire?.entries[1]).toMatchObject({
        kind: 'unknown',
        originalKind: 'signature',
        index: 1,
        unreadable: false,
      });
    });

    it('keeps the extra fields byte-identical through an edit of the rest of the configuration', async () => {
      const { service, configId } = await openWith([
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        signature,
      ]);
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      const entries = (wire?.entries ?? []).map((entry) =>
        entry.kind === 'timestamp' ? { ...entry, timeToLiveSeconds: 60 } : entry,
      );
      await service.mutate({ kind: 'update-wss-outgoing', configId, patch: { name: 'Renamed', entries } });
      const after = storedEntries(service, configId);
      expect(JSON.stringify(after[1])).toBe(JSON.stringify(signature));
      expect(after[0]).toMatchObject({ timeToLiveSeconds: 60 });
    });

    it('keeps an encryption entry with an unknown field, and an encryption part stored with token', async () => {
      const encryption = {
        kind: 'encryption',
        keystoreRef: 'k',
        futureField: 1,
        parts: [{ name: 'Body', namespace: 'urn:x', encode: 'Content' }],
      };
      const tokenPart = {
        kind: 'encryption',
        keystoreRef: 'k',
        parts: [{ name: 'Body', namespace: 'urn:x', encode: 'Content', token: true }],
      };
      const { service, configId } = await openWith([
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        encryption,
        tokenPart,
      ]);
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      expect(wire?.entries[1]).toMatchObject({ kind: 'unknown', originalKind: 'encryption', unreadable: false });
      expect(wire?.entries[2]).toMatchObject({ kind: 'unknown', originalKind: 'encryption', unreadable: false });
      const entries = (wire?.entries ?? []).map((entry) =>
        entry.kind === 'timestamp' ? { ...entry, timeToLiveSeconds: 60 } : entry,
      );
      await service.mutate({ kind: 'update-wss-outgoing', configId, patch: { entries } });
      const after = storedEntries(service, configId);
      expect(JSON.stringify(after[1])).toBe(JSON.stringify(encryption));
      expect(JSON.stringify(after[2])).toBe(JSON.stringify(tokenPart));
    });

    it('mirrors every field of each edited kind (drift guard: a schema field the mirror drops fails here)', async () => {
      const full: Record<string, unknown> = {
        timestamp: { kind: 'timestamp', timeToLiveSeconds: 1, millisecondPrecision: true },
        'username-token': {
          kind: 'username-token',
          username: 'u',
          passwordRef: 'p',
          passwordType: 'text',
          addNonce: true,
          addCreated: true,
        },
        signature: {
          kind: 'signature',
          keystoreRef: 'k',
          alias: 'a',
          keyPasswordRef: 'kp',
          keyIdentifierType: 'Thumbprint',
          signatureAlgorithm: 'rsa-sha1',
          digestAlgorithm: 'sha1',
          canonicalization: 'exc-c14n',
          useSingleCertificate: false,
          parts: [{ name: 'Body', namespace: 'urn:x', encode: 'Element', token: true }],
        },
        encryption: {
          kind: 'encryption',
          keystoreRef: 'k',
          alias: 'a',
          keyIdentifierType: 'Thumbprint',
          symmetricAlgorithm: 'aes128-cbc',
          keyTransportAlgorithm: 'rsa-1_5',
          embedKey: true,
          encryptSymmetricKey: false,
          parts: [{ name: 'Body', namespace: 'urn:x', encode: 'Element' }],
        },
      };
      const { service, configId } = await openWith(Object.values(full));
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      const kinds = (wire?.entries ?? []).map((entry) => entry.kind);
      expect(kinds).toEqual(Object.keys(full));
      expect(wire?.entries).toEqual(Object.values(full));
    });

    it('still edits a known entry whose fields are all ones this build knows', async () => {
      const { service, configId } = await openWith([
        {
          kind: 'signature',
          keystoreRef: 'k',
          parts: [{ name: 'Body', namespace: 'urn:x', encode: 'Content', token: true }],
        },
      ]);
      const wire = service.snapshot()?.wssOutgoing.find((config) => config.id === configId);
      expect(wire?.entries[0]?.kind).toBe('signature');
    });
  });

  it('returns the created configuration ids, so the renderer can select what it just added', async () => {
    const dir = tempDir('proj');
    const service = newService();
    await service.create({ dir, name: 'Demo' });

    const outgoing = await service.mutate({ kind: 'add-wss-outgoing', name: 'Gateway' });
    expect(outgoing.createdWssOutgoingId).toBeDefined();
    expect(outgoing.project.wssOutgoing.map((config) => config.id)).toContain(outgoing.createdWssOutgoingId);

    const incoming = await service.mutate({ kind: 'add-wss-incoming', name: 'Responses' });
    expect(incoming.createdWssIncomingId).toBeDefined();
    expect(incoming.project.wssIncoming.map((config) => config.id)).toContain(incoming.createdWssIncomingId);
  });

  it('mirrors configurations and the request ref onto the wire', async () => {
    const { service } = await openWithConfig();
    const snapshot = service.snapshot();
    expect(snapshot?.wssOutgoing[0]).toMatchObject({ name: 'Gateway', mustUnderstand: true });
    expect(snapshot?.requests[0]?.wssOutgoingRef).toBeDefined();
    // The password itself never reaches the wire, only its reference.
    expect(JSON.stringify(snapshot?.wssOutgoing)).not.toContain('hunter2');
  });

  it('carries issued-token, saml-token and the SamlToken part across engine -> wire -> engine unchanged', async () => {
    const dir = tempDir('proj');
    const service = newService();
    await service.create({ dir, name: 'Demo' });
    const added = await service.mutate({ kind: 'add-wss-outgoing', name: 'Tokens' });
    const configId = added.createdWssOutgoingId as string;
    const entries: WssEntryWire[] = [
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.example/issue',
        soapVersion: '1.2',
        trustVersion: '1.3',
        appliesTo: 'urn:svc',
        tokenType: '2.0',
        keyType: 'public-key',
        proofKeystoreRef: 'ks1',
        proofAlias: 'proof',
        credential: { kind: 'username', username: 'bob', passwordRef: 'secret:pw' },
        requestedLifetimeSeconds: 600,
        claims: '<wst:Claims/>',
        tlsKeystoreRef: 'ks2',
      },
      {
        kind: 'saml-token',
        source: 'form',
        version: '2.0',
        issuer: 'urn:i',
        subject: 'alice',
        subjectFormat: 'urn:fmt',
        confirmation: 'holder-of-key',
        audience: 'urn:aud',
        lifetimeSeconds: 300,
        authnContext: 'urn:ctx',
        attributes: [{ name: 'role', nameFormat: 'urn:nf', values: ['a', 'b'] }],
        sign: { keystoreRef: 'ks1', alias: 'k', keyPasswordRef: 'secret:kp', signatureAlgorithm: 'rsa-sha1' },
        proofKeystoreRef: 'ks1',
        proofAlias: 'proof',
      },
      { kind: 'saml-token', source: 'xml', xml: '<saml2:Assertion/>', expandProperties: true },
      { kind: 'saml-token', source: 'xml', file: 'tokens/a.xml', expandProperties: false },
      {
        kind: 'signature',
        keystoreRef: 'ks1',
        keyIdentifierType: 'saml-token',
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
        canonicalization: 'exc-c14n',
        useSingleCertificate: true,
        parts: [
          { name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' },
          { name: 'SamlToken', namespace: '', encode: 'Element', token: true },
        ],
      },
    ];
    const first = await service.mutate({ kind: 'update-wss-outgoing', configId, patch: { entries } });
    const openOf = () => (service as unknown as { open: { project: Project } }).open.project;
    const stored = toWssOutgoingConfig(openOf().wss.outgoing[0] as never).entries;

    const wire = first.project.wssOutgoing[0]?.entries ?? [];
    expect(wire).toHaveLength(entries.length);
    for (const entry of wire) {
      expect(wssEntryWireSchema.safeParse(entry).success).toBe(true);
    }
    expect(wire).toEqual(stored);

    // And back: the renderer sends the mirrored entries again.
    await service.mutate({ kind: 'update-wss-outgoing', configId, patch: { entries: [...wire] } });
    const reread = toWssOutgoingConfig(openOf().wss.outgoing[0] as never).entries;
    expect(reread).toEqual(stored);
    expect(reread).toMatchObject(entries);
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

  describe('SAML tokens from the project and its properties', () => {
    const envelope =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
    const assertion = (issuer: string) =>
      '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0"' +
      ` IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>${issuer}</saml2:Issuer></saml2:Assertion>`;

    async function openWithEntry(entry: WssEntryWire): Promise<{ service: ProjectHost; dir: string }> {
      const dir = tempDir('proj');
      const service = newService();
      await service.create({ dir, name: 'Demo' });
      const open = (service as unknown as { open: { project: Project } }).open;
      const added = addWssOutgoing(open.project, { name: 'Tokens' });
      const withRequest = projectWithRequest(added.project, added.configId);
      open.project = { ...withRequest, properties: { ...withRequest.properties, issuer: 'urn:expanded' } };
      await service.mutate({ kind: 'update-wss-outgoing', configId: added.configId, patch: { entries: [entry] } });
      return { service, dir };
    }

    it('places a token read from a file in the project folder', async () => {
      const { service, dir } = await openWithEntry({
        kind: 'saml-token',
        source: 'xml',
        file: 'tokens/a.xml',
        expandProperties: false,
      });
      mkdirSync(join(dir, 'tokens'));
      writeFileSync(join(dir, 'tokens', 'a.xml'), assertion('urn:from-file'));
      const secured = await service.previewOutgoingWss('r1', envelope);
      expect(secured).toContain('urn:from-file');
    });

    it('refuses a token file outside the project folder with saml-token-file-missing', async () => {
      const { service, dir } = await openWithEntry({
        kind: 'saml-token',
        source: 'xml',
        file: '../outside.xml',
        expandProperties: false,
      });
      writeFileSync(join(dir, '..', 'outside.xml'), assertion('urn:outside'));
      dirs.push(join(dir, '..', 'outside.xml'));
      await expect(service.previewOutgoingWss('r1', envelope)).rejects.toMatchObject({
        code: 'saml-token-file-missing',
        details: { file: '../outside.xml' },
      });
    });

    it('refuses a missing token file with saml-token-file-missing', async () => {
      const { service } = await openWithEntry({
        kind: 'saml-token',
        source: 'xml',
        file: 'tokens/none.xml',
        expandProperties: false,
      });
      await expect(service.previewOutgoingWss('r1', envelope)).rejects.toMatchObject({
        code: 'saml-token-file-missing',
        details: { file: 'tokens/none.xml' },
      });
    });

    it('expands the token against the project properties when it asks to', async () => {
      const { service } = await openWithEntry({
        kind: 'saml-token',
        source: 'xml',
        xml: assertion('${#Project#issuer}'),
        expandProperties: true,
      });
      const secured = await service.previewOutgoingWss('r1', envelope);
      expect(secured).toContain('urn:expanded');
      expect(secured).not.toContain('${');
    });

    it('refuses a token whose property references nothing resolves', async () => {
      const { service } = await openWithEntry({
        kind: 'saml-token',
        source: 'xml',
        xml: assertion('${#Project#nope}'),
        expandProperties: true,
      });
      await expect(service.previewOutgoingWss('r1', envelope)).rejects.toMatchObject({
        code: 'unresolved-properties',
        details: { unresolved: ['${#Project#nope}'] },
      });
    });

    it('lends the same reader and expander to an ad-hoc entry', async () => {
      const { service, dir } = await openWithEntry({
        kind: 'timestamp',
        timeToLiveSeconds: 60,
        millisecondPrecision: false,
      });
      mkdirSync(join(dir, 'tokens'));
      writeFileSync(join(dir, 'tokens', 'b.xml'), assertion('${#Project#issuer}'));
      const inserted = await service.insertWssEntry(
        'r1',
        { kind: 'saml-token', source: 'xml', file: 'tokens/b.xml', expandProperties: true },
        envelope,
      );
      expect(inserted).toContain('urn:expanded');
    });
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

describe('ProjectHost incoming WS-Security', () => {
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
