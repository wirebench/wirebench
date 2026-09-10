// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '@wirebench/engine';
import {
  generateClientCert,
  generateClientPkcs12,
  generateTestCa,
  startTestSoapServer,
  type TestSoapServer,
} from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import {
  addKeystore,
  keystoreNameFromPath,
  removeKeystore,
  updateKeystore,
} from '../src/main/project-keystore-mutations.js';
import { ProjectService } from '../src/main/project-service.js';
import { RecentProjects } from '../src/main/recent-projects.js';
import { toProjectWire } from '../src/main/project-wire.js';

const PASSWORD = 'p12-password';

let server: TestSoapServer;

beforeAll(async () => {
  server = await startTestSoapServer();
});

afterAll(async () => {
  await server.close();
});
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

function pkcs12Bytes(password = PASSWORD): Uint8Array {
  const ca = generateTestCa();
  return generateClientPkcs12(ca, generateClientCert(ca), { password });
}

function newService(
  userDataDir: string,
  picks?: DialogPicks,
  secrets?: { get(ref: string): Promise<string | undefined> },
) {
  return new ProjectService(
    new EngineService(),
    new RecentProjects(userDataDir),
    {},
    undefined,
    undefined,
    secrets,
    undefined,
    picks,
  );
}

describe('keystore mutations', () => {
  const base = createProject('Demo');

  it('infers the type and defaults the name to the file stem', () => {
    const { project, keystoreId } = addKeystore(base, { path: 'certs/corp.p12' });
    expect(project.wss.keystores).toHaveLength(1);
    expect(project.wss.keystores[0]?.document).toMatchObject({
      id: keystoreId,
      name: 'corp',
      path: 'certs/corp.p12',
      type: 'pkcs12',
    });
  });

  it('takes an explicit name and a password ref', () => {
    const { project } = addKeystore(base, { path: 'a.pem', name: '  Corp  ', passwordSecretRef: 'secret:1' });
    expect(project.wss.keystores[0]?.name).toBe('Corp');
    expect(project.wss.keystores[0]?.document).toMatchObject({ type: 'pem', passwordSecretRef: 'secret:1' });
  });

  it('refuses a file that is not a keystore', () => {
    expect(() => addKeystore(base, { path: 'notes.txt' })).toThrow(/not a recognised keystore/);
  });

  it('patches the name, password ref and default alias', () => {
    const { project, keystoreId } = addKeystore(base, { path: 'a.p12', passwordSecretRef: 'secret:1' });
    const renamed = updateKeystore(project, keystoreId, { name: 'Prod', defaultAlias: 'client' });
    expect(renamed.wss.keystores[0]?.document).toMatchObject({
      name: 'Prod',
      defaultAlias: 'client',
      passwordSecretRef: 'secret:1',
    });
    const cleared = updateKeystore(renamed, keystoreId, { passwordSecretRef: null, defaultAlias: null });
    expect(cleared.wss.keystores[0]?.document['passwordSecretRef']).toBeUndefined();
    expect(cleared.wss.keystores[0]?.document['defaultAlias']).toBeUndefined();
  });

  it('reports an unknown id', () => {
    expect(() => updateKeystore(base, 'nope', { name: 'x' })).toThrow(/No keystore with id/);
    expect(() => removeKeystore(base, 'nope')).toThrow(/No keystore with id/);
  });

  it('clears sslKeystoreRef on every request that selected the removed keystore', () => {
    const { project, keystoreId } = addKeystore(base, { path: 'a.p12' });
    const withRequest = {
      ...project,
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
          wsa: { enabled: false, version: '1.0' as const },
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
                  properties: { sslKeystoreRef: keystoreId, encoding: 'UTF-8' },
                },
              ],
            },
          ],
        },
      ],
    } as unknown as typeof project;

    const removed = removeKeystore(withRequest, keystoreId);
    expect(removed.wss.keystores).toHaveLength(0);
    expect(removed.interfaces[0]?.operations[0]?.requests[0]?.properties.sslKeystoreRef).toBeUndefined();
  });

  it('derives a name from a path with no extension', () => {
    expect(keystoreNameFromPath('/tmp/corp')).toBe('corp');
    expect(keystoreNameFromPath('/tmp/.p12')).toBe('.p12');
  });
});

describe('ProjectService keystores', () => {
  it('refuses a keystore outside the project folder unless it was picked', async () => {
    const dir = tempDir('proj');
    const outside = tempDir('outside');
    const service = newService(tempDir('ud'));
    await service.create({ dir, name: 'Demo' });
    const path = join(outside, 'client.p12');
    await writeFile(path, pkcs12Bytes());

    await expect(service.mutate({ kind: 'add-keystore', path })).rejects.toThrow(/inside the project folder/);

    const picks = new DialogPicks();
    picks.rememberRead(path);
    const picked = newService(tempDir('ud2'), picks);
    await picked.create({ dir: tempDir('proj2'), name: 'Demo' });
    const added = await picked.mutate({ kind: 'add-keystore', path });
    expect(added.createdKeystoreId).toBeDefined();
    expect(added.project.keystores[0]?.type).toBe('pkcs12');
    // The wire projection never carries key material or a password.
    expect(JSON.stringify(added.project.keystores)).not.toContain('PRIVATE KEY');
  });

  it('inspects a keystore inside the project folder and lists its aliases', async () => {
    const dir = tempDir('proj');
    const service = newService(tempDir('ud'), undefined, { get: () => Promise.resolve(PASSWORD) });
    await service.create({ dir, name: 'Demo' });
    await mkdir(join(dir, 'certs'), { recursive: true });
    await writeFile(join(dir, 'certs', 'client.p12'), pkcs12Bytes());
    const added = await service.mutate({
      kind: 'add-keystore',
      path: join(dir, 'certs', 'client.p12'),
      passwordSecretRef: 'secret:1',
    });
    const id = added.createdKeystoreId as string;

    const result = await service.inspectKeystore(id);

    expect(result.status).toBe('ok');
    expect(result.aliases.map((alias) => alias.alias)).toContain('client');
    const client = result.aliases.find((alias) => alias.hasPrivateKey);
    expect(client?.subject).toContain('CN=wirebench-client');
    expect(client?.fingerprintSha256).toContain(':');
    expect(JSON.stringify(result)).not.toContain('BEGIN');
  });

  it('reports bad-password, not-found and a missing file', async () => {
    const dir = tempDir('proj');
    const service = newService(tempDir('ud'), undefined, { get: () => Promise.resolve('wrong') });
    await service.create({ dir, name: 'Demo' });
    await writeFile(join(dir, 'client.p12'), pkcs12Bytes());
    const added = await service.mutate({
      kind: 'add-keystore',
      path: join(dir, 'client.p12'),
      passwordSecretRef: 'secret:1',
    });

    expect((await service.inspectKeystore(added.createdKeystoreId as string)).status).toBe('bad-password');
    expect((await service.inspectKeystore('nope')).status).toBe('not-found');

    const gone = await service.mutate({ kind: 'add-keystore', path: join(dir, 'missing.pem') });
    expect((await service.inspectKeystore(gone.createdKeystoreId as string)).status).toBe('not-found');
  });

  it('reports invalid for a file that is not a keystore at all', async () => {
    const dir = tempDir('proj');
    const service = newService(tempDir('ud'));
    await service.create({ dir, name: 'Demo' });
    await writeFile(join(dir, 'junk.pem'), 'definitely not a certificate');
    const added = await service.mutate({ kind: 'add-keystore', path: join(dir, 'junk.pem') });

    expect((await service.inspectKeystore(added.createdKeystoreId as string)).status).toBe('invalid');
  });

  it('resolves the client identity a request selects, and fails loudly for a broken one', async () => {
    const dir = tempDir('proj');
    const service = newService(tempDir('ud'), undefined, { get: () => Promise.resolve(PASSWORD) });
    await service.create({ dir, name: 'Demo' });
    const imported = await service.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
    await service.whenHydrated();
    const requestId = imported.project.requests[0]?.id as string;
    await writeFile(join(dir, 'client.p12'), pkcs12Bytes());
    const added = await service.mutate({
      kind: 'add-keystore',
      path: join(dir, 'client.p12'),
      passwordSecretRef: 'secret:1',
    });
    const keystoreId = added.createdKeystoreId as string;
    await service.mutate({ kind: 'update-request-properties', requestId, patch: { sslKeystoreRef: keystoreId } });

    const tls = await service.tlsFor(requestId);
    expect(tls?.cert).toContain('BEGIN CERTIFICATE');
    expect(tls?.key).toContain('BEGIN PRIVATE KEY');
    // A client identity is *only* an identity: `ca` would replace Node's trust store wholesale,
    // so selecting a keystore must never change whom the send trusts.
    expect(tls?.ca).toBeUndefined();
    expect(Object.keys(tls ?? {}).sort()).toEqual(['cert', 'key']);
    // The live send input the renderer (and the cURL export) sees carries no key material.
    expect(JSON.stringify(service.buildLiveSendInput(requestId))).not.toContain('BEGIN');

    // Removing the keystore clears the selection rather than leaving a send to fail.
    await service.mutate({ kind: 'remove-keystore', keystoreId });
    expect(await service.tlsFor(requestId)).toBeUndefined();

    // A request pointed at an id the project never had fails the send rather than degrading.
    await service.mutate({ kind: 'update-request-properties', requestId, patch: { sslKeystoreRef: 'ghost' } });
    await expect(service.tlsFor(requestId)).rejects.toThrow(/no longer has/);
    await service.close();
  });

  it('has no TLS options for a request that selects no keystore', async () => {
    const dir = tempDir('proj');
    const service = newService(tempDir('ud'));
    await service.create({ dir, name: 'Demo' });
    expect(await service.tlsFor('unknown-request')).toBeUndefined();
  });

  it('projects a malformed registry entry rather than dropping the row', () => {
    const project = createProject('Demo');
    const broken = {
      ...project,
      wss: { ...project.wss, keystores: [{ id: 'k1', name: 'Legacy', document: { id: 'k1', name: 'Legacy' } }] },
    };
    const wire = toProjectWire(broken, { dir: '/tmp', dirty: false, problems: [], runtime: new Map() });
    expect(wire.keystores).toEqual([{ id: 'k1', name: 'Legacy', path: '', type: 'pem' }]);
  });
});
