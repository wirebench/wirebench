/**
 * The control plane's mails (hosted edition spec §22.5): plain text to each tenant's enabled server admins, through
 * the operator's SMTP settings, when its subscription goes past due, three days before the grace sweep suspends it,
 * and when it is suspended for `unpaid`. Each holds the team's name, as plain text, and the link to its sign-in page;
 * nothing from Paddle.
 *
 * **Each goes once.** The mail step claims a row in `billing_events` under the provider `wirebench`, keyed by the
 * mail, the tenant and the date it is about (`past_due_since`, or `suspended_at`), in the loop's control
 * transaction, and sends after the pass commits: a claimed row is never claimed again, so a mail is sent at most
 * once, and a later spell of past due is a new date and a new mail. Rows age out with the events after 90 days, so a
 * mail is only claimed while its date is recent ({@link MAIL_WINDOW_DAYS}), well inside that.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ModuleConfig } from '../config.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import { tenantUrl } from '../tenancy/urls.js';
import { DAY_MS, GRACE_DAYS } from './billing/sweep.js';
import type { LoopStep } from './loop.js';
import type { ControlTx } from './slugs.js';
import type { TenantLifecycle } from './tenants.js';

export type ControlMailKind = 'past-due' | 'grace-ending' | 'suspended-unpaid';

/** How long before the suspension the warning goes. */
export const WARNING_DAYS = 3;
/** How recent a mail's date must be for it to be claimed: inside the 90 days `billing_events` keeps. */
export const MAIL_WINDOW_DAYS = 30;

/** The provider the mail rows are recorded under: ours, so no provider's event id can meet one. */
const MAIL_PROVIDER = 'wirebench';

export interface ControlMail {
  readonly subject: string;
  readonly text: string;
}

/** Sends one message to `to`; the module's sends through `sendAlertMail`, tests replace it. */
export type ControlSend = (to: readonly string[], mail: ControlMail) => Promise<void>;

/** Folds control characters and line breaks out of a name, so it stays the plain text of one line. */
function oneLine(name: string): string {
  return name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface ControlMailInput {
  readonly teamName: string;
  /** `https://<slug>.<app-domain>/sign-in`. */
  readonly signInUrl: string;
  /** When the grace sweep suspends the team: `past_due_since` + 14 days. */
  readonly suspendsAt?: Date;
}

export function renderControlMail(kind: ControlMailKind, input: ControlMailInput): ControlMail {
  const name = oneLine(input.teamName);
  const when = input.suspendsAt !== undefined ? day(input.suspendsAt) : 'two weeks after it fell due';
  const bodies: Record<ControlMailKind, ControlMail> = {
    'past-due': {
      subject: `Payment overdue for the Wirebench team ${name}`,
      text: [
        `The subscription of the Wirebench team "${name}" is past due.`,
        '',
        'The payment will be retried. Its billing contact can also pay from the email the payment provider sent.',
        `If it is still unpaid on ${when}, the team is suspended until it is paid. Its data is kept.`,
      ].join('\n'),
    },
    'grace-ending': {
      subject: `The Wirebench team ${name} is suspended in three days`,
      text: [
        `The subscription of the Wirebench team "${name}" is still past due.`,
        '',
        `If it is not paid by ${when}, the team is suspended: nobody can sign in until it is paid. Its data is kept.`,
        'Its billing contact can pay from the email the payment provider sent.',
      ].join('\n'),
    },
    'suspended-unpaid': {
      subject: `The Wirebench team ${name} is suspended`,
      text: [
        `The Wirebench team "${name}" is suspended: its subscription is unpaid.`,
        '',
        'Its data is kept. Once it is paid, the team is resumed.',
        'Its billing contact can pay from the email the payment provider sent.',
      ].join('\n'),
    },
  };
  const mail = bodies[kind];
  return { subject: mail.subject, text: `${mail.text}\n\nSign in: ${input.signInUrl}\n` };
}

/** Claims `kind` for `tenantId` about `about`; `true` the first time only. */
async function claim(tx: ControlTx, kind: ControlMailKind, tenantId: string, about: Date, now: Date): Promise<boolean> {
  const inserted = await tx.query(
    `insert into billing_events (provider, event_id, event_type, occurred_at, outcome)
     values ($1, $2, $3, $4::timestamptz, 'sent') on conflict do nothing returning event_id`,
    [MAIL_PROVIDER, `mail.${kind}:${tenantId}:${about.toISOString()}`, `mail.${kind}`, now],
  );
  return inserted.rows.length === 1;
}

export interface MailStepDeps {
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly lifecycle: TenantLifecycle;
  readonly config: Pick<ModuleConfig, 'mode' | 'appDomain'>;
  readonly send: ControlSend;
  readonly log: Pick<FastifyBaseLogger, 'warn'>;
  /** The SMTP host, for a failure's log line; the URL may hold a password. */
  readonly mailHost: string;
}

interface Due {
  readonly id: string;
  readonly name: string;
  readonly kind: ControlMailKind;
  readonly about: Date;
}

/**
 * The mail step. Runs after the grace sweep in the same pass, so a tenant the sweep suspended gets its mail in that
 * pass. A past-due tenant first seen inside the last three days gets the warning alone, which says it is past due.
 */
export function mailStep(deps: MailStepDeps): LoopStep {
  return {
    name: 'billing-mail',
    run: async ({ tx, now, each, afterCommit }) => {
      const recent = new Date(now.getTime() - MAIL_WINDOW_DAYS * DAY_MS);
      const warnFrom = new Date(now.getTime() - (GRACE_DAYS - WARNING_DAYS) * DAY_MS);
      const due: Due[] = [];
      const pastDue = await tx.query<{ id: string; name: string; since: Date }>(
        `select t.id::text as id, t.name, s.past_due_since as since from tenants t
         join subscriptions s on s.tenant_id = t.id
         where t.status = 'active' and t.edition_source = 'subscription' and s.status = 'past_due'
           and s.past_due_since > $1::timestamptz
         order by t.id`,
        [recent],
      );
      for (const row of pastDue.rows) {
        due.push({
          id: row.id,
          name: row.name,
          about: row.since,
          kind: row.since <= warnFrom ? 'grace-ending' : 'past-due',
        });
      }
      const suspended = await tx.query<{ id: string; name: string; at: Date }>(
        `select id::text as id, name, suspended_at as at from tenants
         where status = 'suspended' and suspended_reason = 'unpaid' and suspended_at > $1::timestamptz
         order by id`,
        [recent],
      );
      for (const row of suspended.rows)
        due.push({ id: row.id, name: row.name, about: row.at, kind: 'suspended-unpaid' });
      for (const item of due) {
        await each(item.id, async () => {
          if (!(await claim(tx, item.kind, item.id, item.about, now))) return;
          // The warning stands for the past-due mail too, so a later pass never sends that one after it.
          if (item.kind === 'grace-ending') await claim(tx, 'past-due', item.id, item.about, now);
          const suspendsAt =
            item.kind === 'suspended-unpaid' ? undefined : new Date(item.about.getTime() + GRACE_DAYS * DAY_MS);
          afterCommit(() => mailAdmins(deps, item, suspendsAt), item.id);
        });
      }
    },
  };
}

async function mailAdmins(deps: MailStepDeps, item: Due, suspendsAt: Date | undefined): Promise<void> {
  const scope = await deps.lifecycle.tenantScope(item.id);
  const admins = await deps.tenancy
    .db(scope)
    .query<{ email: string }>(
      'select email from users where server_admin and disabled_at is null order by email_lower',
    );
  if (admins.rows.length === 0) return;
  const mail = renderControlMail(item.kind, {
    teamName: item.name,
    signInUrl: `${tenantUrl(deps.config, scope)}/sign-in`,
    ...(suspendsAt !== undefined ? { suspendsAt } : {}),
  });
  try {
    await deps.send(
      admins.rows.map((row) => row.email),
      mail,
    );
  } catch {
    // A refusal can quote a recipient: only the mail host is logged.
    deps.log.warn(
      { tenantId: item.id, mailHost: deps.mailHost, mail: item.kind },
      'a billing mail could not be sent; it will not be retried',
    );
  }
}
