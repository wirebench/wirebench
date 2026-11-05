/**
 * The socket a tenant's own mail server is reached over (hosted edition spec §17.5, §22.12): opened by the server
 * itself through the checked lookup, then handed to the mail client, which still speaks TLS over it and still
 * verifies the certificate. The egress rule always refuses loopback, where the sinks listen, so here it allows
 * everything: what is under test is that the checked socket carries a whole message.
 */
import { lookup } from 'node:dns';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  generateServerCert,
  generateTestCa,
  type TestCertificate,
} from '../../../../engine/test/helpers/test-certs.js';
import { smtpSink } from '../../helpers/smtp-sink.js';

const asked = vi.hoisted(() => ({ hosts: [] as string[] }));

vi.mock('@wirebench/engine', async (original) => ({
  ...(await original<typeof import('@wirebench/engine')>()),
  checkEgress: () => undefined,
  checkedLookup: () => (hostname: string, options: object, callback: () => void) => {
    asked.hosts.push(hostname);
    lookup(hostname, options, callback as never);
  },
}));

const { sendAlertMail } = await import('../../../src/schedules/alerts/smtp.js');

const EMAIL = { subject: 'Test alert', text: 'plain part\n' };
const FROM = 'wirebench@example.test';
const TO = ['ops@example.test'];
const egress = { denyPrivate: true };

describe('a tenant’s mail over the checked socket', () => {
  let ca: TestCertificate;
  let identity: TestCertificate;
  beforeAll(() => {
    ca = generateTestCa();
    identity = generateServerCert(ca);
  });
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close();
    asked.hosts.length = 0;
  });

  it('smtp:// sends through it, resolving the name through the checked lookup', async () => {
    const sink = await smtpSink();
    cleanup.push(() => sink.close());
    await sendAlertMail({ url: `smtp://alerts:p%40ss@localhost:${sink.port}`, from: FROM }, TO, EMAIL, { egress });
    expect(sink.messages).toMatchObject([{ from: FROM, to: TO, auth: 'alerts:p@ss' }]);
    expect(asked.hosts).toEqual(['localhost']);
  });

  it('smtps:// is TLS over it and still verifies the certificate', async () => {
    const sink = await smtpSink({ tls: identity });
    cleanup.push(() => sink.close());
    const url = `smtps://alerts:hunter2@localhost:${sink.port}`;
    await sendAlertMail({ url, from: FROM }, TO, EMAIL, { egress, ca: ca.certPem });
    expect(sink.messages).toHaveLength(1);
    await expect(sendAlertMail({ url, from: FROM }, TO, EMAIL, { egress })).rejects.toThrow(
      /^the email alert through localhost failed: /,
    );
    expect(sink.messages).toHaveLength(1);
  });
});
