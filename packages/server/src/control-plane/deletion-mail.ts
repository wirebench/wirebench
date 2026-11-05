/**
 * The mail a deletion request sends (hosted edition spec §22.11): plain text to every enabled server admin of the
 * tenant, through the operator's SMTP settings, saying when the team goes, how to cancel, and that the subscription
 * must be canceled at the payment provider first. Without SMTP it is skipped, logged as `deletion-mail-no-smtp`; a
 * failed send is logged as `deletion-mail-failed` with the mail host alone, and the request stands either way.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ModuleConfig } from '../config.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantDbFactory } from '../tenancy/tenant-db.js';
import { tenantUrl } from '../tenancy/urls.js';
import type { ControlSend } from './mail.js';

export interface DeletionMailDeps {
  readonly db: TenantDbFactory;
  readonly config: Pick<ModuleConfig, 'mode' | 'appDomain'>;
  /** The operator's SMTP; `undefined` without it. */
  readonly mail: { readonly send: ControlSend; readonly mailHost: string } | undefined;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

/** Folds control characters and line breaks out of a name, so it stays the plain text of one line. */
const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

export async function mailDeletionRequested(
  deps: DeletionMailDeps,
  scope: TenantScope,
  input: { readonly teamName: string; readonly deletingAt: Date; readonly by: string },
): Promise<void> {
  if (deps.mail === undefined) {
    deps.log.info(
      { tenantId: scope.tenantId, code: 'deletion-mail-no-smtp' },
      'no SMTP: the deletion mail was not sent',
    );
    return;
  }
  const admins = await deps
    .db(scope)
    .query<{ email: string }>(
      'select email from users where server_admin and disabled_at is null order by email_lower',
    );
  if (admins.rows.length === 0) return;
  const name = oneLine(input.teamName);
  const day = input.deletingAt.toISOString().slice(0, 10);
  try {
    await deps.mail.send(
      admins.rows.map((row) => row.email),
      {
        subject: `The Wirebench team ${name} will be deleted on ${day}`,
        text: [
          `The deletion of the Wirebench team "${name}" was asked for by ${oneLine(input.by)}.`,
          '',
          `On ${input.deletingAt.toISOString()} the team and all its data are deleted, for good.`,
          `Until then a server admin can cancel it from the team's settings: ${tenantUrl(deps.config, scope)}/settings`,
          "Cancel the team's subscription with the payment provider first: the deletion waits while it is active.",
          '',
        ].join('\n'),
      },
    );
  } catch {
    // A refusal can quote a recipient: only the mail host is logged.
    deps.log.warn(
      { tenantId: scope.tenantId, mailHost: deps.mail.mailHost, code: 'deletion-mail-failed' },
      'the deletion mail could not be sent',
    );
  }
}
