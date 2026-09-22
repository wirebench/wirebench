/**
 * Secret resolution lives in the engine so the CLI runner resolves credentials exactly as the app
 * does. This module stays as the desktop's import path for it, and adds what only the desktop has:
 * the store entry a `${secret:name}` token names, and a way to hand those values to the send
 * resolvers (`rest-send.ts`, `grpc-send.ts`, `ws-send.ts`), which expand synchronously.
 */
import { parseSecretPseudoRef, resolveSecretTokens, SECRET_NAME_PATTERN } from '@wirebench/engine';
import type { GetSecret, PropertyScopes, UnresolvedRef } from '@wirebench/engine';
import type { SecretStore } from './secrets.js';

export { resolveAuthConfig, resolveEndpointAuth, secretMissingMessage } from '@wirebench/engine';
export type { ResolvedAuth } from '@wirebench/engine';

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
 * directly. Every value it returns is passed to `record` first — the engine's masking contract,
 * which main keeps by recording into `redact.ts`.
 */
export function projectSecretGetter(
  store: SecretLookup,
  projectId: string | undefined,
  record: (value: string) => void,
): GetSecret {
  return async (ref) => {
    const name = parseSecretPseudoRef(ref);
    let value: string | undefined;
    if (name === undefined) {
      value = await store.get(ref);
    } else if (projectId !== undefined) {
      const stored = await store.findByLabel(secretStoreLabel(projectId, name));
      value = stored === undefined ? undefined : await store.get(stored);
    }
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

/** The names of the `${secret:name}` tokens an expansion reached and had no value for. */
export function missingSecretNames(unresolved: readonly UnresolvedRef[]): string[] {
  const names = unresolved.filter(isSecretTokenRef).map((ref) => ref.name as string);
  return [...new Set(names)];
}

/** Token values for the resolution running right now; see {@link withSecretTokenScope}. */
let tokenValues: Readonly<Record<string, string>> | undefined;

/**
 * `scopes` with the token values of the resolution {@link resolveWithSecretTokens} is running, if
 * any. The send resolvers pass their scopes through this, so the host's synchronous `restSend`
 * (and its gRPC and WebSocket twins) expand tokens without a keychain lookup of their own.
 */
export function withSecretTokenScope(scopes: PropertyScopes): PropertyScopes {
  return tokenValues === undefined ? scopes : { ...scopes, secrets: { ...scopes.secrets, ...tokenValues } };
}

/**
 * Runs a synchronous send resolution (`project.restSend(…)` and its twins), filling the secrets
 * scope first. The first pass says which tokens the expansion reached; when there are any, their
 * values are read through `getSecret` and the resolution runs again with them in scope. A token
 * with no value refuses the send as `secret-missing` rather than going out empty or as typed.
 *
 * The values are in scope only for the duration of that second, synchronous call.
 *
 * @throws WirebenchError `secret-missing`
 */
export async function resolveWithSecretTokens<R extends { readonly unresolved: readonly UnresolvedRef[] }>(
  resolve: () => R | undefined,
  getSecret: GetSecret,
): Promise<R | undefined> {
  const first = resolve();
  const names = first === undefined ? [] : missingSecretNames(first.unresolved);
  if (names.length === 0) {
    return first;
  }
  const values = await resolveSecretTokens(names, getSecret);
  const previous = tokenValues;
  tokenValues = values;
  try {
    return resolve();
  } finally {
    tokenValues = previous;
  }
}
