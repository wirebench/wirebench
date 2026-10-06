/**
 * The session's issued-token cache (spec §4.1, plan amendment 5): one engine source for the whole
 * app, never persisted, plus what IPC needs to show, fetch and clear the token of the entry being
 * edited. Every send borrows `source` through its host, so a token fetched here is the one a send
 * of the same request finds, and the other way round.
 */
import { createIssuedTokenSource } from '@wirebench/engine';
import type { IssuedTokenSource, IssuedTokenTarget, TrustDeps, WssIssuedTokenEntry } from '@wirebench/engine';
import { recordSecretValue, redactSecretText } from './redact.js';
import type { IssuedTokenStatusWire } from '../shared/wire-types.js';

/** One issued-token entry of an outgoing configuration, and the request it is fetched for. */
export interface IssuedTokenLocator {
  readonly projectId: string;
  readonly configId: string;
  readonly entryIndex: number;
  /** The request whose endpoint and environment apply; the first that selects the configuration when absent. */
  readonly requestId?: string | undefined;
}

/** The entry a locator names, with the target and the dependencies a send of its request would use. */
export interface ResolvedIssuedToken {
  readonly entry: WssIssuedTokenEntry;
  readonly target: IssuedTokenTarget;
  readonly deps: TrustDeps;
}

export class IssuedTokensService {
  constructor(
    private readonly resolve: (locator: IssuedTokenLocator) => Promise<ResolvedIssuedToken>,
    /** The session's source. A test passes one whose `request` answers without a token service. */
    readonly source: IssuedTokenSource = createIssuedTokenSource({ onSecretValue: recordSecretValue }),
  ) {}

  async status(locator: IssuedTokenLocator, showSecrets: boolean): Promise<IssuedTokenStatusWire> {
    const { entry, target } = await this.resolve(locator);
    return this.statusOf(entry, target, showSecrets);
  }

  /** Fetch now: drops what is cached and asks the token service again. A failure is kept as `lastError`. */
  async fetch(locator: IssuedTokenLocator, showSecrets: boolean): Promise<IssuedTokenStatusWire> {
    const { entry, target, deps } = await this.resolve(locator);
    this.source.clear(entry, target);
    try {
      await this.source.get(entry, target, deps);
    } catch {
      // Kept as status.lastError, which the panel shows.
    }
    return this.statusOf(entry, target, showSecrets);
  }

  async clear(locator: IssuedTokenLocator, showSecrets: boolean): Promise<IssuedTokenStatusWire> {
    const { entry, target } = await this.resolve(locator);
    this.source.clear(entry, target);
    return this.statusOf(entry, target, showSecrets);
  }

  private statusOf(entry: WssIssuedTokenEntry, target: IssuedTokenTarget, showSecrets: boolean): IssuedTokenStatusWire {
    // The engine's status, plus the assertion itself when the session shows secrets.
    const status = this.source.status(entry, target);
    const token = showSecrets ? this.source.peek(entry, target) : undefined;
    // A fault may quote what was sent: every recorded secret value is masked unless secrets show.
    const lastError =
      status.lastError === undefined ? {} : { lastError: redactSecretText(status.lastError, { show: showSecrets }) };
    return { ...status, ...lastError, ...(token !== undefined ? { assertion: token.assertionXml } : {}) };
  }
}
