/**
 * The desktop's HTTP client for Wirebench Server (identity spec §5.3): one method per endpoint
 * the sign-in flow and the Team dialog use, each parsed with the engine's shared schema so a
 * server that drifts is an error here, not a crash in the renderer. Every call goes through the
 * engine's `sendHttp` with the same CA bundle and proxy a request send would use. The token is a
 * parameter, never a field: this class holds no state and can serve several servers.
 */
import {
  accessResponseSchema,
  type DesktopAuditBatch,
  captureSchema,
  ciTokenCreatedSchema,
  ciTokensResponseSchema,
  type CiTokenCreated,
  type CiTokenSummary,
  capturesResponseSchema,
  catchUrlSchema,
  catchUrlsResponseSchema,
  invitationLookupResponseSchema,
  licenseStateSchema,
  type LicenseState,
  meResponseSchema,
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
  type HttpExchange,
  type HttpRequest,
  type InvitationAcceptRequest,
  type InvitationLookupResponse,
  type LocalSignInRequest,
  type MeResponse,
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
import type { z } from 'zod';
import {
  auditPageWireSchema,
  type AuditExportQueryWire,
  type AuditPageWire,
  type AuditQueryWire,
} from '../shared/wire-types.js';

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
const hookPath = (workspaceId: string, hookId: string): string =>
  `${workspacePath(workspaceId)}/hooks/${encodeURIComponent(hookId)}`;

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

  signInLocal(url: string, body: LocalSignInRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/local/sign-in', body, schema: signInResponseSchema });
  }

  startOidc(url: string, body: OidcStartRequest): Promise<OidcStartResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/oidc/start', body, schema: oidcStartResponseSchema });
  }

  completeOidc(url: string, body: OidcCompleteRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/oidc/complete', body, schema: signInResponseSchema });
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
    if (typeof problem?.code === 'string' && typeof problem.message === 'string') {
      throw new WirebenchError(problem.code, problem.message, { details: { status: exchange.status } });
    }
    throw new WirebenchError('server-bad-response', `${origin} answered ${String(exchange.status)}`, {
      details: { status: exchange.status },
    });
  }
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
