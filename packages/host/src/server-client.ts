/**
 * The desktop's HTTP client for Wirebench Server (identity spec §5.3): one method per endpoint
 * the sign-in flow and the Team dialog use, each parsed with the engine's shared schema so a
 * server that drifts is an error here, not a crash in the renderer. Every call goes through the
 * engine's `sendHttp` with the same CA bundle and proxy a request send would use. The token is a
 * parameter, never a field: this class holds no state and can serve several servers.
 */
import {
  sessionLogChunkResponseSchema,
  sessionLogOpenResponseSchema,
  terminalShareCreateResponseSchema,
  terminalShareInfoSchema,
  sessionLogPageSchema,
  sessionLogTextResponseSchema,
} from '@wirebench/engine';
import type {
  SessionLogChunkRequest,
  SessionLogChunkResponse,
  SessionLogEndRequest,
  SessionLogOpenRequest,
  SessionLogOpenResponse,
  SessionLogPage,
  SessionLogsQuery,
  SessionLogTextResponse,
  TerminalShareCreateRequest,
  TerminalShareCreateResponse,
  TerminalShareInfo,
} from '@wirebench/engine';
import {
  localSignInResponseSchema,
  usersResponseSchema,
  type UserSummary,
  passkeyAddResponseSchema,
  passkeyBrowserStartResponseSchema,
  webauthnJsonSchema,
  type PasskeyAddRequest,
  type PasskeyAddResponse,
  recoveryCodesResponseSchema,
  totpConfirmResponseSchema,
  totpSetupResponseSchema,
  twoFactorSetupSignInResponseSchema,
  twoFactorStatusSchema,
  type LocalSignInResponse,
  type PasskeyBrowserStartRequest,
  type PasskeyBrowserStartResponse,
  type PasskeyCompleteRequest,
  type RecoveryCodesResponse,
  type TotpConfirmResponse,
  type TotpSetupResponse,
  type TwoFactorSetupSignInResponse,
  type TwoFactorStatus,
  type TwoFactorVerifyRequest,
} from '@wirebench/engine';
import {
  accessResponseSchema,
  type DesktopAuditBatch,
  captureSchema,
  ciTokenCreatedSchema,
  customDomainResponseSchema,
  ciTokensResponseSchema,
  type CiTokenCreated,
  type CiTokenSummary,
  capturesResponseSchema,
  catchUrlSchema,
  catchUrlsResponseSchema,
  invitationLookupResponseSchema,
  licenseStateSchema,
  alertTestResponseSchema,
  scheduleCreateSchema,
  scheduleRunDetailSchema,
  scheduleRunPageSchema,
  scheduleRunSchema,
  scheduleSchema,
  schedulesResponseSchema,
  type AlertTestResponse,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunDetail,
  type ScheduleRunPage,
  type ScheduleRunStatus,
  type ScheduleSecrets,
  type ScheduleUpdate,
  samlInfoResponseSchema,
  samlStartResponseSchema,
  scimGroupSummarySchema,
  scimGroupsResponseSchema,
  scimTokenCreatedSchema,
  scimTokensResponseSchema,
  type SamlInfoResponse,
  type SamlStartRequest,
  type SamlStartResponse,
  type SamlCompleteRequest,
  type ScimGroupSummary,
  type ScimTokenCreated,
  type ScimTokenSummary,
  type LicenseState,
  meResponseSchema,
  devicesResponseSchema,
  IMAGE_LIMITS,
  imageRefSchema,
  userProfileSchema,
  type ImageKind,
  type ImageRef,
  type MeUpdateRequest,
  type UserProfile,
  metaResponseSchema,
  oidcStartResponseSchema,
  SERVER_API_VERSION,
  SERVER_NAME,
  sendHttp,
  signInResponseSchema,
  syncChangesResponseSchema,
  syncHeadResponseSchema,
  syncLogResponseSchema,
  syncPushResponseSchema,
  syncSnapshotResponseSchema,
  teamInvitationCreatedSchema,
  teamInvitationsResponseSchema,
  teamMemberSchema,
  teamMembersResponseSchema,
  teamSchema,
  teamSecretsKeyRequestResponseSchema,
  teamsResponseSchema,
  teamWorkspaceSchema,
  teamWorkspacesResponseSchema,
  WirebenchError,
  type AccessEntry,
  type Capture,
  type CaptureSummary,
  type CatchUrl,
  type CatchUrlCreateRequest,
  type CatchUrlUpdateRequest,
  type CustomDomain,
  type HttpExchange,
  type HttpRequest,
  type InvitationAcceptRequest,
  type InvitationLookupResponse,
  type LocalSignInRequest,
  type MeResponse,
  type DeviceSummary,
  type PasswordChangeRequest,
  type MetaResponse,
  type MemberAddRequest,
  type OidcCompleteRequest,
  type OidcStartRequest,
  type OidcStartResponse,
  type ProxyOptions,
  type SignInResponse,
  type SyncChangesResponse,
  type SyncHeadResponse,
  type SyncLogEntry,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncSnapshotResponse,
  type Team,
  type TeamInvitation,
  type TeamInvitationCreated,
  type TeamInvitationCreateRequest,
  type TeamMember,
  type TeamRole,
  type TeamSecretsKeyRequest,
  type TeamSecretsKeyRequestResponse,
  type TeamWorkspace,
  type TeamWorkspaceCreateRequest,
  type TeamWorkspaceUpdateRequest,
  type TlsOptions,
  type WorkspaceRole,
} from '@wirebench/engine';
import { z } from 'zod';
import {
  auditPageWireSchema,
  serverSettingsWireSchema,
  tenantBillingWireSchema,
  tenantDeletionCancelledWireSchema,
  tenantDeletionWireSchema,
  tenantExportRequestedWireSchema,
  tenantExportsListResponseWireSchema,
  type ServerSettingsWire,
  type ServerSettingsWritableSectionWire,
  type TenantBillingWire,
  type TenantDeletionWire,
  type TenantExportWire,
  type AuditExportQueryWire,
  type AuditPageWire,
  type AuditQueryWire,
} from '@wirebench/wire/wire-base';

export interface ServerClientDeps {
  /** The engine's `sendHttp` by default; a stub in tests. */
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  /** TLS and proxy for a URL: `mainHttpOptions` in the app. */
  readonly options?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Snapshot, changes and push carry up to the server's `bodyLimitMb` (32 MiB by default) in one
 * body (server-sync R5), which the 15 s every other call gets cannot cover on an ordinary uplink.
 */
export const SYNC_TRANSFER_TIMEOUT_MS = 120_000;

const teamPath = (teamId: string): string => `/api/v1/teams/${encodeURIComponent(teamId)}`;
const workspacePath = (workspaceId: string): string => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
const sessionLogPath = (workspaceId: string, logId: string): string =>
  `${workspacePath(workspaceId)}/session-logs/${encodeURIComponent(logId)}`;
const hookPath = (workspaceId: string, hookId: string): string =>
  `${workspacePath(workspaceId)}/hooks/${encodeURIComponent(hookId)}`;
const schedulePath = (workspaceId: string, scheduleId: string): string =>
  `${workspacePath(workspaceId)}/schedules/${encodeURIComponent(scheduleId)}`;

/** A create body as the client sends it: the server fills the defaults (`z.input`, not the parsed shape). */
export type ScheduleCreateInput = z.input<typeof scheduleCreateSchema>;

/**
 * `path` plus a query string built from the defined values only. `URLSearchParams` encodes every
 * value, and an absent one is left out rather than sent as `undefined` or an empty string.
 */
function withQuery(path: string, query: Readonly<Record<string, string | number | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text.length > 0 ? `${path}?${text}` : path;
}

/** The origin of what the user typed: scheme, host, port. Anything that is not http(s) is refused. */
export function normalizeServerUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new WirebenchError(
      'server-url-invalid',
      'Enter the server address as a URL, such as https://wirebench.example.com',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WirebenchError('server-url-invalid', 'The server address must start with https:// or http://');
  }
  return url.origin;
}

interface Call<T> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly schema?: z.ZodType<T>;
  readonly body?: unknown;
  readonly token?: string;
  /** An `Authorization` other than a bearer token: the setup challenge's `TwoFactor <secret>` (two-step spec §4.3). */
  readonly authorization?: string;
  /** This call's deadline; wins over the client-wide `timeoutMs`. Set only by the large sync transfers. */
  readonly timeoutMs?: number;
}

export class ServerClient {
  private readonly send: (request: HttpRequest) => Promise<HttpExchange>;

  constructor(private readonly deps: ServerClientDeps = {}) {
    this.send = deps.send ?? sendHttp;
  }

  async meta(url: string): Promise<MetaResponse> {
    const raw = await this.call<unknown>(url, { method: 'GET', path: '/api/v1/meta' });
    const shape = raw as { readonly name?: unknown; readonly apiVersion?: unknown } | null;
    if (typeof shape !== 'object' || shape === null || shape.name !== SERVER_NAME) {
      throw new WirebenchError('server-not-wirebench', 'That address is not a Wirebench Server');
    }
    if (shape.apiVersion !== SERVER_API_VERSION) {
      throw new WirebenchError(
        'server-api-version',
        `This server speaks API version ${String(shape.apiVersion)}; this app needs ${String(SERVER_API_VERSION)}. Update Wirebench.`,
      );
    }
    return parseOrBad(metaResponseSchema, raw);
  }

  /** A session, or the second step's challenge for a person with two-step sign-in (two-step spec §3.1). */
  signInLocal(url: string, body: LocalSignInRequest): Promise<LocalSignInResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/auth/local/sign-in',
      body,
      schema: localSignInResponseSchema,
    });
  }

  // ---- two-step sign-in (two-step sign-in spec §7) -------------------------------------------

  verifyTwoFactor(url: string, body: TwoFactorVerifyRequest): Promise<SignInResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/auth/two-factor/verify',
      body,
      schema: signInResponseSchema,
    });
  }

  startTwoFactorPasskey(url: string, body: PasskeyBrowserStartRequest): Promise<PasskeyBrowserStartResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/auth/two-factor/passkey/browser-start',
      body,
      schema: passkeyBrowserStartResponseSchema,
    });
  }

  completeTwoFactorPasskey(url: string, body: PasskeyCompleteRequest): Promise<SignInResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/auth/two-factor/passkey/complete',
      body,
      schema: signInResponseSchema,
    });
  }

  twoFactorStatus(url: string, token: string): Promise<TwoFactorStatus> {
    return this.call(url, { method: 'GET', path: '/api/v1/me/two-factor', token, schema: twoFactorStatusSchema });
  }

  /** Signed in with the password, or under a setup challenge (no password: one was checked moments ago). */
  setUpTotp(
    url: string,
    as: { readonly token: string; readonly password: string } | { readonly challenge: string },
  ): Promise<TotpSetupResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/me/two-factor/totp',
      ...('token' in as
        ? { token: as.token, body: { password: as.password } }
        : { authorization: `TwoFactor ${as.challenge}`, body: {} }),
      schema: totpSetupResponseSchema,
    });
  }

  confirmTotp(url: string, token: string, code: string): Promise<TotpConfirmResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/me/two-factor/totp/confirm',
      token,
      body: { code },
      schema: totpConfirmResponseSchema,
    });
  }

  /** The setup challenge's confirm (two-step spec §4.3): the session, with the recovery codes to show first. */
  confirmTotpSetup(url: string, challenge: string, code: string): Promise<TwoFactorSetupSignInResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/me/two-factor/totp/confirm',
      authorization: `TwoFactor ${challenge}`,
      body: { code },
      schema: twoFactorSetupSignInResponseSchema,
    });
  }

  async removeTotp(url: string, token: string, password: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: '/api/v1/me/two-factor/totp', token, body: { password } });
  }

  regenerateRecoveryCodes(url: string, token: string, password: string): Promise<RecoveryCodesResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/me/two-factor/recovery-codes',
      token,
      body: { password },
      schema: recoveryCodesResponseSchema,
    });
  }

  /** A passkey's creation options, after the password (spec §5.2). */
  passkeyRegistrationOptions(url: string, token: string, password: string): Promise<Record<string, unknown>> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/me/two-factor/passkeys/options',
      token,
      body: { password },
      schema: webauthnJsonSchema,
    });
  }

  addPasskey(url: string, token: string, body: PasskeyAddRequest): Promise<PasskeyAddResponse> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/me/two-factor/passkeys',
      token,
      body,
      schema: passkeyAddResponseSchema,
    });
  }

  async renamePasskey(url: string, token: string, id: string, name: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'PATCH',
      path: `/api/v1/me/two-factor/passkeys/${encodeURIComponent(id)}`,
      token,
      body: { name },
    });
  }

  async removePasskey(url: string, token: string, id: string, password: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `/api/v1/me/two-factor/passkeys/${encodeURIComponent(id)}`,
      token,
      body: { password },
    });
  }

  /** Every user of the server (server admins only): `GET /users`. */
  listUsers(url: string, token: string): Promise<UserSummary[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/users', token, schema: usersResponseSchema });
  }

  /** A server admin's reset of another person's two-step sign-in (two-step spec §7); it ends their sessions. */
  async resetTwoFactor(url: string, token: string, userId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `/api/v1/users/${encodeURIComponent(userId)}/two-factor`,
      token,
    });
  }

  startOidc(url: string, body: OidcStartRequest): Promise<OidcStartResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/oidc/start', body, schema: oidcStartResponseSchema });
  }

  completeOidc(url: string, body: OidcCompleteRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/oidc/complete', body, schema: signInResponseSchema });
  }

  startSaml(url: string, body: SamlStartRequest): Promise<SamlStartResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/saml/start', body, schema: samlStartResponseSchema });
  }

  completeSaml(url: string, body: SamlCompleteRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/saml/complete', body, schema: signInResponseSchema });
  }

  async signOut(url: string, token: string): Promise<void> {
    await this.call<unknown>(url, { method: 'POST', path: '/api/v1/auth/sign-out', token });
  }

  me(url: string, token: string): Promise<MeResponse> {
    return this.call(url, { method: 'GET', path: '/api/v1/me', token, schema: meResponseSchema });
  }

  lookupInvitation(url: string, secret: string): Promise<InvitationLookupResponse> {
    return this.call(url, {
      method: 'GET',
      path: `/api/v1/invitations/lookup?secret=${encodeURIComponent(secret)}`,
      schema: invitationLookupResponseSchema,
    });
  }

  acceptInvitation(url: string, body: InvitationAcceptRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/invitations/accept', body, schema: signInResponseSchema });
  }

  // ---- you on the server (settings split spec §4) ------------------------------------------

  /** `PATCH /me` with any of name, username (`null` clears it) and about; answers what `GET /me` answers. */
  updateMe(url: string, token: string, patch: MeUpdateRequest): Promise<MeResponse> {
    return this.call(url, { method: 'PATCH', path: '/api/v1/me', token, body: patch, schema: meResponseSchema });
  }

  /** `PUT /me/images/:kind` (user profile spec §6.2): the base64 WebP the app made; answers its new version. */
  putImage(url: string, token: string, kind: ImageKind, data: string): Promise<ImageRef> {
    return this.call(url, {
      method: 'PUT',
      path: `/api/v1/me/images/${encodeURIComponent(kind)}`,
      token,
      body: { contentType: 'image/webp', data },
      schema: imageRefSchema,
    });
  }

  async deleteImage(url: string, token: string, kind: ImageKind): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: `/api/v1/me/images/${encodeURIComponent(kind)}`, token });
  }

  /** `GET /users/:id/profile`: a team mate's card; a stranger is the server's 404. */
  profile(url: string, token: string, userId: string): Promise<UserProfile> {
    return this.call(url, {
      method: 'GET',
      path: `/api/v1/users/${encodeURIComponent(userId)}/profile`,
      token,
      schema: userProfileSchema,
    });
  }

  /**
   * `GET /users/:id/images/:kind` as a `data:image/webp;base64,…` URL, the only form the renderer shows (its CSP
   * allows `data:` images, never a server's). Only a WebP within the cover's byte cap is taken: anything else the
   * server answers, whatever its content type says, is `server-bad-response`.
   */
  async image(url: string, token: string, userId: string, kind: ImageKind): Promise<string> {
    const origin = normalizeServerUrl(url);
    const options = (await this.deps.options?.(origin)) ?? {};
    let exchange: HttpExchange;
    try {
      exchange = await this.send({
        url: `${origin}/api/v1/users/${encodeURIComponent(userId)}/images/${encodeURIComponent(kind)}`,
        method: 'GET',
        headers: { accept: 'image/webp', authorization: `Bearer ${token}` },
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        followRedirects: false,
        // One byte over the largest cap shows as `truncated`, so an oversized answer is refused, not cut.
        maxSizeBytes: IMAGE_LIMITS.cover.maxBytes + 1,
        ...transportOptions(options),
      });
    } catch (error) {
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`, { cause: error });
    }
    if (exchange.status < 200 || exchange.status >= 300) return this.throwProblem(origin, exchange);
    const type = (exchange.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'image/webp' || exchange.truncated || !isWebp(exchange.body)) {
      throw new WirebenchError('server-bad-response', 'The server answered with something that is not a profile image');
    }
    return `data:image/webp;base64,${Buffer.from(exchange.body).toString('base64')}`;
  }

  /** The passwords go in the body only; a refusal is the server's code and message, which never quote them. */
  async changePassword(url: string, token: string, body: PasswordChangeRequest): Promise<void> {
    await this.call<unknown>(url, { method: 'POST', path: '/api/v1/me/password', token, body });
  }

  listDevices(url: string, token: string): Promise<DeviceSummary[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/me/devices', token, schema: devicesResponseSchema });
  }

  async revokeDevice(url: string, token: string, id: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: `/api/v1/me/devices/${encodeURIComponent(id)}`, token });
  }

  // ---- teams-access (spec §3.2, §5.2): one method per route ----------------------------------

  listTeams(url: string, token: string): Promise<Team[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/teams', token, schema: teamsResponseSchema });
  }

  createTeam(url: string, token: string, name: string): Promise<Team> {
    return this.call(url, { method: 'POST', path: '/api/v1/teams', token, body: { name }, schema: teamSchema });
  }

  renameTeam(url: string, token: string, teamId: string, name: string): Promise<Team> {
    return this.call(url, { method: 'PATCH', path: teamPath(teamId), token, body: { name }, schema: teamSchema });
  }

  async deleteTeam(url: string, token: string, teamId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: teamPath(teamId), token });
  }

  listMembers(url: string, token: string, teamId: string): Promise<TeamMember[]> {
    return this.call(url, {
      method: 'GET',
      path: `${teamPath(teamId)}/members`,
      token,
      schema: teamMembersResponseSchema,
    });
  }

  addMember(url: string, token: string, teamId: string, body: MemberAddRequest): Promise<TeamMember> {
    return this.call(url, {
      method: 'POST',
      path: `${teamPath(teamId)}/members`,
      token,
      body,
      schema: teamMemberSchema,
    });
  }

  setMemberRole(url: string, token: string, teamId: string, userId: string, role: TeamRole): Promise<TeamMember> {
    return this.call(url, {
      method: 'PATCH',
      path: `${teamPath(teamId)}/members/${encodeURIComponent(userId)}`,
      token,
      body: { role },
      schema: teamMemberSchema,
    });
  }

  async removeMember(url: string, token: string, teamId: string, userId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${teamPath(teamId)}/members/${encodeURIComponent(userId)}`,
      token,
    });
  }

  listTeamInvitations(url: string, token: string, teamId: string): Promise<TeamInvitation[]> {
    return this.call(url, {
      method: 'GET',
      path: `${teamPath(teamId)}/invitations`,
      token,
      schema: teamInvitationsResponseSchema,
    });
  }

  inviteToTeam(
    url: string,
    token: string,
    teamId: string,
    body: TeamInvitationCreateRequest,
  ): Promise<TeamInvitationCreated> {
    return this.call(url, {
      method: 'POST',
      path: `${teamPath(teamId)}/invitations`,
      token,
      body,
      schema: teamInvitationCreatedSchema,
    });
  }

  async revokeTeamInvitation(url: string, token: string, teamId: string, invitationId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${teamPath(teamId)}/invitations/${encodeURIComponent(invitationId)}`,
      token,
    });
  }

  /** A new link for the same email and role; the old one is refused from then on. */
  renewTeamInvitation(
    url: string,
    token: string,
    teamId: string,
    invitationId: string,
  ): Promise<TeamInvitationCreated> {
    return this.call(url, {
      method: 'POST',
      path: `${teamPath(teamId)}/invitations/${encodeURIComponent(invitationId)}/renew`,
      token,
      schema: teamInvitationCreatedSchema,
    });
  }

  listWorkspaces(url: string, token: string): Promise<TeamWorkspace[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/workspaces', token, schema: teamWorkspacesResponseSchema });
  }

  createWorkspace(
    url: string,
    token: string,
    teamId: string,
    body: TeamWorkspaceCreateRequest,
  ): Promise<TeamWorkspace> {
    return this.call(url, {
      method: 'POST',
      path: `${teamPath(teamId)}/workspaces`,
      token,
      body,
      schema: teamWorkspaceSchema,
    });
  }

  getWorkspace(url: string, token: string, workspaceId: string): Promise<TeamWorkspace> {
    return this.call(url, { method: 'GET', path: workspacePath(workspaceId), token, schema: teamWorkspaceSchema });
  }

  updateWorkspace(
    url: string,
    token: string,
    workspaceId: string,
    body: TeamWorkspaceUpdateRequest,
  ): Promise<TeamWorkspace> {
    return this.call(url, {
      method: 'PATCH',
      path: workspacePath(workspaceId),
      token,
      body,
      schema: teamWorkspaceSchema,
    });
  }

  async deleteWorkspace(url: string, token: string, workspaceId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: workspacePath(workspaceId), token });
  }

  workspaceAccess(url: string, token: string, workspaceId: string): Promise<AccessEntry[]> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/access`,
      token,
      schema: accessResponseSchema,
    });
  }

  /** team-secrets §5.1: adds this machine's key request as a server-authored commit. */
  requestTeamSecretsKey(
    url: string,
    token: string,
    workspaceId: string,
    body: TeamSecretsKeyRequest,
  ): Promise<TeamSecretsKeyRequestResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/team-secrets/key-requests`,
      token,
      body,
      schema: teamSecretsKeyRequestResponseSchema,
    });
  }

  async setAccess(url: string, token: string, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await this.call<unknown>(url, {
      method: 'PUT',
      path: `${workspacePath(workspaceId)}/access/${encodeURIComponent(userId)}`,
      token,
      body: { role },
    });
  }

  async clearAccess(url: string, token: string, workspaceId: string, userId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${workspacePath(workspaceId)}/access/${encodeURIComponent(userId)}`,
      token,
    });
  }

  // ---- server-sync (spec §3.2): one method per route -------------------------------------------

  /** `from` is the client's base; absent or `null` (an empty base) asks for the totals only. */
  syncHead(url: string, token: string, workspaceId: string, from?: string | null): Promise<SyncHeadResponse> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/head`, { from: from ?? undefined }),
      token,
      schema: syncHeadResponseSchema,
    });
  }

  /** The whole tree at `at`, or at the head when `at` is absent. */
  syncSnapshot(url: string, token: string, workspaceId: string, at?: string): Promise<SyncSnapshotResponse> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/snapshot`, { at }),
      token,
      schema: syncSnapshotResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** Every path that differs between `from` (`null`: the empty tree) and `to`. */
  syncChanges(
    url: string,
    token: string,
    workspaceId: string,
    from: string | null,
    to: string,
  ): Promise<SyncChangesResponse> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/changes`, { from: from ?? undefined, to }),
      token,
      schema: syncChangesResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** `409 sync-push-rejected` when `body.parent` is not the head; the caller pulls and retries. */
  pushCommits(url: string, token: string, workspaceId: string, body: SyncPushRequest): Promise<SyncPushResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/sync/commits`,
      token,
      body,
      schema: syncPushResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** The `limit` newest commits on the server's head, newest first. */
  syncLog(url: string, token: string, workspaceId: string, limit: number): Promise<SyncLogEntry[]> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/log`, { limit }),
      token,
      schema: syncLogResponseSchema,
    });
  }

  // ---- webhook-capture (spec §3.5): one method per route -----------------------------------------

  listHooks(url: string, token: string, workspaceId: string): Promise<CatchUrl[]> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/hooks`,
      token,
      schema: catchUrlsResponseSchema,
    });
  }

  createHook(url: string, token: string, workspaceId: string, body: CatchUrlCreateRequest): Promise<CatchUrl> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/hooks`,
      token,
      body,
      schema: catchUrlSchema,
    });
  }

  updateHook(
    url: string,
    token: string,
    workspaceId: string,
    hookId: string,
    body: CatchUrlUpdateRequest,
  ): Promise<CatchUrl> {
    return this.call(url, {
      method: 'PATCH',
      path: hookPath(workspaceId, hookId),
      token,
      body,
      schema: catchUrlSchema,
    });
  }

  /** The old URL stops answering the moment the server commits (§3.5). */
  rotateHook(url: string, token: string, workspaceId: string, hookId: string): Promise<CatchUrl> {
    return this.call(url, {
      method: 'POST',
      path: `${hookPath(workspaceId, hookId)}/rotate`,
      token,
      schema: catchUrlSchema,
    });
  }

  async deleteHook(url: string, token: string, workspaceId: string, hookId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: hookPath(workspaceId, hookId), token });
  }

  /** Newest first; `before` pages back from an id, `after` returns the captures right after one (the gap fill). */
  listCaptures(
    url: string,
    token: string,
    workspaceId: string,
    hookId: string,
    page: { readonly before?: string; readonly after?: string; readonly limit?: number },
  ): Promise<CaptureSummary[]> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${hookPath(workspaceId, hookId)}/captures`, {
        before: page.before,
        after: page.after,
        limit: page.limit,
      }),
      token,
      schema: capturesResponseSchema,
    });
  }

  /** One capture in full. Its body can be the server's whole body limit, so it gets the transfer timeout. */
  getCapture(url: string, token: string, workspaceId: string, hookId: string, captureId: string): Promise<Capture> {
    return this.call(url, {
      method: 'GET',
      path: `${hookPath(workspaceId, hookId)}/captures/${encodeURIComponent(captureId)}`,
      token,
      schema: captureSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  async clearCaptures(url: string, token: string, workspaceId: string, hookId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: `${hookPath(workspaceId, hookId)}/captures`, token });
  }

  // ---- scheduled-runs (spec §3.7): one method per route ------------------------------------------

  listSchedules(url: string, token: string, workspaceId: string): Promise<Schedule[]> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/schedules`,
      token,
      schema: schedulesResponseSchema,
    });
  }

  getSchedule(url: string, token: string, workspaceId: string, scheduleId: string): Promise<Schedule> {
    return this.call(url, {
      method: 'GET',
      path: schedulePath(workspaceId, scheduleId),
      token,
      schema: scheduleSchema,
    });
  }

  createSchedule(url: string, token: string, workspaceId: string, body: ScheduleCreateInput): Promise<Schedule> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/schedules`,
      token,
      body,
      schema: scheduleSchema,
    });
  }

  updateSchedule(
    url: string,
    token: string,
    workspaceId: string,
    scheduleId: string,
    body: ScheduleUpdate,
  ): Promise<Schedule> {
    return this.call(url, {
      method: 'PATCH',
      path: schedulePath(workspaceId, scheduleId),
      token,
      body,
      schema: scheduleSchema,
    });
  }

  async deleteSchedule(url: string, token: string, workspaceId: string, scheduleId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: schedulePath(workspaceId, scheduleId), token });
  }

  /** The whole map at once: a value sets a name, `null` removes it, a name left out stays (§3.3). */
  setScheduleSecrets(
    url: string,
    token: string,
    workspaceId: string,
    scheduleId: string,
    body: ScheduleSecrets,
  ): Promise<Schedule> {
    return this.call(url, {
      method: 'PUT',
      path: `${schedulePath(workspaceId, scheduleId)}/secrets`,
      token,
      body,
      schema: scheduleSchema,
    });
  }

  /** Sends to every target synchronously; touches neither the alert state nor the history (§14). */
  testScheduleAlerts(url: string, token: string, workspaceId: string, scheduleId: string): Promise<AlertTestResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${schedulePath(workspaceId, scheduleId)}/alerts/test`,
      token,
      schema: alertTestResponseSchema,
    });
  }

  /** Run now: queues a run, subject to the overlap rule; `next_run_at` does not move (§3.1). */
  runScheduleNow(url: string, token: string, workspaceId: string, scheduleId: string): Promise<ScheduleRun> {
    return this.call(url, {
      method: 'POST',
      path: `${schedulePath(workspaceId, scheduleId)}/runs`,
      token,
      schema: scheduleRunSchema,
    });
  }

  /** Newest first, cursor paged: `after` is the previous page's `next`. */
  listScheduleRuns(
    url: string,
    token: string,
    workspaceId: string,
    scheduleId: string,
    page: { readonly after?: string; readonly limit?: number; readonly status?: ScheduleRunStatus },
  ): Promise<ScheduleRunPage> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${schedulePath(workspaceId, scheduleId)}/runs`, {
        status: page.status,
        after: page.after,
        limit: page.limit,
      }),
      token,
      schema: scheduleRunPageSchema,
    });
  }

  /** One run with its results and alert deliveries; failed results carry their exchange, so the transfer timeout. */
  getScheduleRun(
    url: string,
    token: string,
    workspaceId: string,
    scheduleId: string,
    runId: string,
  ): Promise<ScheduleRunDetail> {
    return this.call(url, {
      method: 'GET',
      path: `${schedulePath(workspaceId, scheduleId)}/runs/${encodeURIComponent(runId)}`,
      token,
      schema: scheduleRunDetailSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** Cancels a queued or running run; a finished one answers `schedules-run-finished`. */
  async cancelScheduleRun(
    url: string,
    token: string,
    workspaceId: string,
    scheduleId: string,
    runId: string,
  ): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${schedulePath(workspaceId, scheduleId)}/runs/${encodeURIComponent(runId)}`,
      token,
    });
  }

  // ---- ci-tokens (callback-assertion spec §3): editors and admins, on their own session -----------

  listCiTokens(url: string, token: string, workspaceId: string): Promise<CiTokenSummary[]> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/ci-tokens`,
      token,
      schema: ciTokensResponseSchema,
    });
  }

  /** The one answer that carries the new token; the caller shows it once. */
  createCiToken(url: string, token: string, workspaceId: string, name: string): Promise<CiTokenCreated> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/ci-tokens`,
      token,
      body: { name },
      schema: ciTokenCreatedSchema,
    });
  }

  async revokeCiToken(url: string, token: string, workspaceId: string, tokenId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${workspacePath(workspaceId)}/ci-tokens/${encodeURIComponent(tokenId)}`,
      token,
    });
  }

  // ---- licensing (licensing spec §3.6): server admins, on their own session ------------------------

  getLicense(url: string, token: string): Promise<LicenseState> {
    return this.call(url, { method: 'GET', path: '/api/v1/license', token, schema: licenseStateSchema });
  }

  /** The server verifies; a refusal arrives as `licensing-invalid` with the reason in its message. */
  installLicense(url: string, token: string, license: string): Promise<LicenseState> {
    return this.call(url, {
      method: 'PUT',
      path: '/api/v1/license',
      token,
      body: { license },
      schema: licenseStateSchema,
    });
  }

  async removeLicense(url: string, token: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: '/api/v1/license', token });
  }

  // ---- provisioning (saml-scim spec §3.4, §3.6, §3.7): server admins on Enterprise ---------------

  samlInfo(url: string, token: string): Promise<SamlInfoResponse> {
    return this.call(url, { method: 'GET', path: '/api/v1/auth/saml/info', token, schema: samlInfoResponseSchema });
  }

  listScimTokens(url: string, token: string): Promise<ScimTokenSummary[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/scim-tokens', token, schema: scimTokensResponseSchema });
  }

  createScimToken(url: string, token: string, name: string): Promise<ScimTokenCreated> {
    return this.call(url, {
      method: 'POST',
      path: '/api/v1/scim-tokens',
      token,
      body: { name },
      schema: scimTokenCreatedSchema,
    });
  }

  async revokeScimToken(url: string, token: string, tokenId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `/api/v1/scim-tokens/${encodeURIComponent(tokenId)}`,
      token,
    });
  }

  listScimGroups(url: string, token: string): Promise<ScimGroupSummary[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/scim-groups', token, schema: scimGroupsResponseSchema });
  }

  linkScimGroup(url: string, token: string, groupId: string, teamId: string): Promise<ScimGroupSummary> {
    return this.call(url, {
      method: 'PUT',
      path: `/api/v1/scim-groups/${encodeURIComponent(groupId)}/team`,
      token,
      body: { teamId },
      schema: scimGroupSummarySchema,
    });
  }

  unlinkScimGroup(url: string, token: string, groupId: string): Promise<ScimGroupSummary> {
    return this.call(url, {
      method: 'DELETE',
      path: `/api/v1/scim-groups/${encodeURIComponent(groupId)}/team`,
      token,
      schema: scimGroupSummarySchema,
    });
  }

  // ---- custom domain (hosted edition spec §23.6): a hosted tenant's server admins, with the feature --------

  /** The tenant's claim, or `undefined` when it has none (the server answers `{}`). */
  async getCustomDomain(url: string, token: string): Promise<CustomDomain | undefined> {
    return claimOf(
      await this.call(url, { method: 'GET', path: CUSTOM_DOMAIN_PATH, token, schema: customDomainResponseSchema }),
    );
  }

  /** A refused name arrives as its reason's code (`custom-name-ours`, ...), a second claim as `custom-domains-one-per-tenant`. */
  async claimCustomDomain(url: string, token: string, name: string): Promise<CustomDomain | undefined> {
    return claimOf(
      await this.call(url, {
        method: 'PUT',
        path: CUSTOM_DOMAIN_PATH,
        token,
        body: { name },
        schema: customDomainResponseSchema,
      }),
    );
  }

  /** At most once a minute: a `429` carries `retryAfterMs` in its details. */
  async checkCustomDomain(url: string, token: string): Promise<CustomDomain | undefined> {
    return claimOf(
      await this.call(url, {
        method: 'POST',
        path: `${CUSTOM_DOMAIN_PATH}/check`,
        token,
        schema: customDomainResponseSchema,
      }),
    );
  }

  async removeCustomDomain(url: string, token: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: CUSTOM_DOMAIN_PATH, token });
  }

  // ---- the tenant's settings, billing, export and deletion (hosted edition spec §22.9–§22.13) ----------------

  /** Every section, secrets as `{ set }`; `source: "environment"` on a self-hosted server. */
  async getServerSettings(url: string, token: string): Promise<ServerSettingsWire> {
    return this.call(url, { method: 'GET', path: SETTINGS_PATH, token, schema: serverSettingsWireSchema });
  }

  /**
   * Checks and stores one section (the issuer's discovery, the metadata, the URL rules run on the server); the answer
   * is the whole view again. A refusal arrives as its code: `settings-invalid`, `settings-environment`, ...
   */
  async saveServerSettings(
    url: string,
    token: string,
    section: ServerSettingsWritableSectionWire,
    value: Readonly<Record<string, unknown>>,
  ): Promise<ServerSettingsWire> {
    return this.call(url, {
      method: 'PUT',
      path: `${SETTINGS_PATH}/${encodeURIComponent(section)}`,
      token,
      body: value,
      schema: serverSettingsWireSchema,
    });
  }

  async clearServerSettings(
    url: string,
    token: string,
    section: ServerSettingsWritableSectionWire,
  ): Promise<ServerSettingsWire> {
    return this.call(url, {
      method: 'DELETE',
      path: `${SETTINGS_PATH}/${encodeURIComponent(section)}`,
      token,
      schema: serverSettingsWireSchema,
    });
  }

  /** Hosted only: a self-hosted server has no such route, and answers `404`. */
  async getTenantBilling(url: string, token: string): Promise<TenantBillingWire> {
    return this.call(url, { method: 'GET', path: '/api/v1/tenant/billing', token, schema: tenantBillingWireSchema });
  }

  async listTenantExports(url: string, token: string): Promise<TenantExportWire[]> {
    const answer = await this.call(url, {
      method: 'GET',
      path: EXPORTS_PATH,
      token,
      schema: tenantExportsListResponseWireSchema,
    });
    return answer.exports;
  }

  /** One export runs per tenant at a time: a second answers `409` with its code. */
  async requestTenantExport(url: string, token: string): Promise<TenantExportWire> {
    const answer = await this.call(url, {
      method: 'POST',
      path: EXPORTS_PATH,
      token,
      schema: tenantExportRequestedWireSchema,
    });
    return answer.export;
  }

  /**
   * Streams a ready export's file. `open` is called once the server has answered 2xx, so a refusal leaves no file
   * behind; a chunk handler that returns a promise holds the stream until it settles (backpressure); the token goes in the `Authorization` header, never in the URL (spec §6).
   */
  async streamTenantExport(
    url: string,
    token: string,
    id: string,
    open: () => (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    const origin = normalizeServerUrl(url);
    const options = (await this.deps.options?.(origin)) ?? {};
    let streamed = false;
    let response: HttpExchange;
    try {
      response = await this.send({
        url: `${origin}${EXPORTS_PATH}/${encodeURIComponent(id)}/file`,
        method: 'GET',
        headers: { accept: 'application/gzip', authorization: `Bearer ${token}` },
        timeoutMs: EXPORT_DOWNLOAD_TIMEOUT_MS,
        followRedirects: false,
        ...transportOptions(options),
        stream: {
          accept: (status) => {
            if (status < 200 || status >= 300) return undefined;
            streamed = true;
            return { onChunk: open() };
          },
        },
      });
    } catch (cause) {
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`, { cause });
    }
    if (!streamed) this.throwProblem(origin, response);
    if (response.streamEnd?.by === 'error') {
      throw new WirebenchError('server-unreachable', `The export from ${origin} stopped early`, {
        cause: response.streamEnd.error,
      });
    }
  }

  /** `slug` is what the person typed; the server refuses any other with `control-plane-deletion-unconfirmed`. */
  async requestTenantDeletion(url: string, token: string, slug: string): Promise<TenantDeletionWire> {
    return this.call(url, {
      method: 'POST',
      path: DELETION_PATH,
      token,
      body: { slug },
      schema: tenantDeletionWireSchema,
    });
  }

  async cancelTenantDeletion(url: string, token: string): Promise<boolean> {
    const answer = await this.call(url, {
      method: 'DELETE',
      path: DELETION_PATH,
      token,
      schema: tenantDeletionCancelledWireSchema,
    });
    return answer.cancelled;
  }

  // ---- audit log (audit-log spec §3.4): server admins on Enterprise ------------------------------

  /**
   * Parsed with the wire schema, not the engine's: its `action` is any string, so a newer server's new
   * action reaches the tab instead of failing as `server-bad-response` (audit-log spec §3.6).
   */
  queryAudit(url: string, token: string, query: AuditQueryWire): Promise<AuditPageWire> {
    return this.call(url, {
      method: 'GET',
      path: withQuery('/api/v1/audit', auditParams(query)),
      token,
      schema: auditPageWireSchema,
    });
  }

  /** Sends one batch of desktop events; the server answers 204, or 409 `audit-desktop-recording-off`. */
  async reportDesktopEvents(url: string, token: string, workspaceId: string, batch: DesktopAuditBatch): Promise<void> {
    await this.call<unknown>(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/audit/desktop-events`,
      token,
      body: batch,
    });
  }

  // ---- team session logs (team session logs spec A1): members of a recording workspace ----------

  /** Opens this account's server copy of a session log, or finds it again; answers the size the server holds. */
  openSessionLog(
    url: string,
    token: string,
    workspaceId: string,
    body: SessionLogOpenRequest,
  ): Promise<SessionLogOpenResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/session-logs`,
      token,
      body,
      schema: sessionLogOpenResponseSchema,
    });
  }

  /** Appends text at `offset`, which must be the size the server holds (else 409 `session-logs-offset`). */
  appendSessionLog(
    url: string,
    token: string,
    workspaceId: string,
    logId: string,
    body: SessionLogChunkRequest,
  ): Promise<SessionLogChunkResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${sessionLogPath(workspaceId, logId)}/chunks`,
      token,
      body,
      schema: sessionLogChunkResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  async endSessionLog(
    url: string,
    token: string,
    workspaceId: string,
    logId: string,
    body: SessionLogEndRequest,
  ): Promise<void> {
    await this.call<unknown>(url, { method: 'POST', path: `${sessionLogPath(workspaceId, logId)}/end`, token, body });
  }

  listSessionLogs(url: string, token: string, workspaceId: string, query: SessionLogsQuery): Promise<SessionLogPage> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/session-logs`, {
        hostId: query.hostId,
        userId: query.userId,
        before: query.before,
        limit: query.limit,
      }),
      token,
      schema: sessionLogPageSchema,
    });
  }

  /** A log's text from `offset`; the server records the read in its audit log. */
  readSessionLog(
    url: string,
    token: string,
    workspaceId: string,
    logId: string,
    offset: number,
  ): Promise<SessionLogTextResponse> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${sessionLogPath(workspaceId, logId)}/text`, { offset }),
      token,
      schema: sessionLogTextResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** Starts sharing a terminal (#429): the share waits 30 s for its owner's socket. */
  createTerminalShare(
    url: string,
    token: string,
    workspaceId: string,
    body: TerminalShareCreateRequest,
  ): Promise<TerminalShareCreateResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/terminal-shares`,
      token,
      body,
      schema: terminalShareCreateResponseSchema,
    });
  }

  /** What a share is before joining it; 404 `terminal-share-not-found` once it ended. */
  terminalShareInfo(url: string, token: string, workspaceId: string, shareId: string): Promise<TerminalShareInfo> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/terminal-shares/${encodeURIComponent(shareId)}`,
      token,
      schema: terminalShareInfoSchema,
    });
  }

  /**
   * Streams the NDJSON export as it arrives (audit-log plan ruling 16): `call()` buffers and expects
   * JSON, so this builds the request itself. `open()` runs once, on a 2xx, and returns the chunk sink, so
   * the caller creates its file only then. A non-2xx is read whole and raised as the problem.
   */
  async streamAuditExport(
    url: string,
    token: string,
    query: AuditExportQueryWire,
    open: () => (chunk: Uint8Array) => void,
  ): Promise<void> {
    const origin = normalizeServerUrl(url);
    const options = (await this.deps.options?.(origin)) ?? {};
    let streamed = false;
    let response: HttpExchange;
    try {
      response = await this.send({
        url: `${origin}${withQuery('/api/v1/audit/export', auditParams(query))}`,
        method: 'GET',
        headers: { accept: 'application/x-ndjson', authorization: `Bearer ${token}` },
        timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
        followRedirects: false,
        ...transportOptions(options),
        stream: {
          accept: (status) => {
            if (status < 200 || status >= 300) return undefined;
            streamed = true;
            return { onChunk: open() };
          },
        },
      });
    } catch (cause) {
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`, { cause });
    }
    if (!streamed) this.throwProblem(origin, response);
    if (response.streamEnd?.by === 'error') {
      throw new WirebenchError('server-unreachable', `The export from ${origin} stopped early`, {
        cause: response.streamEnd.error,
      });
    }
  }

  private async call<T>(url: string, call: Call<T>): Promise<T> {
    const origin = normalizeServerUrl(url);
    const options = (await this.deps.options?.(origin)) ?? {};
    const payload = call.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(call.body));
    let exchange: HttpExchange;
    try {
      exchange = await this.send({
        url: `${origin}${call.path}`,
        method: call.method,
        headers: {
          accept: 'application/json',
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(call.token !== undefined ? { authorization: `Bearer ${call.token}` } : {}),
          ...(call.authorization !== undefined ? { authorization: call.authorization } : {}),
        },
        ...(payload !== undefined ? { body: payload } : {}),
        timeoutMs: call.timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        followRedirects: false,
        ...transportOptions(options),
      });
    } catch (error) {
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`, { cause: error });
    }
    const text = new TextDecoder().decode(exchange.body);
    const json = parseJson(text, exchange.headers['content-type']);
    if (exchange.status >= 200 && exchange.status < 300) {
      if (call.schema === undefined) return json as T;
      return parseOrBad(call.schema, json);
    }
    return this.throwProblem(origin, exchange);
  }

  /** Raises a non-2xx answer as the server's own problem code, or `server-bad-response` when it has none. */
  private throwProblem(origin: string, exchange: HttpExchange): never {
    const json = parseJson(new TextDecoder().decode(exchange.body), exchange.headers['content-type']);
    const problem = json as { readonly code?: unknown; readonly message?: unknown } | undefined;
    const retryAfterMs = parseRetryAfter(exchange.headers['retry-after']);
    const details = { status: exchange.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    if (typeof problem?.code === 'string' && typeof problem.message === 'string') {
      throw new WirebenchError(problem.code, problem.message, { details });
    }
    throw new WirebenchError('server-bad-response', `${origin} answered ${String(exchange.status)}`, { details });
  }
}

const CUSTOM_DOMAIN_PATH = '/api/v1/tenant/domain';
const SETTINGS_PATH = '/api/v1/tenant/settings';
const EXPORTS_PATH = '/api/v1/tenant/exports';
const DELETION_PATH = '/api/v1/tenant/deletion';
/** A whole tenant's export can run to hundreds of megabytes. */
const EXPORT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** `{}` is no claim. */
const claimOf = (answer: z.infer<typeof customDomainResponseSchema>): CustomDomain | undefined =>
  'name' in answer ? (answer as CustomDomain) : undefined;

/** A `Retry-After` as milliseconds: whole seconds or an HTTP-date. Anything else is ignored. */
function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
  const text = value?.trim();
  if (text === undefined || text === '') return undefined;
  let ms: number;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else if (/[A-Za-z]/.test(text)) ms = Date.parse(text) - now;
  else return undefined;
  return Number.isNaN(ms) || ms <= 0 ? undefined : ms;
}

/** The TLS and proxy settings a request to this server carries, only the ones that are set. */
function transportOptions(options: { readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }): {
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
} {
  return {
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
  };
}

/** Alphabetical, because `withQuery` keeps the object's order. */
const auditParams = (q: AuditQueryWire | AuditExportQueryWire): Record<string, string | number | undefined> => ({
  action: q.action,
  actorUserId: q.actorUserId,
  ...('after' in q ? { after: q.after } : {}),
  from: q.from,
  ...('limit' in q ? { limit: q.limit } : {}),
  targetId: q.targetId,
  targetKind: q.targetKind,
  teamId: q.teamId,
  to: q.to,
  workspaceId: q.workspaceId,
});

/** A RIFF container of type `WEBP`: the first twelve bytes, which is all the client needs to check. */
function isWebp(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}

function parseJson(text: string, contentType: string | undefined): unknown {
  if (text.length === 0) return undefined;
  if (contentType === undefined || !contentType.includes('json')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseOrBad<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WirebenchError('server-bad-response', 'The server answered with an unexpected shape');
  return parsed.data;
}
