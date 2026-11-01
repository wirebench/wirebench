/**
 * One request template and one class for every route the server registers (tenancy Task 19, spec §19.13). A template
 * is built twice: as A's admin on A's host, where it must answer 2xx (the positive control), and as B's admin on B's
 * host with A's ids, where it must answer as its class says:
 * - **refused**: one of `statuses` (404 by default), or a 2xx empty list;
 * - **own**: 2xx, B's own data;
 * - **federated**: 404 in hosted mode on both hosts (spec §19.1), so no control applies;
 * - **socket**: a WebSocket route, which the socket sweep covers.
 * No body B gets may hold any of A's ids or anything named for A. A route missing here fails the suite.
 *
 * `from` is the sender's fill; ids are always A's (`a`), and a template that uses a row up makes a fresh one.
 */
import { agentRedeemMessage, agentRequestMessage, LIVE_PATH, TERMINAL_SHARE_PATH } from '@wirebench/engine';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { mintSecret, newId, pkceChallenge } from '../../../src/identity/tokens.js';
import { license } from '../../helpers/licensing.js';
import {
  bearer,
  cookie,
  firstCommitFiles,
  fresh,
  LICENSE_KEYS,
  PASSWORD,
  sha256,
  type Filled,
  type World,
} from './fill.js';

export type RouteClass = 'refused' | 'own' | 'federated' | 'socket';

export interface Ctx {
  readonly w: World;
  /** The route's URL as registered (`/assets/<file>` for a static file). */
  readonly url: string;
  /** The sender's fill: its admin sends, on its host. */
  readonly from: Filled;
  /** A's fill: the ids every template names. */
  readonly a: Filled;
}

export interface RouteCase {
  readonly cls: RouteClass;
  /** The request, without `Host`; `undefined` for a socket. */
  readonly request?: (ctx: Ctx) => Promise<InjectOptions> | InjectOptions;
  /** What a refusal may answer instead of 404. */
  readonly statuses?: readonly number[];
  /** A refusal this route answers its own way (a form posted back): true when `res` refused. */
  readonly refused?: (res: LightMyRequestResponse) => boolean;
  /**
   * B's answer may hold what B itself was sent (its audit log records the A emails typed into its sign-in): the leak
   * check strips every string the sweep sent to B before it looks for A's name and ids.
   */
  readonly stripsSent?: boolean;
  /** Runs after each send, as the sender: puts back what the request took away. */
  readonly after?: (ctx: Ctx) => Promise<void>;
}

const VERIFIER = 'v'.repeat(43);
const keys = LICENSE_KEYS;
const SENT = {
  action: 'desktop.request_sent',
  details: {
    protocol: 'rest',
    method: 'GET',
    url: 'https://api.example.com/orders',
    status: 200,
    outcome: 'ok',
    durationMs: 42,
    environment: 'staging',
    requestId: 'req-1',
    requestName: 'List orders',
    sentAt: '2026-09-24T11:59:00.000Z',
  },
};

const api = (path: string) => `/api/v1${path}`;
const ws = (ctx: Ctx, rest = '') => api(`/workspaces/${ctx.a.workspaceId}${rest}`);
/** The sender's admin, by bearer token. */
const asAdmin = (ctx: Ctx) => bearer(ctx.from.admin);
/** The sender's browser session. */
const asTab = (ctx: Ctx) => cookie(ctx.from.tenant, ctx.from.browser);
const json = (
  ctx: Ctx,
  method: NonNullable<InjectOptions['method']>,
  url: string,
  payload?: object,
  headers: Record<string, string> = asAdmin(ctx),
): InjectOptions => ({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

/** A's head, read as A. */
async function headOf(ctx: Ctx): Promise<string | null> {
  const res = await ctx.a.tenant.call<{ head: string | null }>(
    ctx.a.admin,
    'GET',
    `/workspaces/${ctx.a.workspaceId}/sync/head`,
  );
  return res.body.head;
}

/** An agent-signed request of `pairingId`, by `key`, on the tenant `ctx.from` is (the path is the server's). */
function signedAgent(
  ctx: Ctx,
  method: 'DELETE' | 'PATCH',
  pairingId: string,
  key: { sign(message: string): string },
  body?: string,
): InjectOptions {
  const url = api(`/agent/pairings/${pairingId}`);
  const timestamp = ctx.w.t.h.clock.now.toISOString();
  return {
    method,
    url,
    headers: {
      'x-wirebench-agent-pairing': pairingId,
      'x-wirebench-agent-timestamp': timestamp,
      'x-wirebench-agent-signature': key.sign(
        agentRequestMessage(method, url, pairingId, timestamp, sha256(body ?? '')),
      ),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: body } : {}),
  };
}

/**
 * The socket routes, each with its case in the isolation suite's socket sweep. A socket route not named here fails the
 * map check (Task 19 review M1).
 */
export const SOCKET_ROUTES = {
  live: `GET ${LIVE_PATH}`,
  host: 'GET /api/v1/host',
  terminalShares: `GET ${TERMINAL_SHARE_PATH}`,
} as const;

/** Keys are `${method} ${url}` as `onRoute` reports them; a route on every method is `ALL`. */
export const ROUTE_MAP: Readonly<Record<string, RouteCase>> = {
  // ---- the host and meta
  'GET /healthz': { cls: 'own', request: () => ({ method: 'GET', url: '/healthz' }) },
  'GET /api/v1/meta': { cls: 'own', request: () => ({ method: 'GET', url: api('/meta') }) },
  'GET /': { cls: 'own', request: (ctx) => ({ method: 'GET', url: '/', headers: asTab(ctx) }) },
  'GET /*': { cls: 'own', request: (ctx) => ({ method: 'GET', url: '/workspaces', headers: asTab(ctx) }) },
  // The browser build's files, one route each (`routeKey` folds them into one key).
  'GET /assets/*': { cls: 'own', request: (ctx) => ({ method: 'GET', url: ctx.url }) },

  // ---- identity: the caller's own
  'GET /api/v1/me': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/me')) },
  'GET /api/v1/me/devices': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/me/devices')) },
  'DELETE /api/v1/me/devices/:id': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/me/devices/${await fresh.token(ctx.a, ctx.a.admin)}`)),
  },
  'POST /api/v1/me/password': {
    cls: 'own',
    // A user of the sender's of their own: a change of password ends their other sessions.
    request: async (ctx) => {
      const user = await fresh.user(ctx.from.tenant);
      return json(
        ctx,
        'POST',
        api('/me/password'),
        { currentPassword: PASSWORD, newPassword: `${PASSWORD} 2` },
        bearer(user),
      );
    },
    statuses: [],
  },
  'POST /api/v1/auth/local/sign-in': {
    cls: 'refused',
    statuses: [401],
    request: (ctx) =>
      json(
        ctx,
        'POST',
        api('/auth/local/sign-in'),
        {
          email: ctx.a.admin.user.email,
          password: PASSWORD,
          device: { name: 'probe' },
        },
        {},
      ),
  },
  'POST /api/v1/auth/sign-out': {
    cls: 'own',
    request: async (ctx) =>
      json(ctx, 'POST', api('/auth/sign-out'), undefined, bearer(await fresh.user(ctx.from.tenant))),
  },
  'POST /api/v1/auth/oidc/start': {
    cls: 'federated',
    request: () => ({
      method: 'POST',
      url: api('/auth/oidc/start'),
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: 49152 },
    }),
  },
  'POST /api/v1/auth/oidc/complete': {
    cls: 'federated',
    request: () => ({
      method: 'POST',
      url: api('/auth/oidc/complete'),
      payload: { flowId: newId(), grant: mintSecret().secret, codeVerifier: VERIFIER },
    }),
  },
  'GET /api/v1/auth/oidc/callback': {
    cls: 'federated',
    request: () => ({ method: 'GET', url: api('/auth/oidc/callback?state=s&code=c') }),
  },
  'GET /api/v1/auth/oidc/browser-callback': {
    cls: 'federated',
    request: () => ({ method: 'GET', url: api('/auth/oidc/browser-callback?state=s&code=c') }),
  },
  'GET /sign-in/oidc': { cls: 'federated', request: () => ({ method: 'GET', url: '/sign-in/oidc' }) },
  'GET /sign-in': { cls: 'own', request: () => ({ method: 'GET', url: '/sign-in' }) },
  'POST /sign-in/local': {
    cls: 'refused',
    // The form answers a refusal with the page again or a redirect; a sign-in sets the session cookie.
    refused: (res) => !String(res.headers['set-cookie'] ?? '').includes('wb_session='),
    request: (ctx) => ({
      method: 'POST',
      url: '/sign-in/local',
      headers: { origin: ctx.from.tenant.origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: ctx.a.admin.user.email, password: PASSWORD }).toString(),
    }),
  },
  'POST /sign-out': {
    cls: 'own',
    request: async (ctx) => ({
      method: 'POST',
      url: '/sign-out',
      headers: {
        ...cookie(ctx.from.tenant, await fresh.user(ctx.from.tenant, 'browser')),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
    }),
  },

  // ---- invitations and users
  'GET /api/v1/invitations': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/invitations')) },
  'POST /api/v1/invitations': {
    cls: 'own',
    request: (ctx) =>
      json(ctx, 'POST', api('/invitations'), { email: `p-${newId().toLowerCase()}@${ctx.from.tenant.slug}.example` }),
  },
  'DELETE /api/v1/invitations/:id': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/invitations/${(await fresh.invitation(ctx.a)).id}`)),
  },
  'GET /api/v1/invitations/lookup': {
    cls: 'refused',
    request: (ctx) => ({ method: 'GET', url: api(`/invitations/lookup?secret=${ctx.a.inviteSecret}`) }),
  },
  'POST /api/v1/invitations/accept': {
    cls: 'refused',
    request: async (ctx) => ({
      method: 'POST',
      url: api('/invitations/accept'),
      payload: {
        secret: (await fresh.invitation(ctx.a)).secret,
        displayName: 'Probe',
        password: PASSWORD,
        device: { name: 'probe' },
      },
    }),
  },
  'GET /invite/:secret': {
    cls: 'refused',
    // The page answers an unknown secret with its closed variant, at 200 (Task 19 review M5).
    refused: (res) => res.statusCode === 200 && res.body.includes('This invitation has expired or was already used.'),
    request: (ctx) => ({ method: 'GET', url: `/invite/${ctx.a.inviteSecret}` }),
  },
  'GET /api/v1/users': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/users')) },
  'PATCH /api/v1/users/:id': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'PATCH', api(`/users/${ctx.a.member.user.id}`), { disabled: false }),
  },
  'POST /api/v1/users/:id/password-reset': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', api(`/users/${ctx.a.member.user.id}/password-reset`)),
  },

  // ---- licensing
  'GET /api/v1/license': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/license')) },
  'PUT /api/v1/license': {
    cls: 'own',
    request: (ctx) =>
      json(ctx, 'PUT', api('/license'), { license: license(keys, { id: newId(), edition: 'enterprise', seats: 500 }) }),
  },
  'DELETE /api/v1/license': {
    cls: 'own',
    request: (ctx) => json(ctx, 'DELETE', api('/license')),
    // The other routes need the license back.
    after: async (ctx) => {
      const res = await ctx.from.tenant.call(ctx.from.admin, 'PUT', '/license', {
        license: license(keys, { id: newId(), edition: 'enterprise', seats: 500 }),
      });
      if (res.status !== 200) throw new Error(`license reinstall answered ${res.status}`);
    },
  },

  // ---- teams
  'GET /api/v1/teams': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/teams')) },
  'POST /api/v1/teams': {
    cls: 'own',
    request: (ctx) => json(ctx, 'POST', api('/teams'), { name: `${ctx.from.tenant.slug} p-${newId()}` }),
  },
  'PATCH /api/v1/teams/:teamId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'PATCH', api(`/teams/${ctx.a.teamId}`), { name: `acme payments ${newId()}` }),
  },
  'DELETE /api/v1/teams/:teamId': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/teams/${await fresh.team(ctx.a)}`)),
  },
  'GET /api/v1/teams/:teamId/members': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', api(`/teams/${ctx.a.teamId}/members`)),
  },
  'POST /api/v1/teams/:teamId/members': {
    cls: 'refused',
    request: async (ctx) =>
      json(ctx, 'POST', api(`/teams/${ctx.a.teamId}/members`), {
        email: (await fresh.user(ctx.a.tenant, undefined, ctx.a.ids)).user.email,
        role: 'member',
      }),
  },
  'PATCH /api/v1/teams/:teamId/members/:userId': {
    cls: 'refused',
    request: (ctx) =>
      json(ctx, 'PATCH', api(`/teams/${ctx.a.teamId}/members/${ctx.a.member.user.id}`), { role: 'member' }),
  },
  'DELETE /api/v1/teams/:teamId/members/:userId': {
    cls: 'refused',
    request: async (ctx) =>
      json(ctx, 'DELETE', api(`/teams/${ctx.a.teamId}/members/${(await fresh.member(ctx.a)).user.id}`)),
  },
  'GET /api/v1/teams/:teamId/invitations': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', api(`/teams/${ctx.a.teamId}/invitations`)),
  },
  'POST /api/v1/teams/:teamId/invitations': {
    cls: 'refused',
    request: (ctx) =>
      json(ctx, 'POST', api(`/teams/${ctx.a.teamId}/invitations`), {
        email: `q-${newId().toLowerCase()}@acme.example`,
        role: 'member',
      }),
  },
  'DELETE /api/v1/teams/:teamId/invitations/:id': {
    cls: 'refused',
    request: async (ctx) =>
      json(ctx, 'DELETE', api(`/teams/${ctx.a.teamId}/invitations/${await fresh.teamInvitation(ctx.a)}`)),
  },

  // ---- workspaces and access
  'GET /api/v1/workspaces': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/workspaces')) },
  'POST /api/v1/teams/:teamId/workspaces': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', api(`/teams/${ctx.a.teamId}/workspaces`), { name: `acme w-${newId()}` }),
  },
  'GET /api/v1/workspaces/:workspaceId': { cls: 'refused', request: (ctx) => json(ctx, 'GET', ws(ctx)) },
  'PATCH /api/v1/workspaces/:workspaceId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'PATCH', ws(ctx), { recordDesktopActivity: true }),
  },
  'DELETE /api/v1/workspaces/:workspaceId': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/workspaces/${await fresh.workspace(ctx.a)}`)),
  },
  'GET /api/v1/workspaces/:workspaceId/access': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, '/access')),
  },
  'PUT /api/v1/workspaces/:workspaceId/access/:userId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'PUT', ws(ctx, `/access/${ctx.a.member.user.id}`), { role: 'editor' }),
  },
  'DELETE /api/v1/workspaces/:workspaceId/access/:userId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'DELETE', ws(ctx, `/access/${ctx.a.member.user.id}`)),
    // The grant back, for the next template that needs it.
    after: async (ctx) => {
      await ctx.a.tenant.call(ctx.a.admin, 'PUT', `/workspaces/${ctx.a.workspaceId}/access/${ctx.a.member.user.id}`, {
        role: 'editor',
      });
    },
  },

  // ---- sync
  'GET /api/v1/workspaces/:workspaceId/sync/head': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, '/sync/head')),
  },
  'GET /api/v1/workspaces/:workspaceId/sync/log': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, '/sync/log')),
  },
  'GET /api/v1/workspaces/:workspaceId/sync/snapshot': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'GET', ws(ctx, `/sync/snapshot?at=${await headOf(ctx)}`)),
  },
  'GET /api/v1/workspaces/:workspaceId/sync/changes': {
    cls: 'refused',
    request: async (ctx) => {
      const head = await headOf(ctx);
      return json(ctx, 'GET', ws(ctx, `/sync/changes?from=${head}&to=${head}`));
    },
  },
  'POST /api/v1/workspaces/:workspaceId/sync/commits': {
    cls: 'refused',
    // A's workspace.yaml again, with a comment line of its own, on A's head.
    request: async (ctx) => {
      const files = await firstCommitFiles(ctx.a.workspaceId);
      const yaml = files.find((file) => file.path === 'workspace.yaml')!;
      return json(ctx, 'POST', ws(ctx, '/sync/commits'), {
        parent: await headOf(ctx),
        commits: [
          {
            subject: 'probe',
            at: '2026-09-24T12:00:00.000Z',
            changes: [{ ...yaml, content: `${yaml.content}# probe ${newId()}\n` }],
          },
        ],
      });
    },
  },
  'POST /api/v1/workspaces/:workspaceId/team-secrets/key-requests': {
    cls: 'refused',
    request: (ctx) =>
      json(ctx, 'POST', ws(ctx, '/team-secrets/key-requests'), {
        keyId: Array.from({ length: 26 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(Date.now() + i * 7) % 32]).join(
          '',
        ),
        content: 'public key',
      }),
  },

  // ---- webhook capture
  'GET /api/v1/workspaces/:workspaceId/hooks': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, '/hooks')),
  },
  'POST /api/v1/workspaces/:workspaceId/hooks': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', ws(ctx, '/hooks'), { name: `acme h-${newId()}` }),
  },
  'PATCH /api/v1/workspaces/:workspaceId/hooks/:hookId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'PATCH', ws(ctx, `/hooks/${ctx.a.hookId}`), { name: `acme callback ${newId()}` }),
  },
  'POST /api/v1/workspaces/:workspaceId/hooks/:hookId/rotate': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'POST', ws(ctx, `/hooks/${await fresh.hook(ctx.a)}/rotate`)),
  },
  'DELETE /api/v1/workspaces/:workspaceId/hooks/:hookId': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', ws(ctx, `/hooks/${await fresh.hook(ctx.a)}`)),
  },
  'GET /api/v1/workspaces/:workspaceId/hooks/:hookId/captures': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, `/hooks/${ctx.a.hookId}/captures`)),
  },
  'GET /api/v1/workspaces/:workspaceId/hooks/:hookId/captures/:captureId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, `/hooks/${ctx.a.hookId}/captures/${ctx.a.captureId}`)),
  },
  'DELETE /api/v1/workspaces/:workspaceId/hooks/:hookId/captures': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', ws(ctx, `/hooks/${await fresh.hook(ctx.a)}/captures`)),
  },
  'ALL /hooks/:secret': {
    cls: 'refused',
    request: (ctx) => ({ method: 'POST', url: `/hooks/${ctx.a.hookSecret}`, payload: 'probe' }),
  },
  'ALL /hooks/:secret/*': {
    cls: 'refused',
    request: (ctx) => ({ method: 'POST', url: `/hooks/${ctx.a.hookSecret}/events`, payload: 'probe' }),
  },

  // ---- CI tokens
  'GET /api/v1/workspaces/:workspaceId/ci-tokens': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, '/ci-tokens')),
  },
  'POST /api/v1/workspaces/:workspaceId/ci-tokens': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', ws(ctx, '/ci-tokens'), { name: `acme c-${newId()}` }),
  },
  'DELETE /api/v1/workspaces/:workspaceId/ci-tokens/:tokenId': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', ws(ctx, `/ci-tokens/${await fresh.ciToken(ctx.a)}`)),
  },
  'GET /api/v1/ci/whoami': {
    cls: 'refused',
    statuses: [401],
    request: (ctx) => ({
      method: 'GET',
      url: api('/ci/whoami'),
      headers: { authorization: `Bearer ${ctx.a.ciToken}` },
    }),
  },

  // ---- terminal shares
  'POST /api/v1/workspaces/:workspaceId/terminal-shares': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', ws(ctx, '/terminal-shares'), { hostName: 'acme-web', cols: 80, rows: 24 }),
  },
  'GET /api/v1/workspaces/:workspaceId/terminal-shares/:shareId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, `/terminal-shares/${ctx.a.shareId}`)),
  },

  // ---- scheduled runs
  'GET /api/v1/workspaces/:workspaceId/schedules': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, '/schedules')),
  },
  'POST /api/v1/workspaces/:workspaceId/schedules': {
    cls: 'refused',
    request: (ctx) =>
      json(ctx, 'POST', ws(ctx, '/schedules'), {
        name: `acme s-${newId()}`,
        schedule: '@daily',
        target: { project: 'Billing' },
      }),
  },
  'GET /api/v1/workspaces/:workspaceId/schedules/:scheduleId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, `/schedules/${ctx.a.scheduleId}`)),
  },
  'PATCH /api/v1/workspaces/:workspaceId/schedules/:scheduleId': {
    cls: 'refused',
    request: (ctx) =>
      json(ctx, 'PATCH', ws(ctx, `/schedules/${ctx.a.scheduleId}`), { name: `acme nightly ${newId()}` }),
  },
  'DELETE /api/v1/workspaces/:workspaceId/schedules/:scheduleId': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', ws(ctx, `/schedules/${await fresh.schedule(ctx.a)}`)),
  },
  'PUT /api/v1/workspaces/:workspaceId/schedules/:scheduleId/secrets': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'PUT', ws(ctx, `/schedules/${ctx.a.scheduleId}/secrets`), { API_KEY: 'probe' }),
  },
  'POST /api/v1/workspaces/:workspaceId/schedules/:scheduleId/alerts/test': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', ws(ctx, `/schedules/${ctx.a.scheduleId}/alerts/test`), {}),
  },
  'GET /api/v1/workspaces/:workspaceId/schedules/:scheduleId/runs': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, `/schedules/${ctx.a.scheduleId}/runs`)),
  },
  'POST /api/v1/workspaces/:workspaceId/schedules/:scheduleId/runs': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'POST', ws(ctx, `/schedules/${await fresh.schedule(ctx.a)}/runs`)),
  },
  'GET /api/v1/workspaces/:workspaceId/schedules/:scheduleId/runs/:runId': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, `/schedules/${ctx.a.scheduleId}/runs/${ctx.a.runId}`)),
  },
  'DELETE /api/v1/workspaces/:workspaceId/schedules/:scheduleId/runs/:runId': {
    cls: 'refused',
    request: async (ctx) => {
      const { scheduleId, runId } = await fresh.queuedRun(ctx.a);
      return json(ctx, 'DELETE', ws(ctx, `/schedules/${scheduleId}/runs/${runId}`));
    },
  },

  // ---- the audit log
  // B's log records what B was sent, A's emails in B's failed sign-ins among it.
  'GET /api/v1/audit': { cls: 'own', stripsSent: true, request: (ctx) => json(ctx, 'GET', api('/audit?limit=200')) },
  'GET /api/v1/audit/export': {
    cls: 'own',
    stripsSent: true,
    request: (ctx) => json(ctx, 'GET', api('/audit/export')),
  },
  'POST /api/v1/workspaces/:workspaceId/audit/desktop-events': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', ws(ctx, '/audit/desktop-events'), { events: [SENT] }),
  },

  // ---- session logs
  'GET /api/v1/workspaces/:workspaceId/session-logs': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, '/session-logs')),
  },
  'POST /api/v1/workspaces/:workspaceId/session-logs': {
    cls: 'refused',
    request: (ctx) =>
      json(ctx, 'POST', ws(ctx, '/session-logs'), {
        clientLogId: `20261101T000000Z-${newId().slice(-8)}`,
        hostId: 'acme-host',
        hostName: 'acme-web',
        address: '10.0.0.1',
        port: 22,
        user: 'ops',
        startedAt: '2026-09-24T12:00:00.000Z',
      }),
  },
  'POST /api/v1/workspaces/:workspaceId/session-logs/:logId/chunks': {
    cls: 'refused',
    request: async (ctx) =>
      json(ctx, 'POST', ws(ctx, `/session-logs/${await fresh.sessionLog(ctx.a)}/chunks`), {
        offset: 0,
        data: Buffer.from('probe\r\n').toString('base64'),
      }),
  },
  'POST /api/v1/workspaces/:workspaceId/session-logs/:logId/end': {
    cls: 'refused',
    request: async (ctx) =>
      json(ctx, 'POST', ws(ctx, `/session-logs/${await fresh.sessionLog(ctx.a)}/end`), {
        endedAt: '2026-09-24T12:00:01.000Z',
        reason: 'closed',
      }),
  },
  'GET /api/v1/workspaces/:workspaceId/session-logs/:logId/text': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', ws(ctx, `/session-logs/${ctx.a.sessionLogId}/text`)),
  },
  'DELETE /api/v1/workspaces/:workspaceId/session-logs/:logId': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', ws(ctx, `/session-logs/${await fresh.sessionLog(ctx.a)}`)),
  },

  // ---- the local agent
  'POST /api/v1/agent/pairing-codes': {
    cls: 'own',
    request: (ctx) => ({ method: 'POST', url: api('/agent/pairing-codes'), headers: asTab(ctx) }),
  },
  'GET /api/v1/agent/pairings': {
    cls: 'own',
    request: (ctx) => ({ method: 'GET', url: api('/agent/pairings'), headers: asTab(ctx) }),
  },
  'POST /api/v1/agent/pairings': {
    cls: 'refused',
    statuses: [400],
    request: async (ctx) => ({
      method: 'POST',
      url: api('/agent/pairings'),
      payload: {
        code: await fresh.code(ctx.a),
        agentId: `probe-${newId()}`,
        publicKey: ctx.a.agent.publicKey,
        port: 47615,
        sshOptIn: false,
      },
    }),
  },
  'POST /api/v1/agent/nonces': {
    cls: 'refused',
    request: (ctx) => ({
      method: 'POST',
      url: api('/agent/nonces'),
      headers: asTab(ctx),
      payload: { pairingId: ctx.a.pairingId },
    }),
  },
  'POST /api/v1/agent/nonces/redeem': {
    cls: 'refused',
    request: async (ctx) => {
      const nonce = await fresh.nonce(ctx.a);
      const timestamp = ctx.w.t.h.clock.now.toISOString();
      return {
        method: 'POST',
        url: api('/agent/nonces/redeem'),
        headers: {
          'x-wirebench-agent-pairing': ctx.a.pairingId,
          'x-wirebench-agent-timestamp': timestamp,
          'x-wirebench-agent-signature': ctx.a.agent.sign(agentRedeemMessage(nonce, ctx.a.pairingId, timestamp)),
        },
        payload: { nonce },
      };
    },
  },
  'PATCH /api/v1/agent/pairings/:id': {
    cls: 'refused',
    request: (ctx) => signedAgent(ctx, 'PATCH', ctx.a.pairingId, ctx.a.agent, JSON.stringify({ port: 47616 })),
  },
  'DELETE /api/v1/agent/pairings/:id': {
    cls: 'refused',
    request: async (ctx) => ({
      method: 'DELETE',
      url: api(`/agent/pairings/${(await fresh.pairing(ctx.a)).pairingId}`),
      headers: asTab(ctx),
    }),
  },

  // ---- sockets: the socket sweep's, one case each (`SOCKET_ROUTES`)
  [SOCKET_ROUTES.live]: { cls: 'socket' },
  [SOCKET_ROUTES.host]: { cls: 'socket' },
  [SOCKET_ROUTES.terminalShares]: { cls: 'socket' },
};

/**
 * The map's key for a registered route. A route whose only method is `HEAD` is the twin Fastify adds beside each
 * `GET` (`exposeHeadRoutes`), and has no key: no module registers a `HEAD` route of its own today, and one that did
 * would have to change this. Three methods or more fold into `ALL`, which only the catch-URL routes use (`root.all`).
 * The browser build's `/assets/<file>` routes fold into one key.
 */
export function routeKey(route: { readonly method: string | string[]; readonly url: string }): string | undefined {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  if (methods.length === 1 && methods[0] === 'HEAD') return undefined;
  const url = route.url.startsWith('/assets/') ? '/assets/*' : route.url;
  return `${methods.length > 2 ? 'ALL' : methods.filter((method) => method !== 'HEAD').join(',')} ${url}`;
}
