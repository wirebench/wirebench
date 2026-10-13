/**
 * SCIM `PatchOp` on a user (RFC 7644 §3.5.2, saml-scim spec §3.5), applied to the four things Wirebench
 * keeps: `userName` (the email), `displayName`, `externalId` and `active`. The shapes the two IdPs send
 * both work: a `replace` with no path and an object value, a path per attribute, and the string booleans
 * `"True"` / `"False"`. An attribute of the SCIM user schema that Wirebench does not keep (a title, a
 * phone number, the enterprise extension) is accepted and ignored, as RFC 7644 §3.3 allows; a path that
 * names nothing in the schema is `invalidPath`.
 */
import { scimError } from './errors.js';

export const PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:user';
const CORE_USER = 'urn:ietf:params:scim:schemas:core:2.0:user:';

/** RFC 7643 §4.1 attributes Wirebench accepts and does not keep. */
const IGNORED = new Set([
  'name',
  'nickname',
  'profileurl',
  'title',
  'usertype',
  'preferredlanguage',
  'locale',
  'timezone',
  'phonenumbers',
  'ims',
  'photos',
  'addresses',
  'entitlements',
  'roles',
  'x509certificates',
  'emails',
]);

export interface UserState {
  readonly userName: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly active: boolean;
}

export interface PatchOperation {
  readonly op: string;
  readonly path?: string;
  readonly value?: unknown;
}

export function parseActive(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  throw scimError(400, '"active" must be a boolean.', 'invalidValue');
}

const text = (value: unknown, attribute: string): string => {
  if (typeof value !== 'string') throw scimError(400, `"${attribute}" must be a string.`, 'invalidValue');
  return value;
};

/** The local part of an email: a user always has a display name. */
export const fallbackName = (email: string): string => email.split('@')[0] || email;

type Mutable = { -readonly [K in keyof UserState]: UserState[K] };

/** Applies one attribute, by its lower-cased path, to `state`. */
function apply(state: Mutable, path: string, value: unknown, remove: boolean): void {
  let key = path.toLowerCase();
  if (key.startsWith(CORE_USER)) key = key.slice(CORE_USER.length);
  switch (key) {
    case 'username':
      if (remove) throw scimError(400, '"userName" is required.', 'mutability');
      state.userName = text(value, 'userName');
      return;
    case 'displayname':
    case 'name.formatted':
      state.displayName = remove ? fallbackName(state.userName) : text(value, 'displayName');
      return;
    case 'externalid':
      state.externalId = remove ? null : text(value, 'externalId');
      return;
    case 'active':
      if (remove) throw scimError(400, '"active" cannot be removed.', 'mutability');
      state.active = parseActive(value);
      return;
    case 'emails[type eq "work"].value':
      if (!remove) state.userName = text(value, 'emails');
      return;
  }
  const root = key.split(/[.[]/, 1)[0]!;
  if (IGNORED.has(root) || key.startsWith(ENTERPRISE)) return;
  throw scimError(400, `"${path}" is not an attribute of a user.`, 'invalidPath');
}

/** The user `state` after `operations`, or a SCIM error naming the first one that does not apply. */
export function applyUserPatch(state: UserState, operations: readonly PatchOperation[]): UserState {
  const next: Mutable = { ...state };
  for (const operation of operations) {
    const op = typeof operation.op === 'string' ? operation.op.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove')
      throw scimError(400, `"${String(operation.op)}" is not a PATCH operation.`, 'invalidSyntax');
    const remove = op === 'remove';
    if (operation.path !== undefined && operation.path !== '') {
      apply(next, operation.path, operation.value, remove);
      continue;
    }
    if (remove) throw scimError(400, 'A remove needs a path.', 'noTarget');
    if (typeof operation.value !== 'object' || operation.value === null || Array.isArray(operation.value))
      throw scimError(400, 'A PATCH without a path needs an object value.', 'invalidValue');
    for (const [attribute, value] of Object.entries(operation.value)) {
      if (attribute.toLowerCase() === 'name' && typeof value === 'object' && value !== null) {
        const formatted = (value as Record<string, unknown>)['formatted'];
        if (formatted !== undefined) apply(next, 'name.formatted', formatted, false);
        continue;
      }
      apply(next, attribute, value, false);
    }
  }
  return next;
}
