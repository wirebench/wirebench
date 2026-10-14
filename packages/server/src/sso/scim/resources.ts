/** Wirebench users ⇄ SCIM user resources (RFC 7643 §4.1, saml-scim spec §3.5). `userName` is the email. */
import type { ScimUserView } from '../repo.js';
import { USER_SCHEMA } from './discovery.js';
import { scimError } from './errors.js';
import { fallbackName, parseActive, type UserState } from './patch.js';

export const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

/** Loose on purpose: the IdP owns the address, Wirebench only needs one `@` with something either side. */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function assertEmail(userName: string): string {
  const email = userName.trim();
  if (!EMAIL.test(email) || email.length > 320)
    throw scimError(400, '"userName" must be an email address.', 'invalidValue');
  return email;
}

export function userResource(view: ScimUserView, base: string): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: view.id,
    ...(view.externalId !== null ? { externalId: view.externalId } : {}),
    userName: view.email,
    name: { formatted: view.displayName },
    displayName: view.displayName,
    emails: [{ value: view.email, type: 'work', primary: true }],
    active: view.disabledAt === null,
    meta: {
      resourceType: 'User',
      created: view.createdAt,
      lastModified: view.updatedAt ?? view.createdAt,
      location: `${base}/Users/${view.id}`,
    },
  };
}

export function stateOf(view: ScimUserView): UserState {
  return {
    userName: view.email,
    displayName: view.displayName,
    externalId: view.externalId,
    active: view.disabledAt === null,
  };
}

const optionalText = (value: unknown, attribute: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw scimError(400, `"${attribute}" must be a string.`, 'invalidValue');
  return value.trim() === '' ? undefined : value.trim();
};

/** A POST or PUT body as the state it asks for: anything left out takes its default (RFC 7644 §3.5.1). */
export function userInput(body: unknown): UserState {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw scimError(400, 'The body must be a SCIM user.', 'invalidSyntax');
  const record = body as Record<string, unknown>;
  const userName = optionalText(record['userName'], 'userName');
  if (userName === undefined) throw scimError(400, '"userName" is required.', 'invalidValue');
  const name =
    typeof record['name'] === 'object' && record['name'] !== null ? (record['name'] as Record<string, unknown>) : {};
  const given = optionalText(name['givenName'], 'name.givenName');
  const family = optionalText(name['familyName'], 'name.familyName');
  const displayName =
    optionalText(record['displayName'], 'displayName') ??
    optionalText(name['formatted'], 'name.formatted') ??
    ([given, family].filter((part) => part !== undefined).join(' ') || fallbackName(userName));
  return {
    userName,
    displayName,
    externalId: optionalText(record['externalId'], 'externalId') ?? null,
    active: record['active'] === undefined ? true : parseActive(record['active']),
  };
}
