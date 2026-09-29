/**
 * The CI tokens' wire shapes (callback-assertion spec §3). A CI token reads captures in one server
 * workspace and nothing else; the server keeps only its hash. The server's routes validate with these
 * and the desktop's main process and the CLI parse answers with them. Plain zod only (ADR-0009).
 *
 * The token itself appears in exactly one answer, the create, and is never listed again.
 */
import { z } from 'zod';
import { DEVICE_TOKEN_PATTERN } from './identity.js';
import { teamsIdSchema } from './teams.js';

export const CI_TOKEN_NAME_MAX_LENGTH = 64;

/** `POST …/ci-tokens`. The handler trims the name and refuses a blank one. */
export const ciTokenCreateRequestSchema = z.object({ name: z.string().min(1).max(CI_TOKEN_NAME_MAX_LENGTH) });
export type CiTokenCreateRequest = z.infer<typeof ciTokenCreateRequestSchema>;

/** The one answer that holds the token: the desktop shows it once, with *Copy*. */
export const ciTokenCreatedSchema = z.object({
  id: teamsIdSchema,
  name: z.string(),
  token: z.string().regex(DEVICE_TOKEN_PATTERN),
});
export type CiTokenCreated = z.infer<typeof ciTokenCreatedSchema>;

export const ciTokenSummarySchema = z.object({
  id: teamsIdSchema,
  name: z.string(),
  /** The creator's display name; `null` once that account is gone. */
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  /** Written at most once a minute; `null` until first used. */
  lastUsedAt: z.string().nullable(),
});
export type CiTokenSummary = z.infer<typeof ciTokenSummarySchema>;
/** Unrevoked tokens, by name. */
export const ciTokensResponseSchema = z.array(ciTokenSummarySchema);

export const ciTokenParamsSchema = z.object({ workspaceId: teamsIdSchema, tokenId: teamsIdSchema });

/** `GET /api/v1/ci/whoami`: which workspace a CI token reads. */
export const ciWhoamiResponseSchema = z.object({
  workspaceId: teamsIdSchema,
  workspaceName: z.string(),
  tokenName: z.string(),
});
export type CiWhoamiResponse = z.infer<typeof ciWhoamiResponseSchema>;
