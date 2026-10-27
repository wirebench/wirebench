/**
 * Session logs (#414): what an SSH session printed, kept on this machine as plain text. Logging is turned
 * on per host or group by a switch kept on this machine (`userData/ssh-session-logs.json`), never in the
 * workspace, so a shared workspace cannot turn it on for someone else. Logs live under
 * `userData/session-logs/<workspace>/<host>/` as `<id>.log` (plain text), `<id>.json` (who, where, when)
 * and, when the raw switch is on, `<id>.raw` (the stream with its escape sequences). Together they stay
 * under a size limit: past it the oldest logs go first.
 *
 * Only output is written: what the user types reaches a log only as the remote echoes it, so a password
 * typed at a prompt that does not echo is never in one. The output arrives already masked for the secrets
 * a snippet typed; every secret used at connect (password, key, passphrase) is masked here as well.
 * Electron-free (the window is only a key).
 */
import type { Caller } from './host/platform.js';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { WirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import { createStreamMasker, createTextLog, resolveHost } from '@wirebench/ssh';
import type { HopCredentials, HostsFile } from '@wirebench/ssh';
import { logSwitchKey, resolveLogSwitch } from '@wirebench/wire/session-log-switch';
import type { LogSwitchTarget, LogSwitches } from '@wirebench/wire/session-log-switch';
import { UPLOAD_SUFFIX } from './session-log-uploader.js';
import type { SessionLogUpload, SessionLogUploader, SessionLogUploadTarget } from './session-log-uploader.js';

export const SESSION_LOGS_DIR = 'session-logs';
export const SESSION_LOG_SWITCHES_FILE = 'ssh-session-logs.json';

/** The most of a log `read` answers with: the end of a longer one, marked `truncated`. */
export const SESSION_LOG_READ_MAX_BYTES = 4 * 1024 * 1024;
/** Characters of a matching line `search` answers with. */
const MATCH_TEXT_MAX = 300;

/** A workspace or host id as a folder name: no separators, no dots alone. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** `<start, compact UTC>-<the session id's first 8 letters or digits>`. */
const LOG_ID = /^\d{8}T\d{6}Z-[A-Za-z0-9]{1,8}$/;

export interface SessionLogStart {
  readonly workspaceId: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly address: string;
  readonly port: number;
  readonly user: string;
  readonly sessionId: string;
  /** Every secret value used at connect: masked wherever it shows up. */
  readonly secrets: readonly string[];
  /** The server the workspace is bound to, for a later upload (#430). */
  readonly server?: { readonly url: string; readonly recording: boolean } | undefined;
  /** Where the log streams to while it is written: the workspace's server records SSH sessions (#430). */
  readonly upload?: SessionLogUploadTarget | undefined;
}

export interface SessionLogEnd {
  readonly code: number | null;
  readonly signal?: string | undefined;
  readonly reason: 'exit' | 'lost' | 'closed';
}

/** The sidecar (`<id>.json`), version 1. */
export interface SessionLogMeta {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly address: string;
  readonly port: number;
  readonly user: string;
  /** ISO 8601, UTC. */
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number | null;
  readonly signal?: string;
  readonly reason?: SessionLogEnd['reason'];
  /** Whether a `<id>.raw` stream sits beside the text. */
  readonly raw: boolean;
  readonly server?: { readonly url: string; readonly recording: boolean };
}

export interface SessionLogEntry extends SessionLogMeta {
  /** Bytes of the plain text. */
  readonly bytes: number;
  /** The session is still writing it. */
  readonly live: boolean;
}

export interface SessionLogMatch {
  readonly id: string;
  /** Matching lines. */
  readonly count: number;
  /** The first one's number (1-based) and text. */
  readonly line: number;
  readonly text: string;
}

export interface SessionLogWriter {
  /** Output as the screen got it (snippet secrets already masked). */
  push(data: Uint8Array): void;
  /** Writes what is held and the end to the sidecar; idempotent. `undefined`: the window closed the session. */
  end(exit: SessionLogEnd | undefined): Promise<void>;
  /** Resolves once everything pushed so far is on disk. */
  settled(): Promise<void>;
}

export interface SessionLogStoreDeps {
  /** `userData/session-logs`. */
  readonly root: string;
  /** Read at each start and prune: the Settings page's limit and raw switch. */
  readonly limits: () => { readonly maxBytes: number; readonly raw: boolean };
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  /** Streams logs that name an upload target (#430). */
  readonly uploader?: Pick<SessionLogUploader, 'begin'>;
}

const unknownLog = (): WirebenchError => new WirebenchError('session-log-unknown', 'That session log no longer exists');

function checkSegment(value: string): string {
  if (!SEGMENT.test(value)) throw unknownLog();
  return value;
}

/** `2026-10-13T18:30:00.000Z` → `20261013T183000Z`. */
const compact = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');

const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class SessionLogStore {
  /** `<workspace>/<host>/<id>` of every log a session is still writing. */
  private readonly live = new Set<string>();
  private pruning: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionLogStoreDeps) {}

  /** Starts a log; its files are written in the background, and a failure stops it without touching the session. */
  start(info: SessionLogStart): SessionLogWriter {
    const startedAt = this.now();
    const workspaceId = checkSegment(info.workspaceId);
    const hostId = checkSegment(info.hostId);
    const id = `${compact(startedAt)}-${info.sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'session'}`;
    const dir = join(this.deps.root, workspaceId, hostId);
    const key = `${workspaceId}/${hostId}/${id}`;
    const raw = this.deps.limits().raw;
    let meta: SessionLogMeta = {
      version: 1,
      id,
      workspaceId,
      hostId,
      hostName: info.hostName,
      address: info.address,
      port: info.port,
      user: info.user,
      startedAt: startedAt.toISOString(),
      raw,
      ...(info.server ? { server: { url: info.server.url, recording: info.server.recording } } : {}),
    };
    // The text is masked after the escape sequences go, so a secret drawn with a colour change inside is caught.
    const text = createTextLog();
    const textMasker = createStreamMasker();
    const rawMasker = createStreamMasker();
    textMasker.add(info.secrets);
    rawMasker.add(info.secrets);
    this.live.add(key);

    let failed = false;
    let ended = false;
    let handles: { log: FileHandle; raw: FileHandle | undefined } | undefined;
    let upload: SessionLogUpload | undefined;
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      this.deps.log?.(`[session-log] ${id}: stopped writing (${(error as Error).message})`);
    };
    let chain: Promise<void> = (async () => {
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(nodeFs, join(dir, `${id}.json`), `${JSON.stringify(meta, null, 2)}\n`);
      handles = {
        log: await open(join(dir, `${id}.log`), 'a'),
        raw: raw ? await open(join(dir, `${id}.raw`), 'a') : undefined,
      };
      if (info.upload && this.deps.uploader) {
        // The upload is the log's passenger: if it cannot start, the log on this machine still is written.
        upload = await this.deps.uploader.begin(dir, meta, info.upload).catch((error: unknown) => {
          this.deps.log?.(`[session-log] ${id}: cannot start its upload (${(error as Error).message})`);
          return undefined;
        });
      }
    })().catch(fail);
    const write = (textBytes: Uint8Array, rawBytes: Uint8Array): void => {
      if (failed || (textBytes.length === 0 && rawBytes.length === 0)) return;
      chain = chain
        .then(async () => {
          if (failed || !handles) return;
          if (textBytes.length > 0) await handles.log.write(textBytes);
          if (rawBytes.length > 0 && handles.raw) await handles.raw.write(rawBytes);
          if (textBytes.length > 0) upload?.grew();
        })
        .catch(fail);
    };

    let ending: Promise<void> | undefined;
    return {
      push: (data) => {
        if (ended || failed) return;
        const masked = textMasker.push(Buffer.from(text.push(data), 'utf8'));
        write(masked, raw ? rawMasker.push(data) : new Uint8Array());
      },
      settled: () => chain,
      end: (exit) => {
        if (ending) return ending;
        ended = true;
        const tail = Buffer.concat([textMasker.push(Buffer.from(text.flush(), 'utf8')), textMasker.flush()]);
        write(tail, raw ? rawMasker.flush() : new Uint8Array());
        meta = {
          ...meta,
          endedAt: this.now().toISOString(),
          ...(exit
            ? { exitCode: exit.code, reason: exit.reason, ...(exit.signal ? { signal: exit.signal } : {}) }
            : { reason: 'closed' as const }),
        };
        ending = chain
          .then(async () => {
            await handles?.log.close();
            await handles?.raw?.close();
            if (!failed) await writeFileAtomic(nodeFs, join(dir, `${id}.json`), `${JSON.stringify(meta, null, 2)}\n`);
            upload?.ended(meta);
          })
          .catch(fail)
          .finally(() => {
            this.live.delete(key);
          })
          .then(() => this.prune());
        return ending;
      },
    };
  }

  /**
   * A host's logs, or with no host every host's in the workspace, newest first.
   * @throws WirebenchError `session-log-unknown` for an id that cannot be a folder
   */
  async list(workspaceId: string, hostId?: string): Promise<SessionLogEntry[]> {
    if (hostId === undefined) {
      const hosts = (await names(join(this.deps.root, checkSegment(workspaceId)))).filter((n) => SEGMENT.test(n));
      const all = await Promise.all(hosts.map((host) => this.list(workspaceId, host)));
      return all.flat().sort(byId).reverse();
    }
    const dir = this.dirOf(workspaceId, hostId);
    const ids = (await names(dir))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((i) => LOG_ID.test(i));
    const entries: SessionLogEntry[] = [];
    for (const id of ids) {
      try {
        const meta = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as SessionLogMeta;
        const bytes = await sizeOf(join(dir, `${id}.log`));
        entries.push({ ...meta, id, bytes, live: this.live.has(`${workspaceId}/${hostId}/${id}`) });
      } catch {
        // A sidecar a crash left half-written is skipped; prune still counts its files.
      }
    }
    return entries.sort(byId).reverse();
  }

  /** The text of a log; the last {@link SESSION_LOG_READ_MAX_BYTES} of a longer one. */
  async read(workspaceId: string, hostId: string, id: string): Promise<{ text: string; truncated: boolean }> {
    const file = this.fileOf(workspaceId, hostId, id);
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch {
      throw unknownLog();
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, SESSION_LOG_READ_MAX_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return { text: buffer.toString('utf8'), truncated: size > length };
    } finally {
      await handle.close();
    }
  }

  /** The host's logs with a line containing `query` (case-insensitive), newest first. */
  async search(workspaceId: string, hostId: string, query: string): Promise<SessionLogMatch[]> {
    const needle = query.toLowerCase();
    if (needle.length === 0) return [];
    const matches: SessionLogMatch[] = [];
    for (const entry of await this.list(workspaceId, hostId)) {
      const found = await firstMatch(this.fileOf(workspaceId, hostId, entry.id), needle);
      if (found) matches.push({ id: entry.id, ...found });
    }
    return matches;
  }

  /** @throws WirebenchError `session-log-unknown` | `session-log-live` (a running session's log stays) */
  async remove(workspaceId: string, hostId: string, id: string): Promise<void> {
    const file = this.fileOf(workspaceId, hostId, id);
    if (this.live.has(`${workspaceId}/${hostId}/${id}`)) {
      throw new WirebenchError('session-log-live', 'The session is still running; close it before deleting its log');
    }
    await removeLog(file.slice(0, -'.log'.length));
  }

  /** Where a log's text is, for Reveal. @throws WirebenchError `session-log-unknown` */
  async pathOf(workspaceId: string, hostId: string, id: string): Promise<string> {
    const file = this.fileOf(workspaceId, hostId, id);
    await stat(file).catch(() => {
      throw unknownLog();
    });
    return file;
  }

  /**
   * Deletes the oldest logs, across every workspace and host, until all of them together fit the size limit.
   * A running session's log is never deleted. One prune at a time.
   */
  prune(): Promise<void> {
    this.pruning = this.pruning
      .then(() => this.pruneNow())
      .catch((error: unknown) => {
        this.deps.log?.(`[session-log] prune failed: ${(error as Error).message}`);
      });
    return this.pruning;
  }

  private async pruneNow(): Promise<void> {
    const max = this.deps.limits().maxBytes;
    const logs: { stem: string; id: string; bytes: number; live: boolean }[] = [];
    for (const workspace of (await names(this.deps.root)).filter((n) => SEGMENT.test(n))) {
      for (const host of (await names(join(this.deps.root, workspace))).filter((n) => SEGMENT.test(n))) {
        const dir = join(this.deps.root, workspace, host);
        const sizes = new Map<string, number>();
        for (const name of await names(dir)) {
          const id = name.replace(/\.(log|raw|json)$/, '');
          if (id === name || !LOG_ID.test(id)) continue;
          sizes.set(id, (sizes.get(id) ?? 0) + (await sizeOf(join(dir, name))));
        }
        for (const [id, bytes] of sizes) {
          logs.push({ stem: join(dir, id), id, bytes, live: this.live.has(`${workspace}/${host}/${id}`) });
        }
      }
    }
    let total = logs.reduce((sum, l) => sum + l.bytes, 0);
    // Ids start with the start time, so they sort oldest first across hosts.
    for (const log of logs.sort(byId)) {
      if (total <= max) break;
      if (log.live) continue;
      await removeLog(log.stem);
      total -= log.bytes;
    }
  }

  private dirOf(workspaceId: string, hostId: string): string {
    return join(this.deps.root, checkSegment(workspaceId), checkSegment(hostId));
  }

  /** A log's text file. @throws WirebenchError `session-log-unknown` for an id that is not a log's */
  private fileOf(workspaceId: string, hostId: string, id: string): string {
    if (!LOG_ID.test(id)) throw unknownLog();
    return join(this.dirOf(workspaceId, hostId), `${id}.log`);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

/** A folder's entries; a missing folder has none. */
async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function removeLog(stem: string): Promise<void> {
  await Promise.all(['.log', '.raw', '.json', UPLOAD_SUFFIX].map((ext) => rm(`${stem}${ext}`, { force: true })));
}

/** How many lines of `file` hold `needle` (lower case), and the first; `undefined` for none or an unreadable file. */
async function firstMatch(
  file: string,
  needle: string,
): Promise<{ count: number; line: number; text: string } | undefined> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let count = 0;
  let number = 0;
  let first: { line: number; text: string } | undefined;
  try {
    for await (const line of lines) {
      number += 1;
      if (!line.toLowerCase().includes(needle)) continue;
      count += 1;
      first ??= { line: number, text: line.slice(0, MATCH_TEXT_MAX) };
    }
  } catch {
    return undefined;
  }
  return first ? { count, ...first } : undefined;
}

interface SwitchesFile {
  version: 1;
  workspaces: Record<string, Record<string, boolean>>;
}

/**
 * The per-machine logging switches (`userData/ssh-session-logs.json`), one map per workspace keyed
 * `host:<id>` / `group:<id>`. Writes go one at a time, each reading the file afresh; a missing or broken
 * file reads as no switches (a broken one is reported once).
 */
export class SessionLogSwitches {
  private queue: Promise<unknown> = Promise.resolve();
  private reported = false;

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  all(workspaceId: string): Promise<LogSwitches> {
    return this.enqueue(async () => ({ ...((await this.read()).workspaces[workspaceId] ?? {}) }));
  }

  /** `null` clears the target's own switch, so it follows its group again. */
  set(workspaceId: string, target: LogSwitchTarget, on: boolean | null): Promise<void> {
    return this.enqueue(async () => {
      const file = await this.read();
      const own = { ...(file.workspaces[workspaceId] ?? {}) };
      if (on === null) delete own[logSwitchKey(target)];
      else own[logSwitchKey(target)] = on;
      const workspaces = { ...file.workspaces, [workspaceId]: own };
      if (Object.keys(own).length === 0) delete workspaces[workspaceId];
      await writeFileAtomic(nodeFs, this.file, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<SwitchesFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return { version: 1, workspaces: {} };
    }
    try {
      const parsed = JSON.parse(text) as Partial<SwitchesFile>;
      const workspaces: SwitchesFile['workspaces'] = {};
      for (const [id, map] of Object.entries(parsed.workspaces ?? {})) {
        const own: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(map)) if (typeof value === 'boolean') own[key] = value;
        workspaces[id] = own;
      }
      return { version: 1, workspaces };
    } catch (error) {
      if (!this.reported) {
        this.reported = true;
        this.log(
          `[session-log] ${this.file} is not valid JSON; no host is logged until a switch is set again (${(error as Error).message})`,
        );
      }
      return { version: 1, workspaces: {} };
    }
  }
}

export interface SessionLogPlannerDeps {
  readonly store: Pick<SessionLogStore, 'start'>;
  readonly switches: Pick<SessionLogSwitches, 'all'>;
  /** The window's open workspace, and the server it is bound to; `undefined` when none is open. */
  readonly workspaceOf: (sender: Caller) =>
    | {
        readonly id: string;
        readonly server?: SessionLogStart['server'];
        /** Set while the workspace's server records SSH sessions: every session is logged, whatever the switches. */
        readonly upload?: SessionLogUploadTarget;
      }
    | undefined;
  readonly hosts: (sender: Caller) => { current(): HostsFile | undefined };
}

/** Starts the log of a session that just opened, told its id. */
export type StartSessionLog = (sessionId: string) => SessionLogWriter;

/**
 * Asked once per connect, before the session opens: whether this host's sessions are logged (its own switch,
 * else its nearest group's), and if so how to start the log. The secrets every hop signed in with go to the
 * log's masker; the target hop gives the address, port and user.
 */
export function sessionLogPlanner(deps: SessionLogPlannerDeps): (
  sender: Caller,
  request: {
    hostId: string;
    hops: readonly HopCredentials[];
    /** A Telnet target (#425), past the SSH hops; the last hop otherwise. */
    target?: { readonly address: string; readonly port: number; readonly user: string };
    /** Secrets beyond the hops' own (a Telnet password). */
    secrets?: readonly string[];
  },
) => Promise<StartSessionLog | undefined> {
  return async (sender, { hostId, hops, target: past, secrets: more = [] }) => {
    const workspace = deps.workspaceOf(sender);
    const file = deps.hosts(sender).current();
    const target = past ?? hops[hops.length - 1];
    if (!workspace || !file || !target) return undefined;
    const host = resolveHost(file, hostId);
    // The team's recording (#430 R3) logs every session; otherwise this machine's switch decides.
    if (!workspace.upload && !resolveLogSwitch(await deps.switches.all(workspace.id), hostId, host.path).on)
      return undefined;
    const secrets = [
      ...hops.flatMap((hop) =>
        hop.auth.kind === 'password'
          ? [hop.auth.password]
          : hop.auth.kind === 'key'
            ? [hop.auth.privateKey, ...(hop.auth.passphrase === undefined ? [] : [hop.auth.passphrase])]
            : [],
      ),
      ...more,
    ];
    return (sessionId) =>
      deps.store.start({
        workspaceId: workspace.id,
        hostId,
        hostName: host.name,
        address: target.address,
        port: target.port,
        user: target.user,
        sessionId,
        secrets,
        server: workspace.server,
        upload: workspace.upload,
      });
  };
}
