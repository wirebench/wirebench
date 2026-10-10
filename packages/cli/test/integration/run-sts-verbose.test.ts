/**
 * `wirebench run --verbose` on a SOAP request whose WS-Security configuration asks a token service
 * for a SAML token (#41): one stderr line per token request, never a secret.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveProject, soapInterfacesOf } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { projectWithWss, startTestSts } from '@wirebench/engine/test-helpers';
import type { TestSts } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Op/></soapenv:Body></soapenv:Envelope>';
const PASSWORD = 'sts-password-long-6e2a';
/** The fixture's lifetime has passed; push it far enough ahead that the cache keeps the token. */
const ASSERTION = readFileSync(
  fileURLToPath(new URL('../../../engine/test/fixtures/ws-trust/rstrc-1.3-saml2.xml', import.meta.url)),
  'utf8',
).replace(/2026-10-05T/g, '2099-10-05T');

let sts: TestSts;
let service: Server;
let dir: string;

beforeAll(async () => {
  sts = await startTestSts(() => ({ status: 200, body: ASSERTION }));
  service = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/xml' });
      response.end(
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ok/></soapenv:Body></soapenv:Envelope>',
      );
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((service.address() as AddressInfo).port)}/svc`;
  const { project } = projectWithWss([
    {
      kind: 'issued-token',
      stsUrl: sts.url,
      soapVersion: '1.2',
      trustVersion: '1.3',
      tokenType: '2.0',
      keyType: 'bearer',
      credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
      requestedLifetimeSeconds: 0,
    },
  ]);
  dir = await mkdtemp(join(tmpdir(), 'wirebench-sts-'));
  await saveProject(twoRequests(project, url), dir);
});

afterAll(async () => {
  await sts.close();
  await new Promise<void>((resolve) => {
    service.close(() => resolve());
    service.closeAllConnections();
  });
  await rm(dir, { recursive: true, force: true });
});

/** The helper's one request, twice, pointed at the local service, so one run sends it two times. */
function twoRequests(project: Project, url: string): Project {
  return {
    ...project,
    containers: {
      ...project.containers,
      soap: soapInterfacesOf(project).map((iface) => {
        if (iface.kind !== 'soap') {
          return iface;
        }
        return {
          ...iface,
          endpoints: iface.endpoints.map((endpoint) => ({ ...endpoint, url })),
          operations: iface.operations.map((operation) => {
            const [only] = operation.requests;
            if (only === undefined) {
              return operation;
            }
            const first = { ...only, envelopeXml: ENVELOPE };
            return { ...operation, requests: [first, { ...first, id: 'req-2', name: 'Req2', slug: 'req2', order: 1 }] };
          }),
        };
      }),
    },
  };
}

describe('wirebench run --verbose with an issued SAML token', () => {
  it('reports the token request once, then the cached token, and never the password or assertion', async () => {
    const { code, stderr, stdout } = await runCli(['run', dir, '--insecure', '--verbose'], {
      WIREBENCH_SECRET_SEC: PASSWORD,
    });
    expect(stdout + stderr).not.toContain('Assertion');
    expect(code).toBe(0);
    expect(stderr).toMatch(/^STS 127\.0\.0\.1 200 fetched, valid until \d{2}:\d{2}$/m);
    expect(stderr).toMatch(/^STS 127\.0\.0\.1 cached, valid until \d{2}:\d{2}$/m);
    expect(stderr).not.toContain(PASSWORD);
    expect(sts.requests).toHaveLength(1);
  });

  it('prints no STS line without --verbose', async () => {
    const { code, stderr } = await runCli(['run', dir, '--insecure'], { WIREBENCH_SECRET_SEC: PASSWORD });
    expect(code).toBe(0);
    expect(stderr).not.toContain('STS ');
  });
});
