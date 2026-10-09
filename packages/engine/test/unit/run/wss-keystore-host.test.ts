/**
 * A SOAP send's WS-Security keystores: a host that lends `keystoreFor` loads every one of them (the
 * app also reads a file its user picked, outside the project folder); without one, the project
 * folder is the whole boundary, as it is for the command line.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Keystore } from '../../../src/keystore/index.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project, SoapRequestDef } from '../../../src/project/model.js';
import type { RunContext } from '../../../src/run/context.js';
import type { SendHost } from '../../../src/run/host.js';
import { resolveSoap, soapItemFor } from '../../../src/soap/run.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { generateClientCert, generateTestCa } from '../../helpers/test-certs.js';
import { testHost } from '../../helpers/send-host.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `wirebench-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** One SOAP request that signs with keystore `ks-1`, which lives at `keystorePath`. */
function projectWith(keystorePath: string): Project {
  const request: SoapRequestDef = {
    kind: 'soap',
    id: 'req-1',
    name: 'Get',
    slug: 'get',
    order: 0,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: '<Envelope/>',
    endpointUrl: 'http://127.0.0.1:1/soap',
    wssOutgoingRef: 'wss-out',
  };
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-1',
    name: 'Test project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [
      {
        kind: 'soap',
        id: 'iface-1',
        name: 'Billing',
        slug: 'Billing',
        order: 0,
        definitionUrl: 'http://example.test/def.wsdl',
        cacheDefinition: false,
        endpoints: [],
        wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
        operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [request] }],
      },
    ],
    apis: [],
    grpcApis: [],
    wsApis: [],
    sequences: [],
    mocks: [],
    environments: [],
    wss: {
      keystores: [
        { id: 'ks-1', name: 'signer', document: { id: 'ks-1', name: 'signer', path: keystorePath, type: 'pem' } },
      ],
      outgoing: [
        {
          id: 'wss-out',
          name: 'Out',
          document: { id: 'wss-out', name: 'Out', entries: [{ kind: 'timestamp', timeToLiveSeconds: 300 }] },
        },
      ],
      incoming: [],
    },
  };
}

async function keystoreLoaderOf(project: Project, projectDir: string, extra: Partial<SendHost> = {}) {
  const context: RunContext = { project, projectDir, overrides: {}, host: testHost({}, extra) };
  const selected = soapItemFor(project, 'req-1');
  if (selected === undefined) throw new Error('req-1 is not selectable');
  const { input } = await resolveSoap(selected, context);
  const ctx = input.wss?.ctx;
  if (ctx === undefined) throw new Error('the send has no WS-Security context');
  return ctx.keystores;
}

describe('WS-Security keystores through the host', () => {
  it("loads a keystore outside the project folder through the host's keystoreFor", async () => {
    const projectDir = await tempDir('proj');
    const outside = join(await tempDir('outside'), 'signer.pem');
    const lent = { aliases: [] } as unknown as Keystore;
    const asked: string[] = [];
    const keystores = await keystoreLoaderOf(projectWith(outside), projectDir, {
      keystoreFor: (id) => (asked.push(id), Promise.resolve(lent)),
    });

    await expect(keystores('ks-1')).resolves.toBe(lent);
    expect(asked).toEqual(['ks-1']);
  });

  it('refuses a keystore outside the project folder when the host lends no loader', async () => {
    const projectDir = await tempDir('proj');
    const outside = join(await tempDir('outside'), 'signer.pem');
    const ca = generateTestCa();
    const client = generateClientCert(ca);
    await writeFile(outside, `${client.certPem}\n${client.keyPem}`);
    const keystores = await keystoreLoaderOf(projectWith(outside), projectDir);

    await expect(keystores('ks-1')).rejects.toMatchObject({ code: 'keystore-outside-project' });
  });
});
