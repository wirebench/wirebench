import { useEffect, useState } from 'react';
import type { CustomDomainStateWire } from '@shared/wire-base.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useDomainStore } from '../../state/domain.js';
import { INPUT_CLASS } from './roles.js';

/** Each state of spec §23.2 in plain words: a short label and what it means for the admin. */
export const DOMAIN_STATE_WORDS: Readonly<Record<CustomDomainStateWire, { label: string; detail: string }>> = {
  pending: {
    label: 'Waiting for the DNS records',
    detail:
      'Create the two records below. They are checked every hour, or choose Check now once they are in place. A claim not proved within 7 days expires.',
  },
  verified: {
    label: 'Records found',
    detail:
      'The records are in place. A certificate for the name is on its way, and the name is served once it arrives.',
  },
  active: {
    label: 'Active',
    detail: 'The team is served at this name. Links in invitations and mail use it.',
  },
  failing: {
    label: 'Records missing',
    detail:
      'The last check did not find the records. The name is still served, but it stops after 72 hours of failed checks. Put the records back, then choose Check now.',
  },
  lapsed: {
    label: 'Lapsed',
    detail:
      'The records were missing for 72 hours, so the name is no longer served. Put the records back and choose Check now to prove it again.',
  },
  paused: {
    label: 'Paused',
    detail:
      'The name stopped being served while custom domains were not part of this team’s edition. Choose Check now to prove it again.',
  },
  expired: {
    label: 'Expired',
    detail: 'The records were not seen within 7 days. Remove the name, then claim it again to get new records.',
  },
};

/** Words for a name another team holds: they say that one does, never which. */
export const HELD_ELSEWHERE =
  'The records are right, but another team on this service already uses this name, so it cannot be served here.';

/**
 * A name with only two labels is most likely the top of a domain, which cannot hold a CNAME (spec §23.1). The
 * server carries no public suffix list, so this is a hint, not a refusal.
 */
export const looksLikeApex = (name: string): boolean => name.split('.').filter((label) => label !== '').length === 2;

function CopyButton({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  return (
    <Button
      variant="ghost"
      data-testid={testId}
      aria-label={`Copy ${label}`}
      onClick={() => void navigator.clipboard.writeText(value)}
    >
      Copy
    </Button>
  );
}

/**
 * The Domain tab (hosted edition spec §23.6), for server admins of a hosted server with the `custom-domains` feature:
 * claim one name, create its two DNS records, check them and remove the name. The team dialog shows the tab only
 * when the server answered its read. The last check's message can quote DNS content, so it is shown as text only.
 */
export function DomainTab({ url }: { readonly url: string }) {
  const store = useDomainStore();
  const [name, setName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    const current = useDomainStore.getState();
    if (current.url !== url || !current.loaded) void current.load(url);
  }, [url]);

  const claim = async (): Promise<void> => {
    if (name.trim().length === 0) return;
    if (await store.claim(url, name)) setName('');
  };

  const domain = store.domain;
  const words = domain !== undefined ? DOMAIN_STATE_WORDS[domain.state] : undefined;

  return (
    <div data-testid="domain-tab" className="flex flex-col gap-5 text-sm">
      {store.error !== undefined && (
        <p data-testid="domain-error" role="alert" className="text-xs text-status-danger">
          {store.error}
        </p>
      )}

      {domain === undefined ? (
        <section aria-labelledby="domain-claim-heading" className="flex flex-col gap-2">
          <h3 id="domain-claim-heading" className="font-medium text-fg-default">
            Custom domain
          </h3>
          <p className="text-xs text-fg-subtle">
            Serve this team at a name of your own, such as wirebench.example.com. You prove the name with two DNS
            records.
          </p>
          {store.loaded && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void claim();
              }}
            >
              <input
                data-testid="domain-name-input"
                aria-label="Domain name"
                placeholder="wirebench.example.com"
                maxLength={253}
                spellCheck={false}
                autoCapitalize="off"
                className={`${INPUT_CLASS} flex-1`}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <Button
                type="submit"
                variant="primary"
                data-testid="domain-claim"
                disabled={store.busy || name.trim().length === 0}
              >
                Claim
              </Button>
            </form>
          )}
        </section>
      ) : (
        <>
          <section aria-labelledby="domain-heading" className="flex flex-col gap-2">
            <h3 id="domain-heading" className="font-medium text-fg-default">
              Custom domain
            </h3>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-fg-subtle">Name</dt>
              <dd data-testid="domain-name" className="truncate font-mono text-xs">
                {domain.name}
              </dd>
              <dt className="text-fg-subtle">Status</dt>
              <dd data-testid="domain-state">{words?.label}</dd>
              <dt className="text-fg-subtle">Last checked</dt>
              <dd data-testid="domain-checked-at">
                {domain.checkedAt === null
                  ? 'Not checked yet'
                  : `${domain.checkedAt.slice(0, 16).replace('T', ' ')} UTC`}
              </dd>
            </dl>
            <p data-testid="domain-state-detail">{words?.detail}</p>
            {domain.lastResult?.heldElsewhere === true && (
              <p data-testid="domain-held-elsewhere" role="status" className="text-status-warning">
                {HELD_ELSEWHERE}
              </p>
            )}
            {domain.lastResult !== null && (
              // DNS content, quoted by the server: React renders it as text, never as markup.
              <p data-testid="domain-last-result" className="text-xs break-words whitespace-pre-wrap text-fg-subtle">
                {domain.lastResult.message}
              </p>
            )}
            {looksLikeApex(domain.name) && (
              <p data-testid="domain-apex-hint" role="note" className="text-xs text-status-warning">
                A name at the top of a domain, such as example.com, cannot hold a CNAME record, so its check passes only
                if your DNS provider flattens the record. A subdomain such as wirebench.example.com always works.
              </p>
            )}
            {domain.state === 'active' && (
              <p
                data-testid="domain-idp-notice"
                role="note"
                className="rounded-sm bg-surface-hover px-2 py-1 text-xs text-fg-default"
              >
                Sign-in through an identity provider now completes at {domain.name}. Update the redirect URI (OIDC) or
                the ACS URL (SAML) at the identity provider, or sign-in through it fails. Password and email sign-in are
                not affected.
              </p>
            )}
            <div className="flex gap-2">
              {domain.state !== 'expired' && (
                <Button data-testid="domain-check" disabled={store.busy} onClick={() => void store.check(url)}>
                  Check now
                </Button>
              )}
              <Button
                variant="ghost"
                data-testid="domain-remove"
                disabled={store.busy}
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                Remove…
              </Button>
            </div>
          </section>

          <section aria-labelledby="domain-records-heading" className="flex flex-col gap-2">
            <h3 id="domain-records-heading" className="font-medium text-fg-default">
              DNS records
            </h3>
            <p className="text-xs text-fg-subtle">
              Create both records at your DNS provider. Keep them for as long as you use the name.
            </p>
            <table data-testid="domain-records" className="w-full table-fixed text-left">
              <thead className="text-xs text-fg-subtle">
                <tr>
                  <th className="w-16 font-normal">Type</th>
                  <th className="font-normal">Name</th>
                  <th className="font-normal">Value</th>
                </tr>
              </thead>
              <tbody>
                {domain.records.map((record, index) => (
                  <tr key={record.type} data-testid={`domain-record-${String(index)}`}>
                    <td data-testid={`domain-record-${String(index)}-type`}>{record.type}</td>
                    <td>
                      <span className="flex min-w-0 items-center gap-1">
                        <span
                          data-testid={`domain-record-${String(index)}-name`}
                          className="truncate font-mono text-xs"
                        >
                          {record.name}
                        </span>
                        <CopyButton
                          label={`${record.type} name`}
                          value={record.name}
                          testId={`domain-record-${String(index)}-name-copy`}
                        />
                      </span>
                    </td>
                    <td>
                      <span className="flex min-w-0 items-center gap-1">
                        <span
                          data-testid={`domain-record-${String(index)}-value`}
                          className="truncate font-mono text-xs"
                        >
                          {record.value}
                        </span>
                        <CopyButton
                          label={`${record.type} value`}
                          value={record.value}
                          testId={`domain-record-${String(index)}-value-copy`}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${domain?.name ?? 'the name'}?`}
        description={
          domain?.state === 'active'
            ? 'The name stops being served, and links go back to the team’s own address. Change the identity provider’s redirect URI or ACS URL back too. To use the name again, claim it with new records.'
            : 'The claim and its records are dropped. To use the name again, claim it with new records.'
        }
        confirmLabel="Remove name"
        destructive
        testId="domain-remove-confirm"
        confirmTestId="domain-remove-confirm-button"
        onConfirm={() => {
          void store.remove(url);
        }}
      />
    </div>
  );
}
