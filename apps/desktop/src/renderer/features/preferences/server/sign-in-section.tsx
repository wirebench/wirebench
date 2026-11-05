/**
 * Server › Sign-in (hosted edition spec §22.12, §22.13): the tenant's OpenID Connect provider and its SAML identity
 * provider. On a hosted team both are edited here and checked on save (the issuer's discovery must answer, the
 * metadata must parse and carry a signing certificate); on a self-hosted server both are read-only, from the
 * environment.
 */
import {
  Chip,
  CardError,
  CopyValue,
  EnvironmentCard,
  FieldGrid,
  FieldLabel,
  INPUT,
  MONO_INPUT,
  SaveFooter,
  SecretField,
  ServerCard,
  TEXTAREA,
  fieldText,
  secretSet,
  secretText,
} from './server-card.js';
import { compact, optional, useSection, wholeNumber } from './use-section.js';

const ENV = 'WIREBENCH_SERVER_';

interface OidcDraft {
  readonly issuer: string;
  readonly clientId: string;
  /** `undefined` keeps the stored secret. */
  readonly clientSecret: string | undefined;
  readonly scopes: string;
  readonly displayName: string;
}

const oidcDraft = (value: Readonly<Record<string, unknown>> | null): OidcDraft => ({
  issuer: fieldText(value, 'issuer') ?? '',
  clientId: fieldText(value, 'clientId') ?? '',
  clientSecret: undefined,
  scopes: fieldText(value, 'scopes') ?? 'openid email profile',
  displayName: fieldText(value, 'displayName') ?? '',
});

export function OidcCard() {
  const card = useSection('oidc', 'OpenID Connect', oidcDraft);
  const { draft, value } = card;
  if (card.state?.source === 'environment') {
    return (
      <EnvironmentCard
        title="OpenID Connect"
        testId="server-oidc"
        set={value !== null}
        rows={[
          { label: 'Issuer', variable: `${ENV}OIDC_ISSUER`, value: fieldText(value, 'issuer') },
          { label: 'Client ID', variable: `${ENV}OIDC_CLIENT_ID`, value: fieldText(value, 'clientId') },
          {
            label: 'Client secret',
            variable: `${ENV}OIDC_CLIENT_SECRET`,
            value: secretText(value, 'clientSecret'),
            secret: true,
          },
          { label: 'Scopes', variable: `${ENV}OIDC_SCOPES`, value: fieldText(value, 'scopes') },
          { label: 'Button label', variable: `${ENV}OIDC_DISPLAY_NAME`, value: fieldText(value, 'displayName') },
        ]}
      />
    );
  }
  const stored = secretSet(value, 'clientSecret');
  const save = (): void => {
    const secret = draft.clientSecret?.trim();
    const problem =
      draft.issuer.trim() === '' || draft.clientId.trim() === ''
        ? 'Enter the issuer and the client ID.'
        : !stored && (secret === undefined || secret === '')
          ? 'Enter the client secret.'
          : undefined;
    const scopes = draft.scopes.split(/[\s,]+/).filter((scope) => scope !== '');
    void card.save(
      compact({
        issuer: draft.issuer.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: secret === '' ? undefined : secret,
        scopes: scopes.length === 0 ? undefined : scopes,
        displayName: optional(draft.displayName),
      }),
      problem,
    );
  };
  return (
    <ServerCard
      title="OpenID Connect"
      testId="server-oidc"
      chip={
        <Chip tone={value === null ? 'neutral' : 'ok'} testId="server-oidc-state">
          {value === null ? 'Not set up' : 'Connected'}
        </Chip>
      }
      footer={
        <SaveFooter
          testId="server-oidc"
          busy={card.busy}
          canRemove={value !== null}
          onRemove={() => void card.remove()}
          onSave={save}
        />
      }
    >
      <FieldGrid>
        <FieldLabel htmlFor="server-oidc-issuer">Issuer</FieldLabel>
        <input
          id="server-oidc-issuer"
          data-testid="server-oidc-issuer"
          value={draft.issuer}
          placeholder="https://login.example.com"
          spellCheck={false}
          onChange={(event) => card.setDraft({ issuer: event.target.value })}
          className={MONO_INPUT}
        />
        <FieldLabel htmlFor="server-oidc-client-id">Client ID</FieldLabel>
        <input
          id="server-oidc-client-id"
          data-testid="server-oidc-client-id"
          value={draft.clientId}
          spellCheck={false}
          onChange={(event) => card.setDraft({ clientId: event.target.value })}
          className={MONO_INPUT}
        />
        <FieldLabel>Client secret</FieldLabel>
        <SecretField
          id="server-oidc-secret"
          label="Client secret"
          set={stored}
          value={draft.clientSecret ?? (stored ? undefined : '')}
          onChange={(clientSecret) => card.setDraft({ clientSecret })}
        />
        <FieldLabel htmlFor="server-oidc-scopes">Scopes</FieldLabel>
        <input
          id="server-oidc-scopes"
          data-testid="server-oidc-scopes"
          value={draft.scopes}
          spellCheck={false}
          onChange={(event) => card.setDraft({ scopes: event.target.value })}
          className={INPUT}
        />
        <FieldLabel htmlFor="server-oidc-display-name">Button label</FieldLabel>
        <input
          id="server-oidc-display-name"
          data-testid="server-oidc-display-name"
          value={draft.displayName}
          placeholder="OIDC"
          maxLength={60}
          onChange={(event) => card.setDraft({ displayName: event.target.value })}
          className={INPUT}
        />
        <FieldLabel>Redirect URIs</FieldLabel>
        <div className="flex min-w-0 flex-col gap-1">
          <CopyValue testId="server-oidc-redirect" value={`${card.url}/api/v1/auth/oidc/callback`} />
          <CopyValue testId="server-oidc-browser-redirect" value={`${card.url}/api/v1/auth/oidc/browser-callback`} />
        </div>
      </FieldGrid>
      <CardError error={card.error} testId="server-oidc-error" />
    </ServerCard>
  );
}

interface SamlDraft {
  readonly idpMetadataXml: string;
  readonly displayName: string;
  readonly emailAttribute: string;
  readonly nameAttribute: string;
  readonly clockSkewSeconds: string;
}

const samlDraft = (value: Readonly<Record<string, unknown>> | null): SamlDraft => ({
  idpMetadataXml: fieldText(value, 'idpMetadataXml') ?? '',
  displayName: fieldText(value, 'displayName') ?? '',
  emailAttribute: fieldText(value, 'emailAttribute') ?? '',
  nameAttribute: fieldText(value, 'nameAttribute') ?? '',
  clockSkewSeconds: fieldText(value, 'clockSkewSeconds') ?? '',
});

export function SamlCard() {
  const card = useSection('saml', 'SAML', samlDraft);
  const { draft, value } = card;
  if (card.state?.source === 'environment') {
    return (
      <EnvironmentCard
        title="SAML"
        testId="server-saml"
        set={value !== null}
        rows={[
          { label: 'IdP metadata', variable: `${ENV}SAML_IDP_METADATA`, value: fieldText(value, 'idpMetadataSource') },
          { label: 'Button label', variable: `${ENV}SAML_DISPLAY_NAME`, value: fieldText(value, 'displayName') },
          {
            label: 'Email attribute',
            variable: `${ENV}SAML_EMAIL_ATTRIBUTE`,
            value: fieldText(value, 'emailAttribute'),
          },
          { label: 'Name attribute', variable: `${ENV}SAML_NAME_ATTRIBUTE`, value: fieldText(value, 'nameAttribute') },
          {
            label: 'Clock skew (seconds)',
            variable: `${ENV}SAML_CLOCK_SKEW_SECONDS`,
            value: fieldText(value, 'clockSkewSeconds'),
          },
        ]}
      />
    );
  }
  const save = (): void => {
    const skew = wholeNumber(draft.clockSkewSeconds);
    const problem =
      draft.idpMetadataXml.trim() === ''
        ? 'Paste the identity provider’s metadata XML.'
        : skew !== undefined && (Number.isNaN(skew) || skew > 300)
          ? 'The clock skew is a whole number of seconds, at most 300.'
          : undefined;
    void card.save(
      compact({
        idpMetadataXml: draft.idpMetadataXml.trim(),
        displayName: optional(draft.displayName),
        emailAttribute: optional(draft.emailAttribute),
        nameAttribute: optional(draft.nameAttribute),
        clockSkewSeconds: skew,
      }),
      problem,
    );
  };
  return (
    <ServerCard
      title="SAML"
      testId="server-saml"
      chip={
        <Chip tone={value === null ? 'neutral' : 'ok'} testId="server-saml-state">
          {value === null ? 'Not set up' : 'Connected'}
        </Chip>
      }
      footer={
        <SaveFooter
          testId="server-saml"
          busy={card.busy}
          canRemove={value !== null}
          onRemove={() => void card.remove()}
          onSave={save}
        />
      }
    >
      <FieldGrid>
        <FieldLabel htmlFor="server-saml-metadata">IdP metadata (XML)</FieldLabel>
        <textarea
          id="server-saml-metadata"
          data-testid="server-saml-metadata"
          rows={4}
          value={draft.idpMetadataXml}
          placeholder="Paste your identity provider’s metadata XML"
          spellCheck={false}
          onChange={(event) => card.setDraft({ idpMetadataXml: event.target.value })}
          className={TEXTAREA}
        />
        <FieldLabel htmlFor="server-saml-display-name">Button label</FieldLabel>
        <input
          id="server-saml-display-name"
          data-testid="server-saml-display-name"
          value={draft.displayName}
          placeholder="SSO"
          maxLength={60}
          onChange={(event) => card.setDraft({ displayName: event.target.value })}
          className={INPUT}
        />
        <FieldLabel htmlFor="server-saml-email">Email attribute</FieldLabel>
        <input
          id="server-saml-email"
          value={draft.emailAttribute}
          placeholder="The subject’s NameID"
          onChange={(event) => card.setDraft({ emailAttribute: event.target.value })}
          className={MONO_INPUT}
        />
        <FieldLabel htmlFor="server-saml-name">Name attribute</FieldLabel>
        <input
          id="server-saml-name"
          value={draft.nameAttribute}
          onChange={(event) => card.setDraft({ nameAttribute: event.target.value })}
          className={MONO_INPUT}
        />
        <FieldLabel htmlFor="server-saml-skew">Clock skew (seconds)</FieldLabel>
        <input
          id="server-saml-skew"
          inputMode="numeric"
          value={draft.clockSkewSeconds}
          placeholder="120"
          onChange={(event) => card.setDraft({ clockSkewSeconds: event.target.value })}
          className={`${INPUT} max-w-32`}
        />
        <FieldLabel>Entity ID · ACS URL</FieldLabel>
        <div className="flex min-w-0 flex-col gap-1">
          <CopyValue testId="server-saml-entity-id" value={`${card.url}/api/v1/auth/saml/metadata`} />
          <CopyValue testId="server-saml-acs" value={`${card.url}/api/v1/auth/saml/acs`} />
        </div>
      </FieldGrid>
      <CardError error={card.error} testId="server-saml-error" />
    </ServerCard>
  );
}

/** The Sign-in page: both providers, one card each. */
export function SignInSection() {
  return (
    <div data-testid="server-sign-in">
      <OidcCard />
      <SamlCard />
    </div>
  );
}
