/**
 * `agent.send`, `agent.cancel`, `agent.cookies.clear` and `agent.cookies.domains` (hosted edition spec §18.1, §18.4; ADR-0035): a
 * paired tab hands the agent a send bundle its server built, and the agent sends that one request from this
 * machine.
 *
 * 1. The bundle is checked against `sendBundleSchema`: relative paths only, at most 2000 files and 23 MiB
 *    decoded. An origin has at most four sends running, whichever of its pairings started them.
 * 2. Its files are written to `<temp>/agent-sends/<instance>/<random id>`, a directory made for this send
 *    alone (two pairings may use one send id), under a folder of this agent process's own (with its `pid`). Each
 *    path is resolved and must stay inside it; each file is created with `wx`, and nothing here makes a
 *    link.
 * 3. The engine's `loadProject` reads it, and the embedder's host sends the one item through the send
 *    path a desktop send uses (`Host.sendFromDirectory`). Its secrets are only the agent's own namespace
 *    for the tab's pairing and workspace, never the desktop's project secrets; its `${#System#…}` values
 *    are only the names the bundle declares and this machine allows (`allowedSystemNames`); its cookie jar
 *    and token caches are the ones this agent holds for the tab's pairing. Two accounts on one server that
 *    pair this machine are two pairings, and share none of these.
 * 4. The directory is removed however the send ended.
 *
 * WebSocket is a session, not a send, so it has no bundle; gRPC and MCP answer `agent-kind-unsupported`
 * until they are added. The jars are held in memory only.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CookieJar, loadProject, WirebenchError, type CookieJarHost } from '@wirebench/engine';
import { createSendSession, type Host, type HostPlatform, type SendSession } from '@wirebench/host';
import {
  AGENT_SEND_KINDS,
  agentCancelRequestSchema,
  type AgentCookieDomainsResponse,
  agentSendRequestSchema,
  agentSendResponseSchema,
  type AgentSendResponse,
  type SendBundleFile,
} from '@wirebench/wire/agent';
import type { FailedExchangeWire } from '@wirebench/wire/wire-base';
import type { z } from 'zod';
import type { PairingStore } from './pairings.js';
import type { AgentCallContext, AgentHandler } from './server.js';

/** The folder under the platform's temp directory each send's own directory is made in. */
export const AGENT_SENDS_DIR = 'agent-sends';

/** Sends one pairing origin may have running at once; the next answers `agent-busy`. */
export const AGENT_MAX_SENDS_PER_ORIGIN = 4;

/** The file in an instance folder that names the agent process it belongs to. */
export const PID_FILE = 'pid';

/** An instance folder unchanged this long is removed at another agent's start, whatever its pid says. */
export const AGENT_STALE_INSTANCE_MS = 60 * 60 * 1000;

/**
 * An instance folder younger than this with no `pid` file yet is another agent between making the folder
 * and renaming its pid file in: it is kept.
 */
export const AGENT_YOUNG_INSTANCE_MS = 60 * 1000;

export interface AgentSendOptions {
  /** `network` gives the egress rule every agent send, its token requests included, is held to. */
  readonly platform: Pick<HostPlatform, 'paths' | 'network'>;
  /** Where this machine's `${#System#…}` allowlist is read, at each send (it may change while the agent runs). */
  readonly store: Pick<PairingStore, 'allowedSystemNames'>;
  /** The environment an allowed name is read from; `process.env` when absent. */
  readonly env?: NodeJS.ProcessEnv;
  /** Where a failure of the agent's own housekeeping goes; never handed a bundle or a value. */
  readonly log?: (message: string, error?: unknown) => void;
  /**
   * Whether this embedder can resolve team secrets (the desktop's agent, §18.5). Absent, a bundle that reads
   * one (it carries the workspace's `team-secrets/` subtree) answers `team-secret-needs-approval` before
   * anything is written: the headless agent has no approved machine key, and no screen to ask for one on.
   */
  readonly teamSecrets?: boolean;
}

/** What the headless agent answers a send that reads a team secret. */
export const HEADLESS_TEAM_SECRET_MESSAGE =
  'This request reads a team secret, which the command-line agent cannot hold. Pair the Wirebench desktop app with this server instead (Pair this machine…), and send through it.';

/** What a bundle the agent will not run is answered with: the paths and messages of its faults. */
function invalid(message: string, details?: Record<string, unknown>): WirebenchError {
  return new WirebenchError('agent-bundle-invalid', message, details === undefined ? undefined : { details });
}

/** The schema's faults, by path and message only: never the values that failed. */
function issuesOf(error: z.ZodError): { readonly path: string; readonly message: string }[] {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Whether the schema refused the bundle for its size: too many files, or too many bytes. */
function overCap(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) =>
      (issue.code === 'custom' && (issue.params as { tooLarge?: unknown } | undefined)?.tooLarge === true) ||
      (issue.code === 'too_big' && issue.path.join('.') === 'bundle.files'),
  );
}

/** The kind a raw request names, if it names one at all; read before the strict parse. */
function kindOf(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const bundle = (raw as { bundle?: unknown }).bundle;
  return typeof bundle === 'object' && bundle !== null ? (bundle as { kind?: unknown }).kind : undefined;
}

function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** Why the sends folder is not this account's own, or `undefined` when it is (or is not there yet). */
async function unsafeRoot(root: string): Promise<string | undefined> {
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
  const ownUid = process.getuid?.();
  // Windows has no owner or mode bits worth the name here; its temp directory is the user's own.
  const posix = process.platform !== 'win32';
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'not a folder';
  if (ownUid !== undefined && stat.uid !== ownUid) return 'owned by another account';
  if (posix && (stat.mode & 0o077) !== 0) return 'open to other accounts';
  return undefined;
}

/**
 * The sends folder, created owner-only. On a shared temp directory another account could have made it
 * first, made it a link or left it open to others: then it is refused rather than written into.
 */
async function sendsRoot(platform: Pick<HostPlatform, 'paths'>): Promise<string> {
  const root = join(platform.paths.temp(), AGENT_SENDS_DIR);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await unsafeRoot(root)) !== undefined) {
    throw new WirebenchError('agent-temp-unsafe', 'The agent’s temporary folder is not its own', {
      details: { dir: root },
    });
  }
  return root;
}

/** Whether process `pid` is running: `EPERM` is a live process of another account. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

/**
 * Removes the instance folders other agent processes left behind (the desktop and a headless agent share
 * the temp directory, and may run at once): one whose `pid` file names no running process, or whose
 * folder has not changed for {@link AGENT_STALE_INSTANCE_MS}. A live agent's folder is kept, and so is one
 * with no `pid` file yet that is younger than {@link AGENT_YOUNG_INSTANCE_MS}. Nothing is
 * read or removed unless the sends folder passes the same check a send makes; when it does not, the sweep
 * is skipped and logged once.
 */
async function sweepInstances(
  platform: Pick<HostPlatform, 'paths'>,
  own: string,
  log: (message: string, error?: unknown) => void,
): Promise<void> {
  const root = join(platform.paths.temp(), AGENT_SENDS_DIR);
  const unsafe = await unsafeRoot(root);
  if (unsafe !== undefined) {
    log(`the agent's temporary folder was not swept: it is ${unsafe}`);
    return;
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name !== own)
      .map(async (name) => {
        const folder = join(root, name);
        try {
          const stat = await lstat(folder);
          if (stat.isSymbolicLink() || !stat.isDirectory()) return;
          const pidText = await readFile(join(folder, PID_FILE), 'utf8').catch(() => undefined);
          const age = now - stat.mtimeMs;
          // Just made by an agent that has not renamed its pid file in yet.
          if (pidText === undefined && age < AGENT_YOUNG_INSTANCE_MS) return;
          const pid = Number.parseInt(pidText ?? '', 10);
          const stale = age > AGENT_STALE_INSTANCE_MS;
          if (Number.isInteger(pid) && pid > 0 && alive(pid) && !stale) return;
          await rm(folder, { recursive: true, force: true });
        } catch (error) {
          log('a leftover agent folder could not be removed', error);
        }
      }),
  );
}

/**
 * Writes `files` under `dir`: each inside it, each a new file. The schema already refused any path that
 * could leave; the prefix check here holds even for one it let through.
 */
export async function writeBundle(dir: string, files: readonly SendBundleFile[], signal: AbortSignal): Promise<void> {
  for (const file of files) {
    if (signal.aborted) throw new WirebenchError('aborted', 'The request was aborted.');
    const target = resolve(dir, file.path);
    if (!target.startsWith(dir + sep)) throw invalid('A bundle path leaves its folder', { path: file.path });
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(file.content, file.encoding), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // A path given twice, or a file where another path needs a folder.
      if (['EEXIST', 'ENOTDIR', 'EISDIR'].includes(codeOf(error) ?? '')) {
        throw invalid('A bundle path clashes with another', { path: file.path });
      }
      throw error;
    }
  }
}

/** A jar as the engine reads and stores into it, on the clock of the moment. */
function jarHost(jar: CookieJar): CookieJarHost {
  return {
    cookiesFor: (url) => jar.cookiesFor(url, Date.now()),
    remember: (url, cookies) => jar.store(url, cookies, Date.now()),
  };
}

/**
 * The `${#System#…}` scope of one send: each name the bundle declares that this machine allows, with its
 * value here. Every other name is absent, so it is unresolved and the send is refused.
 */
function systemValuesFor(
  declared: readonly string[],
  allowed: readonly string[],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const allow = new Set(allowed);
  const values: Record<string, string> = {};
  for (const name of declared) {
    const value = allow.has(name) ? env[name] : undefined;
    if (value !== undefined) values[name] = value;
  }
  return values;
}

/**
 * A failed send's error, with the HTTP Log's row for it on `details.failure` (already redacted by the host),
 * so the tab can have its server write the History entry and the row a failed send leaves there.
 */
function withFailure(error: unknown, failure: FailedExchangeWire): WirebenchError {
  const known = error instanceof WirebenchError;
  // The transport's own copy of the request is unredacted: only the row, which is, goes with the error.
  const details = Object.fromEntries(
    Object.entries(known ? (error.details ?? {}) : {}).filter(([key]) => key !== 'request'),
  );
  return new WirebenchError(known ? error.code : failure.error.code, known ? error.message : failure.error.message, {
    details: { ...details, failure },
    cause: error,
  });
}

/**
 * The three send handlers, for `startAgent({ handlers })`. Each send and each jar belongs to the pairing of
 * the tab that called: a tab cancels only its pairing's sends and clears only its pairing's jar, even beside
 * another pairing of the same origin (two accounts on one server).
 */
export function agentSendHandlers(options: AgentSendOptions): Map<string, AgentHandler> {
  const { platform } = options;
  const log = options.log ?? (() => undefined);
  const env = options.env ?? process.env;
  /** This agent process's own folder under the sends folder: no other process's send id can collide. */
  const instance = randomUUID();
  /** Each pairing's jar and token caches, in memory only (slice 3). */
  const pairings = new Map<string, { jar: CookieJar; readonly session: SendSession }>();
  /** The sends running, by pairing and send id. */
  const running = new Map<string, { readonly origin: string; readonly abort: AbortController }>();
  const swept = sweepInstances(platform, instance, log).catch((error: unknown) => {
    log('the agent could not sweep its temporary folder', error);
  });

  /**
   * This process's folder, made again when missing (another agent's sweep may have judged it stale). Its
   * `pid` file is written under a temporary name and renamed in, so a sweep never reads half of one, and the
   * folder's mtime is set to now (rewriting a file in it would not move it), so a sweep sees it in use.
   */
  const instanceFolder = async (): Promise<string> => {
    const folder = join(await sendsRoot(platform), instance);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(folder, `${PID_FILE}.${randomUUID()}.tmp`);
    await writeFile(temporary, String(process.pid), { mode: 0o600 });
    await rename(temporary, join(folder, PID_FILE));
    const now = new Date();
    await utimes(folder, now, now);
    return folder;
  };

  const key = (pairingId: string, sendId: string): string => `${pairingId}\n${sendId}`;
  const runningFor = (origin: string): number => [...running.values()].filter((one) => one.origin === origin).length;

  const stateFor = (pairingId: string, host: Host): { jar: CookieJar; readonly session: SendSession } => {
    let state = pairings.get(pairingId);
    if (state === undefined) {
      state = { jar: new CookieJar(), session: createSendSession(host, { egress: platform.network?.egress }) };
      pairings.set(pairingId, state);
    }
    return state;
  };

  const send = async (raw: unknown, { pairing, host }: AgentCallContext): Promise<AgentSendResponse> => {
    const kind = kindOf(raw);
    if (typeof kind === 'string' && !(AGENT_SEND_KINDS as readonly string[]).includes(kind)) {
      throw new WirebenchError('agent-kind-unsupported', `The agent does not send ${kind} requests yet`, {
        details: { kind },
      });
    }
    const parsed = agentSendRequestSchema.safeParse(raw);
    if (!parsed.success) {
      if (overCap(parsed.error)) {
        throw new WirebenchError('agent-bundle-too-large', 'The bundle is over the agent’s size cap', {
          details: { issues: issuesOf(parsed.error) },
        });
      }
      throw invalid('The bundle is not one the agent can run', { issues: issuesOf(parsed.error) });
    }
    const { sendId, bundle } = parsed.data;
    const { origin, pairingId } = pairing;
    if (bundle.teamSecrets !== undefined && options.teamSecrets !== true) {
      throw new WirebenchError('team-secret-needs-approval', HEADLESS_TEAM_SECRET_MESSAGE, {
        details: { workspaceId: bundle.workspaceId },
      });
    }
    if (running.has(key(pairingId, sendId))) {
      throw new WirebenchError('agent-send-exists', 'A send with that id is already running', { details: { sendId } });
    }
    if (runningFor(origin) >= AGENT_MAX_SENDS_PER_ORIGIN) {
      throw new WirebenchError('agent-busy', 'This machine is already sending as much as it will for that server', {
        details: { limit: AGENT_MAX_SENDS_PER_ORIGIN },
      });
    }
    const abort = new AbortController();
    running.set(key(pairingId, sendId), { origin, abort });
    let dir: string | undefined;
    try {
      await swept;
      const candidate = join(await instanceFolder(), randomUUID());
      // Not recursive: the directory must be new, made for this send.
      await mkdir(candidate, { mode: 0o700 });
      dir = candidate;
      await writeBundle(dir, bundle.files, abort.signal);
      try {
        await loadProject(dir);
      } catch (error) {
        throw invalid('The bundle does not load as a project', {
          reason: error instanceof Error ? error.message.replaceAll(dir, '<bundle>') : 'unknown',
        });
      }
      const state = stateFor(pairingId, host);
      /** The HTTP Log's row of a send that failed, which the tab takes to its server (§18.4). */
      let failed: FailedExchangeWire | undefined;
      const sending = host.sendFromDirectory({
        // The host's own id for it: two pairings may each run a send of one id, and the host keeps one registry.
        sendId: randomUUID(),
        projectDir: dir,
        itemId: bundle.itemId,
        ...(bundle.environment !== undefined ? { environment: bundle.environment } : {}),
        kind: bundle.kind,
        pairingId,
        origin,
        workspaceId: bundle.workspaceId,
        secretNames: bundle.secretNames,
        // The server's workspace and global values, as the bundle carries them; never this machine's globals.
        scopes: { workspace: bundle.scopes?.workspace ?? {}, global: bundle.scopes?.global ?? {} },
        systemValues: systemValuesFor(bundle.systemNames, options.store.allowedSystemNames(), env),
        cookies: jarHost(state.jar),
        session: state.session,
        signal: abort.signal,
        onFailed: (failure) => {
          failed = failure;
        },
      });
      let result: Awaited<typeof sending>;
      try {
        result = await sending;
      } catch (error) {
        throw failed === undefined ? error : withFailure(error, { ...failed, sendId });
      }
      // The tab's id, not the host's own: History and the HTTP Log match the send the tab shows.
      return agentSendResponseSchema.parse({ ...result, sendId, sentFrom: 'agent' });
    } finally {
      running.delete(key(pairingId, sendId));
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  };

  const cancel = (raw: unknown, { pairing }: AgentCallContext): Promise<{ cancelled: boolean }> => {
    const parsed = agentCancelRequestSchema.safeParse(raw);
    if (!parsed.success) return Promise.reject(invalid('Not a cancel request', { issues: issuesOf(parsed.error) }));
    // Only this pairing's sends are looked at: another's, even of the same origin, is not this tab's to stop.
    const entry = running.get(key(pairing.pairingId, parsed.data.sendId));
    if (entry === undefined || entry.abort.signal.aborted) return Promise.resolve({ cancelled: false });
    entry.abort.abort();
    return Promise.resolve({ cancelled: true });
  };

  const clearCookies = (_raw: unknown, { pairing }: AgentCallContext): Promise<undefined> => {
    const state = pairings.get(pairing.pairingId);
    if (state !== undefined) state.jar = new CookieJar();
    return Promise.resolve(undefined);
  };

  /** One row per domain the pairing's jar holds; a domain both host-only and not is listed as not. */
  const cookieDomains = (_raw: unknown, { pairing }: AgentCallContext): Promise<AgentCookieDomainsResponse> => {
    const state = pairings.get(pairing.pairingId);
    const byDomain = new Map<string, boolean>();
    for (const cookie of state?.jar.list(Date.now()) ?? []) {
      byDomain.set(cookie.domain, (byDomain.get(cookie.domain) ?? true) && cookie.hostOnly);
    }
    const domains = [...byDomain].slice(0, 1000).map(([domain, hostOnly]) => ({ domain, hostOnly }));
    return Promise.resolve({ domains });
  };

  return new Map<string, AgentHandler>([
    ['agent.send', send],
    ['agent.cancel', cancel],
    ['agent.cookies.clear', clearCookies],
    ['agent.cookies.domains', cookieDomains],
  ]);
}
