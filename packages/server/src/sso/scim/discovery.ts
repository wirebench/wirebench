/**
 * The SCIM discovery documents (RFC 7643 §5–§7, saml-scim spec §3.5): static, and what an IdP reads to
 * learn that this server takes PATCH and filters but not bulk, sort, ETags or password changes.
 */
import type { FastifyInstance } from 'fastify';
import type { SsoEnv } from '../env.js';

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
/** §3.5: a filter answers at most this many resources. */
export const MAX_RESULTS = 200;

const attribute = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

function schemas(base: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: USER_SCHEMA,
      name: 'User',
      description: 'A Wirebench Server account.',
      attributes: [
        attribute('userName', 'string', { required: true, uniqueness: 'server' }),
        attribute('name', 'complex', { subAttributes: [attribute('formatted', 'string')] }),
        attribute('displayName', 'string'),
        attribute('emails', 'complex', {
          multiValued: true,
          subAttributes: [attribute('value', 'string'), attribute('type', 'string'), attribute('primary', 'boolean')],
        }),
        attribute('active', 'boolean'),
        attribute('externalId', 'string', { caseExact: true }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${USER_SCHEMA}` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: GROUP_SCHEMA,
      name: 'Group',
      description: 'A group from the identity provider; a server admin may link it to a team.',
      attributes: [
        attribute('displayName', 'string', { required: true, uniqueness: 'server' }),
        attribute('members', 'complex', {
          multiValued: true,
          subAttributes: [attribute('value', 'string', { mutability: 'immutable' }), attribute('display', 'string')],
        }),
        attribute('externalId', 'string', { caseExact: true }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${GROUP_SCHEMA}` },
    },
  ];
}

function resourceTypes(base: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: USER_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: GROUP_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` },
    },
  ];
}

const list = (resources: readonly unknown[]) => ({
  schemas: [LIST_SCHEMA],
  totalResults: resources.length,
  startIndex: 1,
  itemsPerPage: resources.length,
  Resources: resources,
});

export const discoveryRoutes =
  (env: SsoEnv) =>
  (scim: FastifyInstance): void => {
    const base = env.urls.scimBaseUrl;
    scim.get('/ServiceProviderConfig', () => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_RESULTS },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'A SCIM token created by a server admin, sent as Authorization: Bearer wbscim_…',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
    }));
    scim.get('/ResourceTypes', () => list(resourceTypes(base)));
    scim.get('/Schemas', () => list(schemas(base)));
  };
