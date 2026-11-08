/**
 * One request template and one class for every route the server registers (tenancy Task 19, spec §19.13). A template
 * is built twice: as A's admin on A's host, where it must answer 2xx (the positive control), and as B's admin on B's
 * host with A's ids, where it must answer as its class says:
 * - **refused**: one of `statuses` (404 by default), or a 2xx empty list;
 * - **own**: 2xx, B's own data;
 * - **federated**: a sign-in method that is a tenant's own setting (spec §22.12), which neither tenant of the world
 *   has, so `404` on both hosts and no control applies (`settings/sign-in.test.ts` runs them with a provider each);
 * - **entry**: an entry route (spec §21.4), which only `app.<app-domain>` serves, so 404 on both tenant hosts too;
 * - **hosted-off**: a self-hosted write hosted mode refuses on every host, `409` on both (the license file, §22.4);
 * - **socket**: a WebSocket route, which the socket sweep covers.
 * No body B gets may hold any of A's ids or anything named for A. A route missing here fails the suite.
 *
 * `from` is the sender's fill; ids are always A's (`a`), and a template that uses a row up makes a fresh one.
 */
import { agentRedeemMessage, agentRequestMessage, LIVE_PATH, TERMINAL_SHARE_PATH } from '@wirebench/engine';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { claim, removeClaim } from '../../../src/custom-domains/repo.js';
import { accountsCookieName, addedCookieName, sessionCookieName } from '../../../src/identity/cookies.js';
import { primaryUrl } from '../../../src/tenancy/urls.js';
import { mintSecret, newId, pkceChallenge } from '../../../src/identity/tokens.js';
import { sealTotpSecret } from '../../../src/identity/two-factor/keys.js';
import * as twoFactorRepo from '../../../src/identity/two-factor/repo.js';
import { newTotpSecret, stepAt, totpAt } from '../../../src/identity/two-factor/totp.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { license } from '../../helpers/licensing.js';
import { SoftAuthenticator } from '../../helpers/soft-authenticator.js';
import { webpFor } from '../../helpers/webp.js';
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

export type RouteClass = 'refused' | 'own' | 'federated' | 'entry' | 'hosted-off' | 'socket';

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
const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
/** One SCIM call as the sender's token. */
const scim = (
  ctx: Ctx,
  method: NonNullable<InjectOptions['method']>,
  path: string,
  payload?: object,
): InjectOptions => ({
  method,
  url: `/scim/v2${path}`,
  headers: { authorization: `Bearer ${ctx.from.scimToken}`, 'content-type': 'application/scim+json' },
  ...(payload !== undefined ? { payload } : {}),
});

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

/**
 * Removes the sender's custom-domain claim and, with `claimAgain`, claims `<slug>.customer.test` again, pending. Through
 * the repository, not the routes: the suspended sweep builds every template as a tenant whose routes refuse it.
 */
async function reclaim(ctx: Ctx, claimAgain: boolean): Promise<void> {
  const name = `${ctx.from.tenant.slug}.customer.test`;
  await ctx.from.tenant.tdb.transaction(async (tx) => {
    await removeClaim(tx);
    if (claimAgain) await claim(tx, { name, createdBy: null, now: ctx.w.t.h.clock.now });
  });
}

/**
 * A fresh user of A's with a confirmed authenticator, and a second-step challenge of theirs finished as `kind`: its
 * secret and the current code. Always A's (two-step sign-in spec §3.2), so B's host, which has no such challenge,
 * refuses it, while A's own finishes the sign-in.
 */
async function twoFactorChallenge(ctx: Ctx, kind: 'device' | 'browser'): Promise<{ secret: string; code: string }> {
  const tenant = ctx.a.tenant;
  const now = ctx.w.t.h.clock.now;
  const user = await fresh.user(tenant);
  const totp = newTotpSecret();
  const dataKey = await ctx.w.t.h.ctx.tenancy.dataKey(tenant.scope);
  await twoFactorRepo.upsertPendingTotp(tenant.tdb, user.user.id, sealTotpSecret(dataKey, user.user.id, totp), now);
  await twoFactorRepo.confirmTotp(tenant.tdb, user.user.id, stepAt(now.getTime()) - 2, now);
  const { secret, hash } = mintSecret();
  await twoFactorRepo.insertChallenge(tenant.tdb, {
    id: newId(),
    userId: user.user.id,
    secretHash: hash,
    purpose: 'sign-in',
    deviceName: 'probe',
    tokenKind: kind,
    at: now,
    expiresAt: new Date(now.getTime() + 5 * 60_000),
  });
  return { secret, code: totpAt(totp, stepAt(now.getTime())) };
}

/**
 * A software passkey for `tenant`'s relying party: its primary URL (spec §3.5), which is its live custom name while it
 * has one. The custom-domain templates claim and drop that name during the sweep, so it is read from the server's own
 * map of hosts when the template is built.
 */
function softKeyOf(ctx: Ctx, tenant: Ctx['from']['tenant']): SoftAuthenticator {
  const scope = ctx.w.t.resolver.resolve(tenant.host) ?? tenant.scope;
  const origin = primaryUrl(ctx.w.t.h.ctx.config, scope);
  return new SoftAuthenticator(new URL(origin).hostname, origin);
}

/** A passkey of `owner`'s in `tenant`, written through the repository, with the software key that signs for it. */
async function withPasskey(ctx: Ctx, tenant: Ctx['from']['tenant'], owner: SignedInUser) {
  const key = softKeyOf(ctx, tenant);
  const id = newId();
  await twoFactorRepo.insertPasskey(tenant.tdb, {
    id,
    userId: owner.user.id,
    credentialId: key.credentialId,
    publicKey: key.publicKey,
    counter: 0,
    transports: ['internal'],
    name: 'probe',
    at: ctx.w.t.h.clock.now,
  });
  return { id, key };
}

/** A's passkey, of a fresh user of A's; sent by that user on A's host, by a fresh user of the sender's elsewhere. */
async function foreignPasskey(ctx: Ctx): Promise<{ id: string; sender: SignedInUser }> {
  const owner = await fresh.user(ctx.a.tenant);
  const { id } = await withPasskey(ctx, ctx.a.tenant, owner);
  return { id, sender: ctx.from.tenant.slug === ctx.a.tenant.slug ? owner : await fresh.user(ctx.from.tenant) };
}

/**
 * A sign-in challenge of a fresh user of A's with a passkey, its WebAuthn challenge asked, and the key's answer;
 * finished as `kind`, and with the desktop's passkey hand-off started when `flow`.
 */
async function passkeyChallenge(
  ctx: Ctx,
  kind: 'device' | 'browser' = 'device',
  flow = false,
): Promise<{ secret: string; response: Record<string, unknown>; flowId: string }> {
  const tenant = ctx.a.tenant;
  const now = ctx.w.t.h.clock.now;
  const user = await fresh.user(tenant);
  const { key } = await withPasskey(ctx, tenant, user);
  const { secret, hash } = mintSecret();
  const webauthnChallenge = mintSecret().secret;
  const id = newId();
  await twoFactorRepo.insertChallenge(tenant.tdb, {
    id,
    userId: user.user.id,
    secretHash: hash,
    purpose: 'sign-in',
    deviceName: 'probe',
    tokenKind: kind,
    webauthnChallenge,
    at: now,
    expiresAt: new Date(now.getTime() + 5 * 60_000),
  });
  const flowId = newId();
  if (flow)
    await twoFactorRepo.startChallengeFlow(tenant.tdb, id, {
      flowId,
      codeChallenge: pkceChallenge(mintSecret().secret),
      loopbackPort: 49152,
    });
  return { secret, response: key.get({ challenge: webauthnChallenge }), flowId };
}

/**
 * A fresh user of `tenant`'s with an authenticator, confirmed or still pending, and the code it shows now; through
 * the repository, so a template on a suspended tenant can still build it.
 */
async function withTotp(ctx: Ctx, tenant: Ctx['from']['tenant'], confirmed: boolean) {
  const now = ctx.w.t.h.clock.now;
  const user = await fresh.user(tenant);
  const totp = newTotpSecret();
  const dataKey = await ctx.w.t.h.ctx.tenancy.dataKey(tenant.scope);
  await twoFactorRepo.upsertPendingTotp(tenant.tdb, user.user.id, sealTotpSecret(dataKey, user.user.id, totp), now);
  if (confirmed) await twoFactorRepo.confirmTotp(tenant.tdb, user.user.id, stepAt(now.getTime()) - 2, now);
  return { user, code: totpAt(totp, stepAt(now.getTime())) };
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
  // Spec §20.9: this process's own state, the same on every host.
  'GET /readyz': { cls: 'own', request: () => ({ method: 'GET', url: '/readyz' }) },
  'GET /api/v1/meta': { cls: 'own', request: () => ({ method: 'GET', url: api('/meta') }) },
  // Also the entry's page (spec §21.4), which the entry suite covers: on a tenant host `/` is the browser client's.
  'GET /': { cls: 'own', request: (ctx) => ({ method: 'GET', url: '/', headers: asTab(ctx) }) },
  'POST /': {
    cls: 'entry',
    request: () => ({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40acme.test',
    }),
  },
  // The billing webhook (spec §22.5), on the entry host only: a signature is never checked on a tenant's host.
  'POST /billing/paddle': {
    cls: 'entry',
    request: () => ({
      method: 'POST',
      url: '/billing/paddle',
      headers: { 'content-type': 'application/json', 'paddle-signature': 'ts=1;h1=' + '0'.repeat(64) },
      payload: '{}',
    }),
  },
  // Signup (spec §22.6), on the entry host only; on a tenant host `GET /signup` is the browser client's, as `GET /`.
  'GET /signup': { cls: 'own', request: (ctx) => ({ method: 'GET', url: '/signup', headers: asTab(ctx) }) },
  'POST /signup': {
    cls: 'entry',
    request: () => ({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40acme.test&name=A&slug=probe&seats=1',
    }),
  },
  // The signup link's pages: on a tenant host these paths are the browser client's too.
  'GET /signup/:token': {
    cls: 'own',
    request: (ctx) => ({ method: 'GET', url: `/signup/${'A'.repeat(43)}`, headers: asTab(ctx) }),
  },
  'GET /signup/:token/status': {
    cls: 'own',
    request: (ctx) => ({ method: 'GET', url: `/signup/${'A'.repeat(43)}/status`, headers: asTab(ctx) }),
  },
  'POST /signup/:token': {
    cls: 'entry',
    request: () => ({
      method: 'POST',
      url: `/signup/${'A'.repeat(43)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'password=probe-password-long',
    }),
  },
  'GET /*': { cls: 'own', request: (ctx) => ({ method: 'GET', url: '/workspaces', headers: asTab(ctx) }) },

  // ---- the control plane's tenant routes (spec §22.9, §22.11): a tenant's own, its server admins only
  'GET /api/v1/tenant/billing': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/tenant/billing')) },
  'GET /api/v1/tenant/exports': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/tenant/exports')) },
  'POST /api/v1/tenant/exports': {
    cls: 'own',
    request: (ctx) => json(ctx, 'POST', api('/tenant/exports')),
    // One queued at a time: the next send asks again.
    after: async (ctx) => {
      await ctx.from.tenant.tdb.query("delete from tenant_exports where status = 'queued'");
    },
  },
  'GET /api/v1/tenant/exports/:id/file': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', api(`/tenant/exports/${ctx.a.exportId}/file`)),
  },
  'POST /api/v1/tenant/deletion': {
    cls: 'own',
    request: (ctx) => json(ctx, 'POST', api('/tenant/deletion'), { slug: ctx.from.tenant.slug }),
    after: async (ctx) => {
      await ctx.from.tenant.inject(json(ctx, 'DELETE', api('/tenant/deletion')));
    },
  },
  'DELETE /api/v1/tenant/deletion': { cls: 'own', request: (ctx) => json(ctx, 'DELETE', api('/tenant/deletion')) },
  // The browser build's files, one route each (`routeKey` folds them into one key).
  'GET /assets/*': { cls: 'own', request: (ctx) => ({ method: 'GET', url: ctx.url }) },

  // ---- identity: the caller's own
  'GET /api/v1/me': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/me')) },
  'GET /api/v1/me/two-factor': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/me/two-factor')) },
  'POST /api/v1/me/two-factor/totp': {
    cls: 'own',
    request: async (ctx) =>
      json(ctx, 'POST', api('/me/two-factor/totp'), { password: PASSWORD }, bearer(await fresh.user(ctx.from.tenant))),
  },
  'POST /api/v1/me/two-factor/totp/confirm': {
    cls: 'own',
    request: async (ctx) => {
      const { user, code } = await withTotp(ctx, ctx.from.tenant, false);
      return json(ctx, 'POST', api('/me/two-factor/totp/confirm'), { code }, bearer(user));
    },
  },
  'DELETE /api/v1/me/two-factor/totp': {
    cls: 'own',
    request: async (ctx) => {
      const { user } = await withTotp(ctx, ctx.from.tenant, true);
      return json(ctx, 'DELETE', api('/me/two-factor/totp'), { password: PASSWORD }, bearer(user));
    },
  },
  'POST /api/v1/me/two-factor/passkeys/options': {
    cls: 'own',
    request: async (ctx) =>
      json(
        ctx,
        'POST',
        api('/me/two-factor/passkeys/options'),
        { password: PASSWORD },
        bearer(await fresh.user(ctx.from.tenant)),
      ),
  },
  'POST /api/v1/me/two-factor/passkeys': {
    cls: 'own',
    request: async (ctx) => {
      const tenant = ctx.from.tenant;
      const now = ctx.w.t.h.clock.now;
      const user = await fresh.user(tenant);
      // The relying party as the server names it right now; a suspended tenant's routes refuse, so there the
      // registration is written through the repository instead.
      const asked = await tenant.call<{ challenge: string; rp: { id: string } }>(
        user,
        'POST',
        '/me/two-factor/passkeys/options',
        { password: PASSWORD },
      );
      let challenge: string;
      let key: SoftAuthenticator;
      if (asked.status === 200) {
        challenge = asked.body.challenge;
        key = new SoftAuthenticator(asked.body.rp.id, `https://${asked.body.rp.id}`);
      } else {
        challenge = mintSecret().secret;
        await twoFactorRepo.replaceRegisterChallenge(tenant.tdb, {
          id: newId(),
          userId: user.user.id,
          secretHash: mintSecret().hash,
          webauthnChallenge: challenge,
          at: now,
          expiresAt: new Date(now.getTime() + 5 * 60_000),
        });
        key = softKeyOf(ctx, tenant);
      }
      return json(
        ctx,
        'POST',
        api('/me/two-factor/passkeys'),
        { name: 'probe', response: key.create({ challenge }) },
        bearer(user),
      );
    },
  },
  'PATCH /api/v1/me/two-factor/passkeys/:id': {
    cls: 'refused',
    request: async (ctx) => {
      const { id, sender } = await foreignPasskey(ctx);
      return json(ctx, 'PATCH', api(`/me/two-factor/passkeys/${id}`), { name: 'renamed' }, bearer(sender));
    },
  },
  'DELETE /api/v1/me/two-factor/passkeys/:id': {
    cls: 'refused',
    request: async (ctx) => {
      const { id, sender } = await foreignPasskey(ctx);
      return json(ctx, 'DELETE', api(`/me/two-factor/passkeys/${id}`), { password: PASSWORD }, bearer(sender));
    },
  },
  'POST /api/v1/me/two-factor/recovery-codes': {
    cls: 'own',
    request: async (ctx) => {
      const { user } = await withTotp(ctx, ctx.from.tenant, true);
      return json(ctx, 'POST', api('/me/two-factor/recovery-codes'), { password: PASSWORD }, bearer(user));
    },
  },
  'GET /api/v1/me/devices': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/me/devices')) },
  'GET /api/v1/me/accounts': {
    cls: 'own',
    // A browser of the sender's own that also presents a session of A's: B's host lists no one, since A's token is
    // unknown in B (switch accounts spec §8).
    request: async (ctx) => {
      const active = await fresh.user(ctx.from.tenant, 'browser');
      const remembered = await fresh.user(ctx.a.tenant, 'browser');
      const origin = ctx.from.tenant.origin;
      return {
        method: 'GET',
        url: api('/me/accounts'),
        headers: {
          cookie: `${sessionCookieName(origin)}=${active.token}; ${accountsCookieName(origin)}=${remembered.token}`,
        },
      };
    },
  },
  'DELETE /api/v1/me/devices/:id': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/me/devices/${await fresh.token(ctx.a, ctx.a.admin)}`)),
  },
  'PATCH /api/v1/me': {
    cls: 'own',
    // A user of the sender's own, so the admin every other template sends as keeps its name.
    request: async (ctx) => {
      const user = await fresh.user(ctx.from.tenant);
      return json(ctx, 'PATCH', api('/me'), { name: 'Renamed' }, bearer(user));
    },
  },
  'PUT /api/v1/me/images/:kind': {
    cls: 'own',
    // A user of the sender's own: uploads are limited per person (user profile ruling 12).
    request: async (ctx) => {
      const user = await fresh.user(ctx.from.tenant);
      const data = webpFor('photo').toString('base64');
      return json(ctx, 'PUT', api('/me/images/photo'), { contentType: 'image/webp', data }, bearer(user));
    },
  },
  'DELETE /api/v1/me/images/:kind': { cls: 'own', request: (ctx) => json(ctx, 'DELETE', api('/me/images/cover')) },
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
  'POST /api/v1/auth/two-factor/verify': {
    cls: 'refused',
    statuses: [401],
    request: async (ctx) => {
      const { secret, code } = await twoFactorChallenge(ctx, 'device');
      return json(ctx, 'POST', api('/auth/two-factor/verify'), { challenge: secret, method: 'totp', code }, {});
    },
  },
  'POST /api/v1/auth/two-factor/passkey/options': {
    cls: 'refused',
    statuses: [401],
    request: async (ctx) => {
      const { secret } = await passkeyChallenge(ctx);
      return json(ctx, 'POST', api('/auth/two-factor/passkey/options'), { challenge: secret }, {});
    },
  },
  'POST /api/v1/auth/two-factor/passkey/verify': {
    cls: 'refused',
    statuses: [401],
    request: async (ctx) => {
      const { secret, response } = await passkeyChallenge(ctx);
      return json(ctx, 'POST', api('/auth/two-factor/passkey/verify'), { challenge: secret, response }, {});
    },
  },
  'POST /api/v1/auth/two-factor/passkey/browser-start': {
    cls: 'refused',
    statuses: [401],
    request: async (ctx) => {
      const { secret } = await passkeyChallenge(ctx);
      return json(
        ctx,
        'POST',
        api('/auth/two-factor/passkey/browser-start'),
        { challenge: secret, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: 49152 },
        {},
      );
    },
  },
  // A's flow, granted as its flow page would grant it: B's host knows no such flow.
  'POST /api/v1/auth/two-factor/passkey/complete': {
    cls: 'refused',
    statuses: [400],
    request: async (ctx) => {
      const tenant = ctx.a.tenant;
      const now = ctx.w.t.h.clock.now;
      const user = await fresh.user(tenant);
      const id = newId();
      const flowId = newId();
      const grant = mintSecret();
      await twoFactorRepo.insertChallenge(tenant.tdb, {
        id,
        userId: user.user.id,
        secretHash: mintSecret().hash,
        purpose: 'sign-in',
        deviceName: 'probe',
        tokenKind: 'device',
        at: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      });
      await twoFactorRepo.startChallengeFlow(tenant.tdb, id, {
        flowId,
        codeChallenge: pkceChallenge(VERIFIER),
        loopbackPort: 49152,
      });
      await twoFactorRepo.setChallengeGrant(tenant.tdb, id, grant.hash);
      return json(
        ctx,
        'POST',
        api('/auth/two-factor/passkey/complete'),
        { flowId, grant: grant.secret, codeVerifier: VERIFIER },
        {},
      );
    },
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
  'POST /sign-in/two-factor': {
    cls: 'refused',
    // As the password form: a refusal is the page again, a sign-in sets the session cookie.
    refused: (res) => !String(res.headers['set-cookie'] ?? '').includes('wb_session='),
    request: async (ctx) => {
      const { secret, code } = await twoFactorChallenge(ctx, 'browser');
      return {
        method: 'POST',
        url: '/sign-in/two-factor',
        headers: {
          origin: ctx.from.tenant.origin,
          cookie: `__Host-wb_2fa=${secret}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ method: 'totp', code }).toString(),
      };
    },
  },
  'GET /sign-in/two-factor.js': { cls: 'own', request: () => ({ method: 'GET', url: '/sign-in/two-factor.js' }) },
  'POST /sign-in/two-factor/cancel': {
    cls: 'own',
    request: (ctx) => ({
      method: 'POST',
      url: '/sign-in/two-factor/cancel',
      headers: { origin: ctx.from.tenant.origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    }),
  },
  // The page script's calls, for A's browser challenge in its cookie: B's host has no such challenge.
  'POST /sign-in/two-factor/passkey/options': {
    cls: 'refused',
    statuses: [401],
    request: async (ctx) => {
      const { secret } = await passkeyChallenge(ctx, 'browser');
      return {
        method: 'POST',
        url: '/sign-in/two-factor/passkey/options',
        headers: { origin: ctx.from.tenant.origin, cookie: `__Host-wb_2fa=${secret}` },
        payload: {},
      };
    },
  },
  'POST /sign-in/two-factor/passkey/verify': {
    cls: 'refused',
    refused: (res) => !String(res.headers['set-cookie'] ?? '').includes('wb_session='),
    request: async (ctx) => {
      const { secret, response } = await passkeyChallenge(ctx, 'browser');
      return {
        method: 'POST',
        url: '/sign-in/two-factor/passkey/verify',
        headers: { origin: ctx.from.tenant.origin, cookie: `__Host-wb_2fa=${secret}` },
        payload: { response },
      };
    },
  },
  // The desktop's flow page, for A's flow: B's host answers no page for it.
  'GET /sign-in/two-factor/passkey': {
    cls: 'refused',
    refused: (res) => !res.body.includes('data-flow'),
    request: async (ctx) => {
      const { flowId } = await passkeyChallenge(ctx, 'device', true);
      return { method: 'GET', url: `/sign-in/two-factor/passkey?flow=${flowId}` };
    },
  },
  'GET /sign-in/added': {
    cls: 'refused',
    // A SAML add's handed-over session of A's: adopted on A's host, unknown on B's, which sets no session.
    refused: (res) => !String(res.headers['set-cookie'] ?? '').includes('wb_session='),
    request: async (ctx) => {
      const added = await fresh.user(ctx.a.tenant, 'browser');
      return {
        method: 'GET',
        url: '/sign-in/added',
        headers: { cookie: `${addedCookieName(ctx.from.tenant.origin)}=${added.token}` },
      };
    },
  },
  'POST /sign-in/switch': {
    cls: 'refused',
    // Switching to a session of A's: on A's host it swaps the session cookie; on B's, A's token is unknown and the
    // browser is sent to sign in with no session set.
    refused: (res) => !String(res.headers['set-cookie'] ?? '').includes('wb_session='),
    request: async (ctx) => {
      const active = await fresh.user(ctx.from.tenant, 'browser');
      const remembered = await fresh.user(ctx.a.tenant, 'browser');
      const origin = ctx.from.tenant.origin;
      return {
        method: 'POST',
        url: '/sign-in/switch',
        headers: {
          cookie: `${sessionCookieName(origin)}=${active.token}; ${accountsCookieName(origin)}=${remembered.token}`,
          origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ user: remembered.user.id }).toString(),
      };
    },
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
  'POST /invite/:secret': {
    cls: 'refused',
    // The browser's accept form (team management in the browser §2.3): another tenant's secret is the closed page.
    refused: (res) =>
      res.statusCode === 404 &&
      res.body.includes('This invitation has expired or was already used.') &&
      !String(res.headers['set-cookie'] ?? '').includes('wb_session='),
    request: async (ctx) => ({
      method: 'POST',
      url: `/invite/${(await fresh.invitation(ctx.a)).secret}`,
      headers: { origin: ctx.from.tenant.origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ password: PASSWORD, confirm: PASSWORD }).toString(),
    }),
  },
  'GET /api/v1/users': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/users')) },
  // The fill gives A's browser user a photo; B's units cannot see it, nor A's people.
  'GET /api/v1/users/:id/images/:kind': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', api(`/users/${ctx.a.browser.user.id}/images/photo`)),
  },
  'GET /api/v1/users/:id/profile': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'GET', api(`/users/${ctx.a.member.user.id}/profile`)),
  },
  'PATCH /api/v1/users/:id': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'PATCH', api(`/users/${ctx.a.member.user.id}`), { disabled: false }),
  },
  // A fresh user of A's: the reset ends their sessions, which the member's other templates need.
  'DELETE /api/v1/users/:id/two-factor': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/users/${(await fresh.user(ctx.a.tenant)).user.id}/two-factor`)),
  },
  'POST /api/v1/users/:id/password-reset': {
    cls: 'refused',
    request: (ctx) => json(ctx, 'POST', api(`/users/${ctx.a.member.user.id}/password-reset`)),
  },

  // ---- licensing
  'GET /api/v1/license': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/license')) },
  // Hosted mode takes no license file (spec §22.4): the tenant row is the edition, on both hosts.
  'PUT /api/v1/license': {
    cls: 'hosted-off',
    request: (ctx) =>
      json(ctx, 'PUT', api('/license'), { license: license(keys, { id: newId(), edition: 'enterprise', seats: 500 }) }),
  },
  'DELETE /api/v1/license': { cls: 'hosted-off', request: (ctx) => json(ctx, 'DELETE', api('/license')) },

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
  'POST /api/v1/teams/:teamId/invitations/:id/renew': {
    cls: 'refused',
    request: async (ctx) =>
      json(ctx, 'POST', api(`/teams/${ctx.a.teamId}/invitations/${await fresh.teamInvitation(ctx.a)}/renew`)),
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

  // ---- a tenant's settings (spec §22.12): the sender's own, never another tenant's
  'GET /api/v1/tenant/settings': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/tenant/settings')) },
  'PUT /api/v1/tenant/settings/:section': {
    cls: 'own',
    request: (ctx) => json(ctx, 'PUT', api('/tenant/settings/retention'), { hooksKeep: 100 }),
  },
  'DELETE /api/v1/tenant/settings/:section': {
    cls: 'own',
    request: (ctx) => json(ctx, 'DELETE', api('/tenant/settings/retention')),
  },

  // ---- SAML: a tenant's own setting (spec §22.12), which neither world tenant has
  'POST /api/v1/auth/saml/start': {
    cls: 'federated',
    request: () => ({
      method: 'POST',
      url: api('/auth/saml/start'),
      payload: { device: { name: 'probe' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: 49152 },
    }),
  },
  'POST /api/v1/auth/saml/acs': {
    cls: 'federated',
    request: () => ({
      method: 'POST',
      url: api('/auth/saml/acs'),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'SAMLResponse=x&RelayState=y',
    }),
  },
  'POST /api/v1/auth/saml/browser-acs': {
    cls: 'federated',
    request: () => ({
      method: 'POST',
      url: api('/auth/saml/browser-acs'),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'SAMLResponse=x&RelayState=y',
    }),
  },
  'POST /api/v1/auth/saml/complete': {
    cls: 'federated',
    request: () => ({
      method: 'POST',
      url: api('/auth/saml/complete'),
      payload: { flowId: newId(), grant: mintSecret().secret, codeVerifier: VERIFIER },
    }),
  },
  'GET /api/v1/auth/saml/metadata': {
    cls: 'federated',
    request: () => ({ method: 'GET', url: api('/auth/saml/metadata') }),
  },
  'GET /sign-in/saml': { cls: 'federated', request: () => ({ method: 'GET', url: '/sign-in/saml' }) },
  // The sender's own URLs, and no IdP.
  'GET /api/v1/auth/saml/info': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/auth/saml/info')) },

  // ---- SCIM: the admin routes, then the base, by the sender's own token
  'GET /api/v1/scim-tokens': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/scim-tokens')) },
  'POST /api/v1/scim-tokens': {
    cls: 'own',
    request: (ctx) => json(ctx, 'POST', api('/scim-tokens'), { name: `${ctx.from.tenant.slug} probe` }),
  },
  'DELETE /api/v1/scim-tokens/:id': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/scim-tokens/${await fresh.scimTokenId(ctx.a)}`)),
  },
  'GET /api/v1/scim-groups': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/scim-groups')) },
  'PUT /api/v1/scim-groups/:id/team': {
    cls: 'refused',
    request: async (ctx) =>
      json(ctx, 'PUT', api(`/scim-groups/${await fresh.scimGroup(ctx.a)}/team`), { teamId: ctx.from.teamId }),
  },
  'DELETE /api/v1/scim-groups/:id/team': {
    cls: 'refused',
    request: async (ctx) => json(ctx, 'DELETE', api(`/scim-groups/${await fresh.scimGroup(ctx.a)}/team`)),
  },
  'GET /scim/v2/ServiceProviderConfig': { cls: 'own', request: (ctx) => scim(ctx, 'GET', '/ServiceProviderConfig') },
  'GET /scim/v2/ResourceTypes': { cls: 'own', request: (ctx) => scim(ctx, 'GET', '/ResourceTypes') },
  'GET /scim/v2/Schemas': { cls: 'own', request: (ctx) => scim(ctx, 'GET', '/Schemas') },
  'GET /scim/v2/Users': { cls: 'own', request: (ctx) => scim(ctx, 'GET', '/Users') },
  'GET /scim/v2/Users/:id': {
    cls: 'refused',
    request: async (ctx) => scim(ctx, 'GET', `/Users/${await fresh.scimUser(ctx.a)}`),
  },
  'POST /scim/v2/Users': {
    cls: 'own',
    request: (ctx) => {
      const email = `p-${newId().toLowerCase()}@${ctx.from.tenant.slug}.example`;
      return scim(ctx, 'POST', '/Users', {
        schemas: [SCIM_USER],
        userName: email,
        emails: [{ value: email, primary: true }],
        active: true,
      });
    },
  },
  'PUT /scim/v2/Users/:id': {
    cls: 'refused',
    request: async (ctx) => {
      const id = await fresh.scimUser(ctx.a);
      return scim(ctx, 'PUT', `/Users/${id}`, {
        schemas: [SCIM_USER],
        userName: `r-${id.toLowerCase()}@acme.example`,
        active: true,
      });
    },
  },
  'PATCH /scim/v2/Users/:id': {
    cls: 'refused',
    request: async (ctx) =>
      scim(ctx, 'PATCH', `/Users/${await fresh.scimUser(ctx.a)}`, {
        schemas: [SCIM_PATCH],
        Operations: [{ op: 'replace', path: 'displayName', value: 'Patched' }],
      }),
  },
  'DELETE /scim/v2/Users/:id': {
    cls: 'refused',
    request: async (ctx) => scim(ctx, 'DELETE', `/Users/${await fresh.scimUser(ctx.a)}`),
  },
  'GET /scim/v2/Groups': { cls: 'own', request: (ctx) => scim(ctx, 'GET', '/Groups') },
  'GET /scim/v2/Groups/:id': {
    cls: 'refused',
    request: async (ctx) => scim(ctx, 'GET', `/Groups/${await fresh.scimGroup(ctx.a)}`),
  },
  'POST /scim/v2/Groups': {
    cls: 'own',
    request: (ctx) =>
      scim(ctx, 'POST', '/Groups', { schemas: [SCIM_GROUP], displayName: `${ctx.from.tenant.slug} p-${newId()}` }),
  },
  'PUT /scim/v2/Groups/:id': {
    cls: 'refused',
    request: async (ctx) =>
      scim(ctx, 'PUT', `/Groups/${await fresh.scimGroup(ctx.a)}`, {
        schemas: [SCIM_GROUP],
        displayName: `acme r-${newId()}`,
      }),
  },
  'PATCH /scim/v2/Groups/:id': {
    cls: 'refused',
    request: async (ctx) =>
      scim(ctx, 'PATCH', `/Groups/${await fresh.scimGroup(ctx.a)}`, {
        schemas: [SCIM_PATCH],
        Operations: [{ op: 'replace', path: 'displayName', value: `acme q-${newId()}` }],
      }),
  },
  'DELETE /scim/v2/Groups/:id': {
    cls: 'refused',
    request: async (ctx) => scim(ctx, 'DELETE', `/Groups/${await fresh.scimGroup(ctx.a)}`),
  },

  // ---- custom domains (slice 8): the sender's own claim, which fill made (`<slug>.customer.test`)
  'GET /api/v1/tenant/domain': { cls: 'own', request: (ctx) => json(ctx, 'GET', api('/tenant/domain')) },
  'PUT /api/v1/tenant/domain': {
    cls: 'own',
    // One claim per tenant: the sender's goes first, and the claim made again is the one fill made.
    request: async (ctx) => {
      await reclaim(ctx, false);
      return json(ctx, 'PUT', api('/tenant/domain'), { name: `${ctx.from.tenant.slug}.customer.test` });
    },
  },
  'POST /api/v1/tenant/domain/check': {
    cls: 'own',
    request: (ctx) => json(ctx, 'POST', api('/tenant/domain/check')),
  },
  'DELETE /api/v1/tenant/domain': {
    cls: 'own',
    request: (ctx) => json(ctx, 'DELETE', api('/tenant/domain')),
    // The table sweeps need the sender's claim back.
    after: (ctx) => reclaim(ctx, true),
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
