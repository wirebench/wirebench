/**
 * OpenCollection auth, as a collection, folder or request declares it, mapped to Wirebench auth
 * under the credential rule (spec §3.4): a secret field is never carried into a project. A bearer
 * token or API key made only of references is kept as the header or query row it sends instead.
 * Core only: it creates nothing protocol-specific.
 */

import type { KeyValueEntry } from '../../http/entries.js';
import { entry } from '../../http/entries.js';
import type { AuthConfig, OAuth2Auth } from '../../project/model.js';
import type { ReportBuilder } from '../report.js';
import { rewriteMustache } from '../templates.js';
import { referencesOnly } from '../values.js';

type Rec = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(record: Rec | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

export interface MappedOcAuth {
  readonly auth: AuthConfig;
  /** A references-only credential, sent as this header on each request below the owner. */
  readonly header?: KeyValueEntry;
  /** A references-only credential, sent as this query row on each request below the owner. */
  readonly query?: KeyValueEntry;
}

/**
 * The OAuth 2 grants Wirebench runs (client credentials, authorization code); any other flow is
 * `none` with a warning. The client secret and the resource owner's password are never carried.
 */
export function mapOcOAuth2(a: Rec, where: string, report: ReportBuilder, dynamic?: Set<string>): AuthConfig {
  const flow = text(a, 'flow');
  const credentials = isRecord(a['credentials']) ? a['credentials'] : undefined;
  const owner = isRecord(a['resourceOwner']) ? a['resourceOwner'] : undefined;
  if (text(credentials, 'clientSecret') !== '' || text(owner, 'password') !== '') {
    report.warn(`${where}: the oauth2 credential was not imported; set it on the request or API.`);
  }
  if (flow !== 'client_credentials' && flow !== 'authorization_code') {
    const named = flow === '' ? 'an unnamed' : `the "${flow}"`;
    report.warn(`${where}: OAuth 2 with ${named} flow is not supported and was imported as none.`);
    return { type: 'none' };
  }
  const authCode = flow === 'authorization_code';
  const rewrite = (value: string): string => rewriteMustache(value, dynamic);
  const authorizationUrl = text(a, 'authorizationUrl');
  const pkce = isRecord(a['pkce']) ? a['pkce'] : undefined;
  const auth: OAuth2Auth = {
    type: 'oauth2',
    grant: authCode ? 'authorization-code' : 'client-credentials',
    tokenUrl: rewrite(text(a, 'accessTokenUrl')),
    ...(authCode && authorizationUrl !== '' ? { authorizationUrl: rewrite(authorizationUrl) } : {}),
    clientId: rewrite(text(credentials, 'clientId')),
    scopes: text(a, 'scope').split(/\s+/).filter(Boolean),
    clientAuth: text(credentials, 'placement') === 'body' ? 'body' : 'basic',
    pkce: authCode && pkce?.['disabled'] !== true,
  };
  return auth;
}

/**
 * Maps one `auth` value: absent or `inherit` is `inherit`, `none` is `none`, the supported types
 * keep their shape without the secret (each literal one dropped is warned about), and any other
 * type is `none` with a warning naming it.
 */
export function mapOcAuth(auth: unknown, where: string, report: ReportBuilder, dynamic?: Set<string>): MappedOcAuth {
  if (auth === undefined || auth === 'inherit') return { auth: { type: 'inherit' } };
  if (auth === null || auth === 'none') return { auth: { type: 'none' } };
  if (!isRecord(auth)) return { auth: { type: 'inherit' } };
  const type = text(auth, 'type');
  const rewrite = (value: string): string => rewriteMustache(value, dynamic);
  const dropped = (): void =>
    report.warn(`${where}: the ${type} credential was not imported; set it on the request or API.`);
  switch (type) {
    case 'inherit':
      return { auth: { type: 'inherit' } };
    case 'none':
      return { auth: { type: 'none' } };
    case 'basic': {
      if (text(auth, 'password') !== '') dropped();
      const username = text(auth, 'username');
      return { auth: { type: 'basic', ...(username !== '' ? { username: rewrite(username) } : {}) } };
    }
    case 'bearer': {
      const token = rewrite(text(auth, 'token'));
      if (token !== '' && referencesOnly(token)) {
        return { auth: { type: 'bearer' }, header: entry('Authorization', `Bearer ${token}`) };
      }
      if (token !== '') dropped();
      return { auth: { type: 'bearer' } };
    }
    case 'apikey': {
      const placement = text(auth, 'placement') === 'query' ? 'query' : 'header';
      const name = text(auth, 'key');
      const value = rewrite(text(auth, 'value'));
      const mapped: AuthConfig = { type: 'api-key', name, in: placement };
      if (value !== '' && name !== '' && referencesOnly(value)) {
        const row = entry(name, value);
        return placement === 'query' ? { auth: mapped, query: row } : { auth: mapped, header: row };
      }
      if (value !== '') dropped();
      return { auth: mapped };
    }
    case 'ntlm': {
      if (text(auth, 'password') !== '') dropped();
      const username = text(auth, 'username');
      const domain = text(auth, 'domain');
      return {
        auth: {
          type: 'ntlm',
          ...(username !== '' ? { username: rewrite(username) } : {}),
          ...(domain !== '' ? { domain: rewrite(domain) } : {}),
        },
      };
    }
    case 'oauth2':
      return { auth: mapOcOAuth2(auth, where, report, dynamic) };
    default: {
      // A type name is a schema word, never a credential, but cap it so a hostile one stays short.
      const named = type === '' ? 'An unnamed' : type.slice(0, 40);
      report.warn(`${where}: ${named} authentication is not supported and was imported as none.`);
      return { auth: { type: 'none' } };
    }
  }
}
