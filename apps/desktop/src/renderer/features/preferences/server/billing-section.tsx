/**
 * Server › Billing (hosted edition spec §22.13): the plan, seats, status and period end. Payment is handled by the
 * payment provider's own pages, reached from its receipt emails; the app never takes a card. While the subscription is
 * past due, a banner says how many days are left before the team is suspended.
 */
import type { TenantBillingWire } from '@shared/wire-base.js';
import { CardError, Chip, FieldGrid, FieldLabel, ServerCard } from './server-card.js';
import { useServerSettingsStore } from './server-settings-store.js';

const STATUS: Readonly<Record<string, string>> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Past due',
  paused: 'Paused',
  canceled: 'Cancelled',
};

export const formatDate = (iso: string | null | undefined): string =>
  iso === null || iso === undefined
    ? '—'
    : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const capitalised = (text: string): string => (text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`);

/** The past-due banner (spec §22.13): the days left before the grace sweep suspends the team. */
export function PastDueBanner({ billing }: { readonly billing: TenantBillingWire | undefined }) {
  const subscription = billing?.subscription;
  if (subscription?.status !== 'past_due') return null;
  const days = subscription.pastDueDaysLeft;
  return (
    <div
      role="alert"
      data-testid="server-billing-past-due"
      className="mb-5 rounded-lg border border-status-danger/40 bg-status-danger/10 px-4 py-3 text-sm"
    >
      <p className="font-semibold text-status-danger">Payment failed</p>
      <p className="mt-0.5 text-fg-muted">
        {days === null
          ? 'The team will be suspended unless the subscription is paid.'
          : days === 0
            ? 'The team is suspended today unless the subscription is paid.'
            : `The team is suspended in ${String(days)} ${days === 1 ? 'day' : 'days'} unless the subscription is paid.`}{' '}
        Pay from the email Paddle sent to your billing contact.
      </p>
    </div>
  );
}

export function BillingSection() {
  const billing = useServerSettingsStore((s) => s.billing);
  const error = useServerSettingsStore((s) => s.errors.billing);
  const subscription = billing?.subscription ?? null;
  const status = subscription?.status;
  return (
    <div data-testid="server-billing">
      <PastDueBanner billing={billing} />
      <ServerCard
        title="Billing"
        testId="server-billing-card"
        chip={
          status === undefined ? undefined : (
            <Chip tone={status === 'past_due' ? 'danger' : status === 'active' ? 'ok' : 'neutral'}>
              {STATUS[status] ?? status}
            </Chip>
          )
        }
      >
        <FieldGrid>
          <FieldLabel>Plan</FieldLabel>
          <span data-testid="server-billing-plan" className="text-fg-default">
            {capitalised(subscription?.plan ?? billing?.edition ?? '—')}
          </span>
          <FieldLabel>Seats</FieldLabel>
          <span data-testid="server-billing-seats" className="text-fg-default">
            {subscription === null ? '—' : String(subscription.seats)}
          </span>
          <FieldLabel>Status</FieldLabel>
          <span data-testid="server-billing-status" className="text-fg-default">
            {status === undefined ? 'No subscription' : (STATUS[status] ?? status)}
            {billing?.status === 'suspended' && ' · the team is suspended'}
          </span>
          <FieldLabel>Current period ends</FieldLabel>
          <span data-testid="server-billing-period" className="text-fg-default">
            {formatDate(subscription?.currentPeriodEnd)}
          </span>
          <FieldLabel>Change seats or card</FieldLabel>
          <span className="text-fg-subtle">From the links in Paddle’s receipt emails</span>
        </FieldGrid>
        <CardError error={error} testId="server-billing-error" />
      </ServerCard>
    </div>
  );
}
