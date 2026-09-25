/**
 * The desktop's HTTP client for Wirebench Server (identity spec §5.3): one method per endpoint
 * the sign-in flow and the Team dialog use, each parsed with the engine's shared schema so a
 * server that drifts is an error here, not a crash in the renderer. Every call goes through the
 * engine's `sendHttp` with the same CA bundle and proxy a request send would use. The token is a
 * parameter, never a field: this class holds no state and can serve several servers.
 */
import {
  accessResponseSchema,
  invitationLookupResponseSchema,
  meResponseSchema,
  metaResponseSchema,
  oidcStartResponseSchema,
  SERVER_API_VERSION,
  SERVER_NAME,
  sendHttp,
  signInResponseSchema,
  teamInvitationCreatedSchema,
  teamInvitationsResponseSchema,
  teamMemberSchema,
  teamMembersResponseSchema,
  teamSchema,
  teamsResponseSchema,
  teamWorkspaceSchema,
  teamWorkspacesResponseSchema,
  WirebenchError,
  type AccessEntry,
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
  type Team,
  type TeamInvitation,
  type TeamInvitationCreated,
  type TeamInvitationCreateRequest,
  type TeamMember,
  type TeamRole,
  type TeamWorkspace,
  type TeamWorkspaceCreateRequest,
  type TeamWorkspaceUpdateRequest,
  type TlsOptions,
  type WorkspaceRole,
} from '@wirebench/engine';
import type { z } from 'zod';

export interface ServerClientDeps {
  /** The engine's `sendHttp` by default; a stub in tests. */
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  /** TLS and proxy for a URL: `mainHttpOptions` in the app. */
  readonly options?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const teamPath = (teamId: string): string => `/api/v1/teams/${encodeURIComponent(teamId)}`;
const workspacePath = (workspaceId: string): string => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;

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
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        followRedirects: false,
        ...(options.tls !== undefined ? { tls: options.tls } : {}),
        ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
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
    const problem = json as { readonly code?: unknown; readonly message?: unknown } | undefined;
    if (typeof problem?.code === 'string' && typeof problem.message === 'string') {
      throw new WirebenchError(problem.code, problem.message, { details: { status: exchange.status } });
    }
    throw new WirebenchError('server-bad-response', `${origin} answered ${String(exchange.status)}`, {
      details: { status: exchange.status },
    });
  }
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
