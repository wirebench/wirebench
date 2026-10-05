/**
 * `runRequests` over a SOAP request whose WS-Security configuration asks an STS for a SAML token:
 * the token is fetched once per run, a refused token is dropped, and STS failures refuse the send.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../src/run/context.js';
import { createIssuedTokenSource } from '../../src/run/issued-token.js';
import { runRequests } from '../../src/run/run.js';
import { selectRequests } from '../../src/run/select.js';
import { soapIssuedTokenKeyTarget, soapIssuedTokenTarget, soapItemFor } from '../../src/soap/run.js';
import type { Project } from '../../src/project/model.js';
import type { WssIssuedTokenEntry } from '../../src/wss/model.js';
import { projectWithWss } from '../helpers/fixtures.js';
import { testHost } from '../helpers/send-host.js';
import { startTestSts } from '../helpers/test-sts-server.js';
import type { TestSts } from '../helpers/test-sts-server.js';

/** The fixture's lifetime has passed; push it far enough ahead that the cache keeps the token. */
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/ws-trust/${name}`, import.meta.url)), 'utf8').replace(
    /2026-10-05T/g,
    '2099-10-05T',
  );

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><Op/></soapenv:Body></soapenv:Envelope>';

interface Service {
  readonly url: string;
  readonly bodies: string[];
  /** 1-based ordinals of the requests to answer with an InvalidSecurityToken fault. */
  readonly refuse: Set<number>;
  close(): Promise<void>;
}

async function startService(): Promise<Service> {
  const bodies: string[] = [];
  const refuse = new Set<number>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      if (refuse.has(bodies.length)) {
        response.writeHead(500, { 'content-type': 'text/xml' });
        response.end(
          '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>' +
            '<faultcode>wsse:InvalidSecurityToken</faultcode><faultstring>refused</faultstring>' +
            '</soapenv:Fault></soapenv:Body></soapenv:Envelope>',
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/xml' });
      response.end(
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ok/></soapenv:Body></soapenv:Envelope>',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/svc`,
    bodies,
    refuse,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

let sts: TestSts | undefined;
let service: Service;
beforeEach(async () => {
  service = await startService();
});
afterEach(async () => {
  await sts?.close();
  sts = undefined;
  await service.close();
});

function entryFor(stsUrl: string, extra: Partial<WssIssuedTokenEntry> = {}): WssIssuedTokenEntry {
  return {
    kind: 'issued-token',
    stsUrl,
    soapVersion: '1.2',
    trustVersion: '1.3',
    tokenType: '2.0',
    keyType: 'bearer',
    credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
    requestedLifetimeSeconds: 0,
    ...extra,
  };
}

function projectFor(entry: WssIssuedTokenEntry): Project {
  const { project } = projectWithWss([entry]);
  return {
    ...project,
    interfaces: project.interfaces.map((iface) =>
      iface.kind === 'soap'
        ? {
            ...iface,
            endpoints: iface.endpoints.map((endpoint) => ({ ...endpoint, url: service.url })),
            operations: iface.operations.map((operation) => ({
              ...operation,
              requests: operation.requests.map((request) => ({ ...request, envelopeXml: ENVELOPE })),
            })),
          }
        : iface,
    ),
  };
}

function contextFor(project: Project, extra: Partial<RunContext['host']> = {}): RunContext {
  return {
    project,
    projectDir: '/tmp',
    overrides: {},
    host: testHost({ sec: 'hunter2' }, { tls: { anchors: [sts?.caPem ?? ''] }, ...extra }),
  };
}

const requestsOf = (project: Project, times: number) => {
  const [one] = selectRequests(project, []).selected;
  if (one === undefined) throw new Error('no request selected');
  return Array.from({ length: times }, () => one);
};

describe('runRequests with an issued SAML token', () => {
  it('sends the assertion in wsse:Security and shares one STS call per run', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const project = projectFor(entryFor(sts.url));
    const result = await runRequests(requestsOf(project, 2), contextFor(project));
    expect(result.summary).toMatchObject({ total: 2 });
    expect(service.bodies).toHaveLength(2);
    for (const body of service.bodies) {
      expect(body).toContain('<saml2:Assertion');
      expect(body).toContain('ID="_fixture-2.0"');
      expect(body).toMatch(/<wsse:Security[\s\S]*<saml2:Assertion/);
    }
    expect(sts.requests).toHaveLength(1);
  });

  it('makes a new STS call in a second run, which has its own source', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const project = projectFor(entryFor(sts.url));
    await runRequests(requestsOf(project, 1), contextFor(project));
    await runRequests(requestsOf(project, 1), contextFor(project));
    expect(sts.requests).toHaveLength(2);
  });

  it('uses the source the host lends', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const project = projectFor(entryFor(sts.url));
    const issuedTokens = createIssuedTokenSource();
    await runRequests(requestsOf(project, 1), contextFor(project, { issuedTokens }));
    await runRequests(requestsOf(project, 1), contextFor(project, { issuedTokens }));
    expect(sts.requests).toHaveLength(1);
  });

  it('drops the token after the service refuses it, so the next request fetches anew', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const project = projectFor(entryFor(sts.url));
    service.refuse.add(2);
    await runRequests(requestsOf(project, 3), contextFor(project));
    expect(service.bodies).toHaveLength(3);
    // The first two sends share a token; the refusal drops it; the third fetches a new one.
    expect(sts.requests).toHaveLength(2);
  });

  it('refuses the send when the STS answers a fault, without leaking the password', async () => {
    sts = await startTestSts(() => ({ status: 500, body: fixture('fault-1.2.xml') }));
    const project = projectFor(entryFor(sts.url));
    const result = await runRequests(requestsOf(project, 1), contextFor(project));
    expect(JSON.stringify(result)).toContain('ws-trust-sts-fault');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(service.bodies).toHaveLength(0);
  });

  it('refuses a Kerberos credential with kerberos-unavailable', async () => {
    const project = projectFor(
      entryFor('https://sts.test/', { credential: { kind: 'kerberos', spn: 'HTTP@sts.test' } }),
    );
    const result = await runRequests(requestsOf(project, 1), contextFor(project));
    expect(JSON.stringify(result)).toContain('kerberos-unavailable');
  });
});

describe('soapIssuedTokenTarget', () => {
  it('builds the target a send uses, so a token fetched outside a send is the one the send finds', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const entry = entryFor(sts.url);
    const project = projectFor(entry);
    const context = contextFor(project);
    const [one] = selectRequests(project, []).selected;
    const selected = soapItemFor(project, one!.request.id)!;
    const issuedTokens = createIssuedTokenSource();
    const { target, ctx } = await soapIssuedTokenTarget(selected, context, entry);
    expect(target.endpointUrl).toBe(service.url);
    expect(target.tls?.ca).toEqual([sts.caPem]);
    await issuedTokens.get(entry, target, { ctx });
    expect(issuedTokens.peek(entry, soapIssuedTokenKeyTarget(selected, context))).toBeDefined();
    await runRequests(requestsOf(project, 1), contextFor(project, { issuedTokens }));
    expect(sts.requests).toHaveLength(1);
    expect(service.bodies[0]).toContain('ID="_fixture-2.0"');
  });
});
