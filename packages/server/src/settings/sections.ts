/**
 * The per-tenant settings' sections (hosted edition spec §22.12): one `tenant_settings` row each, its plain fields in
 * `value` and its secret fields, when it has any, sealed in `sealed` under the tenant's data key (`store.ts`).
 *
 * Each section has three shapes:
 *
 * - **input**: what a `PUT` (or `admin tenant settings set`) sends, secrets as plain text. A secret left out keeps the
 *   stored one, so a screen that never shows a secret can still save the other fields.
 * - **resolved** ({@link SectionValues}): what a module reads through `ctx.settings.of`, secrets opened. Never on the
 *   API, never in a log.
 * - **view** ({@link SectionView}): what the API answers, each secret as `{ set: boolean }` and nothing more.
 *
 * `budgets` is the operator's (spec §20.7): a tenant's own `PUT` is refused with `settings-operator-only`.
 */
import { z } from 'zod';

export const SETTINGS_SECTIONS = ['oidc', 'saml', 'auditForward', 'smtp', 'retention', 'budgets'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The sections only the operator writes (spec §22.12). */
export const OPERATOR_ONLY_SECTIONS: ReadonlySet<SettingsSection> = new Set<SettingsSection>(['budgets']);

export function isSettingsSection(name: string): name is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(name);
}

/** The most a pasted metadata document, or a CA bundle, may be: far above any real one. */
export const MAX_DOCUMENT_CHARS = 1024 * 1024;

const text = (max: number) => z.string().min(1).max(max);
const days = (max: number) => z.number().int().min(1).max(max);

const oidcInput = z.strictObject({
  issuer: text(2048),
  clientId: text(256),
  clientSecret: text(1024).optional(),
  scopes: z
    .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/))
    .min(1)
    .max(20)
    .default(['openid', 'email', 'profile']),
  displayName: text(60).default('OIDC'),
});

const samlInput = z.strictObject({
  idpMetadataXml: text(MAX_DOCUMENT_CHARS),
  displayName: text(60).default('SSO'),
  emailAttribute: text(256).optional(),
  nameAttribute: text(256).optional(),
  clockSkewSeconds: z.number().int().min(0).max(300).default(120),
});

const auditForwardInput = z.strictObject({
  url: text(2048),
  caPem: text(MAX_DOCUMENT_CHARS).optional(),
  token: text(4096).optional(),
});

const smtpInput = z.strictObject({
  /** `smtp://` or `smtps://`; its credentials, when it carries any, are sealed and the rest kept plain. */
  url: text(2048),
  from: z.email(),
});

const retentionInput = z.strictObject({
  auditMaxAgeDays: days(3650).optional(),
  hooksMaxAgeDays: days(365).optional(),
  hooksKeep: z.number().int().min(1).max(10_000).optional(),
  schedulesMaxAgeDays: days(3650).optional(),
  sessionLogMaxMb: z.number().int().min(1).max(1024).optional(),
});

const budgetsInput = z.strictObject({
  sendsPerMinute: z.number().int().min(1).max(1_000_000).optional(),
  burst: z.number().int().min(1).max(1_000_000).optional(),
  concurrentSends: z.number().int().min(1).max(10_000).optional(),
  runSlots: z.number().int().min(1).max(1_000).optional(),
});

export const SECTION_INPUTS = {
  oidc: oidcInput,
  saml: samlInput,
  auditForward: auditForwardInput,
  smtp: smtpInput,
  retention: retentionInput,
  budgets: budgetsInput,
} as const satisfies Record<SettingsSection, z.ZodType>;

export type SectionInputs = { readonly [S in SettingsSection]: z.output<(typeof SECTION_INPUTS)[S]> };

/** What a module reads: the plain fields and the opened secrets (never on the API). */
export interface SectionValues {
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly scopes: readonly string[];
    readonly displayName: string;
  };
  readonly saml: {
    readonly idpMetadataXml: string;
    readonly displayName: string;
    readonly emailAttribute?: string;
    readonly nameAttribute?: string;
    readonly clockSkewSeconds: number;
  };
  readonly auditForward: { readonly url: string; readonly caPem?: string; readonly token?: string };
  /** `url` with its credentials put back: what the mail transport takes. */
  readonly smtp: { readonly url: string; readonly from: string };
  readonly retention: z.output<typeof retentionInput>;
  readonly budgets: z.output<typeof budgetsInput>;
}

/** A secret on the API: whether one is stored, never what. */
export interface SecretState {
  readonly set: boolean;
}

/** What the API answers for a section: its plain fields, and each secret as {@link SecretState}. */
export interface SectionViews {
  readonly oidc: Omit<SectionValues['oidc'], 'clientSecret'> & { readonly clientSecret: SecretState };
  readonly saml: SectionValues['saml'];
  readonly auditForward: Omit<SectionValues['auditForward'], 'token'> & { readonly token: SecretState };
  readonly smtp: SectionValues['smtp'] & { readonly credentials: SecretState };
  readonly retention: SectionValues['retention'];
  readonly budgets: SectionValues['budgets'];
}

/** A section's row split: the plain `value` and the `secret` fields to seal, `undefined` when it has none. */
export interface SplitSection {
  readonly value: Record<string, unknown>;
  readonly secret: Record<string, string> | undefined;
}

/** The secret fields each section keeps sealed. */
export const SECRET_FIELDS: { readonly [S in SettingsSection]: readonly string[] } = {
  oidc: ['clientSecret'],
  saml: [],
  auditForward: ['token'],
  smtp: ['username', 'password'],
  retention: [],
  budgets: [],
};

/** `url` without its credentials, and the credentials apart; `undefined` for a URL that does not parse. */
export function splitUrlCredentials(
  url: string,
): { readonly bare: string; readonly username?: string; readonly password?: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const username = parsed.username === '' ? undefined : decodeURIComponent(parsed.username);
  const password = parsed.password === '' ? undefined : decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  return {
    bare: parsed.href,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** `bare` with `username` and `password` put back. */
export function joinUrlCredentials(bare: string, secret: Readonly<Record<string, string>> | undefined): string {
  if (secret?.username === undefined) return bare;
  const url = new URL(bare);
  url.username = encodeURIComponent(secret.username);
  if (secret.password !== undefined) url.password = encodeURIComponent(secret.password);
  return url.href;
}

/**
 * `input` (already parsed) as a row: its plain fields and its secrets. A secret the input leaves out keeps
 * `stored`'s, so saving the plain fields never drops one.
 */
export function splitSection<S extends SettingsSection>(
  section: S,
  input: SectionInputs[S],
  stored: Readonly<Record<string, string>> | undefined,
): SplitSection {
  const record = { ...(input as Record<string, unknown>) };
  let secret: Record<string, string> = {};
  if (section === 'smtp') {
    const split = splitUrlCredentials(record.url as string);
    if (split === undefined) throw new Error('the SMTP URL does not parse');
    record.url = split.bare;
    // A URL with credentials replaces both; one without keeps the stored ones.
    if (split.username !== undefined)
      secret = { username: split.username, ...(split.password !== undefined ? { password: split.password } : {}) };
    else if (stored !== undefined) secret = { ...stored };
  } else {
    for (const field of SECRET_FIELDS[section]) {
      const value = record[field];
      delete record[field];
      if (typeof value === 'string') secret[field] = value;
      else if (stored?.[field] !== undefined) secret[field] = stored[field];
    }
  }
  return { value: record, secret: Object.keys(secret).length === 0 ? undefined : secret };
}

/** A stored row as a module reads it: the plain fields with the secrets merged back. */
export function resolveSection<S extends SettingsSection>(
  section: S,
  value: Readonly<Record<string, unknown>>,
  secret: Readonly<Record<string, string>> | undefined,
): SectionValues[S] {
  if (section === 'smtp') {
    return { ...value, url: joinUrlCredentials(value.url as string, secret) } as unknown as SectionValues[S];
  }
  return { ...value, ...secret } as unknown as SectionValues[S];
}

/** A stored row as the API shows it: the plain fields, and each secret as set or not. */
export function viewSection<S extends SettingsSection>(
  section: S,
  value: Readonly<Record<string, unknown>>,
  secret: Readonly<Record<string, string>> | undefined,
): SectionViews[S] {
  const view: Record<string, unknown> = { ...value };
  if (section === 'smtp') view.credentials = { set: secret?.username !== undefined };
  else for (const field of SECRET_FIELDS[section]) view[field] = { set: secret?.[field] !== undefined };
  return view as unknown as SectionViews[S];
}
