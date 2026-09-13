/**
 * The `oauth2.*` channels: obtaining, inspecting, clearing and cancelling an access token.
 *
 * Every call names an *owner* — an API, a folder or a request — and main reads the configuration
 * from the model itself. The renderer never sends one, because a configuration carries the
 * reference to a client secret, and a channel that accepted one would be a channel for pointing the
 * app at somebody else's token endpoint with the user's credentials.
 */

import { WirebenchError } from '@wirebench/engine';
import type { AuthConfig, OAuth2Auth } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { OAuth2StatusWire } from '../../shared/wire-types.js';
import type { OAuth2Service } from '../oauth2.js';
import type { ProjectRouter } from '../project-router.js';
import { registerHandler } from './register.js';

/** What the OAuth2 channels need: the model to read a configuration from, and the token service. */
export interface OAuth2ChannelDeps {
  readonly oauth2: OAuth2Service;
  /** Finds the API, folder or request the call names, and its credentials. */
  readonly project: Pick<ProjectRouter, 'restAuthOf' | 'projectId'> &
    Partial<Pick<ProjectRouter, 'restTlsFor' | 'proxyFor'>>;
  /** Resolves one keychain reference; the store in the app, a stub in tests. */
  readonly getSecret?: (ref: string) => Promise<string | undefined>;
  /** Stores a refresh token the user asked to be remembered. */
  readonly setSecret?: (ref: string, value: string) => Promise<void>;
  readonly showSecrets?: { get(): boolean };
}

/** The OAuth2 configuration of the named owner, or a clear error saying it has none. */
function configOf(deps: OAuth2ChannelDeps, ownerId: string): OAuth2Auth {
  const auth: AuthConfig | undefined = deps.project.restAuthOf(ownerId);
  if (auth === undefined) {
    throw new WirebenchError('unknown-entity', `No API, folder or request with id "${ownerId}"`, {
      details: { ownerId },
    });
  }
  if (auth.type !== 'oauth2') {
    throw new WirebenchError('oauth2-not-configured', 'This entity does not use OAuth2', {
      details: { ownerId, type: auth.type },
    });
  }
  return auth;
}

/** The secret values a configuration needs, resolved from the keychain. */
async function credentialsOf(
  deps: OAuth2ChannelDeps,
  config: OAuth2Auth,
): Promise<{ readonly clientSecret?: string; readonly refreshToken?: string }> {
  const read = async (ref: string | undefined): Promise<string | undefined> =>
    ref === undefined || ref === '' ? undefined : await deps.getSecret?.(ref);
  const clientSecret = await read(config.clientSecretRef);
  const refreshToken = await read(config.refreshTokenRef);
  return {
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

/** The status as the renderer sees it: the service's view plus the redirect URI to register. */
function statusWire(deps: OAuth2ChannelDeps, config: OAuth2Auth): OAuth2StatusWire {
  const status = deps.oauth2.status(config, { showSecrets: deps.showSecrets?.get() ?? false });
  return {
    state: status.state,
    ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
    ...(status.scopes !== undefined ? { scopes: [...status.scopes] } : {}),
    ...(status.token !== undefined ? { token: status.token } : {}),
    redirectUri: deps.oauth2.redirectUri(),
  };
}

/** Registers the four `oauth2.*` handlers. */
export function registerOAuth2Channels(deps: OAuth2ChannelDeps): void {
  registerHandler(channels.oauth2.fetchToken, async (request) => {
    const config = configOf(deps, request.ownerId);
    const credentials = await credentialsOf(deps, config);
    await deps.oauth2.fetchToken(config, {
      credentials,
      // A refresh token is only ever stored when the configuration says to remember one: without
      // `refreshTokenRef` there is nowhere to put it, and it stays in memory for the session.
      ...(config.refreshTokenRef !== undefined && deps.setSecret !== undefined
        ? { rememberRefreshToken: (token: string) => deps.setSecret!(config.refreshTokenRef!, token) }
        : {}),
    });
    return statusWire(deps, config);
  });

  registerHandler(channels.oauth2.status, (request) =>
    Promise.resolve(statusWire(deps, configOf(deps, request.ownerId))),
  );

  registerHandler(channels.oauth2.clearToken, (request) => {
    const config = configOf(deps, request.ownerId);
    deps.oauth2.clear(config);
    return Promise.resolve(statusWire(deps, config));
  });

  registerHandler(channels.oauth2.cancel, () => Promise.resolve(deps.oauth2.cancel()));
}
