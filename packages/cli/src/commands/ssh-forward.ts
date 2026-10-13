/**
 * `wirebench ssh forward` (#460, `docs/specs/2026-10-12-ssh-forwarding-layouts-design.md` D7, R11): opens a
 * host's forwarding rules from the workspace's `hosts.yaml` over the same runner the app uses, and keeps
 * them open until SIGINT or SIGTERM.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createSourceCache,
  envVariablesFor,
  isWirebenchError,
  loadWorkspace,
  secretPseudoRef,
} from '@wirebench/engine';
import type { SecretNeed, Workspace } from '@wirebench/engine';
import { EMPTY_HOSTS_FILE, isNetworkBind, jumpChain, openForwardConnection, parseHostsFile, secretNameOf } from '#ssh';
import type {
  DialOptions,
  ForwardConnection,
  ForwardRule,
  ForwardStatus,
  HopCredentials,
  HostsFile,
  KnownHostEntry,
  ResolvedHost,
} from '#ssh';
import type { SshForwardArgs } from '../args-ssh.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { defaultUserDataDir } from '../ops/paths.js';
import { cliSecrets } from '../source-secrets.js';
import {
  cliHostKeyVerifier,
  defaultKnownHostsFile,
  KnownHostsUnreadable,
  readKnownHostsFile,
} from '../ssh-known-hosts.js';
import type { HostKeyRefusal } from '../ssh-known-hosts.js';
import { exists } from '../workspace-lookup.js';

/** What the command reads from its surroundings; tests replace the runner and the folders. */
export interface SshForwardDeps {
  readonly cwd?: string;
  /** The app's data folder, which holds `ssh-known-hosts.json`. */
  readonly userDataDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly open?: (options: DialOptions) => ForwardConnection;
  /** Called once every rule has started; for tests. */
  readonly onRunning?: () => void;
}

interface Failure {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A refusal before anything connects: its exit code and the line saying why. */
class Refused extends Error {
  constructor(
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const usage = (code: string, message: string): Refused => new Refused(ExitCode.Usage, code, message);

function failureOf(error: unknown): Failure {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    const details = (error as { details?: unknown }).details;
    return {
      code: error.code,
      message: error instanceof Error ? error.message : error.code,
      ...(typeof details === 'object' && details !== null ? { details: details as Record<string, unknown> } : {}),
    };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
}

/** Resolves when `signal` aborts, or, without one, on the process's first SIGINT or SIGTERM. */
function stopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((done) => {
    if (signal !== undefined) {
      if (signal.aborted) done();
      else signal.addEventListener('abort', () => done(), { once: true });
      return;
    }
    const onSignal = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      done();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

/** `--workspace`, or the nearest folder above `cwd` holding a `workspace.yaml`. */
async function findWorkspace(cwd: string, given: string | undefined): Promise<string> {
  if (given !== undefined) {
    const dir = resolve(cwd, given);
    if (!(await exists(join(dir, 'workspace.yaml')))) {
      throw usage('workspace-not-found', `no workspace.yaml in ${dir}`);
    }
    return dir;
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (await exists(join(dir, 'workspace.yaml'))) return dir;
    if (dirname(dir) === dir) {
      throw usage(
        'workspace-not-found',
        `no workspace.yaml in ${resolve(cwd)} or any folder above it; pass --workspace`,
      );
    }
  }
}

async function readHosts(workspaceDir: string): Promise<HostsFile> {
  let text: string;
  try {
    text = await readFile(join(workspaceDir, 'hosts.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_HOSTS_FILE;
    throw error;
  }
  try {
    return parseHostsFile(text);
  } catch (error) {
    const failure = failureOf(error);
    throw usage(failure.code, `hosts.yaml: ${failure.message}`);
  }
}

/** The hops to the host, outermost first, each with a user and a way to authenticate. */
function chainOf(file: HostsFile, hostId: string): readonly ResolvedHost[] {
  let chain: readonly ResolvedHost[];
  try {
    chain = jumpChain(file, hostId);
  } catch (error) {
    const failure = failureOf(error);
    throw usage(failure.code, failure.message);
  }
  for (const hop of chain) {
    if (hop.incomplete) {
      throw usage(
        'ssh-host-incomplete',
        `${hop.id} has no ${hop.incomplete.field}; set it on the host or one of its groups`,
      );
    }
  }
  return chain;
}

/** `address:port`, with an IPv6 address in brackets. */
function hostPort(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

/** The rules named, or every rule switched on; each checked against the flags that must allow it. */
function rulesOf(host: ResolvedHost, args: SshForwardArgs): readonly ForwardRule[] {
  let rules: ForwardRule[];
  if (args.rules.length === 0) {
    rules = host.forwards.filter((forward) => forward.enabled).map((forward) => forward.rule);
    if (rules.length === 0) {
      throw usage('ssh-forward-unknown', `${host.id} has no forwarding rule switched on`);
    }
  } else {
    rules = args.rules.map((id) => {
      const forward = host.forwards.find((each) => each.rule.id === id);
      if (forward === undefined) {
        throw usage('ssh-forward-unknown', `"${id}" is not a forwarding rule of ${host.id}`);
      }
      if (!forward.enabled) {
        throw usage('ssh-forward-invalid', `${id} is switched off for ${host.id}`);
      }
      return forward.rule;
    });
  }
  for (const id of Object.keys(args.ports)) {
    if (!rules.some((rule) => rule.id === id)) {
      throw usage('ssh-forward-unknown', `--port ${id}: ${id} is not started by this run`);
    }
  }
  if (!args.allowNetworkBind) {
    const open = rules.find((rule) => isNetworkBind(rule.bind));
    if (open !== undefined) {
      const where = open.type === 'remote' ? ` on ${host.id}` : '';
      throw usage(
        'ssh-forward-invalid',
        `${open.id} listens on ${hostPort(open.bind, args.ports[open.id] ?? open.port)}${where}, which other machines can reach; pass --allow-network-bind to start it`,
      );
    }
  }
  return rules;
}

/** Every hop's credentials, read in order so the first missing secret is the one named. */
async function credentialsOf(
  chain: readonly ResolvedHost[],
  args: SshForwardArgs,
  io: CliIo,
  workspace: Workspace | undefined,
  platform: NodeJS.Platform,
): Promise<HopCredentials[]> {
  const names = chain.flatMap((hop) => {
    const auth = hop.ssh.auth.value;
    if (auth?.kind === 'password') return [secretNameOf(auth.password)];
    if (auth?.kind === 'key') {
      return [secretNameOf(auth.key), ...(auth.passphrase ? [secretNameOf(auth.passphrase)] : [])];
    }
    return [];
  });
  const needs: SecretNeed[] = names.map((name) => ({ ref: secretPseudoRef(name), purpose: 'SSH credential' }));
  const secrets = cliSecrets(needs, io.env, workspace, args.secretSources, createSourceCache());
  const value = async (token: string): Promise<string> => {
    const name = secretNameOf(token);
    const ref = secretPseudoRef(name);
    let found: string | undefined;
    try {
      found = await secrets.getSecret(ref);
    } catch (error) {
      const failure = failureOf(error);
      throw new Refused(ExitCode.RunError, failure.code, failure.message);
    }
    if (found === undefined) {
      throw new Refused(
        ExitCode.RunError,
        'secret-missing',
        `the secret "${name}" is not set (${envVariablesFor({ ref }).join(', ')})`,
      );
    }
    return found;
  };
  const hops: HopCredentials[] = [];
  for (const hop of chain) {
    const auth = hop.ssh.auth.value;
    const user = hop.ssh.user.value;
    if (auth === undefined || user === undefined) continue; // chainOf refused incomplete hops
    let credentials: HopCredentials['auth'];
    if (auth.kind === 'password') {
      credentials = { kind: 'password', password: await value(auth.password) };
    } else if (auth.kind === 'key') {
      credentials = {
        kind: 'key',
        privateKey: await value(auth.key),
        ...(auth.passphrase ? { passphrase: await value(auth.passphrase) } : {}),
      };
    } else {
      const socket = platform === 'win32' ? 'pageant' : io.env['SSH_AUTH_SOCK'];
      if (socket === undefined || socket.length === 0) {
        throw new Refused(
          ExitCode.RunError,
          'ssh-auth-failed',
          `no SSH agent is running (SSH_AUTH_SOCK is unset) for ${hop.id} (${hostPort(hop.address, hop.ssh.port.value)})`,
        );
      }
      credentials = { kind: 'agent', socket };
    }
    hops.push({
      address: hop.address,
      port: hop.ssh.port.value,
      user,
      auth: credentials,
      keepAlive: hop.ssh.keepAlive.value,
      connectTimeout: hop.ssh.connectTimeout.value,
    });
  }
  return hops;
}

/** The workspace's secret sources apply only when it loads; a broken one is reported and skipped. */
async function workspaceOf(dir: string, args: SshForwardArgs, io: CliIo): Promise<Workspace | undefined> {
  if (!args.secretSources.enabled) return undefined;
  try {
    return (await loadWorkspace(dir)).workspace;
  } catch (error) {
    if (!isWirebenchError(error)) throw error;
    io.stderr.write(`${error.code}: ${error.message}; its secret sources do not apply\n`);
    return undefined;
  }
}

function describeRule(rule: ForwardRule, listening: { address: string; port: number }, hostId: string): string {
  const here = hostPort(listening.address, listening.port);
  const target = rule.target === undefined ? '' : hostPort(rule.target.host, rule.target.port);
  if (rule.type === 'local') return `${here} → ${target} via ${hostId}`;
  if (rule.type === 'dynamic') return `${here} SOCKS5 via ${hostId}`;
  return `${here} on ${hostId} → ${target}`;
}

/** A host key refusal as the user can act on it: which hop, which key, and the flag that accepts it. */
function hostKeyLines(
  failure: Failure,
  chain: readonly ResolvedHost[],
  refusals: ReadonlyMap<string, HostKeyRefusal>,
): string {
  const detail = (key: string): string => {
    const value = failure.details?.[key];
    return typeof value === 'string' ? value : '';
  };
  const where = detail('host');
  const refusal = refusals.get(where);
  const keyType = refusal?.key.keyType ?? detail('keyType');
  const fingerprint = refusal?.key.fingerprint ?? detail('fingerprint');
  const hop = chain.find((each) => hostPort(each.address, each.ssh.port.value) === where);
  const name = hop === undefined ? where : `${hop.id} (${where})`;
  const first =
    refusal?.previous === undefined
      ? `ssh-host-key-new: ${name} presented an ${keyType} key this machine does not trust: ${fingerprint}`
      : `ssh-host-key-changed: ${name} presented a different ${keyType} key than before (was ${refusal.previous}, now ${fingerprint})`;
  return `${first}\n  check it, then pass --host-key ${fingerprint} to accept it for this run (or trust it in the app)\n`;
}

/**
 * Starts the rules and waits for a signal.
 *
 * @returns 0 once stopped by a signal; 2 for a workspace, host or rule problem; 3 when a secret is missing, a
 * key is not trusted, a rule fails to start or reconnecting gives up
 */
export async function sshForwardCommand(
  args: SshForwardArgs,
  io: CliIo,
  signal?: AbortSignal,
  deps: SshForwardDeps = {},
): Promise<ExitCode> {
  const cwd = deps.cwd ?? process.cwd();
  const platform = deps.platform ?? process.platform;
  let chain: readonly ResolvedHost[];
  let rules: readonly ForwardRule[];
  let hops: HopCredentials[];
  let known: readonly KnownHostEntry[];
  try {
    const workspaceDir = await findWorkspace(cwd, args.workspace);
    chain = chainOf(await readHosts(workspaceDir), args.host);
    rules = rulesOf(chain[chain.length - 1] as ResolvedHost, args);
    hops = await credentialsOf(chain, args, io, await workspaceOf(workspaceDir, args, io), platform);
    const knownHostsFile =
      args.knownHosts !== undefined
        ? resolve(cwd, args.knownHosts)
        : defaultKnownHostsFile(deps.userDataDir ?? defaultUserDataDir(platform, io.env, homedir()));
    known = await readKnownHostsFile(knownHostsFile);
  } catch (error) {
    if (error instanceof Refused) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof KnownHostsUnreadable) {
      io.stderr.write(`ssh-hosts-invalid: ${error.message}\n`);
      return ExitCode.RunError;
    }
    throw error;
  }

  const refusals = new Map<string, HostKeyRefusal>();
  const connection = (deps.open ?? openForwardConnection)({
    hops,
    verifyHostKey: cliHostKeyVerifier(known, args.hostKeys, refusals),
  });
  const hostId = args.host;
  const width = Math.max(...rules.map((rule) => rule.id.length));
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const announced = new Set<string>();
  const waiting = new Set<string>();
  let reportedAttempt: number | undefined;
  let failure: { readonly rule: string; readonly failure: Failure } | undefined;
  let onFailure!: () => void;
  const failed = new Promise<void>((done) => (onFailure = done));

  const unsubscribe = connection.onStatus((ruleId: string, status: ForwardStatus) => {
    if (status.state === 'failed') {
      failure ??= { rule: ruleId, failure: status.error };
      onFailure();
    }
    if (args.quiet) return;
    if (args.json) {
      io.stdout.write(`${JSON.stringify({ rule: ruleId, ...status })}\n`);
      return;
    }
    const rule = byId.get(ruleId);
    if (status.state === 'running' && rule !== undefined) {
      if (!announced.has(ruleId)) {
        announced.add(ruleId);
        io.stdout.write(`${ruleId.padEnd(width)}  ${describeRule(rule, status.listening, hostId)}\n`);
      } else if (waiting.delete(ruleId)) {
        io.stderr.write(`${ruleId}  running again\n`);
      }
      reportedAttempt = undefined;
    } else if (status.state === 'reconnecting') {
      waiting.add(ruleId);
      if (status.attempt !== reportedAttempt) {
        reportedAttempt = status.attempt;
        io.stderr.write(
          `reconnecting to ${hostId}: attempt ${status.attempt} in ${Math.round(status.nextInMs / 1000)}s\n`,
        );
      }
    }
  });
  const stop = stopped(signal);
  let stopping = false;
  void stop.then(() => (stopping = true));

  // A signal during a start lets that start settle, so `close` can end the chain it dialled.
  for (const rule of rules) {
    if (stopping || failure !== undefined) break;
    const port = args.ports[rule.id];
    try {
      await connection.start(rule, port === undefined ? undefined : { port });
    } catch (error) {
      failure ??= { rule: rule.id, failure: failureOf(error) };
    }
  }
  if (failure === undefined && !stopping) {
    deps.onRunning?.();
    await Promise.race([stop, failed]);
  }
  await connection.close();
  unsubscribe();

  if (failure === undefined) return ExitCode.Ok;
  const { code, message } = failure.failure;
  io.stderr.write(
    code === 'ssh-host-key-new'
      ? hostKeyLines(failure.failure, chain, refusals)
      : `${code}: ${failure.rule}: ${message}\n`,
  );
  return ExitCode.RunError;
}
