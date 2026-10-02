/**
 * The audit-log wire shapes (audit-log spec §2, §3.4, §5.2). The server writes events and serves
 * them; the desktop reads pages and streams the export. Plain zod only (ADR-0009).
 *
 * `details` is flat on purpose: a fire site names fields, never spreads a body, and nothing nested
 * can smuggle a payload in (§6).
 */
import { z } from 'zod';

/** §3.2, a closed list: a fire site references the enum, never a literal. */
export const AUDIT_ACTIONS = [
  'auth.signed_in',
  'auth.sign_in_failed',
  'auth.signed_out',
  'auth.password_changed',
  'user.invited',
  'user.invitation_revoked',
  'user.created',
  'user.disabled',
  'user.enabled',
  'user.admin_granted',
  'user.admin_revoked',
  'user.password_reset_issued',
  'team.created',
  'team.renamed',
  'team.deleted',
  'team.member_added',
  'team.member_removed',
  'team.member_role_changed',
  'workspace.created',
  'workspace.deleted',
  'workspace.renamed',
  'workspace.default_role_changed',
  'workspace.grant_set',
  'workspace.grant_removed',
  'workspace.pushed',
  'secret.shared',
  'secret.rotated',
  'secret.access_changed',
  'hook.created',
  'hook.changed',
  'hook.rotated',
  'hook.deleted',
  'hook.cleared',
  'hook.signature_set',
  'hook.signature_cleared',
  'ci_token.created',
  'ci_token.revoked',
  'license.installed',
  'license.removed',
  'audit.exported',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

/** The part before the dot, for the desktop's action-group filter. */
export const AUDIT_ACTION_GROUPS = [
  'auth',
  'user',
  'team',
  'workspace',
  'secret',
  'hook',
  'ci_token',
  'license',
  'audit',
] as const;
export type AuditActionGroup = (typeof AUDIT_ACTION_GROUPS)[number];

export const AUDIT_ACTOR_KINDS = ['user', 'ci-token', 'system', 'anonymous'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_TARGET_KINDS = [
  'server',
  'user',
  'invitation',
  'team',
  'workspace',
  'hook',
  'ci-token',
  'license',
] as const;
export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[number];

export const AUDIT_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 200,
  /** Rows per keyset query behind the export stream (§3.4). */
  exportBatch: 1000,
  /** `details`, serialised; a larger object is cut down with `_truncated: true` (§4.2). */
  maxDetailsBytes: 4096,
  maxUserAgentLength: 512,
  /** `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS` (§4.1). */
  maxAgeDays: { min: 30, max: 3650, default: 365 },
} as const;

const scalar = z.union([z.string(), z.number(), z.boolean()]);
export const auditDetailsSchema = z.record(
  z.string().min(1).max(64),
  z.union([scalar, z.null(), z.array(scalar).max(64)]),
);
export type AuditDetails = z.infer<typeof auditDetailsSchema>;

/** `email` is the user's email at the time of the event, copied into the row (§3.4). */
export const auditActorSchema = z.object({
  kind: z.enum(AUDIT_ACTOR_KINDS),
  userId: z.string().optional(),
  email: z.string().optional(),
  tokenId: z.string().optional(),
  /** A CI token's workspace (plan ruling 1). */
  workspaceId: z.string().optional(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditEventSchema = z.object({
  id: z.string(),
  at: z.string().datetime(),
  actor: auditActorSchema,
  action: auditActionSchema,
  target: z.object({ kind: z.enum(AUDIT_TARGET_KINDS), id: z.string().nullable() }),
  workspaceId: z.string().nullable(),
  teamId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: auditDetailsSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** `GET /audit` (§3.4). `action` is exact, or a group prefix ending in a dot. `to` is exclusive. */
export const auditQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  action: z
    .string()
    .regex(/^[a-z_]+\.([a-z_]+)?$/, 'an action, or a group followed by a dot')
    .optional(),
  actorUserId: z.string().optional(),
  workspaceId: z.string().optional(),
  teamId: z.string().optional(),
  targetKind: z.enum(AUDIT_TARGET_KINDS).optional(),
  targetId: z.string().optional(),
  /** Opaque; from the previous page's `next`. */
  after: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(AUDIT_LIMITS.maxPageSize).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** `GET /audit/export` and `admin audit export`: the same filters, no paging. */
export const auditExportQuerySchema = auditQuerySchema.omit({ after: true, limit: true });
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

export const auditPageSchema = z.object({ events: z.array(auditEventSchema), next: z.string().optional() });
export type AuditPage = z.infer<typeof auditPageSchema>;
