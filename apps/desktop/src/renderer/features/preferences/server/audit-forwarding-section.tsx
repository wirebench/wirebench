/**
 * Server › Audit forwarding (hosted edition spec §22.12): where the tenant's audit events are also sent. The URL must
 * be `https` with no credentials in it, the token is sealed and never shown, and the CA is a PEM bundle to trust.
 */
import {
  CardError,
  Chip,
  EnvironmentCard,
  FieldGrid,
  FieldLabel,
  MONO_INPUT,
  SaveFooter,
  SecretField,
  ServerCard,
  TEXTAREA,
  fieldText,
  secretSet,
  secretText,
} from './server-card.js';
import { compact, optional, useSection } from './use-section.js';

interface ForwardDraft {
  readonly url: string;
  readonly caPem: string;
  readonly token: string | undefined;
}

const forwardDraft = (value: Readonly<Record<string, unknown>> | null): ForwardDraft => ({
  url: fieldText(value, 'url') ?? '',
  caPem: fieldText(value, 'caPem') ?? '',
  token: undefined,
});

export function AuditForwardingSection() {
  const card = useSection('auditForward', 'Audit forwarding', forwardDraft);
  const { draft, value } = card;
  if (card.state?.source === 'environment') {
    return (
      <EnvironmentCard
        title="Audit forwarding"
        testId="server-audit-forward"
        set={value !== null}
        rows={[
          { label: 'URL', variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_URL', value: fieldText(value, 'url') },
          { label: 'CA file', variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE', value: fieldText(value, 'caFile') },
          {
            label: 'Token',
            variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN',
            value: secretText(value, 'token'),
            secret: true,
          },
        ]}
      />
    );
  }
  const stored = secretSet(value, 'token');
  const save = (): void => {
    const url = draft.url.trim();
    const problem = !url.startsWith('https://') ? 'The forwarding URL must start with https://.' : undefined;
    const token = draft.token?.trim();
    void card.save(compact({ url, caPem: optional(draft.caPem), token: token === '' ? undefined : token }), problem);
  };
  return (
    <div data-testid="server-audit-forwarding">
      <ServerCard
        title="Audit forwarding"
        testId="server-audit-forward"
        chip={
          <Chip tone={value === null ? 'neutral' : 'ok'} testId="server-audit-forward-state">
            {value === null ? 'Not set up' : 'Forwarding'}
          </Chip>
        }
        footer={
          <SaveFooter
            testId="server-audit-forward"
            busy={card.busy}
            canRemove={value !== null}
            onRemove={() => void card.remove()}
            onSave={save}
          />
        }
      >
        <p className="mb-4 text-sm text-fg-subtle">
          Every audit event is also sent to this address as it is written. A failed send is retried, and holds up no
          other team’s.
        </p>
        <FieldGrid>
          <FieldLabel htmlFor="server-audit-forward-url">URL</FieldLabel>
          <input
            id="server-audit-forward-url"
            data-testid="server-audit-forward-url"
            value={draft.url}
            placeholder="https://siem.example.com/ingest"
            spellCheck={false}
            onChange={(event) => card.setDraft({ url: event.target.value })}
            className={MONO_INPUT}
          />
          <FieldLabel>Token</FieldLabel>
          <SecretField
            id="server-audit-forward-token"
            label="Forwarding token"
            set={stored}
            value={draft.token}
            onChange={(token) => card.setDraft({ token })}
          />
          <FieldLabel htmlFor="server-audit-forward-ca">CA (PEM)</FieldLabel>
          <textarea
            id="server-audit-forward-ca"
            data-testid="server-audit-forward-ca"
            rows={3}
            value={draft.caPem}
            placeholder="-----BEGIN CERTIFICATE-----"
            spellCheck={false}
            onChange={(event) => card.setDraft({ caPem: event.target.value })}
            className={TEXTAREA}
          />
        </FieldGrid>
        <CardError error={card.error} testId="server-audit-forward-error" />
      </ServerCard>
    </div>
  );
}
