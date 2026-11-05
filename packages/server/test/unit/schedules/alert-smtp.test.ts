import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LookupFunction } from 'node:net';
import { AlertConnectionError } from '../../../src/schedules/alerts/https.js';
import { sendAlertMail } from '../../../src/schedules/alerts/smtp.js';
import {
  generateServerCert,
  generateTestCa,
  type TestCertificate,
} from '../../../../engine/test/helpers/test-certs.js';
import { silentListener } from '../../helpers/forward-receivers.js';
import { smtpSink } from '../../helpers/smtp-sink.js';

const EMAIL = {
  subject: '[Wirebench] Test alert: Nightly (Billing)',
  text: 'plain part\n',
  html: '<p>html part</p>\n',
};
const FROM = 'wirebench@example.test';
const TO = ['ops@example.test', 'oncall@example.test'];

describe('alert delivery over SMTP (scheduled-runs spec §3.4)', () => {
  let ca: TestCertificate;
  let identity: TestCertificate;
  beforeAll(() => {
    ca = generateTestCa();
    identity = generateServerCert(ca);
  });
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close();
  });
  const failure = (promise: Promise<void>): Promise<Error | undefined> =>
    promise.then(
      () => undefined,
      (error: unknown) => error as Error,
    );

  it('smtp:// logs in with the URL credentials and sends one message to every address, text and HTML', async () => {
    const sink = await smtpSink();
    cleanup.push(() => sink.close());
    await sendAlertMail({ url: `smtp://alerts:p%40ss@127.0.0.1:${sink.port}`, from: FROM }, TO, EMAIL);
    expect(sink.messages).toHaveLength(1);
    const [message] = sink.messages;
    expect(message).toMatchObject({ from: FROM, to: TO, auth: 'alerts:p@ss' });
    expect(message!.data).toContain('Subject: [Wirebench] Test alert: Nightly (Billing)\r\n');
    expect(message!.data).toMatch(/Content-Type: multipart\/alternative/);
    expect(message!.data).toContain('plain part');
    expect(message!.data).toContain('<p>html part</p>');
  });

  it('smtps:// verifies the server certificate', async () => {
    const sink = await smtpSink({ tls: identity });
    cleanup.push(() => sink.close());
    const url = `smtps://alerts:hunter2@localhost:${sink.port}`;
    await sendAlertMail({ url, from: FROM }, TO, EMAIL, { ca: ca.certPem });
    expect(sink.messages).toHaveLength(1);
    const error = await failure(sendAlertMail({ url, from: FROM }, TO, EMAIL));
    expect(error?.message).toMatch(/^the email alert through localhost failed: /);
    expect(error?.message).not.toContain('hunter2');
    expect(sink.messages).toHaveLength(1);
  });

  it('a rejected message fails with the server reply, never the password', async () => {
    const sink = await smtpSink({ reject: true });
    cleanup.push(() => sink.close());
    const error = await failure(
      sendAlertMail({ url: `smtp://alerts:hunter2@127.0.0.1:${sink.port}`, from: FROM }, TO, EMAIL),
    );
    expect(error?.message).toMatch(/^the email alert through 127\.0\.0\.1 failed: .*554/);
    expect(error?.message).not.toContain('hunter2');
  });

  it('a server that never greets fails at the deadline', async () => {
    const silent = await silentListener();
    cleanup.push(() => silent.close());
    const error = await failure(
      sendAlertMail({ url: `smtp://127.0.0.1:${silent.port}`, from: FROM }, TO, EMAIL, { timeoutMs: 200 }),
    );
    expect(error?.message).toMatch(/^the email alert through 127\.0\.0\.1 (did not finish within 200 ms|failed: )/);
  });

  describe('a tenant’s own mail server, under the egress rule (hosted edition spec §17.5, §22.12)', () => {
    const egress = { denyPrivate: true };
    /** A resolver that answers `address` for every name. */
    const resolvesTo =
      (address: string): LookupFunction =>
      (_hostname, _options, callback) =>
        (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
          { address, family: 4 },
        ]);

    it.each([
      ['a private address', 'smtp://10.0.0.1:25', /private network/],
      ['a link-local address', 'smtp://169.254.10.20:25', /link-local/],
      ['the cloud metadata address', 'smtp://169.254.169.254:25', /metadata/],
      ['a loopback address', 'smtps://[::1]:465', /loopback/],
    ])('refuses %s before it connects', async (_name, url, why) => {
      const error = await failure(sendAlertMail({ url, from: FROM }, TO, EMAIL, { egress, timeoutMs: 2_000 }));
      expect(error).toBeInstanceOf(AlertConnectionError);
      expect(error?.message).toMatch(why);
    });

    it('refuses a name that resolves to a private address', async () => {
      const error = await failure(
        sendAlertMail({ url: 'smtp://u:hunter2@mail.acme.test:587', from: FROM }, TO, EMAIL, {
          egress,
          lookup: resolvesTo('192.168.1.5'),
          timeoutMs: 2_000,
        }),
      );
      expect(error).toBeInstanceOf(AlertConnectionError);
      expect(error?.message).toMatch(/^the email alert through mail\.acme\.test failed: .*private network/);
      expect(error?.message).not.toContain('192.168.1.5');
      expect(error?.message).not.toContain('hunter2');
    });

    it('a mail server that answers with a reply code is not a connection failure', async () => {
      const sink = await smtpSink({ reject: true });
      cleanup.push(() => sink.close());
      const error = await failure(sendAlertMail({ url: `smtp://127.0.0.1:${sink.port}`, from: FROM }, TO, EMAIL));
      expect(error).not.toBeInstanceOf(AlertConnectionError);
      const silent = await silentListener();
      cleanup.push(() => silent.close());
      const timedOut = await failure(
        sendAlertMail({ url: `smtp://127.0.0.1:${silent.port}`, from: FROM }, TO, EMAIL, { timeoutMs: 200 }),
      );
      expect(timedOut).toBeInstanceOf(AlertConnectionError);
    });
  });
});
