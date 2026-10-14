/**
 * The SCIM filters an IdP sends before it creates or updates (saml-scim spec §3.5): a single `eq` on one
 * attribute. Anything else (`co`, `sw`, `pr`, `and`, `or`, `not`, groupings) is `400 invalidFilter`, which
 * every IdP handles; a filter the server half-understood would be worse.
 */
import { scimError } from './errors.js';

export interface EqFilter {
  /** Lower-cased canonical attribute name, as given in `allowed`. */
  readonly attribute: string;
  readonly value: string;
}

/** `emails[type eq "work"].value` and `emails.value` both read as `emails.value`. */
const EMAILS_WORK = /^emails\[type eq "work"\]\.value$/i;
const EQ = /^([A-Za-z][A-Za-z0-9.:_-]*(?:\[type eq "work"\]\.value)?)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i;

/**
 * `undefined` for no filter; otherwise the attribute and value. `allowed` lists the canonical names this
 * resource can be filtered on (`userName`, `externalId`, `emails.value`, `displayName`).
 */
export function parseFilter(text: string | undefined, allowed: readonly string[]): EqFilter | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const match = EQ.exec(text.trim());
  if (match === null) throw scimError(400, 'Only a single "eq" filter is supported.', 'invalidFilter');
  const raw = match[1]!;
  const name = EMAILS_WORK.test(raw) ? 'emails.value' : raw;
  const attribute = allowed.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (attribute === undefined) throw scimError(400, `Filtering on "${raw}" is not supported.`, 'invalidFilter');
  const value = match[2]!.replace(/\\(.)/g, '$1');
  return { attribute, value };
}
