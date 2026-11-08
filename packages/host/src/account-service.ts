/**
 * Who this installation is signed in as (identity spec §3.8, §4.3, §5.3; switch accounts spec §2, §6). An
 * account is one person on one server, `(url, userId)`, so two may share a server; exactly one signed-in
 * account is active whenever any is. Main owns all of it: `accounts.yaml` (no token inside — only a
 * secret-store ref), each account's token in the secret store under `wirebench-server:<url>#<userId>`, the
 * browser hand-off for OIDC, and the rule that a server answering `identity-unauthenticated` marks the account
 * signed out rather than looping. The renderer receives `ServerAccount` minus `tokenRef` (see `ipc/account.ts`).
 *
 * Callers outside the renderer that still name a server by URL alone (an {@link AccountTarget} string) get that
 * server's account as {@link AccountService.accountFor} picks it: the active one when it is on that server, else
 * the most recently active signed-in one there, else any.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNTS_FILE_VERSION,
  parseAccountsFile,
  pkce,
  WirebenchError,
  type AccountRef,
  type AccountsFile,
  type ImageRef,
  type InvitationLookupResponse,
  type MetaResponse,
  type ServerAccount,
  type ServerUser,
  type SignInResponse,
} from '@wirebench/engine';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { startLoopbackCallback, type LoopbackCallback } from './loopback-callback.js';
import { normalizeServerUrl, type ServerClient } from './server-client.js';

export const ACCOUNTS_FILE = 'accounts.yaml';
export const TOKEN_LABEL_PREFIX = 'wirebench-server:';
/** The secret-store label of one account's device token (switch accounts ruling 4). */
export function tokenLabel(origin: string, userId: string): string {
  return `${TOKEN_LABEL_PREFIX}${origin}#${userId}`;
}

/**
 * Which account a call is for: an exact account, or a server URL alone (switch accounts ruling 1), which stands
 * for the account {@link AccountService.accountFor} picks on that server.
 */
export type AccountTarget = string | AccountRef;

/**
 * What a host inside a server answers to `setActive` on a remembered browser account (switch accounts ruling 6):
 * only the browser can switch, by submitting `/sign-in/switch`, so the renderer calls `env.switchAccount`.
 */
export const ACCOUNT_SWITCH_IN_BROWSER = 'account-switch-in-browser';

/** As the OAuth2 request flow: five minutes for the browser. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export interface AccountServiceDeps {
  readonly userDataDir: string;
  readonly client: ServerClient;
  readonly secrets: {
    set(value: string, opts?: { label?: string }): Promise<string>;
    get(ref: string): Promise<string | undefined>;
    delete(ref: string): Promise<boolean>;
  };
  /** The loopback helper; injected so tests settle the browser's answer by hand. */
  readonly loopback?: typeof startLoopbackCallback;
  /** Opens the IdP's URL in the user's browser (already gated by `isExternalUrlAllowed` in the app). */
  readonly openExternal: (url: string) => Promise<void>;
  readonly defaultDeviceName?: () => string;
  readonly now?: () => Date;
  /**
   * A host inside a Wirebench Server (hosted edition spec §17.3): `url` is an account the embedder signs
   * in, whose token is whatever `credential()` returns now. Nothing about it is written to
   * `accounts.yaml` or the secret store, and it cannot be signed in to, signed out of or removed here.
   */
  readonly embedded?: { readonly url: string; readonly credential: () => string | undefined };
}

/** What a host inside a server answers for an account that only the embedder may change. */
export const ACCOUNT_MANAGED_BY_SERVER = 'account-managed-by-server';

/** The embedder's account between `me` calls: who the token belongs to, and the ref its token is known by. */
interface EmbeddedAccount {
  readonly origin: string;
  readonly credential: () => string | undefined;
  readonly addedAt: string;
  userId: string;
  email: string;
  displayName: string;
  username: string | null;
  photo: ImageRef | null;
  /**
   * A `sec_` ref no store holds, renewed whenever the credential changes: `LiveClients` reconnects on a
   * new ref, as it does after a desktop sign-in.
   */
  tokenRef: string;
  /** The credential the ref was made for; kept in memory only. */
  token: string | undefined;
}

/**
 * What the account keeps of your profile (user profile spec §7): enough for the account menu. `null` is none set;
 * a field left out is not changed.
 */
export interface AccountProfileFields {
  readonly displayName?: string;
  readonly username?: string | null;
  readonly photo?: ImageRef | null;
}

/** The profile fields of a `/me` or sign-in answer; a server that predates profiles has neither, so none. */
export function profileFieldsOf(user: ServerUser): Required<AccountProfileFields> {
  return { displayName: user.displayName, username: user.username ?? null, photo: user.photo ?? null };
}

/** `account` with `fields` applied, or `undefined` when nothing differs. Absent stands for `null` in the file. */
function withProfile(account: ServerAccount, fields: AccountProfileFields): ServerAccount | undefined {
  const displayName = fields.displayName ?? account.displayName;
  const username = fields.username === undefined ? (account.username ?? null) : fields.username;
  const photo = fields.photo === undefined ? (account.photo ?? null) : fields.photo;
  if (
    displayName === account.displayName &&
    username === (account.username ?? null) &&
    photo?.version === account.photo?.version
  )
    return undefined;
  const next: { -readonly [K in keyof ServerAccount]: ServerAccount[K] } = { ...account, displayName };
  delete next.username;
  delete next.photo;
  if (username !== null) next.username = username;
  if (photo !== null) next.photo = { version: photo.version };
  return next;
}

const sameAccount = (a: AccountRef, b: AccountRef): boolean => a.url === b.url && a.userId === b.userId;

const refOf = (account: AccountRef): AccountRef => ({ url: account.url, userId: account.userId });

/**
 * The order `list()` and the file keep: by server, and within a server the account a URL alone stands for
 * first — the active one, then signed-in ones most recently active first, then signed-out ones — so a caller
 * that finds the first account for a URL gets the same one {@link AccountService.accountFor} does.
 */
function accountOrder(active: AccountRef | null): (a: ServerAccount, b: ServerAccount) => number {
  const rank = (account: ServerAccount): number =>
    active !== null && sameAccount(account, active) ? 0 : account.signedOut === true ? 2 : 1;
  return (a, b) =>
    a.url.localeCompare(b.url) ||
    rank(a) - rank(b) ||
    (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '') ||
    a.userId.localeCompare(b.userId);
}

/** The signed-in account most recently active, other than `except`; `null` when there is none. */
function mostRecentSignedIn(servers: readonly ServerAccount[], except?: AccountRef): AccountRef | null {
  const candidates = servers.filter(
    (server) => server.signedOut !== true && (except === undefined || !sameAccount(server, except)),
  );
  // A stable sort keeps file order among accounts never made active (a file from before switching).
  const [first] = [...candidates].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  return first === undefined ? null : refOf(first);
}

function freshTokenRef(): string {
  return `sec_${randomBytes(13).toString('hex')}`;
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The sign-in codes the server hands back on the loopback, in the app's words. */
const LOOPBACK_MESSAGES: Readonly<Record<string, string>> = {
  'identity-not-invited': 'No account or open invitation exists for this email. Ask a server admin to invite you.',
  'identity-email-unverified': 'The identity provider did not confirm your email address, so it cannot be linked.',
  'identity-user-disabled': 'This account is disabled.',
  'identity-oidc-refused': 'The identity provider refused the sign-in.',
  'identity-oidc-failed': 'The identity provider did not complete the sign-in.',
  'licensing-seat-limit': 'This server has no free seat for a new account.',
  'licensing-feature-required': 'SAML sign-in needs an Enterprise license on this server.',
  'identity-saml-no-email': 'The identity provider did not send an email address for this account.',
  'identity-saml-transient-nameid':
    'The identity provider sent a one-time identifier. Ask your admin to send a persistent NameID.',
  // Every saml-* reason the server records (saml-scim spec §6.1) collapses to this one for the person signing in.
  'identity-saml-refused': "The identity provider's response was not accepted.",
};

export class AccountService {
  private readonly file: string;
  private accounts: AccountsFile = { version: ACCOUNTS_FILE_VERSION, active: null, servers: [] };
  private pending: LoopbackCallback | undefined;
  /** Set synchronously before the loopback binds, so a second `startOidc` in the same tick sees it. */
  private starting = false;
  /** `cancelSignIn` called while {@link starting}: cancel the loopback as soon as it binds. */
  private cancelRequested = false;
  private readonly listeners = new Set<(servers: readonly ServerAccount[]) => void>();
  /** Every write chains onto this so renames can never land out of order (§4.3). */
  private writing: Promise<void> = Promise.resolve();
  /** Settles {@link ready}; assigned in the constructor. */
  private markReady!: () => void;
  /**
   * Settles (never rejects) once {@link load} has finished, successfully or not. A server share
   * waits on it before its first call at launch (server-sync §3.4, R6), so a reopened workspace
   * does not read "signed out" just because `accounts.yaml` had not been read yet.
   */
  readonly ready: Promise<void>;
  /** The embedder's account (`deps.embedded`), never in {@link accounts}; `undefined` on the desktop. */
  private readonly embedded: EmbeddedAccount | undefined;

  constructor(private readonly deps: AccountServiceDeps) {
    this.file = join(deps.userDataDir, ACCOUNTS_FILE);
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
    if (deps.embedded !== undefined) {
      this.embedded = {
        origin: normalizeServerUrl(deps.embedded.url),
        credential: deps.embedded.credential,
        addedAt: (deps.now ?? (() => new Date()))().toISOString(),
        userId: '',
        email: '',
        displayName: '',
        username: null,
        photo: null,
        tokenRef: freshTokenRef(),
        token: deps.embedded.credential(),
      };
    }
  }

  async load(): Promise<void> {
    try {
      let document: unknown;
      try {
        document = parseYaml(await readFile(this.file, 'utf8'));
      } catch {
        document = undefined;
      }
      const parsed = parseAccountsFile(document);
      // The embedder's account is never read from the file, even if one was left there.
      const embedded = this.embedded?.origin;
      const servers = embedded === undefined ? parsed.servers : parsed.servers.filter((s) => s.url !== embedded);
      const active =
        embedded !== undefined && parsed.active?.url === embedded ? mostRecentSignedIn(servers) : parsed.active;
      this.accounts = { ...parsed, active, servers: [...servers].sort(accountOrder(active)) };
    } finally {
      this.markReady();
    }
  }

  list(): readonly ServerAccount[] {
    if (this.embedded === undefined) return this.accounts.servers;
    return [...this.accounts.servers, this.embeddedAccount(this.embedded)].sort(accountOrder(this.active()));
  }

  /**
   * The active account (switch accounts spec §2): signed in, or `null` when no account is. Inside a server it is
   * the embedder's account while the browser session lasts (ruling 6).
   */
  active(): AccountRef | null {
    const embedded = this.embedded;
    if (embedded !== undefined && embedded.credential() !== undefined && embedded.userId !== '')
      return { url: embedded.origin, userId: embedded.userId };
    return this.accounts.active;
  }

  /**
   * The account `target` names: exactly, for an {@link AccountRef}; for a URL alone, that server's active
   * account, else its most recently active signed-in one, else any (ruling 1). `undefined` when there is none.
   */
  accountFor(target: AccountTarget): ServerAccount | undefined {
    if (typeof target === 'string') {
      const origin = normalizeServerUrl(target);
      return this.list().find((server) => server.url === origin);
    }
    const ref = { url: normalizeServerUrl(target.url), userId: target.userId };
    return this.list().find((server) => sameAccount(server, ref));
  }

  /**
   * Makes a signed-in account the active one and stamps `lastActiveAt`, which orders *Switch accounts*. Inside a
   * server, the embedder's account is active already; another account the browser holds is the browser's to
   * switch to.
   *
   * @throws WirebenchError `account-unknown-server` | `account-signed-out` | {@link ACCOUNT_SWITCH_IN_BROWSER}
   */
  async setActive(target: AccountRef): Promise<AccountRef> {
    const ref = { url: normalizeServerUrl(target.url), userId: target.userId };
    const embedded = this.embedded;
    if (embedded !== undefined && ref.url === embedded.origin) {
      if (ref.userId === embedded.userId) return ref;
      // Which other people the browser holds only the page knows (it reads `GET /me/accounts` with its cookie).
      throw new WirebenchError(ACCOUNT_SWITCH_IN_BROWSER, 'Switch to this account in the browser', {
        details: { userId: ref.userId },
      });
    }
    const account = this.find(ref);
    if (account === undefined) throw new WirebenchError('account-unknown-server', `No account for ${ref.url}`);
    if (account.signedOut === true) throw new WirebenchError('account-signed-out', `Sign in to ${ref.url} first.`);
    await this.write(ref, { ...account, lastActiveAt: this.nowIso() }, ref);
    return ref;
  }

  onChange(listener: (servers: readonly ServerAccount[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async probe(url: string): Promise<{ readonly url: string; readonly meta: MetaResponse }> {
    const origin = normalizeServerUrl(url);
    return { url: origin, meta: await this.deps.client.meta(origin) };
  }

  async signInLocal(input: {
    readonly url: string;
    /** An email or a username, as typed. */
    readonly identifier: string;
    readonly password: string;
    readonly deviceName?: string;
  }): Promise<ServerAccount> {
    const origin = this.notEmbedded(normalizeServerUrl(input.url));
    const deviceName = this.deviceName(input.deviceName);
    // User profile spec §5: the server tells an email (it holds `@`) from a username.
    const response = await this.deps.client.signInLocal(origin, {
      identifier: input.identifier,
      password: input.password,
      device: { name: deviceName },
    });
    return this.store(origin, response, deviceName);
  }

  async lookupInvitation(input: { readonly url: string; readonly secret: string }): Promise<InvitationLookupResponse> {
    return this.deps.client.lookupInvitation(normalizeServerUrl(input.url), input.secret);
  }

  async acceptInvitation(input: {
    readonly url: string;
    readonly secret: string;
    readonly displayName: string;
    readonly password: string;
    readonly deviceName?: string;
  }): Promise<ServerAccount> {
    const origin = this.notEmbedded(normalizeServerUrl(input.url));
    const deviceName = this.deviceName(input.deviceName);
    const response = await this.deps.client.acceptInvitation(origin, {
      secret: input.secret,
      displayName: input.displayName,
      password: input.password,
      device: { name: deviceName },
    });
    return this.store(origin, response, deviceName);
  }

  /**
   * The OIDC hand-off (§3.8): open the loopback first because the server needs its port, then
   * ask the server to start a flow, send the browser to the URL the server returned (never one
   * we built), wait for the grant on the loopback, and trade it plus the PKCE verifier for a
   * device token. One flow at a time, as the OAuth2 request flow behaves.
   */
  startOidc(input: { readonly url: string; readonly deviceName?: string }): Promise<ServerAccount> {
    return this.browserSignIn('oidc', input);
  }

  /** The SAML hand-off (saml-scim spec §3.2, §3.7): the same loopback flow on the server's SAML paths. */
  startSaml(input: { readonly url: string; readonly deviceName?: string }): Promise<ServerAccount> {
    return this.browserSignIn('saml', input);
  }

  private async browserSignIn(
    kind: 'oidc' | 'saml',
    input: { readonly url: string; readonly deviceName?: string },
  ): Promise<ServerAccount> {
    this.notEmbedded(normalizeServerUrl(input.url));
    if (this.pending !== undefined || this.starting)
      throw new WirebenchError('account-sign-in-pending', 'A sign-in is already waiting for the browser');
    // Guards the window between this check and the loopback binding below, which is async: two
    // calls in the same tick must not both pass the check above.
    this.starting = true;
    this.cancelRequested = false;
    const origin = normalizeServerUrl(input.url);
    const deviceName = this.deviceName(input.deviceName);
    const pair = pkce();
    let flowId: string | undefined;
    let listener: LoopbackCallback;
    try {
      listener = await (this.deps.loopback ?? startLoopbackCallback)({
        expected: { name: 'flow', value: () => flowId },
        timeoutMs: SIGN_IN_TIMEOUT_MS,
        describe: (params) =>
          params.get('grant') !== null
            ? { ok: true, message: 'Signed in. You can close this tab and go back to Wirebench.' }
            : {
                ok: false,
                message: `Wirebench could not sign you in (${params.get('error') ?? 'no grant'}). You can close this tab.`,
              },
      });
    } catch (error) {
      this.starting = false;
      throw error;
    }
    this.starting = false;
    this.pending = listener;
    void listener.result.catch(() => undefined);
    if (this.cancelRequested) listener.cancel();
    try {
      const body = { device: { name: deviceName }, codeChallenge: pair.challenge, loopbackPort: listener.port };
      const started = await (kind === 'saml'
        ? this.deps.client.startSaml(origin, body)
        : this.deps.client.startOidc(origin, body));
      flowId = started.flowId;
      await this.deps.openExternal(started.authorizationUrl);
      const params = await listener.result;
      const error = params.get('error');
      // The loopback query parameter comes from whatever answered on localhost, not the server;
      // it becomes a WirebenchError code the renderer switches on (SIGN_IN_MESSAGES), so an
      // arbitrary value must not pass through as one — only a code this app actually recognises.
      if (error !== null) {
        const known = error.startsWith('saml-') ? 'identity-saml-refused' : error;
        const code = known in LOOPBACK_MESSAGES ? known : 'account-sign-in-failed';
        throw new WirebenchError(code, LOOPBACK_MESSAGES[known] ?? 'The sign-in was refused.');
      }
      const grant = params.get('grant');
      if (grant === null) throw new WirebenchError('account-sign-in-failed', 'The browser came back without a grant.');
      const complete = { flowId: started.flowId, grant, codeVerifier: pair.verifier };
      const response = await (kind === 'saml'
        ? this.deps.client.completeSaml(origin, complete)
        : this.deps.client.completeOidc(origin, complete));
      return await this.store(origin, response, deviceName);
    } catch (error) {
      listener.cancel();
      if (error instanceof WirebenchError && error.code === 'loopback-timeout')
        throw new WirebenchError('account-sign-in-timeout', 'The sign-in was not completed in time');
      if (error instanceof WirebenchError && error.code === 'loopback-cancelled')
        throw new WirebenchError('account-sign-in-cancelled', 'The sign-in was cancelled');
      throw error;
    } finally {
      this.pending = undefined;
    }
  }

  cancelSignIn(): { readonly cancelled: boolean } {
    if (this.pending !== undefined) {
      this.pending.cancel();
      return { cancelled: true };
    }
    // Between the synchronous `starting` guard and the loopback actually binding: nothing to
    // cancel yet, but the request is remembered and honoured as soon as it does.
    if (this.starting) {
      this.cancelRequested = true;
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  /**
   * Best effort on the server; the token is gone locally either way (§3.8). Signing the active account out makes
   * the most recently active other signed-in account active, or none (switch accounts spec §2).
   */
  async signOut(target: AccountTarget): Promise<void> {
    const origin = this.notEmbedded(normalizeServerUrl(typeof target === 'string' ? target : target.url));
    const account = this.findTarget(target);
    if (account === undefined) throw new WirebenchError('account-unknown-server', `No account for ${origin}`);
    const token = await this.deps.secrets.get(account.tokenRef);
    if (token !== undefined && account.signedOut !== true) {
      await this.deps.client.signOut(origin, token).catch(() => undefined);
    }
    await this.deps.secrets.delete(account.tokenRef);
    await this.markOut(account);
  }

  async remove(target: AccountTarget): Promise<void> {
    this.notEmbedded(normalizeServerUrl(typeof target === 'string' ? target : target.url));
    const account = this.findTarget(target);
    if (account === undefined) return;
    if (account.signedOut !== true) await this.signOut(refOf(account));
    await this.deps.secrets.delete(account.tokenRef).catch(() => undefined);
    await this.persist({
      ...this.accounts,
      servers: this.accounts.servers.filter((server) => !sameAccount(server, account)),
    });
  }

  /** The device token of an account, for the modules that call its server; `undefined` when signed out. */
  async tokenFor(target: AccountTarget): Promise<string | undefined> {
    const origin = normalizeServerUrl(typeof target === 'string' ? target : target.url);
    if (origin === this.embedded?.origin) {
      if (typeof target !== 'string' && target.userId !== this.embedded.userId) return undefined;
      return this.embedded.credential();
    }
    const account = this.findTarget(target);
    if (account === undefined || account.signedOut === true) return undefined;
    return this.deps.secrets.get(account.tokenRef);
  }

  /**
   * The server said `identity-unauthenticated`: the account shows as signed out, nothing retries.
   * Fire-and-forget by design (callers are synchronous IPC handlers); a failed write is not
   * surfaced here, but memory already reflects the intent and the next successful write persists
   * it (see {@link persist}), so this never becomes an unhandled rejection.
   */
  markSignedOut(target: AccountTarget): void {
    // The embedder ends the sessions it signed in; a refused call changes nothing here.
    const account = this.findTarget(target);
    if (account === undefined || account.signedOut === true) return;
    this.markOut(account).catch(() => undefined);
  }

  /**
   * Asks the server who the token belongs to. `identity-unauthenticated` (revoked, expired,
   * device removed) marks the account signed out (§3.8); a fresh display name or email is taken
   * over; any other failure — offline, a proxy in the way — changes nothing, so a laptop on a
   * train does not lose its session. Never retried: one call, one answer.
   */
  async refresh(target: AccountTarget): Promise<void> {
    const origin = normalizeServerUrl(typeof target === 'string' ? target : target.url);
    if (origin === this.embedded?.origin) {
      await this.refreshEmbedded(this.embedded);
      return;
    }
    const account = this.findTarget(target);
    if (account === undefined || account.signedOut === true) return;
    try {
      const token = await this.deps.secrets.get(account.tokenRef);
      if (token === undefined) {
        await this.markOut(account);
        return;
      }
      const me = await this.deps.client.me(account.url, token);
      const next = withProfile({ ...account, email: me.user.email }, profileFieldsOf(me.user));
      if (next !== undefined || me.user.email !== account.email) {
        await this.write(refOf(account), next ?? { ...account, email: me.user.email });
      }
    } catch (error) {
      if (error instanceof WirebenchError && error.code === 'identity-unauthenticated') {
        await this.deps.secrets.delete(account.tokenRef).catch(() => undefined);
        await this.markOut(account);
      }
      // Any other failure (a keychain error reading the token, a network error from `me`) changes
      // nothing, same as it always has for a network failure — a keychain hiccup must not sign
      // the account out.
    }
  }

  /**
   * The server answered with your profile (`GET` or `PATCH /me`, an image upload or removal): the stored
   * account takes the name, username and photo without asking `me` again, so the Accounts list and the account
   * menu follow. The embedder's account changes in memory only, as it is never stored. Nothing changed, nothing
   * is written and no listener is told.
   */
  async setProfile(target: AccountTarget, fields: AccountProfileFields): Promise<void> {
    const origin = normalizeServerUrl(typeof target === 'string' ? target : target.url);
    if (origin === this.embedded?.origin) {
      if (typeof target !== 'string' && target.userId !== this.embedded.userId) return;
      if (this.applyEmbeddedProfile(this.embedded, fields)) this.notify();
      return;
    }
    const account = this.findTarget(target);
    const next = account === undefined ? undefined : withProfile(account, fields);
    if (account === undefined || next === undefined) return;
    await this.write(refOf(account), next);
  }

  /** {@link refresh} for every signed-in account, in parallel; called once after {@link load}. */
  async refreshAll(): Promise<void> {
    await Promise.all([
      ...this.accounts.servers
        .filter((server) => server.signedOut !== true)
        .map((server) => this.refresh(refOf(server))),
      ...(this.embedded !== undefined ? [this.refreshEmbedded(this.embedded)] : []),
    ]);
  }

  /**
   * The embedder's account as the rest of the host sees it: signed out while there is no credential. Its
   * device is the browser the embedder's session belongs to.
   */
  private embeddedAccount(embedded: EmbeddedAccount): ServerAccount {
    return {
      url: embedded.origin,
      userId: embedded.userId,
      email: embedded.email,
      displayName: embedded.displayName,
      deviceName: 'Web browser',
      tokenRef: embedded.tokenRef,
      ...(embedded.credential() === undefined ? { signedOut: true as const } : {}),
      addedAt: embedded.addedAt,
      ...(embedded.username !== null ? { username: embedded.username } : {}),
      ...(embedded.photo !== null ? { photo: embedded.photo } : {}),
    };
  }

  /** {@link setProfile} on the embedder's account; true when anything changed. */
  private applyEmbeddedProfile(embedded: EmbeddedAccount, fields: AccountProfileFields): boolean {
    let changed = false;
    if (fields.displayName !== undefined && fields.displayName !== embedded.displayName) {
      embedded.displayName = fields.displayName;
      changed = true;
    }
    if (fields.username !== undefined && fields.username !== embedded.username) {
      embedded.username = fields.username;
      changed = true;
    }
    if (fields.photo !== undefined && fields.photo?.version !== embedded.photo?.version) {
      embedded.photo = fields.photo === null ? null : { version: fields.photo.version };
      changed = true;
    }
    return changed;
  }

  /**
   * Takes in the embedder's current credential: a new one gets a new ref, so the live client reconnects
   * with it, and `me` names whose it is. A refusal changes nothing: the embedder ends its sessions itself.
   */
  private async refreshEmbedded(embedded: EmbeddedAccount): Promise<void> {
    const token = embedded.credential();
    let changed = false;
    if (token !== embedded.token) {
      embedded.token = token;
      embedded.tokenRef = freshTokenRef();
      changed = true;
    }
    if (token !== undefined) {
      try {
        const me = await this.deps.client.me(embedded.origin, token);
        if (me.user.id !== embedded.userId || me.user.email !== embedded.email) {
          embedded.userId = me.user.id;
          embedded.email = me.user.email;
          changed = true;
        }
        if (this.applyEmbeddedProfile(embedded, profileFieldsOf(me.user))) changed = true;
      } catch {
        // Offline or refused: what the embedder says about its session is what counts.
      }
    }
    if (changed) this.notify();
  }

  /** `origin`, unless it is the embedder's account, which only the embedder may sign in or out. */
  private notEmbedded(origin: string): string {
    if (origin === this.embedded?.origin) {
      throw new WirebenchError(
        ACCOUNT_MANAGED_BY_SERVER,
        'This server signs you in itself; sign in or out from its own page, not from here',
      );
    }
    return origin;
  }

  private notify(): void {
    const servers = this.list();
    for (const listener of this.listeners) listener(servers);
  }

  private deviceName(given: string | undefined): string {
    const name = given?.trim();
    return name !== undefined && name.length > 0 ? name : (this.deps.defaultDeviceName ?? hostname)();
  }

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  /** A stored account, exactly (never the embedder's). */
  private find(ref: AccountRef): ServerAccount | undefined {
    return this.accounts.servers.find((server) => sameAccount(server, ref));
  }

  /** A stored account by {@link AccountTarget}; a URL alone picks as {@link accountFor} does. */
  private findTarget(target: AccountTarget): ServerAccount | undefined {
    if (typeof target === 'string') {
      const origin = normalizeServerUrl(target);
      return this.accounts.servers.find((server) => server.url === origin);
    }
    return this.find({ url: normalizeServerUrl(target.url), userId: target.userId });
  }

  /**
   * A new sign-in is its own account: signing in to a server as a second person adds one, as the same person
   * replaces that person's token. Either way it becomes the active account.
   */
  private async store(origin: string, response: SignInResponse, deviceName: string): Promise<ServerAccount> {
    const ref = { url: origin, userId: response.user.id };
    const previous = this.find(ref);
    if (previous !== undefined) await this.deps.secrets.delete(previous.tokenRef).catch(() => undefined);
    const tokenRef = await this.deps.secrets.set(response.token, { label: tokenLabel(origin, ref.userId) });
    const now = this.nowIso();
    const account: ServerAccount = {
      url: origin,
      userId: response.user.id,
      email: response.user.email,
      displayName: response.user.displayName,
      deviceName,
      tokenRef,
      addedAt: previous?.addedAt ?? now,
      lastActiveAt: now,
    };
    const signedIn = withProfile(account, profileFieldsOf(response.user)) ?? account;
    await this.write(ref, signedIn, ref);
    return signedIn;
  }

  /** `account` signed out: the active account passes to the most recently active other signed-in one. */
  private async markOut(account: ServerAccount): Promise<void> {
    const ref = refOf(account);
    const { active } = this.accounts;
    const servers = this.accounts.servers.map((server) =>
      sameAccount(server, ref) ? { ...server, signedOut: true as const } : server,
    );
    const next = active !== null && sameAccount(active, ref) ? mostRecentSignedIn(servers, ref) : active;
    await this.write(ref, { ...account, signedOut: true }, next);
  }

  /** Puts `account` in place of the entry `ref` names (or adds it); `active` changes the active account. */
  private async write(
    ref: AccountRef,
    account: ServerAccount,
    active: AccountRef | null = this.accounts.active,
  ): Promise<void> {
    const others = this.accounts.servers.filter((server) => !sameAccount(server, ref));
    await this.persist({ ...this.accounts, active, servers: [...others, account] });
  }

  private async persist(proposed: AccountsFile): Promise<void> {
    // Switch accounts spec §2: the active account is a signed-in entry whenever there is one.
    const wanted = proposed.active;
    const named = wanted === null ? undefined : proposed.servers.find((server) => sameAccount(server, wanted));
    const active = named !== undefined && named.signedOut !== true ? wanted : mostRecentSignedIn(proposed.servers);
    const next: AccountsFile = { ...proposed, active, servers: [...proposed.servers].sort(accountOrder(active)) };
    // Updated in memory before the write lands, so a synchronous caller of `markSignedOut`
    // (fire-and-forget) sees `list()` reflect the change immediately, not after the disk I/O.
    // Memory always reflects the latest intent; if the write below fails, the caller that
    // awaited this call sees the rejection, and the next successful write persists the state
    // memory already holds — nothing here is ever logged, this snapshot carries no token.
    this.accounts = next;
    this.notify();
    // Chained on the previous write (not raced against it): two persist() calls in flight — an
    // un-awaited markSignedOut followed by remove/signOut, or refreshAll's parallel refreshes —
    // must land on disk in call order, or an older snapshot's rename could finish last and
    // resurrect state a later call already removed. Each link captures its own `next` at call
    // time, so the file always ends up holding the last snapshot taken.
    const write = this.writing.then(async () => {
      await mkdir(this.deps.userDataDir, { recursive: true });
      await writeAtomic(this.file, stringifyYaml(next, { lineWidth: 0 }));
    });
    // The chain itself must never reject (or every later write would stay stuck on a rejected
    // link); each caller still observes its own failure through `write` below.
    this.writing = write.catch(() => undefined);
    await write;
  }
}
