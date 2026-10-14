/**
 * Delivers an email alert (scheduled-runs spec §3.4) through the server's SMTP settings:
 * `smtp://` upgrades with STARTTLS when the server offers it, `smtps://` is TLS from the start, and
 * credentials ride in the URL. The certificate is always verified. One message per alert, to every
 * address of the target, within the alert deadline. Errors name the mail host, never the URL (it may
 * carry a password).
 */
import { createTransport } from 'nodemailer';
import { reason, trustAnchors } from '../../audit-log/forward/trust.js';
import type { SchedulesSettings } from '../settings.js';
import { ALERT_DEADLINE_MS } from './https.js';
import type { RenderedEmail } from './render.js';

export interface MailDeliveryOptions {
  /** A PEM bundle added to the system roots. */
  readonly ca?: string;
  readonly timeoutMs?: number;
}

export async function sendAlertMail(
  smtp: NonNullable<SchedulesSettings['smtp']>,
  to: readonly string[],
  email: RenderedEmail,
  options: MailDeliveryOptions = {},
): Promise<void> {
  const host = new URL(smtp.url).hostname;
  const timeoutMs = options.timeoutMs ?? ALERT_DEADLINE_MS;
  const ca = trustAnchors(options.ca);
  const transport = createTransport({
    url: smtp.url,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { rejectUnauthorized: true, ...(ca !== undefined ? { ca } : {}) },
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the email alert through ${host} did not finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      transport.sendMail({ from: smtp.from, to: [...to], subject: email.subject, text: email.text, html: email.html }),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('the email alert through')) throw error;
    throw new Error(`the email alert through ${host} failed: ${reason(error)}`);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}
