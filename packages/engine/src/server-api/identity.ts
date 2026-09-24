/**
 * The identity module's wire shapes (identity spec §3.1), one object per request and response.
 * The server's routes validate with them (through `z.toJSONSchema`) and the desktop's
 * `ServerClient` parses answers with them, so a drift between the two fails typecheck.
 *
 * Nothing here trims or lower-cases: Fastify validates the JSON Schema rendering, which cannot
 * carry a transform, so normalisation happens in the handler (`emailKey` in the server).
 */
import { z } from 'zod';

/** §3.4: the only composition rule. Checked in the handler so the problem can name the number. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_DEVICE_NAME_LENGTH = 80;
export const MAX_DISPLAY_NAME_LENGTH = 120;
/** 32 random bytes in base64url without padding: invitation secrets, grants, PKCE challenges. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_TOKEN_PATTERN = /^wbs_[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1 verifier alphabet and length. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export const emailSchema = z.string().min(3).max(254).email();
export const passwordSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);
export const deviceSchema = z.object({ name: z.string().min(1).max(MAX_DEVICE_NAME_LENGTH) });
export const identityIdSchema = z.string().min(1).max(64);

export const serverUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  serverAdmin: z.boolean(),
});
export type ServerUser = z.infer<typeof serverUserSchema>;

export const signInResponseSchema = z.object({ token: z.string().regex(DEVICE_TOKEN_PATTERN), user: serverUserSchema });
export type SignInResponse = z.infer<typeof signInResponseSchema>;

export const localSignInRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  device: deviceSchema,
});
export type LocalSignInRequest = z.infer<typeof localSignInRequestSchema>;

export const oidcStartRequestSchema = z.object({
  device: deviceSchema,
  codeChallenge: z.string().regex(SECRET_PATTERN),
  loopbackPort: z.number().int().min(1).max(65_535),
});
export type OidcStartRequest = z.infer<typeof oidcStartRequestSchema>;
export const oidcStartResponseSchema = z.object({
  flowId: z.string(),
  authorizationUrl: z.string().url(),
  expiresAt: z.string(),
});
export type OidcStartResponse = z.infer<typeof oidcStartResponseSchema>;
export const oidcCompleteRequestSchema = z.object({
  flowId: identityIdSchema,
  grant: z.string().regex(SECRET_PATTERN),
  codeVerifier: z.string().regex(PKCE_VERIFIER_PATTERN),
});
export type OidcCompleteRequest = z.infer<typeof oidcCompleteRequestSchema>;
/** The IdP's redirect back to the server; `code` and `error` are mutually exclusive in practice. */
export const oidcCallbackQuerySchema = z.object({
  state: z.string().min(1).max(256),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(1024).optional(),
});
export type OidcCallbackQuery = z.infer<typeof oidcCallbackQuerySchema>;

export const signInMethodsSchema = z.object({ local: z.boolean(), oidc: z.array(z.object({ issuer: z.string() })) });
export const meResponseSchema = z.object({ user: serverUserSchema, methods: signInMethodsSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const passwordChangeRequestSchema = z.object({
  currentPassword: passwordSchema.optional(),
  newPassword: passwordSchema,
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

export const deviceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  current: z.boolean(),
});
export const devicesResponseSchema = z.array(deviceSummarySchema);
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const invitationCreateRequestSchema = z.object({ email: emailSchema, serverAdmin: z.boolean().optional() });
export type InvitationCreateRequest = z.infer<typeof invitationCreateRequestSchema>;
export const invitationCreatedSchema = z.object({
  id: z.string(),
  email: z.string(),
  url: z.string().url(),
  expiresAt: z.string(),
});
export type InvitationCreated = z.infer<typeof invitationCreatedSchema>;
export const invitationSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  serverAdmin: z.boolean(),
  /** `null` for one created from the console (`admin invite`). */
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().optional(),
});
export const invitationsResponseSchema = z.array(invitationSummarySchema);
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;
export const invitationLookupQuerySchema = z.object({ secret: z.string().regex(SECRET_PATTERN) });
export const invitationLookupResponseSchema = z.object({
  email: z.string(),
  methods: z.object({ local: z.boolean(), oidc: z.boolean() }),
});
export type InvitationLookupResponse = z.infer<typeof invitationLookupResponseSchema>;
export const invitationAcceptRequestSchema = z.object({
  secret: z.string().regex(SECRET_PATTERN),
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  password: passwordSchema,
  device: deviceSchema,
});
export type InvitationAcceptRequest = z.infer<typeof invitationAcceptRequestSchema>;

export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  serverAdmin: z.boolean(),
  disabledAt: z.string().optional(),
  methods: signInMethodsSchema,
});
export const usersResponseSchema = z.array(userSummarySchema);
export type UserSummary = z.infer<typeof userSummarySchema>;
export const userPatchRequestSchema = z.object({
  serverAdmin: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
export type UserPatchRequest = z.infer<typeof userPatchRequestSchema>;
export const passwordResetCreatedSchema = z.object({ url: z.string().url(), expiresAt: z.string() });
export type PasswordResetCreated = z.infer<typeof passwordResetCreatedSchema>;
export const identityIdParamsSchema = z.object({ id: identityIdSchema });
