/**
 * An AsyncAPI security scheme as one of the authentication kinds a WebSocket request already has.
 *
 * Only the shape is carried over — which kind, which key name, which endpoints. No secret is ever
 * filled in: the user supplies it through the keychain as for any other request.
 */

import type { AuthConfig } from '../project/model.js';
import type { AsyncApiSecurityScheme, AsyncApiSkip } from './model.js';

/** What a scheme needs, as the tests and callers hand it: everything but the type is optional. */
export type AsyncApiSchemeInput = Pick<AsyncApiSecurityScheme, 'type'> & Partial<AsyncApiSecurityScheme>;

function skip(scheme: AsyncApiSchemeInput, reason: string): AsyncApiSkip {
  return { where: `security ${scheme.key ?? scheme.type}`, reason };
}

/** The auth a scheme maps to, or why it cannot be mapped. */
export function authFromScheme(scheme: AsyncApiSchemeInput): AuthConfig | AsyncApiSkip {
  switch (scheme.type) {
    case 'userPassword':
      return { type: 'basic' };
    case 'http':
      if (scheme.scheme === 'basic') return { type: 'basic' };
      if (scheme.scheme === 'bearer') return { type: 'bearer' };
      return skip(scheme, `http ${scheme.scheme ?? '(no scheme)'} authentication is not supported`);
    case 'httpApiKey':
      if ((scheme.in === 'query' || scheme.in === 'header') && scheme.name !== undefined) {
        return { type: 'api-key', name: scheme.name, in: scheme.in };
      }
      return skip(scheme, `an API key in ${scheme.in ?? 'an unstated place'} cannot be sent on a WebSocket handshake`);
    case 'apiKey':
      return skip(scheme, `an API key carried in the ${scheme.in ?? 'connection'} is not supported`);
    case 'oauth2':
    case 'openIdConnect': {
      if (scheme.grant !== 'client-credentials' && scheme.grant !== 'authorization-code') {
        return skip(
          scheme,
          scheme.grant === undefined
            ? `${scheme.type} names no flow Wirebench can run`
            : `the OAuth2 ${scheme.grant} flow is not supported`,
        );
      }
      return {
        type: 'oauth2',
        grant: scheme.grant,
        tokenUrl: scheme.tokenUrl ?? '',
        ...(scheme.authorizationUrl !== undefined ? { authorizationUrl: scheme.authorizationUrl } : {}),
        clientId: '',
        scopes: scheme.scopes ?? [],
        clientAuth: 'basic',
        pkce: true,
      };
    }
    case 'X509':
      return skip(scheme, 'X509: set a client certificate in the request settings');
    default:
      return skip(scheme, `${scheme.type} authentication is not supported on WebSocket`);
  }
}

/** Whether {@link authFromScheme} answered with a skip rather than an auth. */
export function isSkip(value: AuthConfig | AsyncApiSkip): value is AsyncApiSkip {
  return 'reason' in value;
}
