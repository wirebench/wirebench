/**
 * Saving a tenant's settings section (hosted edition spec §22.12), the one path the API and `admin tenant settings`
 * share: the section's shape, then what the server checks before it trusts the value, then the write with its
 * `settings.changed` event in the same unit. The event names the section, never a value.
 *
 * - **oidc**: the issuer is `https://` (or `http://` with the development switch) and its discovery answers, under
 *   the egress rule, with the client id and secret given (or the stored secret when none is).
 * - **saml**: the pasted metadata parses and carries a signing certificate.
 * - **auditForward**: the URL is `https://`, with no credentials in it (the token has its own field); a CA, when
 *   given, holds at least one PEM certificate.
 * - **smtp**: the URL is `smtp://` or `smtps://`, and its host passes the egress rule: a literal address as it is, a
 *   name by what it resolves to now (the send checks again, since a name can change what it resolves to).
 */
import { isIP } from 'node:net';
import { checkEgress, checkedLookup, splitPemBundle, type EgressPolicy } from '@wirebench/engine';
import { recordAudit, type AuditSource, type ServerHooks } from '../context.js';
import { discoverOidc, type OidcSettings } from '../identity/oidc.js';
import { problem } from '../problem.js';
import { parseIdpMetadata } from '../sso/saml-metadata.js';
import type { TenantScope } from '../tenancy/scope.js';
import {
  OPERATOR_ONLY_SECTIONS,
  SECRET_AGAIN,
  SECTION_INPUTS,
  type SectionInputs,
  type SettingsSection,
} from './sections.js';
import { settingsInvalid, settingsOperatorOnly, type TenantSettings } from './service.js';

export interface SaveDeps {
  readonly settings: TenantSettings;
  readonly hooks: ServerHooks;
  /** `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL`: an `http://` issuer, for a development one only. */
  readonly allowInsecure: boolean;
  /** The egress rule the issuer's discovery and the SMTP host's check run under: `ctx.egress`, or `'unchecked'` for a test's loopback servers. */
  readonly egress: EgressPolicy | 'unchecked';
  /** Discovery; `discoverOidc` unless a test passes its own. */
  readonly discover?: (settings: OidcSettings) => Promise<unknown>;
}

export interface SaveOptions {
  /** `updated_by`: the caller's user id, or `operator`. */
  readonly by: string;
  readonly operator?: boolean;
  /** Who did it, for `settings.changed`. */
  readonly source: AuditSource;
}

const refused = (code: string, message: string) => problem(code, message, 400);

/**
 * Whether `host` passes `policy`: the egress refusal's own message (it names the host and the class of address,
 * never the address), or `undefined`. A name that does not resolve passes; the send's own check refuses it later.
 */
async function egressRefusal(host: string, policy: EgressPolicy | 'unchecked'): Promise<string | undefined> {
  if (policy === 'unchecked') return undefined;
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  try {
    if (isIP(literal) !== 0) checkEgress(host, literal, policy);
    else
      await new Promise<void>((resolve, reject) => {
        checkedLookup(policy)(literal, { all: true }, (error) => (error === null ? resolve() : reject(error)));
      });
    return undefined;
  } catch (error) {
    return (error as { code?: unknown }).code === 'egress-refused' && error instanceof Error
      ? error.message
      : undefined;
  }
}

const parsedUrl = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** What the server checks of a parsed section before it stores it; throws the section's own refusal. */
async function check<S extends SettingsSection>(
  deps: SaveDeps,
  scope: TenantScope,
  section: S,
  input: SectionInputs[S],
): Promise<void> {
  switch (section) {
    case 'oidc': {
      const oidc = input as SectionInputs['oidc'];
      const issuer = parsedUrl(oidc.issuer);
      if (
        issuer === undefined ||
        !(issuer.protocol === 'https:' || (issuer.protocol === 'http:' && deps.allowInsecure))
      )
        throw refused('settings-oidc-issuer', 'The OIDC issuer must be an https:// URL.');
      const stored = await deps.settings.of(scope, 'oidc');
      // Before discovery, so a new issuer is never asked anything with the old secret kept (the store refuses it too).
      if (
        oidc.clientSecret === undefined &&
        stored !== undefined &&
        (stored.issuer !== oidc.issuer || stored.clientId !== oidc.clientId)
      )
        throw settingsInvalid(SECRET_AGAIN.oidc!);
      const clientSecret = oidc.clientSecret ?? stored?.clientSecret;
      if (clientSecret === undefined) throw settingsInvalid('The OIDC settings need a client secret.');
      try {
        await (deps.discover ?? discoverOidc)({
          issuer: oidc.issuer,
          clientId: oidc.clientId,
          clientSecret,
          scopes: oidc.scopes,
          allowInsecure: deps.allowInsecure,
          egress: deps.egress,
        });
      } catch {
        // Never the IdP's answer: it can echo what it was sent.
        throw refused(
          'settings-oidc-discovery',
          `The OIDC issuer ${issuer.host} did not answer its discovery document.`,
        );
      }
      return;
    }
    case 'saml':
      try {
        parseIdpMetadata((input as SectionInputs['saml']).idpMetadataXml);
      } catch (error) {
        throw refused(
          'settings-saml-metadata',
          `The SAML metadata cannot be used: ${error instanceof Error ? error.message : 'it does not parse'}.`,
        );
      }
      return;
    case 'auditForward': {
      const forward = input as SectionInputs['auditForward'];
      const url = parsedUrl(forward.url);
      if (url?.protocol !== 'https:' || url.username !== '' || url.password !== '')
        throw refused(
          'settings-forward-url',
          'The forwarding URL must be an https:// URL with no credentials in it; put a token in its own field.',
        );
      if (forward.caPem !== undefined && splitPemBundle(forward.caPem).length === 0)
        throw refused('settings-forward-ca', 'The forwarding CA holds no PEM certificate.');
      return;
    }
    case 'smtp': {
      const url = parsedUrl((input as SectionInputs['smtp']).url);
      if (url === undefined || (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || url.hostname === '')
        throw refused('settings-smtp-url', 'The SMTP URL must be an smtp:// or smtps:// URL.');
      const refusal = await egressRefusal(url.hostname, deps.egress);
      if (refusal !== undefined) throw refused('settings-smtp-host', refusal);
      return;
    }
    default:
      return;
  }
}

/**
 * Checks and stores `input` as `scope`'s `section`, with `settings.changed` in the write's unit.
 *
 * @throws WirebenchError as `TenantSettings.set` does, and each check's refusal above.
 */
export async function saveSection(
  deps: SaveDeps,
  scope: TenantScope,
  section: SettingsSection,
  input: unknown,
  options: SaveOptions,
): Promise<void> {
  // The cheap refusals first, so nothing is fetched for a write that cannot happen: self-hosted and operator-only.
  if (deps.settings.source === 'environment') return deps.settings.set(scope, section, input, options);
  if (OPERATOR_ONLY_SECTIONS.has(section) && options.operator !== true) throw settingsOperatorOnly();
  const parsed = SECTION_INPUTS[section].safeParse(input);
  // The service phrases the shape's refusal; it runs the same parse.
  if (parsed.success) await check(deps, scope, section, parsed.data);
  await deps.settings.set(scope, section, input, {
    by: options.by,
    ...(options.operator === true ? { operator: true } : {}),
    within: (tx) =>
      recordAudit(deps.hooks, tx, {
        ...options.source,
        action: 'settings.changed',
        target: { kind: 'server' },
        details: { section },
      }),
  });
}

/** Removes `scope`'s `section`, with `settings.changed` when there was one; whether there was. */
export function clearSection(
  deps: Pick<SaveDeps, 'settings' | 'hooks'>,
  scope: TenantScope,
  section: SettingsSection,
  options: SaveOptions,
): Promise<boolean> {
  return deps.settings.clear(scope, section, {
    by: options.by,
    ...(options.operator === true ? { operator: true } : {}),
    within: (tx) =>
      recordAudit(deps.hooks, tx, {
        ...options.source,
        action: 'settings.changed',
        target: { kind: 'server' },
        details: { section },
      }),
  });
}
