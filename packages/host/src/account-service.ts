/**
 * Who this installation is signed in as, per server (identity spec §3.8, §4.3, §5.3). Main owns
 * all of it: `accounts.yaml` (no token inside — only a secret-store ref), the token itself in the
 * secret store under `wirebench-server:<url>`, the browser hand-off for OIDC, and the rule that a
 * server answering `identity-unauthenticated` marks the account signed out rather than looping.
 * The renderer receives `ServerAccount` minus `tokenRef` (see `ipc/account.ts`).
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
  type AccountsFile,
  type InvitationLookupResponse,
  type MetaResponse,
  type ServerAccount,
  type SignInResponse,
} from '@wirebench/engine';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { startLoopbackCallback, type LoopbackCallback } from './loopback-callback.js';
import { normalizeServerUrl, type ServerClient } from './server-client.js';

export const ACCOUNTS_FILE = 'accounts.yaml';
export const TOKEN_LABEL_PREFIX = 'wirebench-server:';
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
  /**
   * A `sec_` ref no store holds, renewed whenever the credential changes: `LiveClients` reconnects on a
   * new ref, as it does after a desktop sign-in.
   */
  tokenRef: string;
  /** The credential the ref was made for; kept in memory only. */
  token: string | undefined;
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
  private accounts: AccountsFile = { version: ACCOUNTS_FILE_VERSION, servers: [] };
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
      this.accounts =
        embedded === undefined ? parsed : { ...parsed, servers: parsed.servers.filter((s) => s.url !== embedded) };
    } finally {
      this.markReady();
    }
  }

  list(): readonly ServerAccount[] {
    if (this.embedded === undefined) return this.accounts.servers;
    return [...this.accounts.servers, this.embeddedAccount(this.embedded)].sort((a, b) => a.url.localeCompare(b.url));
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
    readonly email: string;
    readonly password: string;
    readonly deviceName?: string;
  }): Promise<ServerAccount> {
    const origin = this.notEmbedded(normalizeServerUrl(input.url));
    const deviceName = this.deviceName(input.deviceName);
    const response = await this.deps.client.signInLocal(origin, {
      email: input.email,
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

  /** Best effort on the server; the token is gone locally either way (§3.8). */
  async signOut(url: string): Promise<void> {
    const origin = this.notEmbedded(normalizeServerUrl(url));
    const account = this.find(origin);
    if (account === undefined) throw new WirebenchError('account-unknown-server', `No account for ${origin}`);
    const token = await this.deps.secrets.get(account.tokenRef);
    if (token !== undefined && account.signedOut !== true) {
      await this.deps.client.signOut(origin, token).catch(() => undefined);
    }
    await this.deps.secrets.delete(account.tokenRef);
    await this.replace(origin, { ...account, signedOut: true });
  }

  async remove(url: string): Promise<void> {
    const origin = this.notEmbedded(normalizeServerUrl(url));
    const account = this.find(origin);
    if (account === undefined) return;
    if (account.signedOut !== true) await this.signOut(origin);
    await this.deps.secrets.delete(account.tokenRef).catch(() => undefined);
    await this.persist({ ...this.accounts, servers: this.accounts.servers.filter((server) => server.url !== origin) });
  }

  /** The device token for a server, for the modules that call it; `undefined` when signed out. */
  async tokenFor(url: string): Promise<string | undefined> {
    const origin = normalizeServerUrl(url);
    if (origin === this.embedded?.origin) return this.embedded.credential();
    const account = this.find(origin);
    if (account === undefined || account.signedOut === true) return undefined;
    return this.deps.secrets.get(account.tokenRef);
  }

  /**
   * The server said `identity-unauthenticated`: the account shows as signed out, nothing retries.
   * Fire-and-forget by design (callers are synchronous IPC handlers); a failed write is not
   * surfaced here, but memory already reflects the intent and the next successful write persists
   * it (see {@link persist}), so this never becomes an unhandled rejection.
   */
  markSignedOut(url: string): void {
    // The embedder ends the sessions it signed in; a refused call changes nothing here.
    const account = this.find(normalizeServerUrl(url));
    if (account === undefined || account.signedOut === true) return;
    this.replace(account.url, { ...account, signedOut: true }).catch(() => undefined);
  }

  /**
   * Asks the server who the token belongs to. `identity-unauthenticated` (revoked, expired,
   * device removed) marks the account signed out (§3.8); a fresh display name or email is taken
   * over; any other failure — offline, a proxy in the way — changes nothing, so a laptop on a
   * train does not lose its session. Never retried: one call, one answer.
   */
  async refresh(url: string): Promise<void> {
    const origin = normalizeServerUrl(url);
    if (origin === this.embedded?.origin) {
      await this.refreshEmbedded(this.embedded);
      return;
    }
    const account = this.find(origin);
    if (account === undefined || account.signedOut === true) return;
    try {
      const token = await this.deps.secrets.get(account.tokenRef);
      if (token === undefined) {
        await this.replace(account.url, { ...account, signedOut: true });
        return;
      }
      const me = await this.deps.client.me(account.url, token);
      if (me.user.email !== account.email || me.user.displayName !== account.displayName) {
        await this.replace(account.url, { ...account, email: me.user.email, displayName: me.user.displayName });
      }
    } catch (error) {
      if (error instanceof WirebenchError && error.code === 'identity-unauthenticated') {
        await this.deps.secrets.delete(account.tokenRef).catch(() => undefined);
        await this.replace(account.url, { ...account, signedOut: true });
      }
      // Any other failure (a keychain error reading the token, a network error from `me`) changes
      // nothing, same as it always has for a network failure — a keychain hiccup must not sign
      // the account out.
    }
  }

  /** {@link refresh} for every signed-in account, in parallel; called once after {@link load}. */
  async refreshAll(): Promise<void> {
    await Promise.all([
      ...this.accounts.servers.filter((server) => server.signedOut !== true).map((server) => this.refresh(server.url)),
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
    };
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
        if (
          me.user.id !== embedded.userId ||
          me.user.email !== embedded.email ||
          me.user.displayName !== embedded.displayName
        ) {
          embedded.userId = me.user.id;
          embedded.email = me.user.email;
          embedded.displayName = me.user.displayName;
          changed = true;
        }
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

  private find(origin: string): ServerAccount | undefined {
    return this.accounts.servers.find((server) => server.url === origin);
  }

  private async store(origin: string, response: SignInResponse, deviceName: string): Promise<ServerAccount> {
    const previous = this.find(origin);
    if (previous !== undefined) await this.deps.secrets.delete(previous.tokenRef).catch(() => undefined);
    const tokenRef = await this.deps.secrets.set(response.token, { label: `${TOKEN_LABEL_PREFIX}${origin}` });
    const account: ServerAccount = {
      url: origin,
      userId: response.user.id,
      email: response.user.email,
      displayName: response.user.displayName,
      deviceName,
      tokenRef,
      addedAt: previous?.addedAt ?? (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    await this.replace(origin, account);
    return account;
  }

  private async replace(origin: string, account: ServerAccount): Promise<void> {
    const others = this.accounts.servers.filter((server) => server.url !== origin);
    await this.persist({ ...this.accounts, servers: [...others, account].sort((a, b) => a.url.localeCompare(b.url)) });
  }

  private async persist(next: AccountsFile): Promise<void> {
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
