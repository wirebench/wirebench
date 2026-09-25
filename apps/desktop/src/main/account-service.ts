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

  constructor(private readonly deps: AccountServiceDeps) {
    this.file = join(deps.userDataDir, ACCOUNTS_FILE);
  }

  async load(): Promise<void> {
    let document: unknown;
    try {
      document = parseYaml(await readFile(this.file, 'utf8'));
    } catch {
      document = undefined;
    }
    this.accounts = parseAccountsFile(document);
  }

  list(): readonly ServerAccount[] {
    return this.accounts.servers;
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
    const origin = normalizeServerUrl(input.url);
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
    const origin = normalizeServerUrl(input.url);
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
  async startOidc(input: { readonly url: string; readonly deviceName?: string }): Promise<ServerAccount> {
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
      const started = await this.deps.client.startOidc(origin, {
        device: { name: deviceName },
        codeChallenge: pair.challenge,
        loopbackPort: listener.port,
      });
      flowId = started.flowId;
      await this.deps.openExternal(started.authorizationUrl);
      const params = await listener.result;
      const error = params.get('error');
      // The loopback query parameter comes from whatever answered on localhost, not the server;
      // it becomes a WirebenchError code the renderer switches on (SIGN_IN_MESSAGES), so an
      // arbitrary value must not pass through as one — only a code this app actually recognises.
      if (error !== null) {
        const code = error in LOOPBACK_MESSAGES ? error : 'account-sign-in-failed';
        throw new WirebenchError(code, LOOPBACK_MESSAGES[error] ?? 'The sign-in was refused.');
      }
      const grant = params.get('grant');
      if (grant === null) throw new WirebenchError('account-sign-in-failed', 'The browser came back without a grant.');
      const response = await this.deps.client.completeOidc(origin, {
        flowId: started.flowId,
        grant,
        codeVerifier: pair.verifier,
      });
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
    const origin = normalizeServerUrl(url);
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
    const origin = normalizeServerUrl(url);
    const account = this.find(origin);
    if (account === undefined) return;
    if (account.signedOut !== true) await this.signOut(origin);
    await this.deps.secrets.delete(account.tokenRef).catch(() => undefined);
    await this.persist({ ...this.accounts, servers: this.accounts.servers.filter((server) => server.url !== origin) });
  }

  /** The device token for a server, for the modules that call it; `undefined` when signed out. */
  async tokenFor(url: string): Promise<string | undefined> {
    const account = this.find(normalizeServerUrl(url));
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
    const account = this.find(normalizeServerUrl(url));
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
    await Promise.all(
      this.accounts.servers.filter((server) => server.signedOut !== true).map((server) => this.refresh(server.url)),
    );
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
    for (const listener of this.listeners) listener(next.servers);
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
