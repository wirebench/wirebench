/**
 * *Make secret* for a variable (#634): a row whose name says it holds a credential and whose value
 * is typed in plain text offers to store that value as a project secret on this machine and put a
 * `${secret:name}` token in its place.
 *
 * The name check only decides whether the action is offered; nothing is masked by name. It reads
 * a name as word parts (`dbPassword`, `api_key`, `X-Auth-Token`) so a part has to *be* the word:
 * `keyboard`, `author` and `tokenizer` are not credentials. `key` and `auth` are too common as
 * parts on their own (`cacheKey`, `authMode`), so `auth` counts only as the last part (`basicAuth`)
 * and `key` only alone or after a qualifier (`apiKey`, `secret_key`). A name that ends in what it is *about* — `tokenUrl`,
 * `passwordPolicy` — is not offered either.
 *
 * The value is stored under the project's label through `secretScan.setValue`, the store *Set
 * Secret Token Value…* writes. That call replaces a value already stored under the name, so a name
 * the project already uses or stores is refused rather than written over: the existing value may
 * be another variable's or a request's. The check ignores case, as a run reads a secret from
 * `WIREBENCH_SECRET_<NAME>`, where `token` and `TOKEN` are one variable.
 */
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { secretNameError } from '../../state/secret-review.js';

/** Parts that make a name credential-like wherever they sit (`dbPassword`, `client_secret`). */
const CREDENTIAL_PARTS = new Set([
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'credential',
  'credentials',
  'apikey',
]);
/** Parts that make a final `key` credential-like (`apiKey`, `secret_key`); `cacheKey` is not. */
const KEY_QUALIFIERS = new Set([
  'api',
  'secret',
  'access',
  'private',
  'signing',
  'client',
  'auth',
  'master',
  'subscription',
]);

/**
 * Last parts that make a name *about* a credential rather than one: `tokenUrl`, `passwordPolicy`,
 * `secretName` hold an address, a rule or a label, which belong in plain text.
 */
const ABOUT_PARTS = new Set([
  'url',
  'uri',
  'endpoint',
  'path',
  'type',
  'name',
  'id',
  'field',
  'header',
  'param',
  'location',
  'prefix',
  'scheme',
  'policy',
  'length',
  'ttl',
  'expiry',
  'expires',
  'lifetime',
]);

/** `dbPassword`, `api_key`, `X-Client-Secret` → lower-case word parts. */
function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '');
}

/** True when `name` reads as the name of a credential: `token`, `password`, `apiKey`, `basicAuth`… */
export function isSecretLikeName(name: string): boolean {
  const parts = nameParts(name);
  const last = parts.at(-1);
  if (last === undefined || ABOUT_PARTS.has(last)) {
    return false;
  }
  if (parts.some((part) => CREDENTIAL_PARTS.has(part))) {
    return true;
  }
  if (last === 'auth' || last === 'authorization') {
    return true;
  }
  if (last === 'key') {
    return parts.length === 1 || KEY_QUALIFIERS.has(parts.at(-2) ?? '');
  }
  return false;
}

/**
 * True when the row `name = value` offers *Make secret*: a secret-like name and a plain, non-empty
 * value. A value with any `${…}` in it is not offered: it is already a secret token, or it refers
 * to another variable, whose text — not its value — is all a secret could hold.
 */
export function offersMakeSecret(name: string, value: string): boolean {
  return value.trim() !== '' && !value.includes('${') && isSecretLikeName(name);
}

/**
 * The secret name for variable `name`: the name itself when a token can carry it, else with every
 * other character as `_` (and a leading `_` before a digit), so `api-key` becomes `api_key`.
 */
export function secretNameFor(name: string): string {
  const trimmed = name.trim();
  if (secretNameError(trimmed) === undefined) {
    return trimmed;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(sanitized) || sanitized === '' ? `_${sanitized}` : sanitized;
}

export type MakeSecretResult =
  { readonly ok: true; readonly token: string } | { readonly ok: false; readonly message: string };

/**
 * Stores `value` as the secret for variable `name` in each of `projectIds`, and answers the token
 * to put in the variable's place. Every project is checked before anything is written, so a name
 * one of them already has stops the whole move with nothing stored.
 */
export async function makeSecret(input: {
  readonly projectIds: readonly string[];
  readonly name: string;
  readonly value: string;
}): Promise<MakeSecretResult> {
  const secret = secretNameFor(input.name);
  const projects = useProjectStore.getState().projects;
  if (input.projectIds.length === 0) {
    return { ok: false, message: 'Open a project first: a secret is stored for a project.' };
  }
  const projectName = (id: string): string => projects[id]?.name ?? id;
  for (const projectId of input.projectIds) {
    if (projects[projectId] === undefined) {
      return { ok: false, message: `${projectName(projectId)} is not open, so its secret cannot be stored.` };
    }
    const listed = await ipc().secretScan.tokens({ projectId });
    if (!listed.ok) {
      return { ok: false, message: listed.error.message };
    }
    if (listed.value.tokens.some((token) => token.name.toLowerCase() === secret.toLowerCase())) {
      return {
        ok: false,
        message: `${projectName(projectId)} already has a secret named "${secret}". Nothing was changed: rename the variable, or set that secret with Set Secret Token Value….`,
      };
    }
  }
  for (const projectId of input.projectIds) {
    const stored = await ipc().secretScan.setValue({ projectId, name: secret, value: input.value });
    if (!stored.ok) {
      return { ok: false, message: stored.error.message };
    }
  }
  return { ok: true, token: `\${secret:${secret}}` };
}
