import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

export interface FakeServerOptions {
  readonly users?: readonly FakeUser[];
  /** Open invitations, by secret. */
  readonly invitations?: Readonly<Record<string, { readonly email: string }>>;
  readonly oidc?: boolean;
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

/**
 * Enough of Wirebench Server for the desktop's sign-in flow (identity spec §11): meta, local
 * sign-in, invitation lookup and accept, me and sign-out, in memory. The real thing is covered
 * by `packages/server`'s integration suite; this exists so the e2e spec needs no PostgreSQL.
 */
export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const users = new Map(
    (options.users ?? []).map((user) => [user.email.toLowerCase(), { ...user, id: `u-${user.email}` }]),
  );
  const invitations = new Map(Object.entries(options.invitations ?? {}));
  const sessions = new Map<string, string>(); // token → email
  const tokens: string[] = [];
  const signOuts: string[] = [];
  let url = '';

  const userOf = (email: string) => {
    const user = users.get(email.toLowerCase())!;
    return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: false };
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
