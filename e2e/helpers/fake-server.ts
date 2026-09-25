import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateId } from '@wirebench/engine';

type TeamRole = 'member' | 'admin';
type WorkspaceRole = 'viewer' | 'editor' | 'admin';
type DefaultRole = 'none' | 'viewer' | 'editor';
type RoleSource = 'server-admin' | 'team-admin' | 'grant' | 'default';

export interface FakeUser {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly serverAdmin?: boolean;
}

/** A team seeded at start: its name, its members' roles by email, and any empty server workspaces. */
export interface FakeTeam {
  readonly name: string;
  readonly members: Readonly<Record<string, TeamRole>>;
  /** Server workspaces with no commits yet, as the Team dialog's *New workspace…* leaves them. */
  readonly workspaces?: readonly { readonly name: string; readonly defaultRole?: DefaultRole }[];
}

export interface FakeServerOptions {
  readonly users?: readonly FakeUser[];
  /** Open invitations, by secret. */
  readonly invitations?: Readonly<Record<string, { readonly email: string }>>;
  readonly oidc?: boolean;
  readonly teams?: readonly FakeTeam[];
  /** What `GET /meta` lists; default `['sync']`. Without `sync`, the sync routes answer a bare `404`. */
  readonly capabilities?: readonly string[];
}

/** One request the fake answered, for specs that assert what the app sent (or did not). */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  /** The bearer token it carried, if any. */
  readonly token?: string;
}

/** A file in a server workspace's tree, as the sync routes carry it (spec §3.2). */
export interface FakeSyncFile {
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}

export interface FakeServer {
  readonly url: string;
  /** Tokens issued so far, in order. */
  readonly tokens: string[];
  /** Tokens the app signed out. */
  readonly signOuts: string[];
  /** Every request, in order. */
  readonly requests: readonly FakeRequest[];
  /** The id of the server workspace called `name`. @throws when there is none. */
  workspaceId(name: string): string;
  /** Gives `email` a grant on a workspace, as a workspace admin would. */
  setRole(workspaceId: string, email: string, role: WorkspaceRole): void;
  /** Sets `email`'s role on the team called `teamName`; `undefined` removes them from it. */
  setTeamRole(teamName: string, email: string, role: TeamRole | undefined): void;
  /** Stops accepting `token`, as an admin removing the device would; the app is not told. */
  revoke(token: string): void;
  /** The newest token issued to `email`. @throws when there is none. */
  lastToken(email: string): string;
  /**
   * Commits onto the workspace's head as `email`, as another member's push would. `edit` maps each
   * UTF-8 file's content; the files it changes make the commit. Returns the new commit id.
   * @throws when the workspace has no head or `edit` changed nothing.
   */
  commitAs(
    workspaceId: string,
    email: string,
    subject: string,
    edit: (path: string, content: string) => string,
  ): string;
  /** The files at the workspace's head; empty before its first commit. */
  headFiles(workspaceId: string): ReadonlyMap<string, FakeSyncFile>;
  /** Whether any UTF-8 file at the workspace's head contains `needle`. */
  headContains(workspaceId: string, needle: string): boolean;
  /** Every commit subject on the workspace, newest first. */
  subjects(workspaceId: string): string[];
  close(): Promise<void>;
}

const NAME = 'wirebench-server';
const API_VERSION = 1;
/** `GET /sync/log`'s page when the client names no limit, and its bounds (spec §3.2). */
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

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

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly members: Map<string, { role: TeamRole; readonly addedAt: string }>;
}

/** One commit of a server workspace: the whole tree after it, which keeps diffs trivial. */
interface FakeCommit {
  readonly id: string;
  readonly subject: string;
  /** `name <email>`, as the real log formats it. */
  readonly author: string;
  readonly at: string;
  readonly files: ReadonlyMap<string, FakeSyncFile>;
}

interface WorkspaceRow {
  readonly id: string;
  name: string;
  readonly teamId: string;
  defaultRole: DefaultRole;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly grants: Map<string, WorkspaceRole>;
  /** Oldest first; the last one is the head. */
  readonly history: FakeCommit[];
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

/** A path's change between two trees; `content: null` deletes it (spec §3.2). */
interface FakeSyncChange {
  readonly path: string;
  readonly encoding: FakeSyncFile['encoding'];
  readonly content: string | null;
}

interface FakePushBody {
  readonly parent: string | null;
  readonly commits: readonly {
    readonly subject: string;
    readonly at: string;
    readonly changes: readonly FakeSyncChange[];
  }[];
}

const at = (): string => new Date().toISOString();
const EMPTY_TREE: ReadonlyMap<string, FakeSyncFile> = new Map();

/** `base` with `changes` applied. */
function applyChanges(
  base: ReadonlyMap<string, FakeSyncFile>,
  changes: readonly FakeSyncChange[],
): Map<string, FakeSyncFile> {
  const next = new Map(base);
  for (const change of changes) {
    if (change.content === null) next.delete(change.path);
    else next.set(change.path, { encoding: change.encoding, content: change.content });
  }
  return next;
}

/** Every path that differs from `from` to `to`, sorted; a path only in `from` is a deletion. */
function diffTrees(from: ReadonlyMap<string, FakeSyncFile>, to: ReadonlyMap<string, FakeSyncFile>): FakeSyncChange[] {
  const changes: FakeSyncChange[] = [];
  for (const [path, file] of to) {
    const before = from.get(path);
    if (before === undefined || before.encoding !== file.encoding || before.content !== file.content)
      changes.push({ path, encoding: file.encoding, content: file.content });
  }
  for (const [path, file] of from) {
    if (!to.has(path)) changes.push({ path, encoding: file.encoding, content: null });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Enough of Wirebench Server for the desktop's sign-in flow (identity spec §11), its teams dialog
 * (teams-access spec §11) and server sync (server-sync spec §11), in memory. The real thing is
 * covered by `packages/server`'s integration suite; this exists so the e2e specs need no PostgreSQL
 * and no git. Ids are ULIDs, as the real server's are, because the desktop refuses anything else for
 * a server share.
 */
export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const users = new Map(
    (options.users ?? []).map((user) => [user.email.toLowerCase(), { ...user, id: `u-${user.email}` }]),
  );
  const invitations = new Map<string, FakeInvitation>(Object.entries(options.invitations ?? {}));
  const capabilities = [...(options.capabilities ?? ['sync'])];
  const sessions = new Map<string, string>(); // token → email
  const issued: { readonly token: string; readonly email: string }[] = [];
  const tokens: string[] = [];
  const signOuts: string[] = [];
  const requests: FakeRequest[] = [];
  let url = '';

  let seq = 1;
  const id = (prefix: string): string => `${prefix}${String(seq++)}`;
  /** Stand-in commit ids in the shape the client checks (`SYNC_COMMIT_ID_PATTERN`). */
  const commitId = (parts: readonly string[]): string =>
    createHash('sha1')
      .update(`${parts.join('\n')}\n${String(seq++)}`)
      .digest('hex');
  const teams = new Map<string, TeamRow>();
  const workspaces = new Map<string, WorkspaceRow>();
  const addWorkspace = (teamId: string, name: string, defaultRole: DefaultRole, workspaceId?: string): WorkspaceRow => {
    const ws: WorkspaceRow = {
      id: workspaceId ?? generateId(),
      name,
      teamId,
      defaultRole,
      createdAt: at(),
      grants: new Map(),
      history: [],
    };
    workspaces.set(ws.id, ws);
    return ws;
  };
  for (const seed of options.teams ?? []) {
    const team: TeamRow = { id: generateId(), name: seed.name, createdAt: at(), members: new Map() };
    for (const [email, role] of Object.entries(seed.members))
      team.members.set(email.toLowerCase(), { role, addedAt: at() });
    teams.set(team.id, team);
    for (const workspace of seed.workspaces ?? [])
      addWorkspace(team.id, workspace.name, workspace.defaultRole ?? 'viewer');
  }
  const userByEmail = (email: string) => users.get(email.toLowerCase());
  const userById = (userId: string) => [...users.values()].find((user) => user.id === userId);
  const authorOf = (email: string): string => {
    const user = userByEmail(email);
    return user === undefined ? email : `${user.displayName} <${user.email}>`;
  };

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

  const headOf = (ws: WorkspaceRow): FakeCommit | undefined => ws.history.at(-1);
  const commitOf = (ws: WorkspaceRow, commit: string): FakeCommit | undefined =>
    ws.history.find((candidate) => candidate.id === commit);
  const append = (
    ws: WorkspaceRow,
    author: string,
    subject: string,
    when: string,
    files: ReadonlyMap<string, FakeSyncFile>,
  ): FakeCommit => {
    const commit: FakeCommit = {
      id: commitId([ws.id, headOf(ws)?.id ?? '', subject, when]),
      subject,
      author,
      at: when,
      files,
    };
    ws.history.push(commit);
    return commit;
  };
  const workspaceOf = (workspaceId: string): WorkspaceRow => {
    const ws = workspaces.get(workspaceId);
    if (ws === undefined) throw new Error(`the fake server has no workspace ${workspaceId}`);
    return ws;
  };

  /**
   * The five sync routes (server-sync spec §3.2) over an in-memory history, behind the same access
   * rule as the real guard: reads need a role, a push needs editor. Paths are not validated; the
   * real server's checks are covered by its integration suite.
   */
  const syncApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    ws: WorkspaceRow,
    role: WorkspaceRole,
    route: string | undefined,
    query: URLSearchParams,
    email: string,
  ): Promise<void> => {
    const method = request.method ?? 'GET';
    if (method === 'GET' && route === 'head') {
      const from = query.get('from');
      // A base this server does not know counts the whole history as behind (§3.2).
      const known = from === null ? -1 : ws.history.findIndex((commit) => commit.id === from);
      const behind = known === -1 ? ws.history.length : ws.history.length - known - 1;
      send(response, 200, {
        head: headOf(ws)?.id ?? null,
        commits: ws.history.length,
        ...(from !== null ? { behind } : {}),
        role,
      });
      return;
    }
    if (method === 'GET' && route === 'snapshot') {
      const atCommit = query.get('at');
      const commit = atCommit === null ? headOf(ws) : commitOf(ws, atCommit);
      if (atCommit !== null && commit === undefined) return problem(response, 404, 'sync-unknown-commit');
      const files = [...(commit?.files ?? EMPTY_TREE)]
        .map(([path, file]) => ({ path, encoding: file.encoding, content: file.content }))
        .sort((a, b) => a.path.localeCompare(b.path));
      send(response, 200, { head: commit?.id ?? null, files });
      return;
    }
    if (method === 'GET' && route === 'changes') {
      const from = query.get('from');
      const to = query.get('to');
      const toCommit = to === null ? undefined : commitOf(ws, to);
      const fromCommit = from === null ? undefined : commitOf(ws, from);
      if (toCommit === undefined || (from !== null && fromCommit === undefined))
        return problem(response, 404, 'sync-unknown-commit');
      if (fromCommit !== undefined && ws.history.indexOf(fromCommit) > ws.history.indexOf(toCommit))
        return problem(response, 400, 'sync-not-ancestor');
      send(response, 200, {
        from: fromCommit?.id ?? null,
        to: toCommit.id,
        files: diffTrees(fromCommit?.files ?? EMPTY_TREE, toCommit.files),
      });
      return;
    }
    if (method === 'POST' && route === 'commits') {
      if (role === 'viewer') return problem(response, 403, 'teams-forbidden');
      const body = (await readJson(request)) as FakePushBody;
      if (body.commits.length === 0) return problem(response, 400, 'invalid-request');
      if (body.parent !== (headOf(ws)?.id ?? null)) return problem(response, 409, 'sync-push-rejected');
      const ids = body.commits.map(
        (commit) =>
          append(
            ws,
            authorOf(email),
            commit.subject,
            commit.at,
            applyChanges(headOf(ws)?.files ?? EMPTY_TREE, commit.changes),
          ).id,
      );
      send(response, 201, { head: headOf(ws)!.id, ids });
      return;
    }
    if (method === 'GET' && route === 'log') {
      const raw = query.get('limit');
      const limit = raw === null ? DEFAULT_LOG_LIMIT : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT)
        return problem(response, 400, 'invalid-request');
      send(
        response,
        200,
        ws.history
          .slice(-limit)
          .reverse()
          .map((commit) => ({ id: commit.id, subject: commit.subject, author: commit.author, at: commit.at })),
      );
      return;
    }
    problem(response, 404, 'not-found');
  };

  /**
   * Enough of the teams API for `team.spec.ts` and `server-sync.spec.ts` (teams-access §3.2); the
   * real routes are covered by `packages/server`'s integration suite. Answers `true` once it has
   * responded.
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
        const team: TeamRow = { id: generateId(), name: body.name.trim(), createdAt: at(), members: new Map() };
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
        const body = (await readJson(request)) as { id?: string; name: string; defaultRole?: DefaultRole };
        const name = body.name.trim();
        // The id first: sharing the same workspace again finds its own row, name included (O2).
        if (body.id !== undefined && workspaces.has(body.id)) {
          problem(response, 409, 'teams-workspace-exists');
          return true;
        }
        const taken = [...workspaces.values()].some(
          (ws) => ws.teamId === team.id && ws.name.toLowerCase() === name.toLowerCase(),
        );
        if (taken) {
          problem(response, 409, 'teams-workspace-name-taken');
          return true;
        }
        const ws = addWorkspace(team.id, name, body.defaultRole ?? 'viewer', body.id);
        if (team.members.has(key)) ws.grants.set(key, 'admin');
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
    issued.push({ token, email });
    send(response, 201, { token, user: userOf(email) });
  };
  const bearer = (request: IncomingMessage): string | undefined =>
    request.headers.authorization?.replace(/^Bearer /, '');

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', url);
      const token = bearer(request);
      requests.push({
        method: request.method ?? 'GET',
        path: path.pathname,
        ...(token !== undefined ? { token } : {}),
      });
      if (request.method === 'GET' && path.pathname === '/api/v1/meta') {
        send(response, 200, {
          name: NAME,
          version: '0.0.0-e2e',
          apiVersion: API_VERSION,
          publicUrl: url,
          auth: { local: true, oidc: options.oidc ?? false },
          capabilities,
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
        if (segments[0] === 'workspaces' && segments[2] === 'sync') {
          // An older server has no such routes: a bare 404, which the client never gets to see
          // because it checks the capability first (R12).
          if (!capabilities.includes('sync')) return problem(response, 404, 'not-found');
          const ws = workspaces.get(segments[1] ?? '');
          const access = ws === undefined ? undefined : effective(ws, email);
          if (ws === undefined || access === undefined) return problem(response, 404, 'teams-workspace-not-found');
          return await syncApi(request, response, ws, access.role, segments[3], path.searchParams, email);
        }
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
    requests,
    workspaceId: (name) => {
      const found = [...workspaces.values()].find((ws) => ws.name === name);
      if (found === undefined) throw new Error(`the fake server has no workspace named ${name}`);
      return found.id;
    },
    setRole: (workspaceId, email, role) => {
      workspaceOf(workspaceId).grants.set(email.toLowerCase(), role);
    },
    setTeamRole: (teamName, email, role) => {
      const team = [...teams.values()].find((candidate) => candidate.name === teamName);
      if (team === undefined) throw new Error(`the fake server has no team named ${teamName}`);
      if (role === undefined) team.members.delete(email.toLowerCase());
      else team.members.set(email.toLowerCase(), { role, addedAt: at() });
    },
    revoke: (token) => {
      sessions.delete(token);
    },
    lastToken: (email) => {
      const found = issued.filter((entry) => entry.email.toLowerCase() === email.toLowerCase()).at(-1);
      if (found === undefined) throw new Error(`the fake server issued no token to ${email}`);
      return found.token;
    },
    commitAs: (workspaceId, email, subject, edit) => {
      const ws = workspaceOf(workspaceId);
      const head = headOf(ws);
      if (head === undefined) throw new Error(`workspace ${workspaceId} has no commits to build on`);
      const files = new Map(
        [...head.files].map(([path, file]): [string, FakeSyncFile] =>
          file.encoding === 'utf8' ? [path, { encoding: 'utf8', content: edit(path, file.content) }] : [path, file],
        ),
      );
      if (diffTrees(head.files, files).length === 0) throw new Error(`commitAs("${subject}") changed nothing`);
      return append(ws, authorOf(email), subject, at(), files).id;
    },
    headFiles: (workspaceId) => headOf(workspaceOf(workspaceId))?.files ?? EMPTY_TREE,
    headContains: (workspaceId, needle) =>
      [...(headOf(workspaceOf(workspaceId))?.files ?? EMPTY_TREE).values()].some(
        (file) => file.encoding === 'utf8' && file.content.includes(needle),
      ),
    subjects: (workspaceId) =>
      workspaceOf(workspaceId)
        .history.map((commit) => commit.subject)
        .reverse(),
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
