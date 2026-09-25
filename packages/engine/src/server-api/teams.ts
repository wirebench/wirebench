/**
 * The teams-access module's wire shapes (teams-access spec §3.2, §4.2). The server's routes
 * validate with them (through `jsonSchema()`) and the desktop's `ServerClient` parses answers with
 * them, so a drift between the two fails typecheck.
 *
 * Names arrive untrimmed: Fastify validates the JSON Schema rendering, which cannot carry a
 * transform, so the handler trims and re-checks the length (`teams-name-invalid`).
 */
import { z } from 'zod';
import { emailSchema } from './identity.js';

/**
 * Crockford base32 ULID, upper case, 26 characters: what `ulidx` mints and what the server's
 * `RepoStore` accepts. `identityIdSchema` only checks length; every teams route parameter is this.
 */
export const TEAMS_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** §6: team and workspace names, after trimming. */
export const MAX_TEAMS_NAME_LENGTH = 80;

export const teamsIdSchema = z.string().regex(TEAMS_ID_PATTERN);
export const teamsNameSchema = z.string().min(1).max(MAX_TEAMS_NAME_LENGTH);

export const teamRoleSchema = z.enum(['member', 'admin']);
export type TeamRole = z.infer<typeof teamRoleSchema>;
export const workspaceRoleSchema = z.enum(['viewer', 'editor', 'admin']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
/** What a team member gets without a grant; `none` hides the workspace from them (§3.1). */
export const defaultRoleSchema = z.enum(['none', 'viewer', 'editor']);
export type DefaultRole = z.infer<typeof defaultRoleSchema>;
export const roleSourceSchema = z.enum(['server-admin', 'team-admin', 'grant', 'default']);
export type RoleSource = z.infer<typeof roleSourceSchema>;
/** A role as the access list shows it: a team member may have `none`. */
export const effectiveRoleSchema = z.enum(['none', 'viewer', 'editor', 'admin']);
export type EffectiveRole = z.infer<typeof effectiveRoleSchema>;

// ---- teams -------------------------------------------------------------------------------

export const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** A server admin sees every team as `admin`. */
  myRole: teamRoleSchema,
  createdAt: z.string(),
});
export type Team = z.infer<typeof teamSchema>;
export const teamsResponseSchema = z.array(teamSchema);
export const teamNameRequestSchema = z.object({ name: teamsNameSchema });
export type TeamNameRequest = z.infer<typeof teamNameRequestSchema>;
export const teamParamsSchema = z.object({ teamId: teamsIdSchema });

// ---- members -----------------------------------------------------------------------------

export const teamMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: teamRoleSchema,
  /** §16 question 4: a disabled user stays listed, marked, and removable. */
  disabled: z.boolean(),
  addedAt: z.string(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;
export const teamMembersResponseSchema = z.array(teamMemberSchema);
export const memberAddRequestSchema = z.object({ email: emailSchema, role: teamRoleSchema });
export type MemberAddRequest = z.infer<typeof memberAddRequestSchema>;
export const memberRoleRequestSchema = z.object({ role: teamRoleSchema });
export type MemberRoleRequest = z.infer<typeof memberRoleRequestSchema>;
export const memberParamsSchema = z.object({ teamId: teamsIdSchema, userId: teamsIdSchema });

// ---- invitations -------------------------------------------------------------------------

export const teamInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TeamInvitation = z.infer<typeof teamInvitationSchema>;
export const teamInvitationsResponseSchema = z.array(teamInvitationSchema);
export const teamInvitationCreateRequestSchema = z.object({ email: emailSchema, role: teamRoleSchema });
export type TeamInvitationCreateRequest = z.infer<typeof teamInvitationCreateRequestSchema>;
/** The link is in this answer and nowhere else: the server stores only the secret's hash. */
export const teamInvitationCreatedSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleSchema,
  url: z.string().url(),
  expiresAt: z.string(),
});
export type TeamInvitationCreated = z.infer<typeof teamInvitationCreatedSchema>;
export const teamInvitationParamsSchema = z.object({ teamId: teamsIdSchema, id: teamsIdSchema });

// ---- workspaces --------------------------------------------------------------------------

export const teamWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  defaultRole: defaultRoleSchema,
  myRole: workspaceRoleSchema,
  source: roleSourceSchema,
  createdAt: z.string(),
});
export type TeamWorkspace = z.infer<typeof teamWorkspaceSchema>;
export const teamWorkspacesResponseSchema = z.array(teamWorkspaceSchema);
export const teamWorkspaceCreateRequestSchema = z.object({
  /** The workspace manifest's ULID, so the server id equals the local one (server-sync §3.2). */
  id: teamsIdSchema.optional(),
  name: teamsNameSchema,
  defaultRole: defaultRoleSchema.optional(),
});
export type TeamWorkspaceCreateRequest = z.infer<typeof teamWorkspaceCreateRequestSchema>;
export const teamWorkspaceUpdateRequestSchema = z.object({
  name: teamsNameSchema.optional(),
  defaultRole: defaultRoleSchema.optional(),
});
export type TeamWorkspaceUpdateRequest = z.infer<typeof teamWorkspaceUpdateRequestSchema>;
export const teamWorkspaceParamsSchema = z.object({ workspaceId: teamsIdSchema });

// ---- access ------------------------------------------------------------------------------

/** One team member as a workspace admin sees them: what they can do, why, and any grant. */
export const accessEntrySchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  teamRole: teamRoleSchema,
  disabled: z.boolean(),
  effectiveRole: effectiveRoleSchema,
  /** Absent exactly when `effectiveRole` is `none`. */
  source: roleSourceSchema.optional(),
  grant: workspaceRoleSchema.optional(),
});
export type AccessEntry = z.infer<typeof accessEntrySchema>;
export const accessResponseSchema = z.array(accessEntrySchema);
export const accessParamsSchema = z.object({ workspaceId: teamsIdSchema, userId: teamsIdSchema });
export const setAccessRequestSchema = z.object({ role: workspaceRoleSchema });
export type SetAccessRequest = z.infer<typeof setAccessRequestSchema>;
