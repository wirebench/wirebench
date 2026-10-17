import { readFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { WirebenchError, secretPseudoRef } from '@wirebench/engine';
import type { GetSecret } from '@wirebench/engine';
import {
  checkKnownHost,
  envSecretName,
  jumpChain,
  parseKnownHosts,
  proxyCredentialsOf,
  secretNameOf,
} from '@wirebench/ssh';
import type {
  DialOptions,
  HopCredentials,
  HostsFile,
  KnownHostEntry,
  MoshSettings,
  ResolvedHost,
  TcpTarget,
} from '@wirebench/ssh';
import { asWirebenchError } from './hosts-service.js';
import type { HostsService } from './hosts-service.js';
import type { SshQuickTarget } from '../shared/ssh-wire.js';

/**
 * A one-off server (#537) as a chain of one: a host of its own, alone in a file of its own, so no saved
 * host, group or default of hosts.yaml applies to it, beside the workspace's identities. It signs in with
 * the agent, which needs nothing stored.
 */
export function quickChain(
  file: HostsFile | undefined,
  hostId: string,
  quick: SshQuickTarget,
): readonly ResolvedHost[] {
  const name = quick.user === undefined ? quick.address : `${quick.user}@${quick.address}`;
  const alone: HostsFile = {
    version: 1,
    ...(file?.identities === undefined ? {} : { identities: file.identities }),
    groups: [],
    hosts: [
      {
        id: hostId,
        name,
        address: quick.address,
        tags: [],
        ssh: { ...(quick.user === undefined ? {} : { user: quick.user }), port: quick.port, auth: { kind: 'agent' } },
      },
    ],
  };
  try {
    return jumpChain(alone, hostId);
  } catch (error) {
    throw asWirebenchError(error);
  }
}

/** What the connect path reads: shared by the terminal (`SshService`) and Files (`SftpService`). */
export interface SshConnectDeps {
  /**
   * The `hosts.yaml` of the connecting window's workspace (multi-window: each window holds its own).
   * @throws WirebenchError when that window is gone
   */
  readonly hosts: (
    sender: WebContents,
  ) => Pick<HostsService, 'current' | 'list'> & Partial<Pick<HostsService, 'sshDefaults'>>;
  /**
   * The secret getter for the connecting window's workspace, taken when a connect begins and bound to the
   * workspace open then, so a switch mid-connect never hands one workspace's secrets to another's host.
   */
  readonly secretsFor: (sender: WebContents) => GetSecret;
  /** `userData/ssh-known-hosts.json`: per machine, never in the workspace tree. */
  readonly knownHostsFile: string;
  /** `SSH_AUTH_SOCK` (or `'pageant'` on Windows); undefined when no agent runs. */
  readonly agentSocket: () => string | undefined;
}

/** A key a connect refused, which that window may now trust (and nothing else). */
export interface Refusal extends KnownHostEntry {
  readonly kind: 'new' | 'changed';
  /** The stored fingerprint a `changed` key differed from. */
  readonly previous?: string;
  readonly at: number;
}

/** How long a refused key stays trustable without connecting again. */
export const REFUSAL_TTL_MS = 10 * 60 * 1000;

/** The same host and key type: the slot a known-hosts entry fills. */
export const sameSlot = (a: KnownHostEntry, b: KnownHostEntry): boolean => a.host === b.host && a.keyType === b.keyType;

/**
 * The keys each window's connects refused, by sender id: the only keys `ssh.trust` will record for it.
 * One store serves the terminal and Files, so a key refused to either is trusted from the same prompt.
 */
export class RefusalStore {
  private readonly refused = new Map<number, Refusal[]>();
  /** Bumped per window by {@link forget} (and for all by {@link clear}): a verifier made before records nothing. */
  private readonly generations = new Map<number, number>();
  private epoch = 0;

  /** `now` in milliseconds; tests inject a clock. */
  constructor(private readonly now: () => number = Date.now) {}

  /** The token a verifier takes when it is made; {@link record} with an older one keeps nothing. */
  generation(senderId: number): string {
    return `${this.epoch}:${this.generations.get(senderId) ?? 0}`;
  }

  /** Keeps `refusal` for that window, unless the window switched (or everything was cleared) since `generation`. */
  record(senderId: number, refusal: Omit<Refusal, 'at'>, generation: string): void {
    if (generation !== this.generation(senderId)) return;
    // Only the latest key a host presented to this window stays trustable.
    const others = this.of(senderId).filter((r) => !sameSlot(r, refusal));
    this.refused.set(senderId, [...others, { ...refusal, at: this.now() }]);
  }

  /** The window's refusals still within the TTL (expired ones are dropped on the way). */
  of(senderId: number): Refusal[] {
    const fresh = (this.refused.get(senderId) ?? []).filter((r) => this.now() - r.at <= REFUSAL_TTL_MS);
    if (fresh.length > 0) this.refused.set(senderId, fresh);
    else this.refused.delete(senderId);
    return fresh;
  }

  /** What was just decided settles this host and key type for every window: no older prompt can undo it. */
  settle(entry: KnownHostEntry): void {
    for (const senderId of [...this.refused.keys()]) {
      this.refused.set(
        senderId,
        this.of(senderId).filter((r) => !sameSlot(r, entry)),
      );
    }
  }

  /** The window switched workspace or went away: its refusals go, and a connect in flight keeps none. */
  forget(senderId: number): void {
    this.refused.delete(senderId);
    this.generations.set(senderId, (this.generations.get(senderId) ?? 0) + 1);
  }

  /** Every window's (quit). */
  clear(): void {
    this.refused.clear();
    this.generations.clear();
    this.epoch += 1;
  }
}

export interface SshConnector {
  /**
   * The hops to `hostId` with credentials, outermost first; the S1 refusals come before any network. The
   * window's secret getter is taken first; `abandoned` is asked once the hosts are read, so a switch
   * meanwhile reads no secret (`ssh-session-closed`).
   */
  prepareHops(sender: WebContents, hostId: string, abandoned?: () => boolean, user?: string): Promise<HopCredentials[]>;
  /**
   * {@link prepareHops}, plus the target's environment variables with their secrets read (same getter, same
   * order: credentials first). `secrets` lists the values that came from secrets, for the terminal's masker.
   * `forwardAgent` is set when the target forwards the agent (never a jump host's setting): with the
   * socket to forward, or without one when no agent runs, in which case the shell opens without it.
   * `user` (both): signs in to the target as this user for this connect only, as typed on the connection
   * screen (#532); hosts.yaml is not changed. `quick` (shell only): a server that is not saved (#537), signed in
   * to with the agent; `hostId` is then the renderer's id for it.
   */
  prepareShell(
    sender: WebContents,
    hostId: string,
    abandoned?: () => boolean,
    user?: string,
    quick?: SshQuickTarget,
  ): Promise<{
    hops: HopCredentials[];
    env: Record<string, string>;
    secrets: string[];
    forwardAgent?: { readonly socket?: string };
    /** Set when the target's protocol is `mosh` (#419): the session starts a mosh server, then runs over UDP. */
    mosh?: { readonly settings?: MoshSettings };
    /**
     * Set when the target's protocol is `telnet` (#425): `hops` are then the SSH jump hosts only, and the
     * target is reached over TCP from the last of them (or straight, through its own proxy). `login` is typed
     * at the device's prompts; `unusedAuth` names a key or agent sign-in Telnet cannot use.
     */
    telnet?: {
      readonly target: TcpTarget;
      readonly login: { readonly user?: string; readonly password?: string };
      readonly unusedAuth?: 'key' | 'agent';
    };
  }>;
  /**
   * Checks the machine's known hosts (read now, once per connect) and records a refusal that sender may
   * then trust.
   *
   * @throws WirebenchError `ssh-hosts-invalid` when the known-hosts file cannot be read
   */
  verifierFor(sender: WebContents): Promise<DialOptions['verifyHostKey']>;
  /** Turns a refused connect into ssh-host-key-new / ssh-host-key-changed with the fingerprint. */
  refusalError(sender: WebContents, error: unknown): unknown;
  /** The window switched workspace or went away: its refusals go (see {@link RefusalStore.forget}). */
  forget(sender: WebContents): void;
}

/** The trusted host keys; a missing file is none, an unreadable one is `ssh-hosts-invalid` (never raw). */
export async function readKnownHosts(file: string): Promise<readonly KnownHostEntry[]> {
  try {
    return parseKnownHosts(await readFile(file, 'utf8'));
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') return [];
    // Raw, it would cross IPC as `internal-error`; no host is trusted or refused without the file.
    throw new WirebenchError(
      'ssh-hosts-invalid',
      `The trusted host keys file could not be read (${errno ?? 'unknown error'}): ${file}`,
      { details: { file: 'known-hosts', ...(errno === undefined ? {} : { errno }) }, cause: error },
    );
  }
}

/** The target with `user` in place of its own: only a missing auth is left to make it incomplete. */
function signInAs(hop: ResolvedHost, user: string): ResolvedHost {
  const { incomplete, ...rest } = hop;
  void incomplete;
  const signed: ResolvedHost = { ...rest, ssh: { ...hop.ssh, user: { ...hop.ssh.user, value: user } } };
  return hop.ssh.auth.value === undefined ? { ...signed, incomplete: { field: 'auth' } } : signed;
}

const slotKey = (key: KnownHostEntry): string => `${key.host}\n${key.fingerprint}`;

export function createSshConnector(deps: SshConnectDeps & { readonly refusals: RefusalStore }): SshConnector {
  const { refusals } = deps;
  /**
   * Keys a verifier refused as changed, per window: host and fingerprint → the stored fingerprint.
   * {@link SshConnector.refusalError} takes the entry back out. Kept apart from the refusals, so a connect
   * that straddled a switch still says "changed" though its refusal is not kept.
   */
  const changedKeys = new Map<number, Map<string, string>>();

  /** The hops to the host, outermost first, each complete; nothing here touches the network. */
  const chainFor = async (
    sender: WebContents,
    hostId: string,
    user?: string,
    quick?: SshQuickTarget,
  ): Promise<readonly ResolvedHost[]> => {
    const hosts = deps.hosts(sender);
    if (quick !== undefined) return completeChain(quickChain(hosts.current(), hostId, quick), user);
    const listing = await hosts.list(); // cached; reads hosts.yaml once per workspace
    const problem = listing.problems[0];
    if (problem) {
      // The file did not parse: its own refusal (ssh-hosts-invalid, ssh-duplicate-id, …) is the answer.
      throw new WirebenchError(problem.code, `hosts.yaml: ${problem.message}`, {
        details: { ...(problem.path ? { path: problem.path } : {}) },
      });
    }
    const file: HostsFile | undefined = hosts.current();
    if (!file) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    let chain: readonly ResolvedHost[];
    try {
      chain = jumpChain(file, hostId, hosts.sshDefaults?.());
    } catch (error) {
      throw asWirebenchError(error);
    }
    return completeChain(chain, user);
  };

  /** The chain with the target signed in as `user` when given; refused while a hop lacks a user or a way in. */
  const completeChain = (resolved: readonly ResolvedHost[], user?: string): readonly ResolvedHost[] => {
    let chain = resolved;
    if (user !== undefined) chain = [...chain.slice(0, -1), signInAs(chain[chain.length - 1] as ResolvedHost, user)];
    for (const hop of chain) {
      if (hop.incomplete) {
        throw new WirebenchError(
          'ssh-host-incomplete',
          `${hop.name} has no ${hop.incomplete.field}; set it on the host or one of its groups`,
          { details: { hostId: hop.id, field: hop.incomplete.field } },
        );
      }
    }
    // A jump host forwards the next hop's connection over SSH: a Telnet host cannot.
    for (const hop of chain.slice(0, -1)) {
      if (hop.ssh.protocol.value === 'telnet') {
        throw new WirebenchError(
          'ssh-jump-not-ssh',
          `${hop.name} is a Telnet host and cannot be a jump host; jump through an SSH host instead`,
          { details: { hostId: hop.id, protocol: hop.ssh.protocol.value } },
        );
      }
    }
    return chain;
  };

  const requireAgent = (hop: ResolvedHost): string => {
    const socket = deps.agentSocket();
    if (!socket) {
      throw new WirebenchError('ssh-auth-failed', 'No SSH agent is running (SSH_AUTH_SOCK is unset)', {
        details: { host: `${hop.address}:${hop.ssh.port.value}`, method: 'agent', agent: 'missing' },
      });
    }
    return socket;
  };

  /** In order, so the first missing secret is the one named; an agent without a socket fails here too. */
  const secretValue = async (token: string, getSecret: GetSecret): Promise<string> => {
    const name = secretNameOf(token);
    const ref = secretPseudoRef(name);
    const found = await getSecret(ref);
    if (found === undefined) {
      throw new WirebenchError(
        'secret-missing',
        `The secret "${name}" is not on this machine — set it from the host's form (Hosts).`,
        { details: { ref, name } },
      );
    }
    return found;
  };

  const credentialsFor = async (chain: readonly ResolvedHost[], getSecret: GetSecret): Promise<HopCredentials[]> => {
    const value = (token: string): Promise<string> => secretValue(token, getSecret);
    const hops: HopCredentials[] = [];
    // The first hop's own proxy (#417): the hops after it are reached through it, never through a proxy.
    const proxySetting = chain[0]?.ssh.proxy.value;
    const proxy = proxySetting === undefined ? undefined : await proxyCredentialsOf(proxySetting, value);
    for (const [index, hop] of chain.entries()) {
      const auth = hop.ssh.auth.value;
      const user = hop.ssh.user.value;
      if (!auth || user === undefined) continue; // unreachable: chainFor refused incomplete hops
      const credentials: HopCredentials['auth'] =
        auth.kind === 'password'
          ? { kind: 'password', password: await value(auth.password) }
          : auth.kind === 'key'
            ? {
                kind: 'key',
                privateKey: await value(auth.key),
                // The secret's name, which is how the user knows the key; shown in progress and errors.
                label: secretNameOf(auth.key),
                ...(auth.certificate ? { certificate: await value(auth.certificate) } : {}),
                ...(auth.passphrase ? { passphrase: await value(auth.passphrase) } : {}),
              }
            : { kind: 'agent', socket: requireAgent(hop) };
      hops.push({
        address: hop.address,
        port: hop.ssh.port.value,
        user,
        auth: credentials,
        keepAlive: hop.ssh.keepAlive.value,
        connectTimeout: hop.ssh.connectTimeout.value,
        ...(index === 0 && proxy !== undefined ? { proxy } : {}),
      });
    }
    return hops;
  };

  /** Only the target's: a jump host's shell is never opened. */
  const envFor = async (
    target: ResolvedHost,
    getSecret: GetSecret,
  ): Promise<{ env: Record<string, string>; secrets: string[] }> => {
    const env: Record<string, string> = {};
    const secrets: string[] = [];
    for (const variable of target.env) {
      if (envSecretName(variable.value) === undefined) env[variable.name] = variable.value;
      else {
        const found = await secretValue(variable.value, getSecret);
        env[variable.name] = found;
        secrets.push(found);
      }
    }
    return { env, secrets };
  };

  /** A Telnet target (#425): where to connect and what to type at its prompts, secrets read in that order. */
  const telnetFor = async (
    target: ResolvedHost,
    jumps: number,
    getSecret: GetSecret,
    user?: string,
  ): Promise<NonNullable<Awaited<ReturnType<SshConnector['prepareShell']>>['telnet']>> => {
    const value = (token: string): Promise<string> => secretValue(token, getSecret);
    // The target's own proxy is used only when it is the first network hop.
    const proxySetting = jumps === 0 ? target.ssh.proxy.value : undefined;
    const proxy = proxySetting === undefined ? undefined : await proxyCredentialsOf(proxySetting, value);
    const auth = target.ssh.auth.value;
    // A user from Preferences → SSH is an SSH login name; only one set for the host is typed.
    const login = user ?? (target.ssh.user.from === 'preferences' ? undefined : target.ssh.user.value);
    const password = auth?.kind === 'password' ? await value(auth.password) : undefined;
    return {
      target: {
        address: target.address,
        port: target.ssh.port.value,
        connectTimeout: target.ssh.connectTimeout.value,
        ...(proxy === undefined ? {} : { proxy }),
      },
      login: { ...(login === undefined ? {} : { user: login }), ...(password === undefined ? {} : { password }) },
      ...(auth === undefined || auth.kind === 'password' ? {} : { unusedAuth: auth.kind }),
    };
  };

  const prepare = async (
    sender: WebContents,
    hostId: string,
    abandoned: () => boolean,
    user?: string,
    quick?: SshQuickTarget,
    shell = false,
  ) => {
    // Taken now, so the secrets are those of the workspace the connect began in, never a later one's.
    const getSecret = deps.secretsFor(sender);
    const chain = await chainFor(sender, hostId, user, quick);
    if (abandoned()) throw new WirebenchError('ssh-session-closed', 'The session closed before it opened');
    const target = chain[chain.length - 1] as ResolvedHost;
    if (target.ssh.protocol.value === 'telnet') {
      // Files, port forwarding and keys all need an SSH connection to the host itself.
      if (!shell) {
        throw new WirebenchError(
          'ssh-protocol-unsupported',
          `${target.name} is a Telnet host: files, port forwarding and keys need SSH`,
          { details: { hostId: target.id, protocol: 'telnet' } },
        );
      }
      const jumps = chain.slice(0, -1);
      const hops = await credentialsFor(jumps, getSecret);
      return { chain, getSecret, hops, telnet: await telnetFor(target, jumps.length, getSecret, user) };
    }
    return { chain, getSecret, hops: await credentialsFor(chain, getSecret), telnet: undefined };
  };

  return {
    async prepareHops(sender, hostId, abandoned = () => false, user) {
      return (await prepare(sender, hostId, abandoned, user)).hops;
    },

    async prepareShell(sender, hostId, abandoned = () => false, user, quick) {
      const { chain, getSecret, hops, telnet } = await prepare(sender, hostId, abandoned, user, quick, true);
      // A Telnet device gets no environment: Telnet has no way to pass it.
      if (telnet !== undefined) {
        return { hops, env: {}, secrets: telnet.login.password === undefined ? [] : [telnet.login.password], telnet };
      }
      const target = chain[chain.length - 1] as ResolvedHost;
      const socket = target.ssh.forwardAgent.value ? deps.agentSocket() : undefined;
      return {
        hops,
        ...(await envFor(target, getSecret)),
        ...(target.ssh.forwardAgent.value ? { forwardAgent: socket ? { socket } : {} } : {}),
        ...(target.ssh.protocol.value === 'mosh'
          ? { mosh: target.ssh.mosh.value === undefined ? {} : { settings: target.ssh.mosh.value } }
          : {}),
      };
    },

    async verifierFor(sender) {
      const known = await readKnownHosts(deps.knownHostsFile);
      const generation = refusals.generation(sender.id);
      return (_hop, key) => {
        if (checkKnownHost(known, key) === 'known') return Promise.resolve('accept');
        const previous = known.find((e) => sameSlot(e, key));
        if (previous) {
          const mine = changedKeys.get(sender.id) ?? new Map<string, string>();
          mine.set(slotKey(key), previous.fingerprint);
          changedKeys.set(sender.id, mine);
        }
        // A refusal from before this window's switch belongs to the workspace it left: not kept.
        refusals.record(
          sender.id,
          {
            host: key.host,
            keyType: key.keyType,
            fingerprint: key.fingerprint,
            kind: previous ? 'changed' : 'new',
            ...(previous ? { previous: previous.fingerprint } : {}),
          },
          generation,
        );
        return Promise.resolve('reject');
      };
    },

    refusalError(sender, error) {
      const code = (error as { code?: unknown } | null)?.code;
      const details = (error as { details?: Record<string, unknown> } | null)?.details;
      if (code !== 'ssh-host-key-new' || !details) return asWirebenchError(error);
      const entry: KnownHostEntry = {
        host: String(details['host']),
        keyType: String(details['keyType']),
        fingerprint: String(details['fingerprint']),
      };
      const mine = changedKeys.get(sender.id);
      const previous = mine?.get(slotKey(entry));
      if (mine) {
        mine.delete(slotKey(entry));
        if (mine.size === 0) changedKeys.delete(sender.id);
      }
      if (previous === undefined) return asWirebenchError(error);
      return new WirebenchError(
        'ssh-host-key-changed',
        `${entry.host} presented a different ${entry.keyType} key than before (was ${previous}, now ${entry.fingerprint})`,
        { details: { ...entry, previous } },
      );
    },

    forget(sender) {
      refusals.forget(sender.id);
      changedKeys.delete(sender.id);
    },
  };
}
