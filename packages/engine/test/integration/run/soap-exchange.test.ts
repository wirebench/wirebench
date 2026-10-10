/**
 * A SOAP send through `openExchange` as a host sees it: what a failure reports (its stage, what was
 * attempted, and the request as resolved), the request as resolved on a sent exchange, and the item
 * of an orphaned request, which a run skips and a person may still send.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest, soapItemFor, WirebenchError } from '../../../src/index.js';
import type { Project, SoapRequestDef, SoapSendInput } from '../../../src/index.js';
import type { SendFailure, SendHost } from '../../../src/run/host.js';
import { openExchange } from '../../../src/run/open.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import type { RunContext } from '../../../src/run/context.js';
import { startTestSoapServer } from '../../helpers/index.js';
import type { TestSoapServer } from '../../helpers/index.js';
import { testHost } from '../../helpers/send-host.js';

let server: TestSoapServer;
let dir: string;

beforeAll(async () => {
  server = await startTestSoapServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-soap-exchange-'));
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const ENVELOPE = '<Envelope><Body><who>${#Project#who}</who></Body></Envelope>';

function project(endpointUrl: string, extra: Partial<SoapRequestDef> = {}): Project {
  const request: SoapRequestDef = {
    ...createRequest('Get', {
      id: 'r1',
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      headers: [{ name: 'X-Trace', value: 'abc' }],
    }),
    endpointUrl,
    ...extra,
  };
  const iface = createInterface('Svc', {
    id: 'i1',
    definitionUrl: `${server.url}/service?wsdl`,
    cacheDefinition: false,
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [request] }],
  });
  return {
    ...createProject('Soap exchange', { id: 'p-soap' }),
    properties: { who: 'ada' },
    containers: { soap: [iface] },
  };
}

function open(p: Project, hostExtra: Partial<SendHost> = {}, secrets: Record<string, string> = {}) {
  const item = soapItemFor(p, 'r1')!;
  const host = { ...testHost(secrets), ...hostExtra };
  const context: RunContext = { project: p, projectDir: dir, overrides: {}, host };
  return openExchange(item, host, { scope: createRunScope(context), interactive: false }).result;
}

function recorder(): { failures: SendFailure[]; host: Partial<SendHost> } {
  const failures: SendFailure[] = [];
  return { failures, host: { events: { onFailed: (_item, failure) => failures.push(failure) } } };
}

async function deadUrl(): Promise<string> {
  const dead = await startTestSoapServer();
  await dead.close();
  return `${dead.url}/soap`;
}

describe('SOAP through openExchange', () => {
  it('keeps the request as resolved, references unexpanded, on the sent exchange', async () => {
    const sent = await open(project(`${server.url}/soap`));
    const input = sent.exchange?.kind === 'soap' ? sent.exchange.input : undefined;
    expect(input?.endpoint).toBe(`${server.url}/soap`);
    expect(input?.envelopeXml).toBe(ENVELOPE);
    expect(input?.headers).toMatchObject({ 'X-Trace': 'abc' });
    expect(new TextDecoder().decode(sent.raw.rawRequest)).toContain('<who>ada</who>');
  });

  it('reports a connection that fails as a send-stage failure, with what was attempted', async () => {
    const { failures, host } = recorder();
    const url = await deadUrl();
    await expect(open(project(url), host)).rejects.toMatchObject({ code: 'connection-refused' });
    expect(failures).toHaveLength(1);
    const [failure] = failures;
    expect(failure).toMatchObject({ stage: 'send', attempted: { url, method: 'POST' } });
    expect(failure!.attempted!.headers).toMatchObject({ 'X-Trace': 'abc' });
    expect((failure!.input as SoapSendInput).envelopeXml).toBe(ENVELOPE);
    expect(failure!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a proxy lookup that fails as a prepare-stage failure, and sends nothing', async () => {
    const { failures, host } = recorder();
    const before = server.requests.length;
    const proxyFor = (): Promise<undefined> => Promise.reject(new WirebenchError('proxy-resolve-failed', 'x'));
    await expect(open(project(`${server.url}/soap`), { ...host, proxyFor })).rejects.toThrow('x');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'prepare',
      attempted: { url: `${server.url}/soap`, method: 'POST' },
      error: { code: 'proxy-resolve-failed' },
    });
    expect(server.requests.length).toBe(before);
  });

  it('reports a secret token with no value as a prepare-stage failure', async () => {
    const { failures, host } = recorder();
    const p = project(`${server.url}/soap`, { envelopeXml: '<Envelope>${secret:gone}</Envelope>' });
    await expect(open(p, host)).rejects.toMatchObject({ code: 'secret-missing' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ stage: 'prepare', attempted: { url: `${server.url}/soap`, method: 'POST' } });
  });

  it('refuses a reference nothing resolves as unresolved-properties, sending nothing', async () => {
    const before = server.requests.length;
    const p = project(`${server.url}/soap`, { envelopeXml: '<Envelope>${nope}</Envelope>' });
    await expect(open(p)).rejects.toMatchObject({ code: 'unresolved-properties' });
    expect(server.requests.length).toBe(before);
  });
});

describe('soapItemFor', () => {
  it('finds an orphaned request, which a run does not select', () => {
    const p = project(`${server.url}/soap`, { orphaned: true });
    expect(soapItemFor(p, 'r1')).toMatchObject({ kind: 'soap', path: 'Svc/Op/Get', request: { id: 'r1' } });
    expect(selectRequests(p, []).selected).toHaveLength(0);
  });

  it('answers undefined for an id no SOAP request has', () => {
    expect(soapItemFor(project(`${server.url}/soap`), 'nope')).toBeUndefined();
  });
});
