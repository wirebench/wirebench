import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly serverAdmin?: boolean;
}

/** A team seeded at start: its name and its members' roles by email. */
export interface FakeTeam {
  readonly name: string;
  readonly members: Readonly<Record<string, 'member' | 'admin'>>;
}

export interface FakeServerOptions {
  readonly users?: readonly FakeUser[];
  /** Open invitations, by secret. */
  readonly invitations?: Readonly<Record<string, { readonly email: string }>>;
  readonly oidc?: boolean;
  readonly teams?: readonly FakeTeam[];
}

export interface FakeServer {
  readonly url: string;
  /** Tokens issued so far, in order. */
  readonly tokens: string[];
  /** Tokens the app signed out. */
  readonly signOuts: string[];
  close(): Promise<void>;
}

const NAME = 'wirebench-server';
const API_VERSION = 1;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.length === 0 ? undefined : (JSON.parse(text) as unknown));
    });
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function problem(response: ServerResponse, status: number, code: string): void {
  send(response, status, { code, message: code });
}

let nextId = 1;
const newToken = (): string => `wbs_${String(nextId++).padStart(43, 'A')}`;

type TeamRole = 'member' | 'admin';
type WorkspaceRole = 'viewer' | 'editor' | 'admin';
type DefaultRole = 'none' | 'viewer' | 'editor';
type RoleSource = 'server-admin' | 'team-admin' | 'grant' | 'default';

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly members: Map<string, { role: TeamRole; readonly addedAt: string }>;
}

interface WorkspaceRow {
  readonly id: string;
  name: string;
  readonly teamId: string;
  defaultRole: DefaultRole;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly grants: Map<string, WorkspaceRole>;
}

interface FakeInvitation {
  readonly email: string;
  /** Present on a team invitation: accepting it adds the member. */
  readonly team?: {
    readonly teamId: string;
    readonly role: TeamRole;
    readonly id: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

const at = (): string => new Date().toISOString();

/**
 * Enough of Wirebench Server for the desktop's sign-in flow (identity spec §11) and its teams
 * dialog (teams-access spec §11), in memory. The real thing is covered by `packages/server`'s
 * integration suite; this exists so the e2e spec needs no PostgreSQL.
 */
export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const users = new Map(
    (options.users ?? []).map((user) => [user.email.toLowerCase(), { ...user, id: `u-${user.email}` }]),
  );
  const invitations = new Map<string, FakeInvitation>(Object.entries(options.invitations ?? {}));
  const sessions = new Map<string, string>(); // token → email
  const tokens: string[] = [];
  const signOuts: string[] = [];
  let url = '';

  let seq = 1;
  const id = (prefix: string): string => `${prefix}${String(seq++)}`;
  const teams = new Map<string, TeamRow>();
  const workspaces = new Map<string, WorkspaceRow>();
  for (const seed of options.teams ?? []) {
    const team: TeamRow = { id: id('t'), name: seed.name, createdAt: at(), members: new Map() };
    for (const [email, role] of Object.entries(seed.members))
      team.members.set(email.toLowerCase(), { role, addedAt: at() });
    teams.set(team.id, team);
  }
  const userByEmail = (email: string) => users.get(email.toLowerCase());
  const userById = (userId: string) => [...users.values()].find((user) => user.id === userId);

  /** The server's rule (teams-access §3.1), cut down to what the specs exercise. */
  const effective = (ws: WorkspaceRow, email: string): { role: WorkspaceRole; source: RoleSource } | undefined => {
    if (userByEmail(email)?.serverAdmin === true) return { role: 'admin', source: 'server-admin' };
    const membership = teams.get(ws.teamId)?.members.get(email.toLowerCase());
    if (membership === undefined) return undefined;
    if (membership.role === 'admin') return { role: 'admin', source: 'team-admin' };
    const grant = ws.grants.get(email.toLowerCase());
    if (grant !== undefined) return { role: grant, source: 'grant' };
    return ws.defaultRole === 'none' ? undefined : { role: ws.defaultRole, source: 'default' };
  };
  const teamRoleOf = (team: TeamRow, email: string): TeamRole | undefined =>
    userByEmail(email)?.serverAdmin === true ? 'admin' : team.members.get(email.toLowerCase())?.role;
  const toTeam = (team: TeamRow, myRole: TeamRole) => ({
    id: team.id,
    name: team.name,
    myRole,
    createdAt: team.createdAt,
  });
  const toMember = (email: string, membership: { role: TeamRole; addedAt: string }) => {
    const user = userByEmail(email)!;
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: membership.role,
      disabled: false,
      addedAt: membership.addedAt,
    };
  };
  const toWorkspace = (ws: WorkspaceRow, access: { role: WorkspaceRole; source: RoleSource }) => ({
    id: ws.id,
    name: ws.name,
    teamId: ws.teamId,
    teamName: teams.get(ws.teamId)!.name,
    defaultRole: ws.defaultRole,
    myRole: access.role,
    source: access.source,
    createdAt: ws.createdAt,
  });

  /**
   * Enough of the teams API for `team.spec.ts` (teams-access §3.2); the real routes are covered by
   * `packages/server`'s integration suite. Answers `true` once it has responded.
   */
  const teamsApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    segments: readonly string[],
    email: string,
  ): Promise<boolean> => {
    const method = request.method ?? 'GET';
    const [head, entityId, sub, subId] = segments;
    const key = email.toLowerCase();

    if (head === 'teams' && entityId === undefined) {
      if (method === 'GET') {
        const mine = [...teams.values()].flatMap((team) => {
          const role = teamRoleOf(team, email);
          return role === undefined ? [] : [toTeam(team, role)];
        });
        send(response, 200, mine);
        return true;
      }
      if (method === 'POST') {
        if (userByEmail(email)?.serverAdmin !== true) {
          problem(response, 403, 'teams-forbidden');
          return true;
        }
        const body = (await readJson(request)) as { name: string };
        const team: TeamRow = { id: id('t'), name: body.name.trim(), createdAt: at(), members: new Map() };
        team.members.set(key, { role: 'admin', addedAt: at() });
        teams.set(team.id, team);
        send(response, 201, toTeam(team, 'admin'));
        return true;
      }
    }

    if (head === 'teams' && entityId !== undefined) {
      const team = teams.get(entityId);
      const role = team === undefined ? undefined : teamRoleOf(team, email);
      if (team === undefined || role === undefined) {
        problem(response, 404, 'teams-team-not-found');
        return true;
      }
      const admin = role === 'admin';
      if (sub === 'members' && subId === undefined && method === 'GET') {
        send(
          response,
          200,
          [...team.members].map(([memberEmail, membership]) => toMember(memberEmail, membership)),
        );
        return true;
      }
      if (sub === 'members' && subId === undefined && method === 'POST' && admin) {
        const body = (await readJson(request)) as { email: string; role: TeamRole };
        if (userByEmail(body.email) === undefined) {
          problem(response, 404, 'teams-user-unknown');
          return true;
        }
        const membership = { role: body.role, addedAt: at() };
        team.members.set(body.email.toLowerCase(), membership);
        send(response, 201, toMember(body.email, membership));
        return true;
      }
      if (sub === 'invitations' && subId === undefined && method === 'GET' && admin) {
        const open = [...invitations.values()].flatMap((invitation) =>
          invitation.team?.teamId === team.id
            ? [
                {
                  id: invitation.team.id,
                  email: invitation.email,
                  role: invitation.team.role,
                  createdBy: null,
                  createdAt: invitation.team.createdAt,
                  expiresAt: invitation.team.expiresAt,
                },
              ]
            : [],
        );
        send(response, 200, open);
        return true;
      }
      if (sub === 'invitations' && subId === undefined && method === 'POST' && admin) {
        const body = (await readJson(request)) as { email: string; role: TeamRole };
        const secret = String(seq).padStart(43, 'S');
        const team_ = {
          teamId: team.id,
          role: body.role,
          id: id('i'),
          createdAt: at(),
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        };
        invitations.set(secret, { email: body.email, team: team_ });
        send(response, 201, {
          id: team_.id,
          email: body.email,
          role: body.role,
          url: `${url}/invite/${secret}`,
          expiresAt: team_.expiresAt,
        });
        return true;
      }
      if (sub === 'workspaces' && subId === undefined && method === 'POST') {
        const body = (await readJson(request)) as { name: string; defaultRole?: DefaultRole };
        const ws: WorkspaceRow = {
          id: id('w'),
          name: body.name.trim(),
          teamId: team.id,
          defaultRole: body.defaultRole ?? 'viewer',
          createdAt: at(),
          grants: new Map(),
        };
        if (team.members.has(key)) ws.grants.set(key, 'admin');
        workspaces.set(ws.id, ws);
        send(response, 201, toWorkspace(ws, effective(ws, email)!));
        return true;
      }
      if (admin) problem(response, 404, 'not-found');
      else problem(response, 403, 'teams-forbidden');
      return true;
    }

    if (head === 'workspaces' && entityId === undefined && method === 'GET') {
      const visible = [...workspaces.values()].flatMap((ws) => {
        const access = effective(ws, email);
        return access === undefined ? [] : [toWorkspace(ws, access)];
      });
      send(response, 200, visible);
      return true;
    }

    if (head === 'workspaces' && entityId !== undefined) {
      const ws = workspaces.get(entityId);
      const access = ws === undefined ? undefined : effective(ws, email);
      if (ws === undefined || access === undefined) {
        problem(response, 404, 'teams-workspace-not-found');
        return true;
      }
      if (access.role !== 'admin') {
        problem(response, 403, 'teams-forbidden');
        return true;
      }
      if (sub === undefined && method === 'PATCH') {
        const body = (await readJson(request)) as { name?: string; defaultRole?: DefaultRole };
        if (body.name !== undefined) ws.name = body.name.trim();
        if (body.defaultRole !== undefined) ws.defaultRole = body.defaultRole;
        send(response, 200, toWorkspace(ws, effective(ws, email)!));
        return true;
      }
      if (sub === 'access' && subId === undefined && method === 'GET') {
        const team = teams.get(ws.teamId)!;
        const entries = [...team.members].map(([memberEmail, membership]) => {
          const user = userByEmail(memberEmail)!;
          const role = effective(ws, memberEmail);
          const grant = ws.grants.get(memberEmail);
          return {
            userId: user.id,
            email: user.email,
            displayName: user.displayName,
            teamRole: membership.role,
            disabled: false,
            effectiveRole: role?.role ?? 'none',
            ...(role !== undefined ? { source: role.source } : {}),
            ...(grant !== undefined ? { grant } : {}),
          };
        });
        send(response, 200, entries);
        return true;
      }
      if (sub === 'access' && subId !== undefined && (method === 'PUT' || method === 'DELETE')) {
        const targetKey = userById(subId)?.email.toLowerCase();
        if (targetKey === undefined || !teams.get(ws.teamId)!.members.has(targetKey)) {
          problem(response, 404, 'teams-not-a-member');
          return true;
        }
        if (method === 'PUT') ws.grants.set(targetKey, ((await readJson(request)) as { role: WorkspaceRole }).role);
        else ws.grants.delete(targetKey);
        send(response, 204);
        return true;
      }
    }
    return false;
  };

  const userOf = (email: string) => {
    const user = users.get(email.toLowerCase())!;
    return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: user.serverAdmin ?? false };
  };
  const issue = (response: ServerResponse, email: string): void => {
    const token = newToken();
    sessions.set(token, email);
    tokens.push(token);
    send(response, 201, { token, user: userOf(email) });
  };
  const bearer = (request: IncomingMessage): string | undefined =>
    request.headers.authorization?.replace(/^Bearer /, '');

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', url);
      if (request.method === 'GET' && path.pathname === '/api/v1/meta') {
        send(response, 200, {
          name: NAME,
          version: '0.0.0-e2e',
          apiVersion: API_VERSION,
          publicUrl: url,
          auth: { local: true, oidc: options.oidc ?? false },
          capabilities: [],
        });
        return;
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/auth/local/sign-in') {
        const body = (await readJson(request)) as { email: string; password: string };
        const user = users.get(body.email.toLowerCase());
        if (user === undefined || user.password !== body.password)
          return problem(response, 401, 'identity-invalid-credentials');
        return issue(response, user.email);
      }
      if (request.method === 'GET' && path.pathname === '/api/v1/invitations/lookup') {
        const invitation = invitations.get(path.searchParams.get('secret') ?? '');
        if (invitation === undefined) return problem(response, 404, 'identity-invitation-invalid');
        return send(response, 200, { email: invitation.email, methods: { local: true, oidc: false } });
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/invitations/accept') {
        const body = (await readJson(request)) as { secret: string; displayName: string; password: string };
        const invitation = invitations.get(body.secret);
        if (invitation === undefined) return problem(response, 404, 'identity-invitation-invalid');
        invitations.delete(body.secret);
        users.set(invitation.email.toLowerCase(), {
          email: invitation.email,
          password: body.password,
          displayName: body.displayName,
          id: `u-${invitation.email}`,
        });
        if (invitation.team !== undefined) {
          teams.get(invitation.team.teamId)?.members.set(invitation.email.toLowerCase(), {
            role: invitation.team.role,
            addedAt: at(),
          });
        }
        return issue(response, invitation.email);
      }
      const token = bearer(request);
      const email = token === undefined ? undefined : sessions.get(token);
      if (request.method === 'GET' && path.pathname === '/api/v1/me') {
        if (email === undefined) return problem(response, 401, 'identity-unauthenticated');
        return send(response, 200, { user: userOf(email), methods: { local: true, oidc: [] } });
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/auth/sign-out') {
        if (email === undefined || token === undefined) return problem(response, 401, 'identity-unauthenticated');
        sessions.delete(token);
        signOuts.push(token);
        return send(response, 204);
      }
      const segments = path.pathname
        .replace(/^\/api\/v1\//, '')
        .split('/')
        .map(decodeURIComponent);
      if (segments[0] === 'teams' || segments[0] === 'workspaces') {
        if (email === undefined) return problem(response, 401, 'identity-unauthenticated');
        if (await teamsApi(request, response, segments, email)) return;
      }
      problem(response, 404, 'not-found');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    tokens,
    signOuts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A plain web server: what a wrong URL looks like to the Sign in dialog. */
export async function startNotWirebenchServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>hello</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
