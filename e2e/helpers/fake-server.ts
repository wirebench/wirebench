import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  generateId,
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_PATH,
  liveClientMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
} from '@wirebench/engine';
import { startTestWsServer, type TestWsServerOptions } from '@wirebench/engine/test-helpers';

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
  /**
   * What `GET /meta` lists; default `['sync', 'live']`. Without `sync`, the sync routes answer a bare
   * `404`; without `live`, so does the `/live` upgrade.
   */
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

/** An open, authenticated `/live` socket, as {@link FakeServer.liveConnections} lists it. */
export interface FakeLiveConnection {
  /** The device token its `auth` message carried. */
  readonly token: string;
  readonly email: string;
  /** The workspaces it subscribed to with a role, in subscription order. */
  readonly workspaces: readonly string[];
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
  /**
   * Gives `email` a grant on a workspace, as a workspace admin would, and sends `access` to their `/live`
   * sockets on it.
   */
  setRole(workspaceId: string, email: string, role: WorkspaceRole): void;
  /**
   * Sets `email`'s role on the team called `teamName`; `undefined` removes them from it. Sends `access` to
   * their `/live` sockets on the team's workspaces, dropping any subscription left with no role.
   */
  setTeamRole(teamName: string, email: string, role: TeamRole | undefined): void;
  /**
   * Stops accepting `token`, as an admin removing the device would. Its `/live` sockets get
   * `session-ended` and close `4401`, as the real hub does; an app without one learns on its next call.
   */
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
  /** Sends `message` to every open `/live` socket subscribed to `workspaceId`; returns how many. */
  liveSend(workspaceId: string, message: LiveServerMessage): number;
  /**
   * Ends `token`'s `/live` sockets as the hub does on a revocation (`session-ended`, then `4401`), without
   * revoking the token itself; returns how many. {@link revoke} does both.
   */
  liveEndSession(token: string): number;
  /** The open, authenticated `/live` sockets. */
  liveConnections(): FakeLiveConnection[];
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

/** A `/live` socket as the engine's test WebSocket server hands it to `onText`. */
type LivePeer = Parameters<NonNullable<TestWsServerOptions['onText']>>[1];

/** One authenticated `/live` socket: the session it bound to, and the workspaces it subscribed to with a role. */
interface LiveConnection {
  readonly peer: LivePeer;
  readonly token: string;
  readonly email: string;
  readonly subscriptions: Set<string>;
}

/**
 * Hands an upgrade the fake received to the engine's test WebSocket server on `port`, byte for byte: the
 * request head as it arrived, anything already read past it, then both directions piped. The app sees
 * the fake's own origin, as it would the real server's; the frames are the test server's.
 */
function pipeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`];
  for (let i = 0; i + 1 < request.rawHeaders.length; i += 2)
    lines.push(`${request.rawHeaders[i] ?? ''}: ${request.rawHeaders[i + 1] ?? ''}`);
  const upstream = connectTcp(port, '127.0.0.1', () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const drop = (): void => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  upstream.on('close', drop);
  socket.on('close', drop);
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
 * (teams-access spec §11), server sync (server-sync spec §11) and live updates (live-updates spec
 * §11), in memory. The real thing is covered by `packages/server`'s integration suite; this exists so
 * the e2e specs need no PostgreSQL and no git. Ids are ULIDs, as the real server's are, because the
 * desktop refuses anything else for a server share. `/api/v1/live` is the engine's test WebSocket
 * server behind the same origin (live-updates spec §7).
 */
export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const users = new Map(
    (options.users ?? []).map((user) => [user.email.toLowerCase(), { ...user, id: `u-${user.email}` }]),
  );
  const invitations = new Map<string, FakeInvitation>(Object.entries(options.invitations ?? {}));
  const capabilities = [...(options.capabilities ?? ['sync', LIVE_CAPABILITY])];
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

  /*
   * `/api/v1/live` (live-updates spec §3.1), enough for the desktop's `LiveClient`. The socket itself
   * is the engine's test WebSocket server, reached through `pipeUpgrade`; every text frame lands in
   * `onLiveText`. Pushes, role changes and revocations made through this fake announce as the real
   * hub does, without its limits, its auth timer or its heartbeat.
   */
  const liveSockets = new Map<LivePeer, LiveConnection>();
  /** The authenticated sockets still open. A socket that closed on its own leaves presence at the next change. */
  const liveOpen = (): LiveConnection[] => [...liveSockets.values()].filter((connection) => !connection.peer.closed);
  /** Sends `message` to each open connection; returns how many it reached. */
  const liveSendTo = (connections: Iterable<LiveConnection>, message: LiveServerMessage): number => {
    let sent = 0;
    for (const connection of connections) {
      if (connection.peer.closed) continue;
      connection.peer.sendText(JSON.stringify(message));
      sent += 1;
    }
    return sent;
  };
  const subscribersOf = (workspaceId: string): LiveConnection[] =>
    liveOpen().filter((connection) => connection.subscriptions.has(workspaceId));
  /** The distinct users subscribed to a workspace, sorted by name then id, recipient included (§3.1). */
  const presenceOf = (workspaceId: string): { id: string; name: string }[] => {
    const names = new Map<string, string>();
    for (const connection of subscribersOf(workspaceId)) {
      const user = userByEmail(connection.email);
      if (user !== undefined) names.set(user.id, user.displayName);
    }
    return [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };
  /** Runs `change`; when it changed the workspace's user list, every subscriber gets the new one (§3.1). */
  const changePresence = (workspaceId: string, change: () => void): void => {
    const before = JSON.stringify(presenceOf(workspaceId));
    change();
    const users = presenceOf(workspaceId);
    if (JSON.stringify(users) !== before)
      liveSendTo(subscribersOf(workspaceId), { type: 'presence', workspaceId, users });
  };
  /** `head` to every subscriber except the pushing session's sockets (§3.1). */
  const announceHead = (workspaceId: string, head: string, pusher: string | undefined): void => {
    const others = subscribersOf(workspaceId).filter((connection) => connection.token !== pusher);
    liveSendTo(others, { type: 'head', workspaceId, head });
  };
  /**
   * `access` to each of `email`'s subscriptions on a workspace `affects` picks. Unlike the real hub it
   * sends without comparing roles first: the app's only reaction is a fetch. A subscription left with no
   * role is dropped after the message, and the others' presence updates (§3.3).
   */
  const announceAccess = (email: string, affects: (ws: WorkspaceRow) => boolean): void => {
    for (const connection of liveOpen()) {
      if (connection.email.toLowerCase() !== email.toLowerCase()) continue;
      for (const workspaceId of [...connection.subscriptions]) {
        const ws = workspaces.get(workspaceId);
        if (ws !== undefined && !affects(ws)) continue;
        liveSendTo([connection], { type: 'access', workspaceId });
        if (ws === undefined || effective(ws, connection.email) === undefined)
          changePresence(workspaceId, () => connection.subscriptions.delete(workspaceId));
      }
    }
  };
  /** `session-ended`, then `4401`, to every socket of `token`; the others' presence updates. Returns how many. */
  const endSession = (token: string): number => {
    const ended = liveOpen().filter((connection) => connection.token === token);
    for (const connection of ended) {
      liveSendTo([connection], { type: 'session-ended' });
      for (const workspaceId of [...connection.subscriptions])
        changePresence(workspaceId, () => connection.subscriptions.delete(workspaceId));
      liveSockets.delete(connection.peer);
      connection.peer.close(LIVE_CLOSE.unauthenticated, 'session ended');
    }
    return ended.length;
  };
  /** One text frame from a `/live` socket. Anything unparseable, or anything before `auth`, closes `4400`. */
  const onLiveText = (text: string, peer: LivePeer): void => {
    let message: LiveClientMessage;
    try {
      message = liveClientMessageSchema.parse(JSON.parse(text));
    } catch {
      peer.close(LIVE_CLOSE.badMessage, 'bad message');
      return;
    }
    const connection = liveSockets.get(peer);
    if (connection === undefined) {
      if (message.type !== 'auth') {
        peer.close(LIVE_CLOSE.badMessage, 'auth first');
        return;
      }
      const email = sessions.get(message.token);
      if (email === undefined) {
        peer.close(LIVE_CLOSE.unauthenticated, 'unauthenticated');
        return;
      }
      const created: LiveConnection = { peer, token: message.token, email, subscriptions: new Set() };
      liveSockets.set(peer, created);
      liveSendTo([created], { type: 'ready' });
      return;
    }
    switch (message.type) {
      case 'auth':
        // The token binds once, in the first message (§3.1).
        peer.close(LIVE_CLOSE.badMessage, 'already authenticated');
        return;
      case 'ping':
        liveSendTo([connection], { type: 'pong' });
        return;
      case 'subscribe': {
        const ws = workspaces.get(message.workspaceId);
        if (ws === undefined || effective(ws, connection.email) === undefined) {
          liveSendTo([connection], {
            type: 'refused',
            workspaceId: message.workspaceId,
            code: 'teams-workspace-not-found',
          });
          return;
        }
        if (connection.subscriptions.has(ws.id)) return;
        const before = JSON.stringify(presenceOf(ws.id));
        connection.subscriptions.add(ws.id);
        const users = presenceOf(ws.id);
        // The new subscriber always hears who is here; the others only when the user list changed.
        const recipients = JSON.stringify(users) === before ? [connection] : subscribersOf(ws.id);
        liveSendTo(recipients, { type: 'presence', workspaceId: ws.id, users });
        return;
      }
      case 'unsubscribe':
        changePresence(message.workspaceId, () => connection.subscriptions.delete(message.workspaceId));
        return;
    }
  };

  /**
   * The five sync routes (server-sync spec §3.2) over an in-memory history, behind the same access
   * rule as the real guard: reads need a role, a push needs editor. Paths are not validated; the
   * real server's checks are covered by its integration suite. A push announces `head` to every
   * `/live` subscriber but `pusher`'s sockets, as the real hub does (live-updates §3.1).
   */
  const syncApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    ws: WorkspaceRow,
    role: WorkspaceRole,
    route: string | undefined,
    query: URLSearchParams,
    email: string,
    pusher: string | undefined,
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
      const head = headOf(ws)!.id;
      // After the history moved and before the 201, where the real route announces (§3.2).
      announceHead(ws.id, head, pusher);
      send(response, 201, { head, ids });
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

  const wsServer = await startTestWsServer({ onText: onLiveText });
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
          return await syncApi(request, response, ws, access.role, segments[3], path.searchParams, email, token);
        }
        if (await teamsApi(request, response, segments, email)) return;
      }
      problem(response, 404, 'not-found');
    })();
  });
  const upgraded = new Set<Duplex>();
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', url).pathname;
    // Logged before anything else, so a spec can prove the app never tried (live-updates §11).
    requests.push({ method: request.method ?? 'GET', path });
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.on('error', () => socket.destroy());
    // A server without live has no socket: a plain 404, which the client reads as "off" (§3.4).
    if (path !== LIVE_PATH || !capabilities.includes(LIVE_CAPABILITY)) {
      socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      return;
    }
    pipeUpgrade(request, socket, head, wsServer.port);
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
      announceAccess(email, (ws) => ws.id === workspaceId);
    },
    setTeamRole: (teamName, email, role) => {
      const team = [...teams.values()].find((candidate) => candidate.name === teamName);
      if (team === undefined) throw new Error(`the fake server has no team named ${teamName}`);
      if (role === undefined) team.members.delete(email.toLowerCase());
      else team.members.set(email.toLowerCase(), { role, addedAt: at() });
      announceAccess(email, (ws) => ws.teamId === team.id);
    },
    revoke: (token) => {
      sessions.delete(token);
      endSession(token);
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
    liveSend: (workspaceId, message) => liveSendTo(subscribersOf(workspaceId), message),
    liveEndSession: (token) => endSession(token),
    liveConnections: () =>
      liveOpen().map((connection) => ({
        token: connection.token,
        email: connection.email,
        workspaces: [...connection.subscriptions],
      })),
    close: async () => {
      // Upgraded sockets are no longer the HTTP server's to drain, so they would hold its close open.
      for (const socket of upgraded) socket.destroy();
      await wsServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
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
