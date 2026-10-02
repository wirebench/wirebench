// @vitest-environment node
/**
 * A SOAP send that signs with a keystore its user added through the file picker, from outside the
 * project folder: the engine loads it through the desktop's own loader (`keystoreFor`), which
 * honours this session's picks, so the send signs instead of refusing `keystore-outside-project`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '@wirebench/engine';
import {
  generateClientCert,
  generateClientPkcs12,
  generateTestCa,
  startTestSoapServer,
  type TestSoapServer,
} from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import { sendDepsFor } from './helpers/send-deps.js';

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

describe('a SOAP send signing with a picked keystore', () => {
  it('signs through the engine with a keystore outside the project folder', async () => {
    const picks = new DialogPicks();
    const host = new ProjectHost(
      new EngineService(),
      {},
      undefined,
      undefined,
      { get: () => Promise.resolve(PASSWORD) },
      undefined,
      picks,
    );
    await host.create({ dir: tempDir('proj'), name: 'Demo' });
    const imported = await host.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
    await host.whenHydrated();
    const requestId = imported.project.requests[0]?.id as string;

    const ca = generateTestCa();
    const path = join(tempDir('outside'), 'signer.p12');
    await writeFile(path, generateClientPkcs12(ca, generateClientCert(ca), { password: PASSWORD }));
    picks.rememberRead(path);
    const added = await host.mutate({ kind: 'add-keystore', path, passwordSecretRef: 'secret:1' });
    const keystoreId = added.createdKeystoreId as string;
    const outgoing = await host.mutate({ kind: 'add-wss-outgoing', name: 'Signer' });
    const configId = outgoing.createdWssOutgoingId as string;
    await host.mutate({
      kind: 'update-wss-outgoing',
      configId,
      patch: {
        entries: [
          {
            kind: 'signature',
            keystoreRef: keystoreId,
            alias: 'client',
            keyIdentifierType: 'BinarySecurityToken',
            signatureAlgorithm: 'rsa-sha256',
            digestAlgorithm: 'sha256',
            canonicalization: 'exc-c14n',
            useSingleCertificate: true,
            parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
          },
        ],
      },
    });
    await host.mutate({ kind: 'update-request', requestId, patch: { wssOutgoingRef: configId } });

    const model = host.runContextFor(requestId)?.project;
    if (model === undefined) throw new Error('no project is open');
    const deps = sendDepsFor(model, {
      preferences: () => DEFAULT_PREFERENCES,
      project: {
        runContextFor: (id, envId) => host.runContextFor(id, envId),
        keystoreFor: (_projectId, id) => host.keystoreFor(id),
      },
    });

    const summary = await sendThroughEngine(deps, 's1', requestId, { draft: { kind: 'soap' } });

    expect(summary.http.status).toBe(200);
    const sent = server.requests.at(-1)?.body.toString('utf8') ?? '';
    expect(sent).toContain('SignatureValue');
    expect(sent).toContain('BinarySecurityToken');
    await host.close();
  });
});
