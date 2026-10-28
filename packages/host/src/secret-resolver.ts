/**
 * Secret resolution lives in the engine so the CLI runner resolves credentials exactly as the app
 * does. This module stays as the desktop's import path for it, and adds what only the desktop has:
 * the store entry a `${secret:name}` token names.
 */
import {
  parseSecretPseudoRef,
  resolveAuthConfig as resolveAuthConfigValues,
  resolveSoapAuth as resolveSoapAuthValues,
  SECRET_NAME_PATTERN,
} from '@wirebench/engine';
import type { GetSecret, UnresolvedRef } from '@wirebench/engine';
import type { Redactor } from './host/redactor.js';
import type { SecretStore } from './secrets.js';

export { resolveEndpointAuth, secretMissingMessage } from '@wirebench/engine';
export type { ResolvedAuth } from '@wirebench/engine';

/**
 * The engine's `resolveAuthConfig`, recording the credential it resolves for the log's masking
 * (`Redactor.recordAuthValues`): every send and export in main resolves its auth through here.
 */
export async function resolveAuthConfig(
  redactor: Redactor,
  ...args: Parameters<typeof resolveAuthConfigValues>
): ReturnType<typeof resolveAuthConfigValues> {
  const auth = await resolveAuthConfigValues(...args);
  redactor.recordAuthValues(auth);
  return auth;
}

/** The engine's `resolveSoapAuth`, recording what it resolves as {@link resolveAuthConfig} does. */
export async function resolveSoapAuth(
  redactor: Redactor,
  ...args: Parameters<typeof resolveSoapAuthValues>
): ReturnType<typeof resolveSoapAuthValues> {
  const auth = await resolveSoapAuthValues(...args);
  redactor.recordAuthValues(auth);
  return auth;
}

/**
 * The store label a `${secret:name}` token's value is kept under on this machine. The project id
 * keeps two projects' `api_token` apart; the file itself carries only the name.
 */
export function secretStoreLabel(projectId: string, name: string): string {
  return `wirebench-secret:${projectId}:${name}`;
}

/** The store surface {@link projectSecretGetter} reads. */
export type SecretLookup = Pick<SecretStore, 'get' | 'findByLabel'>;

/**
 * The `GetSecret` for sends of one project: a `secret:<name>` pseudo-ref reads the entry labelled
 * {@link secretStoreLabel} for `projectId` (nothing, with no project), any other ref reads the store
 * directly. Every token value it returns is passed to `record` first — the engine's masking
 * contract, which main keeps by recording into the host's `Redactor`, since a token can sit anywhere. An auth
 * value is not recorded here: the getter cannot tell a key from a password, so {@link
 * resolveAuthConfig} records the credential in the form it goes out (see `recordAuthValues`),
 * which is never a bare password.
 */
export function projectSecretGetter(
  store: SecretLookup,
  projectId: string | undefined,
  record: (value: string) => void,
): GetSecret {
  return async (ref) => {
    const name = parseSecretPseudoRef(ref);
    if (name === undefined) {
      return await store.get(ref);
    }
    if (projectId === undefined) {
      return undefined;
    }
    const stored = await store.findByLabel(secretStoreLabel(projectId, name));
    const value = stored === undefined ? undefined : await store.get(stored);
    if (value !== undefined) {
      record(value);
    }
    return value;
  };
}

/**
 * The store label a host's `${secret:NAME}` value is kept under on this machine: a host belongs to the
 * workspace, not to a project, so the workspace id scopes the name (A5 of the SSH area design).
 */
export function workspaceSecretLabel(workspaceId: string, name: string): string {
  return `wirebench-secret:workspace:${workspaceId}:${name}`;
}

/**
 * The `GetSecret` for the SSH area: like {@link projectSecretGetter}, but a `secret:<name>` pseudo-ref reads
 * the entry labelled {@link workspaceSecretLabel} (nothing, with no workspace open). Values are recorded first.
 */
export function workspaceSecretGetter(
  store: SecretLookup,
  workspaceId: string | undefined,
  record: (value: string) => void,
): GetSecret {
  return async (ref) => {
    const name = parseSecretPseudoRef(ref);
    if (name === undefined) {
      return await store.get(ref);
    }
    if (workspaceId === undefined) {
      return undefined;
    }
    const stored = await store.findByLabel(workspaceSecretLabel(workspaceId, name));
    const value = stored === undefined ? undefined : await store.get(stored);
    if (value !== undefined) {
      record(value);
    }
    return value;
  };
}

/**
 * True for a well-formed `${secret:name}` token an expansion without its value left unresolved.
 * A dry run (a preflight, a cURL export) reads no secret, so it leaves every token so; the send
 * resolves it, and refuses as `secret-missing` when nothing is stored — so it is not "unresolved".
 */
export function isSecretTokenRef(ref: Pick<UnresolvedRef, 'scope' | 'name' | 'code'>): boolean {
  return (
    ref.scope === 'Secret' && ref.code === 'missing' && ref.name !== undefined && SECRET_NAME_PATTERN.test(ref.name)
  );
}

/** The name a stored value is reported by: a `${secret:name}` token's name, else its label, else its ref. */
export function secretNameOf(label: string | undefined, ref: string): string {
  const token = label === undefined ? undefined : /^wirebench-secret:[^:]*:(.+)$/.exec(label)?.[1];
  return token ?? label ?? ref;
}

/**
 * `get`, telling `report` each ref it resolves to a value, before handing the value on: a
 * `${secret:name}` token or a plain ref (an OAuth client secret, a proxy password, a definition's
 * credentials). `report` names it for the embedder's audit (`HostOptions.onSecret`); a ref with no
 * value is not reported, and the value never is.
 */
export function reportedSecretGetter(get: GetSecret, report: (ref: string) => void | Promise<void>): GetSecret {
  return async (ref) => {
    const value = await get(ref);
    if (value !== undefined) await report(ref);
    return value;
  };
}
