import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpsSink } from '../../../../src/audit-log/forward/https-sink.js';
import { sinkFromConfig } from '../../../../src/audit-log/forward/sink.js';
import { SyslogSink } from '../../../../src/audit-log/forward/syslog-sink.js';
import { generateServerCert, generateTestCa } from '../../../../../engine/test/helpers/test-certs.js';
import { httpReceiver, syslogReceiver } from '../../../helpers/forward-receivers.js';
import { auditEvent } from './fixtures.js';

describe('sinkFromConfig', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });
  const track = <T extends { close(): Promise<void> }>(thing: T): T => {
    cleanup.push(() => thing.close());
    return thing;
  };
  async function caFile(pem: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'wb-forward-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'ca.pem');
    await writeFile(path, pem);
    return path;
  }

  it('builds nothing without a URL', async () => {
    await expect(sinkFromConfig({})).resolves.toBeUndefined();
  });

  it('builds a syslog sink for syslog+tcp and syslog+tls', async () => {
    const tcp = track((await sinkFromConfig({ auditForwardUrl: 'syslog+tcp://127.0.0.1:6514' }))!);
    expect(tcp).toBeInstanceOf(SyslogSink);
    const tls = track((await sinkFromConfig({ auditForwardUrl: 'syslog+tls://[::1]:6514' }))!);
    expect(tls).toBeInstanceOf(SyslogSink);
  });

  it('builds an HTTPS sink for https and loopback http', async () => {
    const https = track(
      (await sinkFromConfig({ auditForwardUrl: 'https://collector.example/x', auditForwardToken: 't' }))!,
    );
    expect(https).toBeInstanceOf(HttpsSink);
    const receiver = track(await httpReceiver());
    const http = track(
      (await sinkFromConfig({ auditForwardUrl: `http://127.0.0.1:${receiver.port}/in`, auditForwardToken: 't' }))!,
    );
    await http.send([auditEvent()]);
    expect(receiver.requests[0]!.url).toBe('/in');
    expect(receiver.requests[0]!.headers.authorization).toBe('Bearer t');
  });

  it('reads the CA file once and trusts it for syslog+tls', async () => {
    const ca = generateTestCa();
    const receiver = track(await syslogReceiver({ tls: generateServerCert(ca) }));
    const path = await caFile(ca.certPem);
    const sink = track(
      (await sinkFromConfig({ auditForwardUrl: `syslog+tls://localhost:${receiver.port}`, auditForwardCaFile: path }))!,
    );
    await rm(path);
    await sink.send([auditEvent()]);
    await receiver.received(1);
  });

  it('reads the CA file for https', async () => {
    const ca = generateTestCa();
    const receiver = track(await httpReceiver(undefined, generateServerCert(ca)));
    const path = await caFile(ca.certPem);
    const sink = track(
      (await sinkFromConfig({ auditForwardUrl: `https://localhost:${receiver.port}/`, auditForwardCaFile: path }))!,
    );
    await sink.send([auditEvent()]);
    expect(receiver.requests).toHaveLength(1);
  });

  it('refuses a CA file it cannot read, or one holding no certificate', async () => {
    await expect(
      sinkFromConfig({ auditForwardUrl: 'https://collector.example/', auditForwardCaFile: '/nonexistent/ca.pem' }),
    ).rejects.toThrow(/WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE/);
    const empty = await caFile('not a certificate');
    await expect(
      sinkFromConfig({ auditForwardUrl: 'https://collector.example/', auditForwardCaFile: empty }),
    ).rejects.toThrow(/no PEM certificate/);
  });
});
