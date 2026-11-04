/**
 * The custom name's mail (hosted edition spec §23.2): one plain-text message to the tenant's server admins when the
 * name becomes `active`, `failing` or `lapsed`. It goes through the SMTP transport the schedule alerts use, and
 * nothing is sent without SMTP. Once slice 7 gives each tenant a sender of its own, {@link Mailer} is built from
 * that instead. No message carries the token.
 */
import type { ModuleConfig } from '../config.js';
import { sendAlertMail } from '../schedules/alerts/smtp.js';

export interface DomainEmail {
  readonly subject: string;
  readonly text: string;
}

/** Sends one message to `to`. */
export type Mailer = (to: readonly string[], email: DomainEmail) => Promise<void>;

/** The server's SMTP sender, or undefined when none is configured: then nothing is mailed. */
export function smtpMailer(config: Pick<ModuleConfig, 'smtpUrl' | 'smtpFrom'>): Mailer | undefined {
  const { smtpUrl, smtpFrom } = config;
  if (smtpUrl === undefined || smtpFrom === undefined) return undefined;
  return (to, email) => sendAlertMail({ url: smtpUrl, from: smtpFrom }, to, email);
}

/** The states a mail is sent for. */
export type DomainNotice = 'active' | 'failing' | 'lapsed';

/** The message for `notice` about `name`. `detail` is the check's message, which never carries the token. */
export function domainEmail(notice: DomainNotice, name: string, detail: string): DomainEmail {
  switch (notice) {
    case 'active':
      return {
        subject: `${name} now serves your team`,
        text:
          `${name} has its certificate and now serves your team. It is the team's primary address from now on: ` +
          `links in mail and invitations use it.\n\n` +
          `If your team signs in through an identity provider (OIDC or SAML), update its redirect URI or ACS URL ` +
          `to ${name}. Until you do, sign-in through it fails. Signing in with a password or by email is unaffected.\n`,
      };
    case 'failing':
      return {
        subject: `The DNS records of ${name} no longer check out`,
        text:
          `The last check of ${name} did not find its records: ${detail}\n\n` +
          `The name is still served. If the records are not back within 72 hours, the name is released and your ` +
          `team is served at its own address only.\n`,
      };
    case 'lapsed':
      return {
        subject: `${name} has been released`,
        text:
          `${name} failed its checks for 72 hours and no longer serves your team: ${detail}\n\n` +
          `Your team is served at its own address. To use ${name} again, put its records back and check it in ` +
          `Settings; it has to pass the check again before it is served.\n`,
      };
  }
}
