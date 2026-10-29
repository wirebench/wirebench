/**
 * The desktop app as this machine's local agent (hosted edition spec §18.2, §18.5; ADR-0035). The agent runs
 * in the main process, over the app's own host, but only while this machine has a pairing: without one no
 * port is opened and nothing changes for anyone who never pairs. It starts after the IPC is bound when the
 * pairings file holds a pairing, starts when *Pair this machine…* pairs, and stops when the last pairing goes
 * (here, or from `wirebench agent unpair` beside it) and when the app quits.
 *
 * Its controls are the `machineAgent.*` channels, which this module registers on the desktop's own table:
 * a browser caller never reaches them (the agent's socket serves `agent.*` alone, and a server host refuses
 * the group). A bundle send here resolves team secrets through the host's hook, from this machine's own
 * approved, imported values.
 *
 * Kept free of `electron`: `index.ts` hands it the platform, the host and Electron's `net.fetch`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_FIRST_PORT,
  agentSendHandlers,
  AgentServerError,
  openPairingStore,
  pair,
  PAIRINGS_FILE,
  startAgent,
  unpair,
  type AgentFetch,
  type AgentHandler,
  type PairingStore,
  type RunningAgent,
  type StartAgentOptions,
} from '@wirebench/agent';
import { WirebenchError } from '@wirebench/engine';
import type { HandlerTable, Host, HostPlatform } from '@wirebench/host';
import { registerHandler } from '@wirebench/host/desktop';
import type { MachineAgentPairingWire, MachineAgentStatusWire } from '@wirebench/wire/agent';
import { channels } from '@wirebench/wire/ipc';

export interface MachineAgentDeps {
  readonly host: Host;
  readonly platform: HostPlatform;
  /** How the agent reaches its servers: Electron's `net.fetch`, so the system proxy applies. */
  readonly fetch?: AgentFetch;
  /** The ports to try; the agent's own range when absent (tests pass a free one). */
  readonly ports?: readonly number[];
  /** `startAgent`, replaceable in tests. */
  readonly start?: (options: StartAgentOptions) => Promise<RunningAgent>;
  /** Messages only, never a code, a key or a value. */
  readonly log?: (message: string, error?: unknown) => void;
}

/** An agent server's refusal as an error the renderer shows; its message is already safe to show. */
function shown(error: unknown): unknown {
  if (error instanceof AgentServerError) {
    return new WirebenchError(`agent-${error.code}`, error.message, {
      ...(error.status !== undefined ? { details: { status: error.status } } : {}),
    });
  }
  return error;
}

export class MachineAgent {
  private running: RunningAgent | undefined;
  private handlers: ReadonlyMap<string, AgentHandler> | undefined;
  /** One start or stop at a time: a pairing and an unpairing never race each other. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly deps: MachineAgentDeps,
    private readonly store: PairingStore | undefined,
  ) {
    store?.onChange(() => {
      void this.sync();
    });
  }

  /**
   * Opens the pairings store. A file this app cannot read (or a key it cannot unseal) is logged and leaves
   * the agent off, rather than costing the app its start.
   */
  static async open(deps: MachineAgentDeps): Promise<MachineAgent> {
    const log = deps.log ?? (() => undefined);
    let store: PairingStore | undefined;
    try {
      store = await openPairingStore(deps.platform, { log });
    } catch (error) {
      log('the agent pairings could not be read; the agent stays off', error);
    }
    return new MachineAgent(deps, store);
  }

  /** The port the agent listens on; `undefined` while it is off. */
  get port(): number | undefined {
    return this.running?.port;
  }

  /** Starts the agent when there is a pairing, stops it when there is none; resolves once that is done. */
  sync(): Promise<void> {
    const next = this.queue.then(async () => {
      const store = this.store;
      const wanted = !this.closed && store !== undefined && store.list().length > 0;
      if (wanted && this.running === undefined) {
        this.running = await (this.deps.start ?? startAgent)({
          host: this.deps.host,
          platform: this.deps.platform,
          store,
          handlers: this.sendHandlers(store),
          teamSecrets: true,
          ...(this.deps.fetch !== undefined ? { fetch: this.deps.fetch } : {}),
          ...(this.deps.ports !== undefined ? { ports: this.deps.ports } : {}),
          ...(this.deps.log !== undefined ? { log: this.deps.log } : {}),
        });
      } else if (!wanted && this.running !== undefined) {
        const running = this.running;
        this.running = undefined;
        await running.close();
      }
    });
    // A failed start (every port busy) is logged and tried again at the next change.
    this.queue = next.catch((error: unknown) => {
      this.deps.log?.('the agent could not start or stop', error);
    });
    return next;
  }

  /** Stops the agent for good: the app is quitting. */
  async close(): Promise<void> {
    this.closed = true;
    await this.sync().catch(() => undefined);
  }

  /** The send handlers, made once: making them sweeps the agent's temporary folder. */
  private sendHandlers(store: PairingStore): ReadonlyMap<string, AgentHandler> {
    this.handlers ??= agentSendHandlers({
      platform: this.deps.platform,
      store,
      teamSecrets: true,
      ...(this.deps.log !== undefined ? { log: this.deps.log } : {}),
    });
    return this.handlers;
  }

  private requireStore(): PairingStore {
    if (this.store === undefined) {
      throw new WirebenchError('agent-pairings-unreadable', 'This machine’s agent pairings could not be read');
    }
    return this.store;
  }

  private fetch(): AgentFetch {
    return this.deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async status(): Promise<MachineAgentStatusWire> {
    const store = this.store;
    if (store === undefined) return { pairings: [], paired: false, allowedSystemNames: [] };
    // A pairing made or removed by `wirebench agent` beside the app counts without a restart.
    await store.refresh().catch(() => undefined);
    const pairings = store.list().map((pairing): MachineAgentPairingWire => ({
      pairingId: pairing.pairingId,
      origin: pairing.origin,
      email: pairing.email,
      createdAt: pairing.createdAt,
      sshOptIn: pairing.sshOptIn,
      ...(pairing.port !== undefined ? { port: pairing.port } : {}),
    }));
    return {
      ...(this.running !== undefined ? { port: this.running.port } : {}),
      pairings,
      paired: existsSync(join(this.deps.platform.paths.userData(), PAIRINGS_FILE)),
      allowedSystemNames: [...store.allowedSystemNames()],
    };
  }

  /** Pairs with the code, then starts the agent (on the port the server was told, or reports the one it got). */
  async pair(request: { readonly serverUrl: string; readonly code: string }) {
    const store = this.requireStore();
    try {
      const result = await pair({
        code: request.code.trim(),
        serverUrl: request.serverUrl.trim(),
        // SSH through the agent is a later version's: nothing is opted in until something serves it.
        sshOptIn: false,
        port: this.running?.port ?? AGENT_FIRST_PORT,
        store,
        fetch: this.fetch(),
      });
      await this.sync();
      return result;
    } catch (error) {
      throw shown(error);
    }
  }

  /** Unpairs at the server and here, or here only (`local`); the agent stops with the last pairing. */
  async unpair(request: {
    readonly pairingId: string;
    readonly local?: boolean | undefined;
  }): Promise<MachineAgentStatusWire> {
    const store = this.requireStore();
    try {
      if (request.local === true) await store.remove(request.pairingId);
      else await unpair({ pairingId: request.pairingId, store, fetch: this.fetch() });
    } catch (error) {
      throw shown(error);
    }
    await this.sync();
    return await this.status();
  }

  async setAllowedSystemNames(names: readonly string[]): Promise<MachineAgentStatusWire> {
    const store = this.requireStore();
    if (!existsSync(join(this.deps.platform.paths.userData(), PAIRINGS_FILE))) {
      throw new WirebenchError(
        'agent-not-paired',
        'Pair this machine first: the allowed variables are kept with its pairings',
      );
    }
    await store.setAllowedSystemNames(names);
    return await this.status();
  }

  /** Registers the `machineAgent.*` channels on the desktop's own table, before it is bound. */
  register(table: HandlerTable): void {
    const group = channels.machineAgent;
    registerHandler(table, group.status, () => this.status());
    registerHandler(table, group.pair, (request) => this.pair(request));
    registerHandler(table, group.unpair, (request) => this.unpair(request));
    registerHandler(table, group.setAllowedSystemNames, (request) => this.setAllowedSystemNames(request.names));
  }
}
