/**
 * Delivers an email alert (scheduled-runs spec §3.4) through the server's SMTP settings:
 * `smtp://` upgrades with STARTTLS when the server offers it, `smtps://` is TLS from the start, and
 * credentials ride in the URL. The certificate is always verified. One message per alert, to every
 * address of the target, within the alert deadline. Errors name the mail host, never the URL (it may
 * carry a password).
 *
 * A tenant's own mail server (hosted edition spec §22.12) goes under the egress rule (§17.5): the socket is opened
 * here, its name resolved through `checkedLookup` and a literal address checked as it is, so a tenant's SMTP URL
 * cannot point the server at its own network. The operator's mail server is the operator's choice and is not.
 */
import { connect, isIP, type LookupFunction, type Socket } from 'node:net';
import { checkEgress, checkedLookup, type EgressPolicy } from '@wirebench/engine';
import { createTransport } from 'nodemailer';
import { reason, trustAnchors } from '../../audit-log/forward/trust.js';
import type { SchedulesSettings } from '../settings.js';
import { ALERT_DEADLINE_MS, AlertConnectionError } from './https.js';
import type { RenderedEmail } from './render.js';

export interface MailDeliveryOptions {
  /** A PEM bundle added to the system roots. */
  readonly ca?: string;
  readonly timeoutMs?: number;
  /**
   * The egress rule the connection goes under: a tenant's own mail server's (`ctx.egress`), or `'unchecked'` for a
   * test's loopback sink. Unset, the system resolver and no check: the operator's own mail server.
   */
  readonly egress?: EgressPolicy | 'unchecked';
  /** The resolver the egress check asks; the system's unless a test passes its own. */
  readonly lookup?: LookupFunction;
}

interface SocketTarget {
  readonly host?: string;
  readonly port?: number | string;
  readonly secure?: boolean;
}

/** nodemailer's `getSocket`: a plain socket to the mail server under `policy`; TLS, when wanted, is nodemailer's. */
function checkedSocket(policy: EgressPolicy, timeoutMs: number, base?: LookupFunction) {
  return (
    target: SocketTarget,
    callback: (err: Error | null, socketOptions: { connection: Socket } | false) => void,
  ) => {
    const host = target.host ?? 'localhost';
    const literal = host.startsWith('[') ? host.slice(1, -1) : host;
    // The port nodemailer would pick: 465 for TLS from the start, else 587.
    const port = Number(target.port) || (target.secure === true ? 465 : 587);
    if (isIP(literal) !== 0) {
      try {
        checkEgress(host, literal, policy);
      } catch (error) {
        callback(error instanceof Error ? error : new Error('egress refused'), false);
        return;
      }
    }
    let done = false;
    const socket = connect({ host: literal, port, lookup: checkedLookup(policy, base) });
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      socket.setTimeout(0);
      socket.removeListener('error', finish);
      if (error === null) callback(null, { connection: socket });
      else {
        socket.destroy();
        callback(error, false);
      }
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('the connection timed out')));
    socket.once('error', finish);
    socket.once('connect', () => finish(null));
  };
}

export async function sendAlertMail(
  smtp: NonNullable<SchedulesSettings['smtp']>,
  to: readonly string[],
  /** `html` may be left out: the hosted entry's message is plain text only (hosted edition spec §21.4). */
  email: Pick<RenderedEmail, 'subject' | 'text'> & { readonly html?: string },
  options: MailDeliveryOptions = {},
): Promise<void> {
  const host = new URL(smtp.url).hostname;
  const timeoutMs = options.timeoutMs ?? ALERT_DEADLINE_MS;
  const ca = trustAnchors(options.ca);
  const policy = options.egress === undefined || options.egress === 'unchecked' ? undefined : options.egress;
  const transport = createTransport({
    url: smtp.url,
    ...(policy !== undefined ? { getSocket: checkedSocket(policy, timeoutMs, options.lookup) } : {}),
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
      () =>
        reject(new AlertConnectionError(`the email alert through ${host} did not finish within ${timeoutMs} ms`, host)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      transport.sendMail({
        from: smtp.from,
        to: [...to],
        subject: email.subject,
        text: email.text,
        ...(email.html !== undefined ? { html: email.html } : {}),
      }),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof AlertConnectionError) throw error;
    const message = `the email alert through ${host} failed: ${reason(error)}`;
    // A reply code means a mail server answered; anything else never got that far.
    if (typeof (error as { responseCode?: unknown } | undefined)?.responseCode === 'number') throw new Error(message);
    throw new AlertConnectionError(message, host);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}
