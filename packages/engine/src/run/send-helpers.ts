/**
 * What the protocol modules share when they prepare and send a request in a run: secret tokens,
 * the project-folder boundary, keystores and TLS, OAuth2 tokens, the base URL an environment
 * overrides, and the secret a keystore needs. Core code: it names no protocol.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { WirebenchError } from '../errors.js';
import { isInsideRealDir } from '../fs.js';
import type { TlsOptions } from '../http/types.js';
import { resolveApiBaseUrl } from '../project/environments.js';
import type { BaseUrlSource } from '../project/environments.js';
import { toKeystoreDef } from '../project/keystores.js';
import type { AuthConfig, Project } from '../project/model.js';
import { secretNamesIn } from '../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { urlOrigin } from '../project/sequence-guards.js';
import type { SecretPlaceholders } from '../script/send.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { resolveAuthConfig, resolveSecretTokens } from '../secrets/resolve.js';
import type { GetSecret } from '../secrets/resolve.js';
import type { SendAuth } from '../http/auth/send-auth.js';
import { resolveWorkspaceApiBaseUrl, withActiveEnvironment } from '../workspace/environments.js';
import { loadKeystore, toTlsClientIdentity } from '../keystore/index.js';
import type { Keystore } from '../keystore/index.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import { createRunTokenSource, requiredSecret } from './oauth2-token.js';
import type { RunTokenSource } from './oauth2-token.js';

/**
 * The `${secret:name}` names anywhere in `value`'s strings — a send input or a saved request —
 * following property values through `scopes`, in first-use order. Binary data is skipped.
 */
export function secretNamesInValue(value: unknown, scopes?: PropertyScopes): string[] {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      if (current.includes('${')) {
        for (const name of secretNamesIn(current, scopes)) {
          found.add(name);
        }
      }
    } else if (Array.isArray(current)) {
      current.forEach(visit);
    } else if (current !== null && typeof current === 'object' && !ArrayBuffer.isView(current)) {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}

/**
 * `scopes` with the value of every `${secret:name}` token `input` reaches. Each value comes from
 * `getSecret`, so a host that masks what it hands out (the CLI's `createEnvSecrets`) masks these too.
 */
export async function withSecrets(
  input: unknown,
  scopes: PropertyScopes,
  getSecret: GetSecret,
  placeholders?: SecretPlaceholders,
): Promise<PropertyScopes> {
  const names = secretNamesInValue(input, scopes);
  if (names.length === 0) return scopes;
  return {
    ...scopes,
    secrets: placeholders !== undefined ? placeholders.scopeFor(names) : await resolveSecretTokens(names, getSecret),
  };
}

/** A send resolved (spec §3.4): what it would send, and the references nothing resolves in it. */
export interface Resolved<I> {
  readonly input: I;
  readonly unresolved: readonly UnresolvedRef[];
}

/**
 * The refusal for a request whose text holds property references nothing resolves, under the code
 * its protocol raises (spec §8).
 */
export function unresolvedError(code: string, path: string, unresolved: readonly UnresolvedRef[]): WirebenchError {
  const exprs = unresolved.map((ref) => ref.expr);
  return new WirebenchError(code, `"${path}" has property references nothing resolves: ${exprs.join(', ')}`, {
    details: { path, unresolved: exprs },
  });
}

/**
 * `path` resolved against the project folder, refused when it lands outside it. The app also
 * accepts a file its user picked through a dialog; a pipeline has no such user, so the project
 * folder is the whole boundary.
 */
export async function insideProject(context: RunContext, path: string, code: string, name: string): Promise<string> {
  const resolved = resolvePath(context.projectDir, path);
  if (!(await isInsideRealDir(context.projectDir, resolved))) {
    throw new WirebenchError(code, `"${name}" resolves outside the project folder.`, { details: { path } });
  }
  return resolved;
}

/**
 * Mirrors the app's keystore loading, minus its cache and its picked files: a run loads each keystore
 * it needs, from inside the project folder. Reached through {@link keystoreFor} only.
 */
async function loadKeystoreById(context: RunContext, keystoreId: string): Promise<Keystore | undefined> {
  const ref = context.project.wss.keystores.find((candidate) => candidate.id === keystoreId);
  if (ref === undefined) {
    return undefined;
  }
  const def = toKeystoreDef(ref);
  const path = await insideProject(context, def.path, 'keystore-outside-project', def.name);
  try {
    await stat(path);
  } catch (error) {
    throw new WirebenchError('keystore-unreadable', `The keystore file "${def.path}" could not be read.`, {
      details: { id: def.id },
      cause: error,
    });
  }
  const password =
    def.passwordSecretRef === undefined
      ? undefined
      : await requiredSecret(def.passwordSecretRef, context.host.getSecret);
  return loadKeystore(await readFile(path), { type: def.type, ...(password !== undefined ? { password } : {}) });
}

/** A keystore by its entry id: through the host's loader when it lends one, else from the project folder. */
export async function keystoreFor(context: RunContext, keystoreId: string): Promise<Keystore | undefined> {
  const { keystoreFor: lent } = context.host;
  return lent !== undefined ? await lent(keystoreId) : await loadKeystoreById(context, keystoreId);
}

/** The `cert`/`key` a request's own keystore presents; there is no global keystore in a run. */
export async function clientIdentityFor(
  context: RunContext,
  keystoreId: string | undefined,
): Promise<TlsOptions | undefined> {
  if (keystoreId === undefined || keystoreId.length === 0) {
    return undefined;
  }
  const keystore = await keystoreFor(context, keystoreId);
  const def = context.project.wss.keystores.find((candidate) => candidate.id === keystoreId);
  if (keystore === undefined || def === undefined) {
    throw new WirebenchError('keystore-missing', 'This request selects a keystore the project no longer has.', {
      details: { keystoreId },
    });
  }
  const identity = toTlsClientIdentity(keystore, toKeystoreDef(def).defaultAlias);
  return { cert: identity.cert, key: identity.key };
}

/** Identity, then the only two trust opt-outs a run honours: `--insecure` and the file's own flag. */
export async function tlsFor(
  context: RunContext,
  keystoreId: string | undefined,
  trustInvalid: boolean,
): Promise<TlsOptions | undefined> {
  const { tls } = context.host;
  const identity =
    tls?.identityFor !== undefined ? await tls.identityFor(keystoreId) : await clientIdentityFor(context, keystoreId);
  const skipVerify = context.insecure === true || trustInvalid;
  const anchors = tls?.anchors;
  if (identity === undefined && !skipVerify && anchors === undefined) return undefined;
  return {
    ...(identity !== undefined ? { cert: identity.cert, key: identity.key } : {}),
    ...(anchors !== undefined ? { ca: [...anchors] } : {}),
    ...(skipVerify ? { rejectUnauthorized: false } : {}),
  };
}

/** The run's shared token source, or a fresh one for a send outside a run. */
export function tokenSourceOf(context: RunContext): RunTokenSource {
  return (
    context.host.tokens ??
    createRunTokenSource({
      getSecret: context.host.getSecret,
      ...(context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {}),
    })
  );
}

/**
 * A request's effective auth with its secrets resolved. OAuth2 client credentials obtains a token
 * (the token request uses the request's own TLS, the proxy for the token URL and the run's
 * timeout); the authorization-code grant needs a browser a pipeline does not have, and is refused.
 *
 * @throws WirebenchError `auth-grant-unsupported` | `secret-missing` | `unresolved-properties` |
 * `oauth2-token-error` | `oauth2-token-malformed`
 */
export async function authFor(
  configured: AuthConfig,
  path: string,
  context: RunContext,
  tls: TlsOptions | undefined,
): Promise<Awaited<ReturnType<typeof resolveAuthConfig>>> {
  if (configured.type !== 'oauth2') {
    return reportedAuth(await resolveAuthConfig(configured, context.host.getSecret), context);
  }
  const accessToken = await tokenSourceOf(context).accessTokenFor(configured, {
    scopes: scopesFor(context),
    ...(tls !== undefined ? { tls } : {}),
    ...(context.host.proxyFor !== undefined ? { proxy: context.host.proxyFor } : {}),
    ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  return reportedAuth(await resolveAuthConfig(configured, context.host.getSecret, { accessToken }), context);
}

/**
 * Tells the host each credential a resolved auth puts on the wire, in the form it travels there,
 * so a server that echoes one back has it masked: an API key's value, a bearer or OAuth2 access
 * token, and Basic's `base64(user:password)`. A password is never reported bare — people choose
 * them, so one is often ordinary text — and NTLM's password never travels at all.
 */
export function reportedAuth(auth: SendAuth | undefined, context: RunContext): SendAuth | undefined {
  const report = context.host.onSecretValue;
  if (report === undefined || auth === undefined) return auth;
  switch (auth.type) {
    case 'api-key':
      report(auth.value);
      break;
    case 'bearer':
      report(auth.token);
      break;
    case 'oauth2':
      report(auth.accessToken);
      break;
    case 'basic':
      report(Buffer.from(`${auth.username}:${auth.password}`, 'utf-8').toString('base64'));
      break;
    case 'kerberos':
      // The password never travels (SSPI uses it locally), but a server echoing it back is still masked.
      if (auth.password !== undefined) report(auth.password);
      break;
    default:
      break;
  }
  return auth;
}

/**
 * An API's base URL (or target) and where it came from, through the workspace's environment when
 * the run has a workspace: what a preview reports beside the URL.
 */
export function resolvedBaseUrl(
  context: Pick<RunContext, 'project' | 'environmentId' | 'workspace'>,
  api: { readonly slug: string; readonly baseUrl: string },
): { readonly url: string; readonly source: BaseUrlSource } {
  const { project, environmentId, workspace } = context;
  return workspace === undefined
    ? resolveApiBaseUrl(project, environmentId, api)
    : resolveWorkspaceApiBaseUrl({
        workspace: withActiveEnvironment(workspace.workspace, environmentId),
        project,
        projectSlug: workspace.projectSlug,
        api,
      });
}

/** An API's base URL (or target), through the workspace's environment likewise. */
export function baseUrlFor(context: RunContext, api: { readonly slug: string; readonly baseUrl: string }): string {
  return resolvedBaseUrl(context, api).url;
}

/**
 * After a server refused the credentials a send carried, drops the run's OAuth2 token among them,
 * so the next request behind that configuration fetches a new one instead of repeating the refusal.
 * The refused request itself is never sent again.
 */
export function dropRefusedToken(context: RunContext, auth: SendAuth | undefined, refused: boolean): void {
  if (refused && auth?.type === 'oauth2') {
    context.host.tokens?.reject(auth.accessToken);
  }
}

/** The origin a request went to, as a sent request reports it; nothing for a URL without one. */
export function originOf(url: string): { readonly origin?: string } {
  const origin = urlOrigin(url);
  return origin !== undefined ? { origin } : {};
}

/** True for a reference that is set: neither absent nor empty. */
export const present = (id: string | undefined): id is string => id !== undefined && id.length > 0;

/** A keystore's password, when the registry entry has one; an unreadable entry needs nothing here. */
export function keystoreNeeds(project: Project, keystoreId: string | undefined): SecretNeed[] {
  if (!present(keystoreId)) {
    return [];
  }
  const ref = project.wss.keystores.find((candidate) => candidate.id === keystoreId);
  if (ref === undefined) {
    return [];
  }
  try {
    const def = toKeystoreDef(ref);
    return present(def.passwordSecretRef)
      ? [
          {
            ref: def.passwordSecretRef,
            ...(def.passwordEnv !== undefined ? { envName: def.passwordEnv } : {}),
            purpose: `keystore password for "${def.name}"`,
          },
        ]
      : [];
  } catch {
    // The module's send refuses such a request with its own error; it needs no secret before then.
    return [];
  }
}
