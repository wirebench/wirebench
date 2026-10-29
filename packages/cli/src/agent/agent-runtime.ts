/**
 * The typed boundary between the CLI and the agent bundle (hosted edition spec §18.6). `@wirebench/host` and
 * `@wirebench/agent` are source-only (ADR-0033), so the build bundles them with esbuild into
 * `dist/agent/bundle.js` (`scripts/bundle-agent.mjs`), and the CLI reaches them only through this file: the
 * shapes below, which `agent-bundle/entry.ts` is typechecked against, and {@link loadAgentBundle}, which
 * imports the bundle only for `wirebench agent`. Nothing here imports either package.
 */

/** A paired server, as `status` lists it. */
export interface AgentPairingRow {
  readonly pairingId: string;
  readonly serverUrl: string;
  readonly origin: string;
  readonly email: string;
  readonly sshOptIn: boolean;
  readonly createdAt: string;
  /** The port the server was last told. */
  readonly port?: number;
}

/** `fetch`, as the agent calls its servers. */
export type AgentBundleFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What every bundle call is given: the agent's folder and the CLI's own facts. */
export interface AgentBundleInput {
  /** The agent's folder (`$WIREBENCH_AGENT_HOME` or `~/.wirebench/agent`). */
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  /** The CLI's version. */
  readonly version: string;
  /** `globalThis.fetch` when absent. */
  readonly fetch?: AgentBundleFetch;
}

export interface HeadlessAgent {
  readonly port: number;
  readonly capabilities: readonly string[];
  readonly pairings: readonly AgentPairingRow[];
  /** Ends every tab's socket, stops listening and shuts the host down. */
  close(): Promise<void>;
}

export interface AgentStatusReport {
  readonly pairings: readonly AgentPairingRow[];
  /** The `${#System#…}` names a paired server's sends may read here. */
  readonly allowedEnv: readonly string[];
}

/** What the bundle exports. */
export interface AgentBundle {
  /** Starts the agent on the first free port of `ports` (47615–47634 when absent). */
  startHeadlessAgent(
    input: AgentBundleInput & {
      readonly ports?: readonly number[];
      readonly log?: (message: string, error: unknown) => void;
    },
  ): Promise<HeadlessAgent>;
  pairAgent(
    input: AgentBundleInput & {
      readonly code: string;
      readonly serverUrl: string;
      readonly sshOptIn: boolean;
      readonly port: number;
    },
  ): Promise<{ readonly pairingId: string; readonly origin: string; readonly email: string }>;
  /** Unpairs every pairing, or those of `serverUrl`, at the server and here; returns the ones removed. */
  unpairAgent(input: AgentBundleInput & { readonly serverUrl?: string }): Promise<readonly AgentPairingRow[]>;
  agentStatus(input: AgentBundleInput): Promise<AgentStatusReport>;
  /**
   * Adds and removes names on the allowlist; returns the list now.
   *
   * @throws AgentNotPairedError (by name) before the first pairing, which is where the list is kept.
   */
  changeAllowedEnv(
    input: AgentBundleInput & { readonly add?: readonly string[]; readonly remove?: readonly string[] },
  ): Promise<readonly string[]>;
}

/** The built bundle, beside this file's compiled output; the same path from `src/agent/` under a test. */
export const AGENT_BUNDLE_URL = new URL('../../dist/agent/bundle.js', import.meta.url);

const loaded = new Map<string, Promise<AgentBundle>>();

/**
 * The bundle's exports, imported once.
 *
 * @throws Error when the bundle is missing or is not one this CLI built.
 */
export async function loadAgentBundle(url: URL = AGENT_BUNDLE_URL): Promise<AgentBundle> {
  let loading = loaded.get(url.href);
  if (loading === undefined) {
    loading = importBundle(url.href);
    loaded.set(url.href, loading);
    // A failed import is not cached, so a later build can still be picked up.
    loading.catch(() => loaded.delete(url.href));
  }
  return await loading;
}

const EXPORTS = ['startHeadlessAgent', 'pairAgent', 'unpairAgent', 'agentStatus', 'changeAllowedEnv'] as const;

async function importBundle(href: string): Promise<AgentBundle> {
  let module: Record<string, unknown>;
  try {
    module = (await import(href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error('The agent bundle could not be loaded; build the CLI (`pnpm build`) first', { cause: error });
  }
  for (const name of EXPORTS) {
    if (typeof module[name] !== 'function') throw new Error(`The agent bundle does not export ${name}`);
  }
  return module as unknown as AgentBundle;
}
