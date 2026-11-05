/**
 * Server › Email (hosted edition spec §22.12): the SMTP server the tenant's mail goes out through, alerts and the
 * team's own notices; without one, the operator's sends them. The URL is `smtp:` or `smtps:`; its credentials are
 * sealed and never shown, so they are typed apart and put into the URL on save.
 */
import {
  CardError,
  Chip,
  EnvironmentCard,
  FieldGrid,
  FieldLabel,
  INPUT,
  MONO_INPUT,
  SaveFooter,
  ServerCard,
  fieldText,
  secretSet,
  secretText,
} from './server-card.js';
import { Button } from '../../../components/button.js';
import { useSection } from './use-section.js';

interface SmtpDraft {
  readonly url: string;
  readonly from: string;
  /** `undefined` keeps the stored credentials. */
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
}

const smtpDraft = (value: Readonly<Record<string, unknown>> | null): SmtpDraft => ({
  url: fieldText(value, 'url') ?? '',
  from: fieldText(value, 'from') ?? '',
  credentials: undefined,
});

/** `url` with `credentials` in it, or `undefined` when it does not parse. */
export function smtpUrl(url: string, credentials: SmtpDraft['credentials']): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (credentials !== undefined && credentials.username.trim() !== '') {
    parsed.username = encodeURIComponent(credentials.username.trim());
    parsed.password = encodeURIComponent(credentials.password);
  }
  return parsed.href;
}

/** Where an SMTP URL connects, as the server compares it: scheme, host and port (each scheme's default filled in). */
export function smtpEndpoint(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    const port = parsed.port === '' ? (parsed.protocol === 'smtps:' ? '465' : '587') : parsed.port;
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return undefined;
  }
}

export function EmailSection() {
  const card = useSection('smtp', 'Email', smtpDraft);
  const { draft, value } = card;
  if (card.state?.source === 'environment') {
    return (
      <EnvironmentCard
        title="Email"
        testId="server-smtp"
        set={value !== null}
        rows={[
          { label: 'SMTP URL', variable: 'WIREBENCH_SERVER_SMTP_URL', value: fieldText(value, 'url') },
          {
            label: 'Credentials',
            variable: 'WIREBENCH_SERVER_SMTP_URL',
            value: secretText(value, 'credentials'),
            secret: true,
          },
          { label: 'From', variable: 'WIREBENCH_SERVER_SMTP_FROM', value: fieldText(value, 'from') },
        ]}
      />
    );
  }
  const stored = secretSet(value, 'credentials');
  const save = (): void => {
    const url = smtpUrl(draft.url, draft.credentials);
    const problem =
      url === undefined || !/^smtps?:$/.test(new URL(url).protocol)
        ? 'The SMTP URL starts with smtp:// or smtps://.'
        : draft.from.trim() === ''
          ? 'Enter the address mail is sent from.'
          : undefined;
    const redirected =
      stored &&
      draft.credentials === undefined &&
      smtpEndpoint(draft.url) !== smtpEndpoint(fieldText(value, 'url') ?? '');
    void card.save(
      { url: url ?? draft.url.trim(), from: draft.from.trim() },
      problem,
      redirected ? { credentials: { username: '', password: '' } } : undefined,
    );
  };
  return (
    <div data-testid="server-email">
      <ServerCard
        title="Email"
        testId="server-smtp"
        chip={
          <Chip tone={value === null ? 'neutral' : 'ok'} testId="server-smtp-state">
            {value === null ? 'The operator’s' : 'Your SMTP server'}
          </Chip>
        }
        footer={
          <SaveFooter
            testId="server-smtp"
            busy={card.busy}
            canRemove={value !== null}
            onRemove={() => void card.remove()}
            onSave={save}
          />
        }
      >
        <p className="mb-4 text-sm text-fg-subtle">
          Alerts, invitations and the team’s notices go out through this server. Without one, the service’s own mail
          server sends them.
        </p>
        <FieldGrid>
          <FieldLabel htmlFor="server-smtp-url">SMTP URL</FieldLabel>
          <input
            id="server-smtp-url"
            data-testid="server-smtp-url"
            value={draft.url}
            placeholder="smtps://smtp.example.com:465"
            spellCheck={false}
            onChange={(event) => card.setDraft({ url: event.target.value })}
            className={MONO_INPUT}
          />
          <FieldLabel>Credentials</FieldLabel>
          {draft.credentials === undefined ? (
            <div className="flex items-center gap-2.5">
              <Chip testId="server-smtp-credentials-state">{stored ? 'Set' : 'Not set'}</Chip>
              <Button
                data-testid="server-smtp-credentials-replace"
                onClick={() => card.setDraft({ credentials: { username: '', password: '' } })}
              >
                {stored ? 'Replace…' : 'Set…'}
              </Button>
              <span className="text-xs text-fg-faint">Never shown again once saved</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                aria-label="SMTP user name"
                data-testid="server-smtp-username"
                autoComplete="off"
                placeholder="User name"
                value={draft.credentials.username}
                onChange={(event) =>
                  card.setDraft({ credentials: { password: '', ...draft.credentials, username: event.target.value } })
                }
                className={INPUT}
              />
              <input
                aria-label="SMTP password"
                data-testid="server-smtp-password"
                type="password"
                autoComplete="off"
                placeholder="Password"
                value={draft.credentials.password}
                onChange={(event) =>
                  card.setDraft({ credentials: { username: '', ...draft.credentials, password: event.target.value } })
                }
                className={INPUT}
              />
              <Button variant="ghost" onClick={() => card.setDraft({ credentials: undefined })}>
                {stored ? 'Keep current' : 'Cancel'}
              </Button>
            </div>
          )}
          <FieldLabel htmlFor="server-smtp-sender">From</FieldLabel>
          <input
            id="server-smtp-sender"
            data-testid="server-smtp-sender"
            type="email"
            value={draft.from}
            placeholder="wirebench@example.com"
            onChange={(event) => card.setDraft({ from: event.target.value })}
            className={INPUT}
          />
        </FieldGrid>
        <CardError error={card.error} testId="server-smtp-error" />
      </ServerCard>
    </div>
  );
}
