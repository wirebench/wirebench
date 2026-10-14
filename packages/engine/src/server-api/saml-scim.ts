/**
 * The SAML sign-in and SCIM administration wire shapes (saml-scim spec §3.2, §3.4, §3.6, §4). The SAML
 * flow reuses the OIDC start and complete shapes: only the middle differs. The SCIM resources themselves
 * are the server's alone; the desktop never speaks SCIM. Plain zod only (ADR-0009).
 *
 * A SCIM token appears in exactly one answer, the create, and is never listed again.
 */
import { z } from 'zod';
import {
  oidcCompleteRequestSchema,
  oidcStartRequestSchema,
  oidcStartResponseSchema,
  type OidcCompleteRequest,
  type OidcStartRequest,
  type OidcStartResponse,
} from './identity.js';
import { teamsIdSchema } from './teams.js';

export const samlStartRequestSchema = oidcStartRequestSchema;
export type SamlStartRequest = OidcStartRequest;
export const samlStartResponseSchema = oidcStartResponseSchema;
export type SamlStartResponse = OidcStartResponse;
export const samlCompleteRequestSchema = oidcCompleteRequestSchema;
export type SamlCompleteRequest = OidcCompleteRequest;

/** `GET /api/v1/auth/saml/info`: what a server admin gives the IdP (plan ruling 1). */
export const samlInfoResponseSchema = z.object({
  configured: z.boolean(),
  idpEntityId: z.string().optional(),
  entityId: z.string().url(),
  acsUrl: z.string().url(),
  scimBaseUrl: z.string().url(),
});
export type SamlInfoResponse = z.infer<typeof samlInfoResponseSchema>;

export const SCIM_TOKEN_NAME_MAX_LENGTH = 64;
/** `wbscim_` + 32 random bytes in base64url: never a device token, so neither guard mistakes the other. */
export const SCIM_TOKEN_PATTERN = /^wbscim_[A-Za-z0-9_-]{43}$/;

export const scimTokenCreateRequestSchema = z.object({ name: z.string().min(1).max(SCIM_TOKEN_NAME_MAX_LENGTH) });
export type ScimTokenCreateRequest = z.infer<typeof scimTokenCreateRequestSchema>;

export const scimTokenCreatedSchema = z.object({
  id: teamsIdSchema,
  name: z.string(),
  token: z.string().regex(SCIM_TOKEN_PATTERN),
  createdAt: z.string(),
});
export type ScimTokenCreated = z.infer<typeof scimTokenCreatedSchema>;

export const scimTokenSummarySchema = z.object({
  id: teamsIdSchema,
  name: z.string(),
  createdAt: z.string(),
  /** Written at most once a minute; `null` until first used. */
  lastUsedAt: z.string().nullable(),
});
export type ScimTokenSummary = z.infer<typeof scimTokenSummarySchema>;
/** Unrevoked tokens, by name. */
export const scimTokensResponseSchema = z.array(scimTokenSummarySchema);

export const scimGroupSummarySchema = z.object({
  id: teamsIdSchema,
  displayName: z.string(),
  memberCount: z.number().int().min(0),
  team: z.object({ id: teamsIdSchema, name: z.string() }).nullable(),
});
export type ScimGroupSummary = z.infer<typeof scimGroupSummarySchema>;
export const scimGroupsResponseSchema = z.array(scimGroupSummarySchema);

export const scimGroupLinkRequestSchema = z.object({ teamId: teamsIdSchema });
export type ScimGroupLinkRequest = z.infer<typeof scimGroupLinkRequestSchema>;
