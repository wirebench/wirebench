import { readFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import type { z } from 'zod';
import { WirebenchError, nodeFs, secretPseudoRef, writeFileAtomic } from '@wirebench/engine';
import {
  HopProgress,
  createStreamMasker,
  detectOs,
  expandSnippet,
  findSnippet,
  listSnippets,
  openSession,
  withCharset,
  openTelnetSession,
  previewSnippet,
  rememberKnownHost,
  serialLineText,
  serializeKnownHosts,
  snippetRevision,
  snippetSecrets,
} from '@wirebench/ssh';
import type {
  ConnectProgress,
  HopCredentials,
  KnownHostEntry,
  Snippet,
  SnippetListItem,
  SshSession,
  StreamMasker,
} from '@wirebench/ssh';
import { events } from '../shared/ipc.js';
import type {
  SshPreviewSnippetRequest,
  SshPreviewSnippetResponse,
  SshRunSnippetRequest,
} from '../shared/snippets-wire.js';
import type { IpcEvent } from '../shared/ipc.js';
import { sshHostOsResponseSchema } from '../shared/ssh-wire.js';
import type {
  SshCloseRequest,
  SshConnectRequest,
  SshConnectResponse,
  SshDetectedOsWire,
  SshHostOsWire,
  SshOsId,
  SshResizeRequest,
  SshTrustRequest,
  SshWriteManyRequest,
  SshWriteManyResponse,
  SshWriteRequest,
} from '../shared/ssh-wire.js';
import { asWirebenchError } from './hosts-service.js';
import type { OpenMoshOptions } from './mosh-session.js';
import type { OpenSerialOptions } from './serial-session.js';
import type { SessionLogWriter, StartSessionLog } from './session-logs.js';
import type { SnippetsService } from './snippets-service.js';
import { RefusalStore, createSshConnector, readKnownHosts } from './ssh-connect.js';
import type { SshConnectDeps, SshConnector } from './ssh-connect.js';

export interface SshServiceDeps extends SshConnectDeps {
  /** `userData/ssh-host-os.json`: per machine, the OS each server was found or chosen to run. */
  readonly hostOsFile: string;
  readonly emit: (target: WebContents, event: IpcEvent<z.ZodType>, payload: unknown) => void;
  /** The window's `snippets.yaml`: a run types only a snippet saved there. */
  readonly snippets: (sender: WebContents) => Pick<SnippetsService, 'current' | 'list'>;
  /** Tests inject a fake. */
  readonly open?: typeof openSession;
  /** Opens a host whose protocol is `mosh` (#419); without it such a host is refused. */
  readonly openMosh?: (options: OpenMoshOptions) => Promise<SshSession>;
  /** Tests inject a fake. */
  readonly openTelnet?: typeof openTelnetSession;
  /** `false` when this build switched Telnet off (`WIREBENCH_AREAS=telnet=off`, #425): its hosts are refused. */
  readonly telnet?: boolean;
  /** Opens a host whose protocol is `serial` (#426); without it such a host is refused (`serial-unavailable`). */
  readonly openSerial?: (options: Omit<OpenSerialOptions, 'modules'>) => Promise<SshSession>;
  /** `false` when this build switched serial consoles off (`WIREBENCH_AREAS=serial=off`). */
  readonly serial?: boolean;
  /** The device this machine opens for the serial host, or `undefined` when none was picked yet. */
  readonly serialDevice?: (sender: WebContents, hostId: string) => Promise<string | undefined>;
  /** Milliseconds; tests inject a clock. */
  readonly now?: () => number;
  /**
   * The refused keys `trust` may record, shared with `SftpService` so one prompt serves terminal and Files;
   * one of its own when not given (tests).
   */
  readonly refusals?: RefusalStore;
  /** The chain, credential and host key path (built over {@link refusals} when not given). */
  readonly connector?: SshConnector;
  /**
   * Told after a session opens or closes, with how many of that window's sessions to the host are open now;
   * port forwards start with a host's first terminal and stop with its last (spec R2).
   */
  readonly onSessionsChange?: (sender: WebContents, hostId: string, open: number) => void;
  /**
   * Session logs (#414): asked once per connect, before the session opens, with the hops and their
   * credentials; answers how to start the log, or `undefined` when the host is not logged. A failure here
   * opens the session unlogged.
   */
  readonly sessionLog?: (
    sender: WebContents,
    request: {
      readonly hostId: string;
      readonly hops: readonly HopCredentials[];
      /** A Telnet target (#425), which is not one of the SSH `hops`, and the secrets it signs in with. */
      readonly target?: { readonly address: string; readonly port: number; readonly user: string };
      readonly secrets?: readonly string[];
    },
  ) => Promise<StartSessionLog | undefined>;
}

/**
 * Sends a connect's stages and log lines to the window that asked, under its attempt id (#528); nothing
 * when the renderer gave none. The events hold no credential: `@wirebench/ssh` builds them from names.
 */
export function progressTo(
  emit: SshServiceDeps['emit'],
  sender: WebContents,
  attemptId: string | undefined,
): { onProgress?: (event: ConnectProgress) => void } {
  if (attemptId === undefined) return {};
  return {
    onProgress: (event) => {
      if (!sender.isDestroyed()) emit(sender, events.ssh.connectProgress, { attemptId, event });
    },
  };
}

/** The command the OS probe runs: `os-release` on Linux, `uname -s` on the BSDs and macOS, `ver` on Windows. */
const OS_PROBE = 'cat /etc/os-release 2>/dev/null || uname -s 2>/dev/null || ver';
/** Milliseconds the probe may take before the host is left unlabelled. */
const OS_PROBE_TIMEOUT_MS = 5000;
/** Milliseconds of quiet after which a held tail that may start a secret is shown as it is (spec D5). */
const MASK_HOLD_MS = 150;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * The text a snippet run writes (spec D4 steps 2–4): the first `skip` characters dropped, a leading space
 * when asked, lines joined by `\r` as a paste is, wrapped as a bracketed paste when the shell turned it on,
 * then `\r` for Enter.
 *
 * @throws WirebenchError `snippet-prefix-mismatch` when `skip` reaches past the snippet's literal start
 */
export function frameSnippet(
  text: string,
  opts: { leadingSpace: boolean; bracketed: boolean; enter: boolean; skip: number; literalStart: string },
): string {
  if (opts.skip > opts.literalStart.length || !text.startsWith(opts.literalStart.slice(0, opts.skip))) {
    throw new WirebenchError('snippet-prefix-mismatch', 'What was typed is not the start of this snippet');
  }
  let body = (opts.leadingSpace ? ' ' : '') + text.slice(opts.skip).replace(/\n/g, '\r');
  // An end marker inside the text would end the paste early and run the rest line by line.
  if (opts.bracketed) body = PASTE_START + body.split(PASTE_END).join('') + PASTE_END;
  return opts.enter ? `${body}\r` : body;
}

/**
 * Calls `onSwitch` when the open workspace id differs from the last one seen (closing counts), and not for
 * a rename, a settings change or a reload of the same workspace.
 */
export function whenWorkspaceSwitches(onSwitch: () => void): (workspaceId: string | null | undefined) => void {
  let last: string | null = null;
  return (workspaceId) => {
    const next = workspaceId ?? null;
    if (next === last) return;
    last = next;
    onSwitch();
  };
}

/**
 * One window's workspace-switch hook (multi-window: each window holds its own workspace). A switch in that
 * window ends that window's sessions only; another window keeps its sessions and its pending refusals.
 */
export function sshSessionsEndOnSwitch(
  ssh: Pick<SshService, 'disposeFor'>,
  sender: WebContents,
): (workspaceId: string | null | undefined) => void {
  return whenWorkspaceSwitches(() => {
    ssh.disposeFor(sender);
  });
}

/** Tells every window when the machine wakes from sleep, so a dropped terminal reconnects at once. */
export function forwardResume(
  powerMonitor: { on(event: 'resume', listener: () => void): unknown },
  broadcast: () => void,
): void {
  powerMonitor.on('resume', broadcast);
}

/** A listener on one session's output as its window sees it, after the masker (a shared terminal, #429). */
export interface SessionTap {
  data(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** The session closed; the tap is gone. */
  end(): void;
}

/** How much recent masked output a session keeps, so a tap starts with the screen as it stands (#429). */
const RECENT_OUTPUT_BYTES = 256 * 1024;

interface Live {
  readonly session: SshSession;
  readonly taps: Set<SessionTap>;
  /** The last {@link RECENT_OUTPUT_BYTES} the window was shown, oldest first. */
  readonly recent: { chunks: Uint8Array[]; size: number };
  readonly sender: WebContents;
  readonly hostId: string;
  /** Masks the secret values a snippet typed into this session, for the session's life. */
  readonly masker: StreamMasker;
  readonly stop: () => void;
}

/**
 * The SSH sessions, each owned by the WebContents that opened it: only that window can write to, resize or
 * close it, and only it receives its events. Credentials are resolved at connect and handed to the session;
 * none is ever in an answer, an event or an error. A host key is trusted only through {@link trust}.
 */
export class SshService {
  private readonly live = new Map<string, Live>();
  /** Senders already watched for going away or reloading (one set of listeners per window, not per session). */
  private readonly watched = new Set<number>();
  /** Keys each window's connects refused: the only keys `trust` will record for it. */
  private readonly refusals: RefusalStore;
  private readonly connector: SshConnector;
  /** `trust` reads, changes and writes the file; one at a time, so no entry is lost. */
  private trustQueue: Promise<void> = Promise.resolve();
  private hostOsQueue: Promise<void> = Promise.resolve();
  /** Bumped by {@link disposeAll}; a connect that straddles it closes what it opened. */
  private epoch = 0;
  /**
   * Windows with a connect in flight, by sender id: how many, and a generation {@link disposeFor} bumps so
   * a connect straddling that window's switch stops. An entry lives only while a connect is in flight.
   */
  private readonly inFlight = new Map<number, { count: number; generation: number }>();

  constructor(private readonly deps: SshServiceDeps) {
    this.refusals = deps.refusals ?? new RefusalStore(() => this.now());
    this.connector = deps.connector ?? createSshConnector({ ...deps, refusals: this.refusals });
  }

  /**
   * @throws WirebenchError `workspace-not-open` | a hosts.yaml refusal | `ssh-host-unknown` | `ssh-jump-unknown` |
   *   `ssh-host-incomplete` | `secret-missing` | `ssh-auth-failed` | `ssh-host-key-new` |
   *   `ssh-host-key-changed` | `ssh-connect-failed` | `ssh-sk-pin` (the security key needs its PIN: the screen asks
   *   for it and connects again with `skPin`) | `ssh-sk-no-device` | `ssh-sk-not-touched` | `ssh-sk-unavailable`
   */
  async connect(sender: WebContents, request: SshConnectRequest): Promise<SshConnectResponse> {
    let flight = this.inFlight.get(sender.id);
    if (!flight) {
      flight = { count: 0, generation: 0 };
      this.inFlight.set(sender.id, flight);
    }
    flight.count += 1;
    try {
      return await this.connectNow(sender, request, flight);
    } finally {
      flight.count -= 1;
      if (flight.count === 0 && this.inFlight.get(sender.id) === flight) this.inFlight.delete(sender.id);
    }
  }

  private async connectNow(
    sender: WebContents,
    request: SshConnectRequest,
    flight: { readonly generation: number },
  ): Promise<SshConnectResponse> {
    const epoch = this.epoch;
    const generation = flight.generation;
    // A quit, or this window's workspace switching (or the window going), since the connect began.
    const stale = (): boolean => epoch !== this.epoch || generation !== flight.generation || sender.isDestroyed();
    const closed = (): WirebenchError =>
      new WirebenchError('ssh-session-closed', 'The session closed before it opened');
    const prepared = await this.connector.prepareShell(sender, request.hostId, stale, request.user, request.quick);
    const { env, secrets, forwardAgent, mosh, telnet, serial } = prepared;
    if (telnet !== undefined && this.deps.telnet === false) {
      throw new WirebenchError(
        'telnet-off',
        'Telnet is switched off in this build of Wirebench. Connect to the device over SSH instead.',
      );
    }
    if (serial !== undefined && this.deps.serial === false) {
      throw new WirebenchError('serial-off', 'Serial consoles are switched off in this build of Wirebench.');
    }
    const device = serial === undefined ? undefined : await this.serialDeviceOf(sender, request.hostId);
    // The PIN goes to every key hop; only a security key reads it.
    const pin = request.skPin;
    const hops = pin
      ? prepared.hops.map((hop) => (hop.auth.kind === 'key' ? { ...hop, auth: { ...hop.auth, pin } } : hop))
      : prepared.hops;
    const verifyHostKey = await this.connector.verifierFor(sender);
    // A switch while the secrets were read: they must not go to the hosts of the workspace left.
    if (stale()) throw closed();
    const logged =
      device !== undefined
        ? // A serial line has no port number and no user: the log names the device.
          { hostId: request.hostId, hops, target: { address: device, port: 0, user: '' } }
        : telnet === undefined
          ? { hostId: request.hostId, hops }
          : {
              hostId: request.hostId,
              hops,
              target: { address: telnet.target.address, port: telnet.target.port, user: telnet.login.user ?? '' },
              secrets,
            };
    const startLog = await this.deps.sessionLog?.(sender, logged).catch(() => undefined);
    let session: SshSession;
    try {
      const options = {
        hops,
        cols: request.cols,
        rows: request.rows,
        verifyHostKey,
        ...progressTo(this.deps.emit, sender, request.attemptId),
        ...(Object.keys(env).length === 0 ? {} : { env }),
      };
      if (serial !== undefined && device !== undefined) {
        const openSerial = this.deps.openSerial;
        if (!openSerial) {
          throw new WirebenchError('serial-unavailable', 'Serial consoles are not available on this computer');
        }
        new HopProgress(options.onProgress, 0, 1, device).log(`Opening ${device} at ${serialLineText(serial.line)}`);
        session = withCharset(await openSerial({ path: device, line: serial.line }), prepared.charset);
      } else if (telnet !== undefined) {
        if (telnet.unusedAuth !== undefined) {
          const where = `${telnet.target.address}:${String(telnet.target.port)}`;
          new HopProgress(options.onProgress, hops.length, hops.length + 1, where).log(
            `Telnet signs in with a password only: the ${telnet.unusedAuth === 'key' ? 'private key' : 'SSH agent'} set for this host is not used`,
          );
        }
        const telnetSession = await (this.deps.openTelnet ?? openTelnetSession)({
          hops,
          target: telnet.target,
          login: telnet.login,
          cols: request.cols,
          rows: request.rows,
          verifyHostKey,
          terminalType: prepared.term,
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        });
        session = withCharset(telnetSession, prepared.charset);
      } else if (mosh !== undefined) {
        const openMosh = this.deps.openMosh;
        if (!openMosh) throw new WirebenchError('mosh-unavailable', 'Mosh sessions are not available here');
        // Agent forwarding is an SSH channel request; a Mosh session has no SSH channel to ask on.
        session = await openMosh({ ...options, ...(mosh.settings === undefined ? {} : { mosh: mosh.settings }) });
      } else {
        session = await (this.deps.open ?? openSession)({
          ...options,
          ...(forwardAgent?.socket === undefined ? {} : { forwardAgent: forwardAgent.socket }),
          term: prepared.term,
          charset: prepared.charset,
        });
      }
    } catch (error) {
      // A refused key is forgotten with the window, as its sessions are.
      if ((error as { code?: unknown }).code === 'ssh-host-key-new' && !stale()) this.watch(sender);
      throw this.connector.refusalError(sender, error);
    }
    if (stale()) {
      session.close();
      throw closed();
    }
    const sessionId = session.id;
    // Everything the renderer sees passes the masker: the screen, scrollback, find and a reconnect replay.
    const masker = createStreamMasker();
    // A variable read from a secret is masked too, should the shell print it (`env`, `echo $TOKEN`).
    masker.add(secrets);
    // The log is written what the screen is shown, so a snippet's or a variable's secret is masked in it too.
    let log: SessionLogWriter | undefined;
    try {
      log = startLog?.(sessionId);
    } catch {
      log = undefined;
    }
    const recording = log !== undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const taps = new Set<SessionTap>();
    const recent = { chunks: [] as Uint8Array[], size: 0 };
    const send = (data: Uint8Array): void => {
      if (data.length === 0) return;
      log?.push(data);
      recent.chunks.push(Uint8Array.from(data));
      recent.size += data.length;
      while (recent.size - (recent.chunks[0]?.length ?? 0) >= RECENT_OUTPUT_BYTES) {
        recent.size -= recent.chunks.shift()?.length ?? 0;
      }
      for (const tap of taps) tap.data(data);
      this.deps.emit(sender, events.ssh.data, { sessionId, data: Buffer.from(data).toString('base64') });
    };
    const release = (): void => {
      clearTimeout(quiet);
      quiet = undefined;
      send(masker.flush());
    };
    const offData = session.onData((data) => {
      clearTimeout(quiet);
      send(masker.push(data));
      // A prompt that happens to end like the start of a secret must not stay hidden.
      quiet = masker.holding ? setTimeout(release, MASK_HOLD_MS) : undefined;
    });
    const offExit = session.onExit((exit) => {
      release();
      void log?.end({ code: exit.code, reason: exit.reason, ...(exit.signal ? { signal: exit.signal } : {}) });
      log = undefined;
      this.deps.emit(sender, events.ssh.exit, {
        sessionId,
        code: exit.code,
        ...(exit.signal ? { signal: exit.signal } : {}),
        reason: exit.reason,
      });
      this.drop(sessionId);
    });
    this.live.set(sessionId, {
      session,
      taps,
      recent,
      sender,
      hostId: request.hostId,
      masker,
      stop: () => {
        clearTimeout(quiet);
        offData();
        offExit();
        // Closed by the window (or its going): the screen is gone, but what the masker held belongs in the log.
        if (log) {
          log.push(masker.flush());
          void log.end(undefined);
        }
      },
    });
    this.watch(sender);
    this.deps.emit(sender, events.ssh.state, { sessionId, state: 'open' });
    this.sessionsChanged(sender, request.hostId);
    const target = hops[hops.length - 1];
    // A Mosh or Telnet session has no SSH channel to ask on: the host keeps its last known label.
    if (target && mosh === undefined && telnet === undefined) {
      void this.probeOs(sender, session, `${target.address}:${target.port}`);
    }
    const opened = { sessionId, ...(recording ? { recording: true as const } : {}) };
    if (forwardAgent === undefined || mosh !== undefined) return opened;
    const forwarding = forwardAgent.socket === undefined ? 'no-agent' : session.agentForwarding;
    return forwarding === 'off' ? opened : { ...opened, agentForwarding: forwarding };
  }

  /**
   * Asks the connected host what it runs and keeps the answer. Runs beside the connect, which never waits
   * for it: any failure leaves the host unlabelled and nothing else changes.
   */
  /**
   * The device this machine opens for a serial host.
   * @throws WirebenchError `serial-device-unset` when none was picked yet: the connection screen asks for one
   */
  private async serialDeviceOf(sender: WebContents, hostId: string): Promise<string> {
    const device = await this.deps.serialDevice?.(sender, hostId);
    if (device === undefined) {
      throw new WirebenchError('serial-device-unset', 'Pick the serial port this computer opens for the console', {
        details: { hostId },
      });
    }
    return device;
  }

  private async probeOs(sender: WebContents, session: SshSession, host: string): Promise<void> {
    try {
      const detected = detectOs(await session.exec(OS_PROBE, OS_PROBE_TIMEOUT_MS));
      if (!detected) return;
      await this.updateHostOs(host, (entry) => ({ ...entry, detected: detected satisfies SshDetectedOsWire }));
      if (!sender.isDestroyed()) this.deps.emit(sender, events.ssh.hostOsChanged, {});
    } catch {
      // Only a label: a probe that failed (or a store that cannot be written) is not worth a message.
    }
  }

  /** The OS found or chosen for each server on this machine, keyed `address:port`. */
  hostOs(): Promise<Record<string, SshHostOsWire>> {
    return this.readHostOs();
  }

  /**
   * Sets (`os`) or clears (`null`) the OS the user chose for `host`; a cleared choice falls back to what
   * was detected. Tells the calling window.
   */
  async setHostOs(sender: WebContents, request: { readonly host: string; readonly os: SshOsId | null }): Promise<void> {
    await this.updateHostOs(request.host, (entry) => {
      const rest: SshHostOsWire = entry.detected ? { detected: entry.detected } : {};
      return request.os === null ? rest : { ...rest, chosen: request.os };
    });
    if (!sender.isDestroyed()) this.deps.emit(sender, events.ssh.hostOsChanged, {});
  }

  /** Serialised, so concurrent probes and choices all land. An entry left empty is dropped. */
  private updateHostOs(host: string, change: (entry: SshHostOsWire) => SshHostOsWire): Promise<void> {
    const run = this.hostOsQueue.then(async () => {
      const all = await this.readHostOs();
      const next = change(all[host] ?? {});
      const written = { ...all };
      if (next.detected || next.chosen) written[host] = next;
      else delete written[host];
      await writeFileAtomic(nodeFs, this.deps.hostOsFile, `${JSON.stringify(written, null, 2)}\n`);
    });
    this.hostOsQueue = run.catch(() => undefined);
    return run;
  }

  /** A missing or broken file reads as empty: it only ever holds labels. */
  private async readHostOs(): Promise<Record<string, SshHostOsWire>> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.deps.hostOsFile, 'utf8'));
      const parsed = sshHostOsResponseSchema.safeParse({ entries: raw });
      return parsed.success ? parsed.data.entries : {};
    } catch {
      return {};
    }
  }

  /** @throws WirebenchError `ssh-session-unknown` for a foreign or dead session. */
  write(sender: WebContents, request: SshWriteRequest): void {
    this.owned(sender, request.sessionId).session.write(Buffer.from(request.data, 'base64'));
  }

  /**
   * Writes `data` to each session this window owns and has live; the rest come back in `skipped` and are
   * written nothing, so a broadcast never reaches another window's session.
   */
  writeMany(sender: WebContents, request: SshWriteManyRequest): SshWriteManyResponse {
    const bytes = Buffer.from(request.data, 'base64');
    const skipped: string[] = [];
    for (const sessionId of request.sessionIds) {
      const live = this.live.get(sessionId);
      if (live?.sender.id === sender.id) live.session.write(bytes);
      else skipped.push(sessionId);
    }
    return { skipped };
  }

  /**
   * Types the saved snippet `snippetId` into a session this window owns (spec D4). Every refusal comes
   * before anything is written. The secret values go to the session's masker before the write and nowhere
   * else: never into an answer, an event or an error.
   *
   * @throws WirebenchError `ssh-session-unknown` | `workspace-not-open` | `snippet-unknown` | `snippet-changed` |
   *   `secret-missing` | `snippet-variable-missing` | `snippet-value-invalid` | `snippet-prefix-mismatch`
   */
  async runSnippet(sender: WebContents, request: SshRunSnippetRequest): Promise<void> {
    this.owned(sender, request.sessionId);
    // Taken now, so the secrets are those of the workspace the run began in.
    const getSecret = this.deps.secretsFor(sender);
    const { snippet, item } = await this.savedSnippet(sender, request.snippetId);
    if (item.revision !== request.revision) {
      throw new WirebenchError('snippet-changed', `The snippet "${snippet.name}" changed since it was shown`, {
        details: { snippet: snippet.id },
      });
    }
    const secrets: Record<string, string> = {};
    for (const name of snippetSecrets(snippet.script)) {
      const value = await getSecret(secretPseudoRef(name));
      if (value === undefined) {
        throw new WirebenchError('secret-missing', `The secret "${name}" is not on this machine`, {
          details: { name },
        });
      }
      secrets[name] = value;
    }
    let expansion: ReturnType<typeof expandSnippet>;
    try {
      expansion = expandSnippet(snippet, request.values, secrets);
    } catch (error) {
      throw asWirebenchError(error);
    }
    const skip = request.skip ?? 0;
    const text = frameSnippet(expansion.text, {
      leadingSpace: item.secrets.length > 0 && skip === 0,
      bracketed: request.bracketed,
      enter: request.enter === false ? false : snippet.enter,
      skip,
      literalStart: item.literalStart,
    });
    // The session may have closed while the secrets were read.
    const live = this.owned(sender, request.sessionId);
    live.masker.add(expansion.secretValues);
    live.session.write(Buffer.from(text, 'utf8'));
  }

  /**
   * The saved snippet expanded with every secret as `••••`, and its revision: what the run dialog shows.
   * Never resolves a secret.
   *
   * @throws WirebenchError `workspace-not-open` | `snippet-unknown` | `snippet-variable-missing` | `snippet-value-invalid`
   */
  async previewSnippet(sender: WebContents, request: SshPreviewSnippetRequest): Promise<SshPreviewSnippetResponse> {
    const { snippet } = await this.savedSnippet(sender, request.snippetId);
    try {
      return { text: previewSnippet(snippet, request.values), revision: snippetRevision(snippet) };
    } catch (error) {
      throw asWirebenchError(error);
    }
  }

  /** @throws WirebenchError `workspace-not-open` | `snippet-unknown` */
  private async savedSnippet(sender: WebContents, id: string): Promise<{ snippet: Snippet; item: SnippetListItem }> {
    const service = this.deps.snippets(sender);
    await service.list(); // reads the file when nothing is cached for the open workspace
    const file = service.current();
    const snippet = file ? findSnippet(file, id) : undefined;
    const item = file ? listSnippets(file).find((i) => i.id === id) : undefined;
    if (!snippet || !item) {
      throw new WirebenchError('snippet-unknown', `No saved snippet "${id}"`, { details: { snippet: id } });
    }
    return { snippet, item };
  }

  /** @throws WirebenchError `ssh-session-unknown` for a foreign or dead session. */
  resize(sender: WebContents, request: SshResizeRequest): void {
    const live = this.owned(sender, request.sessionId);
    live.session.resize(request.cols, request.rows);
    for (const tap of live.taps) tap.resize(request.cols, request.rows);
  }

  /**
   * Hands `tap` what the window is shown of a session it owns, masked: about the last 256 KB at once, then
   * what follows, until the returned function is called or the session closes (then `end`).
   *
   * @throws WirebenchError `ssh-session-unknown` for a foreign or dead session.
   */
  tap(sender: WebContents, sessionId: string, tap: SessionTap): () => void {
    const { taps, recent } = this.owned(sender, sessionId);
    // The screen as it stands first, so a viewer sees what was printed before the share began.
    if (recent.size > 0) tap.data(Buffer.concat(recent.chunks));
    taps.add(tap);
    return () => {
      taps.delete(tap);
    };
  }

  /** Idempotent: a session already gone, or another window's, is left as it is. */
  close(sender: WebContents, request: SshCloseRequest): void {
    const live = this.live.get(request.sessionId);
    if (!live || live.sender.id !== sender.id) return;
    live.session.close();
    this.drop(request.sessionId);
  }

  /**
   * Records a key a connect from this window refused in the last ten minutes (`REFUSAL_TTL_MS`); nothing else.
   * A changed key needs `replace: true`; a new one never does. Serialised, so concurrent trusts all land.
   *
   * @throws WirebenchError `ssh-host-key-unexpected` | `ssh-host-key-changed`
   */
  trust(sender: WebContents, request: SshTrustRequest): Promise<void> {
    const run = this.trustQueue.then(() => this.trustNow(sender, request));
    this.trustQueue = run.catch(() => undefined);
    return run;
  }

  private async trustNow(sender: WebContents, request: SshTrustRequest): Promise<void> {
    const refusal = this.refusals
      .of(sender.id)
      .find((r) => r.host === request.host && r.keyType === request.keyType && r.fingerprint === request.fingerprint);
    if (!refusal) throw new WirebenchError('ssh-host-key-unexpected', 'Connect to the host again to review its key');
    const entry: KnownHostEntry = { host: refusal.host, keyType: refusal.keyType, fingerprint: refusal.fingerprint };
    if (refusal.kind === 'changed' && !request.replace) {
      throw new WirebenchError(
        'ssh-host-key-changed',
        `${request.host} already has a different ${request.keyType} key; replacing it needs confirmation`,
        { details: { ...entry, ...(refusal.previous ? { previous: refusal.previous } : {}) } },
      );
    }
    // The file may have gained a key for this host since the refusal (another prompt, another window):
    // overwriting it is a replace, whatever the refusal was.
    const known = await readKnownHosts(this.deps.knownHostsFile);
    const stored = known.find((e) => e.host === entry.host && e.keyType === entry.keyType);
    if (stored && stored.fingerprint !== entry.fingerprint && !request.replace) {
      throw new WirebenchError(
        'ssh-host-key-changed',
        `${request.host} already has a different ${request.keyType} key; replacing it needs confirmation`,
        { details: { ...entry, previous: stored.fingerprint } },
      );
    }
    await writeFileAtomic(nodeFs, this.deps.knownHostsFile, serializeKnownHosts(rememberKnownHost(known, entry)));
    // What was just decided settles this host and key type for every window: no older prompt can undo it.
    this.refusals.settle(entry);
  }

  /** Closes every session (workspace switch, quit). */
  disposeAll(): void {
    this.epoch += 1;
    this.refusals.clear();
    for (const [sessionId, live] of [...this.live]) {
      live.session.close();
      this.drop(sessionId);
    }
  }

  /**
   * Closes the sessions one window owns (the window went away, reloaded, or switched workspace), and a
   * connect it has in flight; other windows' sessions and refusals are left alone.
   */
  disposeFor(sender: WebContents): void {
    const flight = this.inFlight.get(sender.id);
    if (flight) flight.generation += 1;
    this.connector.forget(sender);
    for (const [sessionId, live] of [...this.live]) {
      if (live.sender.id !== sender.id) continue;
      live.session.close();
      this.drop(sessionId);
    }
  }

  private watch(sender: WebContents): void {
    if (this.watched.has(sender.id)) return;
    this.watched.add(sender.id);
    // A reload or a crash starts a renderer that knows nothing of the old sessions; they go too.
    sender.on('render-process-gone', () => this.disposeFor(sender));
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.disposeFor(sender);
    });
    sender.once('destroyed', () => {
      this.watched.delete(sender.id);
      this.disposeFor(sender);
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private owned(sender: WebContents, sessionId: string): Live {
    const live = this.live.get(sessionId);
    if (!live || live.sender.id !== sender.id) throw new WirebenchError('ssh-session-unknown', 'No such session');
    return live;
  }

  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.stop();
    this.live.delete(sessionId);
    for (const tap of [...live.taps]) tap.end();
    live.taps.clear();
    if (!live.sender.isDestroyed()) this.deps.emit(live.sender, events.ssh.state, { sessionId, state: 'closed' });
    this.sessionsChanged(live.sender, live.hostId);
  }

  /** Tells the hook how many of that window's sessions to the host are open now. */
  private sessionsChanged(sender: WebContents, hostId: string): void {
    const hook = this.deps.onSessionsChange;
    if (!hook) return;
    let open = 0;
    for (const live of this.live.values()) if (live.sender.id === sender.id && live.hostId === hostId) open += 1;
    hook(sender, hostId, open);
  }

  /**
   * Rewrites the trusted host keys from what `change` makes of them, read now, in the same queue as
   * {@link trust} so neither loses the other's entry. Every key it writes settles that host and key type
   * for every window, as a trust does.
   */
  changeKnownHosts<T extends { readonly entries: readonly KnownHostEntry[] }>(
    change: (known: readonly KnownHostEntry[]) => T,
  ): Promise<T> {
    const run = this.trustQueue.then(async () => {
      const known = await readKnownHosts(this.deps.knownHostsFile);
      const changed = change(known);
      const written = changed.entries.filter(
        (e) => !known.some((k) => k.host === e.host && k.keyType === e.keyType && k.fingerprint === e.fingerprint),
      );
      if (written.length === 0 && changed.entries.length === known.length) return changed;
      await writeFileAtomic(nodeFs, this.deps.knownHostsFile, serializeKnownHosts(changed.entries));
      for (const entry of written) this.refusals.settle(entry);
      return changed;
    });
    this.trustQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The host keys trusted on this machine, for the Known hosts view. */
  async knownHosts(): Promise<readonly KnownHostEntry[]> {
    return readKnownHosts(this.deps.knownHostsFile);
  }

  /**
   * Forgets the trusted key for `host` and `keyType`: the next connection to that host shows the
   * trust prompt again. Forgetting a key that is not there is a no-op, not an error.
   */
  async forgetHostKey(request: { readonly host: string; readonly keyType: string }): Promise<void> {
    const known = await readKnownHosts(this.deps.knownHostsFile);
    const kept = known.filter((e) => !(e.host === request.host && e.keyType === request.keyType));
    if (kept.length === known.length) return;
    await writeFileAtomic(nodeFs, this.deps.knownHostsFile, serializeKnownHosts(kept));
  }
}
