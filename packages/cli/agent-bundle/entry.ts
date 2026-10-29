/**
 * The agent bundle's entry (hosted edition spec §18.6): `scripts/bundle-agent.mjs` bundles this file, with
 * `@wirebench/host`, `@wirebench/agent` and `@wirebench/wire`, into `dist/agent/bundle.js`, which
 * `src/agent/agent-runtime.ts` imports for `wirebench agent` alone. Only the host's package root is imported
 * (`pnpm check:host-boundary`).
 *
 * `tsconfig.json` beside this file typechecks it against the real types: that is what holds the CLI's
 * structural copies (`AgentNodePlatform`, `AgentBundle`) to `HostPlatform` and the agent's own shapes.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_FIRST_PORT as FIRST_PORT,
  AgentServerError,
  agentSendHandlers,
  normaliseServerUrl,
  openPairingStore,
  pair,
  PAIRINGS_FILE,
  startAgent,
  unpair,
  type AgentFetch,
  type Pairing,
  type PairingStore,
} from '@wirebench/agent';
import { createHost, type HostPlatform } from '@wirebench/host';
import type { AgentBundle, AgentBundleInput, AgentPairingRow, AgentUnpairOutcome } from '../src/agent/agent-runtime.js';
import { createAgentPlatform, kerberosLoads, openAgentHome } from '../src/agent/node-platform.js';
import { serverFetch } from '../src/agent/server-fetch.js';

export const AGENT_FIRST_PORT: AgentBundle['AGENT_FIRST_PORT'] = FIRST_PORT;

/** `changeAllowedEnv` before the first pairing: the list is kept in the pairings file, which does not exist yet. */
export class AgentNotPairedError extends Error {
  constructor() {
    super(
      'Pair this machine first (wirebench agent pair <code> --server <url>): the allowlist is kept with the pairings',
    );
    this.name = 'AgentNotPairedError';
  }
}

/** The platform for `input`, its folder and key checked (and made on the first run). */
async function platformFor(input: AgentBundleInput, kerberos: boolean): Promise<HostPlatform> {
  const key = await openAgentHome(input.home);
  const platform: HostPlatform = createAgentPlatform({
    home: input.home,
    key,
    version: input.version,
    kerberos,
    env: input.env,
  });
  return platform;
}

function fetchOf(input: AgentBundleInput): AgentFetch {
  return input.fetch ?? serverFetch(input.env);
}

/** The pairing store, without the Kerberos probe: only `startHeadlessAgent` needs the capabilities. */
async function storeFor(input: AgentBundleInput): Promise<PairingStore> {
  return await openPairingStore(await platformFor(input, false));
}

function rowOf(pairing: Pairing): AgentPairingRow {
  return { ...pairing };
}

export const startHeadlessAgent: AgentBundle['startHeadlessAgent'] = async (input) => {
  const platform = await platformFor(input, kerberosLoads());
  const log = input.log ?? (() => undefined);
  const store = await openPairingStore(platform, { log });
  const host = await createHost(platform);
  // No team-secrets hook: a send that reads one answers `team-secret-needs-approval`, pointing at the
  // desktop app (§18.5).
  const handlers = agentSendHandlers({ platform, store, log });
  let agent;
  try {
    agent = await startAgent({
      host,
      platform,
      store,
      fetch: fetchOf(input),
      handlers,
      log,
      ...(input.ports !== undefined ? { ports: input.ports } : {}),
    });
  } catch (error) {
    await host.shutdown();
    throw error;
  }
  const running = agent;
  return {
    port: running.port,
    capabilities: [...platform.capabilities],
    pairings: store.list().map(rowOf),
    close: async () => {
      await running.close();
      await host.shutdown();
    },
  };
};

export const pairAgent: AgentBundle['pairAgent'] = async (input) => {
  const store = await storeFor(input);
  return await pair({
    code: input.code,
    serverUrl: input.serverUrl,
    sshOptIn: input.sshOptIn,
    port: input.port,
    store,
    fetch: fetchOf(input),
  });
};

export const unpairAgent: AgentBundle['unpairAgent'] = async (input) => {
  const store = await storeFor(input);
  const fetch = fetchOf(input);
  const origin = input.serverUrl === undefined ? undefined : normaliseServerUrl(input.serverUrl);
  const chosen = store.list().filter((pairing) => origin === undefined || pairing.origin === origin);
  const outcomes: AgentUnpairOutcome[] = [];
  // Each pairing on its own: one server's refusal or absence must not keep the rest paired.
  for (const pairing of chosen) {
    const row = rowOf(pairing);
    if (input.local === true) {
      await store.remove(pairing.pairingId);
      outcomes.push({ pairing: row, outcome: 'local' });
      continue;
    }
    try {
      await unpair({ pairingId: pairing.pairingId, store, fetch });
      outcomes.push({ pairing: row, outcome: 'unpaired' });
    } catch (error) {
      if (error instanceof AgentServerError && error.code === 'unreachable') {
        // A server that is gone (or not reachable from here) would otherwise hold the pairing here forever.
        await store.remove(pairing.pairingId);
        outcomes.push({ pairing: row, outcome: 'dropped', message: error.message });
      } else {
        outcomes.push({
          pairing: row,
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return outcomes;
};

export const agentStatus: AgentBundle['agentStatus'] = async (input) => {
  const store = await storeFor(input);
  return { pairings: store.list().map(rowOf), allowedEnv: store.allowedSystemNames() };
};

export const changeAllowedEnv: AgentBundle['changeAllowedEnv'] = async (input) => {
  if (!existsSync(join(input.home, PAIRINGS_FILE))) throw new AgentNotPairedError();
  const store = await storeFor(input);
  const removing = new Set(input.remove ?? []);
  const next = [...store.allowedSystemNames(), ...(input.add ?? [])].filter((name) => !removing.has(name));
  await store.setAllowedSystemNames(next);
  return store.allowedSystemNames();
};
