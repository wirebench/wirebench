import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, CircleDot, KeyRound, Laptop, Loader2, X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { findHost, osKeyOf, upsertHost, useHostsStore } from './hosts-store.js';
import { findIdentity, upsertIdentity } from './identities.js';
import type { IdentityWire } from '../../../shared/ssh-wire.js';
import { INPUT_CLASS } from './inherited-field.js';
import { connectFix } from './connect-errors.js';
import { setSignInUser, useConnectStore } from './connect-store.js';
import { OsIcon, osOf } from './os-icon.js';
import { saveQuickAsHost } from './connect.js';
import { isQuickHostId, useQuickHostsStore } from './quick-hosts.js';
import { formatDuration, inTimeOrder, shownSteps, SSH_ROUTE, stepDuration, stepLabel } from './connect-progress.js';
import type { ConnectLogLine, ConnectPurpose, ConnectRoute, ConnectStep, ConnectView } from './connect-progress.js';
import { TYPE_AHEAD_LIMIT, type TypeAheadState } from './type-ahead.js';
import { storeSshSecret } from './secret-writes.js';
import { ipc } from '../../state/ipc-client.js';
import {
  portText,
  portsNote,
  RefreshPortsButton,
  serialLabel,
  serialPathExample,
  serialTargetText,
  useSerialPorts,
} from './serial-section.js';

/** How long "Connected in N ms" shows before the screen fades, and how long the fade takes. */
export const CONNECTED_HOLD_MS = 600;
export const CONNECTED_FADE_MS = 300;

/** The countdown banner a dropped session's reconnect (#407) puts over the steps. */
export interface ReconnectBanner {
  readonly text: string;
  /** Waiting for the next attempt: try now instead. */
  readonly onNow?: (() => void) | undefined;
  /** Waiting or trying: stop reconnecting. */
  readonly onStop?: (() => void) | undefined;
}

export interface ConnectScreenProps {
  readonly hostId: string;
  readonly purpose: ConnectPurpose;
  /** The attempt shown; none yet while a reconnect waits for its first try. */
  readonly view: ConnectView | undefined;
  readonly reconnect?: ReconnectBanner | undefined;
  /** Keys typed into the pane while it connects, kept for its shell (#361). */
  readonly typedAhead?: TypeAheadState | undefined;
  readonly onRetry: () => void;
  /** A security key asked for its PIN (#420): connect again with it. Without it the screen only says so. */
  readonly onPin?: ((pin: string) => void) | undefined;
  /**
   * Connects again with a password typed for this connect only (#721, #722). Without it a missing password is
   * stored before the retry, as before.
   */
  readonly onPassword?: ((password: string) => void) | undefined;
  readonly onEditHost: () => void;
  readonly onClose: () => void;
  /** "Connected in N ms" has shown and faded: the caller drops the screen. */
  readonly onFaded?: (() => void) | undefined;
  /** Over the terminal (a pane), or in place of a Files pane's list. */
  readonly overlay?: boolean;
  /** A failed attempt's log stays folded: a reconnect that gave up says enough without it (#590). */
  readonly foldLog?: boolean;
}

/** What the screen says about keys typed while connecting. */
export function typedAheadText({ full }: TypeAheadState): string {
  return full
    ? `What you typed is sent when the shell opens, up to ${String(TYPE_AHEAD_LIMIT / 1024)} KB; typing after that is not kept.`
    : 'What you typed is sent when the shell opens.';
}

function timeOf(at: number): string {
  const date = new Date(at);
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.toLocaleTimeString([], { hour12: false })}.${ms}`;
}

function StepIcon({ state }: { readonly state: ConnectStep['state'] }) {
  switch (state) {
    case 'done':
      return <Check size={14} aria-hidden="true" className="text-status-success" />;
    case 'failed':
      return <X size={14} aria-hidden="true" className="text-status-danger" />;
    case 'waiting':
      return <KeyRound size={14} aria-hidden="true" className="text-status-warning" />;
    case 'running':
      // With reduced motion there is no spinner: a still mark says the step is the one running.
      return (
        <>
          <Loader2 size={14} aria-hidden="true" className="text-accent motion-safe:animate-spin motion-reduce:hidden" />
          <CircleDot size={14} aria-hidden="true" className="text-accent motion-safe:hidden" />
        </>
      );
    case 'pending':
      return <Circle size={14} aria-hidden="true" className="text-fg-faint" />;
  }
}

/** Words a screen reader gives the step's state, since the icons are hidden from it. */
const STATE_WORDS: Readonly<Record<ConnectStep['state'], string>> = {
  pending: 'not started',
  running: 'in progress',
  done: 'done',
  failed: 'failed',
  waiting: 'waiting for you',
};

/** The line that says what failed: the last one main flagged. The summary sentence is pinned above the log. */
export function failingLine(lines: readonly ConnectLogLine[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.error === true) return index;
  }
  return undefined;
}

/**
 * The handshake log: the failure's summary pinned above it as its own line (#590), then main's lines in
 * time order.
 */
export function ConnectLog({
  lines: logged,
  summary,
}: {
  readonly lines: readonly ConnectLogLine[];
  /** The failure's one sentence; set only once an attempt failed. */
  readonly summary: string | undefined;
}) {
  const box = useRef<HTMLPreElement>(null);
  const failing = useRef<HTMLSpanElement>(null);
  const failed = summary !== undefined;
  const lines = inTimeOrder(logged);
  const failingIndex = failed ? failingLine(lines) : undefined;
  // A failed attempt's log opens at its end, the failing line in view (#532); lines that land late keep it there.
  useEffect(() => {
    if (!failed || box.current === null) return;
    box.current.scrollTop = box.current.scrollHeight;
    failing.current?.scrollIntoView?.({ block: 'nearest' });
  }, [failed, lines.length]);
  return (
    <div
      data-testid="connect-log"
      className={`overflow-hidden rounded-md border ${failed ? 'border-status-danger/60' : 'border-hairline'} bg-surface-base font-mono text-xs`}
    >
      {summary !== undefined && (
        <p
          data-testid="connect-log-summary"
          data-error="true"
          className="border-b border-status-danger/40 bg-status-danger/10 px-2 py-1 font-medium whitespace-pre-wrap text-status-danger select-text"
        >
          {summary}
        </p>
      )}
      {/* A failure with nothing logged shows its summary alone: "Nothing logged yet." under it read as a contradiction (S67). */}
      {(lines.length > 0 || !failed) && (
        <pre ref={box} className="max-h-72 overflow-auto p-2 whitespace-pre-wrap text-fg-muted select-text">
          {lines.length === 0
            ? 'Nothing logged yet.'
            : lines.map((line, index) => (
                <span
                  key={index}
                  ref={index === failingIndex ? failing : undefined}
                  className={`block ${line.error ? 'text-status-danger' : ''} ${
                    index === failingIndex ? 'rounded-sm bg-status-danger/15 font-medium' : ''
                  }`}
                  data-error={line.error ? 'true' : undefined}
                  data-failing={index === failingIndex ? 'true' : undefined}
                >
                  <span className={line.error ? undefined : 'text-fg-faint'}>{timeOf(line.at)}</span> {line.text}
                </span>
              ))}
        </pre>
      )}
    </div>
  );
}

/**
 * A dropped terminal reconnecting (#590), over its dimmed scrollback: the countdown or the attempt under
 * way, with Reconnect now, Stop and Show log as the only controls. The log is the latest attempt's.
 */
export function ReconnectBar({
  banner,
  view,
  typedAhead,
}: {
  readonly banner: ReconnectBanner;
  /** The attempt last made; none before the first try. */
  readonly view: ConnectView | undefined;
  readonly typedAhead?: TypeAheadState | undefined;
}) {
  const [logOpen, setLogOpen] = useState(false);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
      <div className="pointer-events-auto flex w-full max-w-3xl flex-col gap-2">
        <div
          role="status"
          data-testid="ssh-terminal-notice"
          className="flex flex-wrap items-center gap-2 rounded-md border border-status-warning/40 bg-surface-raised px-3 py-2 text-sm text-fg-default shadow-md"
        >
          <span className="min-w-0 flex-1">{banner.text}</span>
          {banner.onNow !== undefined && <Button onClick={banner.onNow}>Reconnect now</Button>}
          {banner.onStop !== undefined && <Button onClick={banner.onStop}>Stop</Button>}
          <Button
            variant="ghost"
            aria-expanded={logOpen}
            onClick={() => {
              setLogOpen((open) => !open);
            }}
          >
            {logOpen ? 'Hide log' : 'Show log'}
          </Button>
        </div>
        {typedAhead !== undefined && (typedAhead.bytes > 0 || typedAhead.full) && (
          <p
            className="self-start rounded-md bg-surface-raised px-2 py-1 text-sm text-fg-subtle"
            role="status"
            data-testid="connect-typed-ahead"
          >
            {typedAheadText(typedAhead)}
          </p>
        )}
        {logOpen && (
          <ConnectLog
            lines={view?.log ?? []}
            summary={view?.outcome.kind === 'failed' ? view.outcome.sentence : undefined}
          />
        )}
      </div>
    </div>
  );
}

/** Focuses the field when it appears: the form is what the screen asks of the user next. */
function useFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

const SIGN_IN_USER = /^[^\s\p{Cc}]+$/u;

/**
 * "Sign in as [user] [Connect] ☐ Save to host" for a host with no user (#532). Saved, the user goes into
 * the host's own settings through the hosts file; not saved, it signs this pane's connects in only. A host
 * signing in through an identity that has no user offers saving it to that identity instead, for every
 * host using it (#416).
 */
function SignInAsForm({
  hostId,
  paneKey,
  identity,
  onConnect,
}: {
  readonly hostId: string;
  readonly paneKey: string | undefined;
  readonly identity: IdentityWire | undefined;
  readonly onConnect: () => void;
}) {
  const [user, setUser] = useState('');
  const [save, setSave] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const field = useFocus<HTMLInputElement>();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = user.trim();
    if (!SIGN_IN_USER.test(name)) {
      setError('Enter a user name without spaces.');
      return;
    }
    setBusy(true);
    if (save) {
      const hosts = useHostsStore.getState();
      const entry = findHost(hosts.file, hostId);
      const current = identity === undefined ? undefined : findIdentity(hosts.file, identity.id);
      const saved =
        current !== undefined
          ? await hosts.save(upsertIdentity(hosts.file, { ...current, user: name }))
          : entry !== undefined &&
            (await hosts.save(upsertHost(hosts.file, { ...entry, ssh: { ...entry.ssh, user: name } })));
      if (!saved) {
        setBusy(false);
        setError(
          identity === undefined
            ? 'The host could not be saved. Edit the host to set its user.'
            : 'The identity could not be saved. Edit it in the Keychain to set its user.',
        );
        return;
      }
      if (paneKey !== undefined) setSignInUser(paneKey, undefined);
    } else if (paneKey !== undefined) {
      setSignInUser(paneKey, name);
    }
    setBusy(false);
    onConnect();
  };
  return (
    <form
      data-testid="connect-sign-in"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg-default">
          <span className="shrink-0">Sign in as</span>
          <input
            ref={field}
            aria-label="Sign in as"
            autoComplete="username"
            spellCheck={false}
            className={`${INPUT_CLASS} min-w-0 flex-1`}
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
              setError(undefined);
            }}
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy || user.trim() === ''}>
          Connect
        </Button>
      </div>
      {/* A one-off server has no host to save to (#537): Save as host… keeps it, user and all. */}
      {!isQuickHostId(hostId) && (
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={save}
            onChange={(e) => {
              setSave(e.target.checked);
            }}
          />
          {identity === undefined ? 'Save to host' : `Save to identity ${identity.name}`}
        </label>
      )}
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * "Password for <user> [____] [Save and retry]" when the target refused its password, or its password is
 * not on this machine (#532). The value goes to the host's secret in the secret store, write-only: it is
 * never read back, and never reaches the hosts file or the log.
 */
function PasswordForm({
  user,
  secret,
  identity,
  onRetry,
  onOnce,
}: {
  readonly user: string | undefined;
  /** Where Remember stores it; none for a host that signs in with the agent (#722). */
  readonly secret: string | undefined;
  /** The identity the password belongs to (#416): saving it changes it for every host using it. */
  readonly identity: string | undefined;
  readonly onRetry: () => void;
  /**
   * Connects once with the typed password, storing nothing (#721, #722): Connect leads, and storing it is the
   * opt-in "Remember on this machine". Without it the form stores the password and retries, as for a password
   * the server refused, whose stored value is the one to fix.
   */
  readonly onOnce?: ((password: string) => void) | undefined;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  const field = useFocus<HTMLInputElement>();
  const label = user === undefined ? 'Password' : `Password for ${user}`;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (value === '') return;
    if (onOnce !== undefined && (!remember || secret === undefined)) {
      const typed = value;
      setValue('');
      onOnce(typed);
      return;
    }
    if (secret === undefined) return;
    setBusy(true);
    const stored = await storeSshSecret({ name: secret, value });
    setValue('');
    setBusy(false);
    if (!stored.ok) {
      setError(stored.error.message);
      return;
    }
    onRetry();
  };
  return (
    <form
      data-testid="connect-password"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg-default">
          <span className="shrink-0">{label}</span>
          <input
            ref={field}
            type="password"
            aria-label={label}
            autoComplete="off"
            className={`${INPUT_CLASS} min-w-0 flex-1`}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy || value === ''}>
          {onOnce === undefined ? 'Save and retry' : 'Connect'}
        </Button>
      </div>
      {onOnce !== undefined && secret !== undefined && (
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked);
            }}
          />
          {identity === undefined ? 'Remember on this machine' : `Remember for the identity ${identity}`}
        </label>
      )}
      {identity !== undefined && (onOnce === undefined || remember) && (
        <p className="text-xs text-fg-muted">{`Saved for the identity ${identity}: every host that uses it signs in with it.`}</p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * A serial console with no device on this computer, or one that is gone (#426): this machine's ports to pick
 * from, a Refresh for an adapter plugged in since, and a path to type. The pick is kept on this machine, and
 * the connect runs again with it.
 */
function SerialDeviceForm({ hostId, onConnect }: { readonly hostId: string; readonly onConnect: () => void }) {
  const state = useSerialPorts();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const use = async (device: string): Promise<void> => {
    setBusy(true);
    const kept = await ipc().ssh.setSerialDevice({ hostId, device });
    setBusy(false);
    if (!kept.ok) {
      setError(kept.error.message);
      return;
    }
    onConnect();
  };
  return (
    <form
      data-testid="connect-serial-device"
      aria-label="Serial port"
      className="flex flex-col gap-2 rounded-md border border-hairline bg-surface-base p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed.trim() !== '') void use(typed.trim());
      }}
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-fg-subtle">{portsNote(state)}</span>
        <RefreshPortsButton state={state} />
      </div>
      {state.ports.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Serial ports on this computer">
          {state.ports.map((port) => (
            <li key={port.path} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-default">{portText(port)}</span>
              <Button
                disabled={busy}
                aria-label={`Connect on ${port.path}`}
                onClick={() => {
                  void use(port.path);
                }}
              >
                Connect
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          aria-label="Serial port path"
          className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
          placeholder={serialPathExample()}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(undefined);
          }}
        />
        <Button type="submit" variant="primary" disabled={busy || typed.trim() === ''}>
          Use and connect
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">Kept on this computer for this console, never in hosts.yaml.</p>
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/** The security key's PIN, typed here and handed straight to the next connect (#420). */
function PinForm({ wrong, onPin }: { readonly wrong: boolean; readonly onPin: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  // CTAP2: at least 4 characters.
  const ok = [...pin].length >= 4;
  return (
    <form
      data-testid="connect-pin"
      className="flex flex-col gap-2 rounded-md border border-hairline bg-surface-base p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ok) onPin(pin);
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-fg-subtle">
        {wrong ? 'Try the security key PIN again' : 'Security key PIN'}
        <input
          type="password"
          autoComplete="off"
          autoFocus
          maxLength={63}
          className={INPUT_CLASS}
          value={pin}
          onChange={(event) => {
            setPin(event.target.value);
          }}
        />
      </label>
      <p className="text-xs text-fg-subtle">
        Used for this connection only and never stored. Touch the key when it blinks.
      </p>
      <div>
        <Button type="submit" variant="primary" disabled={!ok}>
          Unlock and connect
        </Button>
      </div>
    </form>
  );
}

/**
 * A connection in progress, failed or reconnecting (#528): this machine → the host, the steps with their
 * timings, one sentence when it failed with Retry / Edit host / Close, and the handshake log (folded while
 * it connects, open once it fails).
 */
export function ConnectScreen({
  hostId,
  purpose,
  view,
  reconnect,
  typedAhead,
  onRetry,
  onPin,
  onPassword,
  onEditHost,
  onClose,
  onFaded,
  overlay = false,
  foldLog = false,
}: ConnectScreenProps) {
  const host = useHostsStore((s) => s.resolved.find((h) => h.id === hostId));
  const quick = useQuickHostsStore((s) => s.targets[hostId]);
  const hostsFile = useHostsStore((s) => s.file);
  // The identity the host signs in through, and the one its password comes from (#416).
  const identityId = host?.ssh.identity?.value;
  const identity = identityId === undefined ? undefined : findIdentity(hostsFile, identityId);
  const authFrom = host?.ssh.auth.from;
  const authIdentity =
    typeof authFrom === 'object' && 'identity' in authFrom ? findIdentity(hostsFile, authFrom.identity) : undefined;
  // What the screen connects (a pane), from the attempt it shows: a user typed here is kept under it.
  const paneKey = useConnectStore((s) => (view === undefined ? undefined : s.attempts[view.attemptId]));
  const typedUser = useConnectStore((s) => (paneKey === undefined ? undefined : s.users[paneKey]));
  const os = useHostsStore((s) => (host === undefined ? undefined : osOf(s.osByHost[osKeyOf(host)])));
  const outcome = view?.outcome.kind;
  // A serial console with no port picked on this computer yet has not failed: the screen asks for one,
  // with nothing red, no Retry and no log (#688). A port that was set and is gone stays a failure.
  const choosePort = view?.outcome.kind === 'failed' && view.outcome.error.code === 'serial-device-unset';
  // No password stored for a host that signs in with one is a sign-in step, not a failure (#721): the form
  // promised to ask for it at connect time. Asked like the port above: nothing red, no Retry, no log.
  const signIn =
    onPassword !== undefined &&
    view?.outcome.kind === 'failed' &&
    view.outcome.error.code === 'secret-missing' &&
    host?.ssh.auth.value?.kind === 'password' &&
    view.outcome.error.details?.['name'] === host.ssh.auth.value.secret;
  const failed = outcome === 'failed' && !choosePort && !signIn;
  const connected = outcome === 'connected';
  const [logOpen, setLogOpen] = useState(failed && !foldLog);
  const [fading, setFading] = useState(false);
  // Read when the fade ends: the caller's new function on each render must not restart the hold.
  const fadedRef = useRef(onFaded);
  fadedRef.current = onFaded;
  const attemptId = view?.attemptId;
  // Folded while connecting, open as soon as an attempt fails; a new attempt folds it again.
  useEffect(() => {
    setLogOpen(failed && !foldLog);
  }, [failed, attemptId, foldLog]);
  useEffect(() => {
    setFading(false);
    if (!connected) return;
    const fade = setTimeout(() => {
      setFading(true);
    }, CONNECTED_HOLD_MS);
    const gone = setTimeout(() => {
      fadedRef.current?.();
    }, CONNECTED_HOLD_MS + CONNECTED_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [connected, attemptId]);

  const user = typedUser ?? host?.ssh.user.value ?? quick?.user;
  const protocol = host?.ssh.protocol?.value;
  const serialHost = protocol === 'serial';
  // The port this computer opens for a serial console, read again for each attempt: a pick changes it.
  const [device, setDevice] = useState<string>();
  useEffect(() => {
    setDevice(undefined);
    if (!serialHost) return;
    let live = true;
    Promise.resolve()
      .then(() => ipc().ssh.serialDevice({ hostId }))
      .then((result) => {
        if (live && result.ok) setDevice(result.value.device);
      })
      // Unread, the step names no port.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hostId, serialHost, attemptId]);
  // Telnet and a serial console list their own steps, not SSH's (#688).
  const route: ConnectRoute =
    protocol === 'telnet'
      ? { kind: 'telnet', signIn: user !== undefined && user !== '' }
      : serialHost
        ? { kind: 'serial', opening: `${device ?? 'the serial port'} at ${serialLabel(host?.ssh.serial?.value)}` }
        : SSH_ROUTE;
  // A one-off server has no saved host: the screen names what was typed, never its internal id (#716).
  const target =
    host === undefined
      ? quick === undefined
        ? hostId
        : `${user === undefined ? '' : `${user}@`}${quick.address.includes(':') ? `[${quick.address}]` : quick.address}:${String(quick.port)}`
      : host.ssh.protocol?.value === 'serial'
        ? serialTargetText(host)
        : `${user === undefined ? '' : `${user}@`}${host.address}:${String(host.ssh.port.value)}`;
  const running = view === undefined || outcome === 'running' || outcome === 'trust';
  const steps = view === undefined ? undefined : shownSteps(view.steps, route);
  const total = view !== undefined && view.outcome.kind === 'connected' ? view.outcome.at - view.startedAt : undefined;
  const showActions = failed || (reconnect === undefined && view === undefined);
  // A host's settings stopped it before any step ran: the steps are not the story (#532).
  const settings =
    view?.outcome.kind === 'failed' && view.outcome.step === undefined && !choosePort && !signIn
      ? view.outcome
      : undefined;
  // Retry leads only where trying again can work; a refused sign-in or a setting is fixed first (#532).
  const fix =
    view?.outcome.kind === 'failed'
      ? connectFix(
          view.outcome.error,
          host !== undefined
            ? { hostId, user, auth: host.ssh.auth.value, host: `${host.address}:${String(host.ssh.port.value)}` }
            : // A one-off server signs in with the agent (#537); a password is the way in when that fails (#722).
              quick !== undefined
              ? { hostId, user, auth: { kind: 'agent' }, host: `${quick.address}:${String(quick.port)}` }
              : undefined,
        )
      : undefined;
  const retryPrimary = fix?.retryPrimary ?? true;

  return (
    <div
      data-testid="connect-screen"
      data-state={choosePort ? 'choose-port' : signIn ? 'sign-in' : (outcome ?? 'waiting')}
      role="region"
      aria-label={`Connection to ${host?.name ?? hostId}`}
      className={`${overlay ? 'absolute inset-0 z-10' : 'h-full'} flex flex-col items-center overflow-auto bg-surface-sunken px-4 py-6 transition-opacity duration-300 ${
        fading ? 'opacity-0' : 'opacity-100'
      } ${connected ? 'pointer-events-none' : ''}`}
    >
      <div className="flex w-full max-w-md flex-col gap-4">
        {reconnect !== undefined && (
          <div
            role="status"
            data-testid="ssh-terminal-notice"
            className="flex flex-wrap items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm text-fg-default"
          >
            <span className="min-w-0 flex-1">{reconnect.text}</span>
            {reconnect.onNow !== undefined && <Button onClick={reconnect.onNow}>Reconnect now</Button>}
            {reconnect.onStop !== undefined && <Button onClick={reconnect.onStop}>Stop</Button>}
          </div>
        )}

        <div className="flex items-center gap-3 text-sm text-fg-muted" aria-hidden="true">
          <span className="flex shrink-0 items-center gap-1.5">
            <Laptop size={16} /> This machine
          </span>
          <span
            className={`h-px min-w-6 flex-1 ${
              failed
                ? 'bg-status-danger/60'
                : connected
                  ? 'bg-status-success/60'
                  : running
                    ? 'wb-connect-line'
                    : 'bg-hairline'
            }`}
          />
          <span className="flex min-w-0 items-center gap-1.5 text-fg-default">
            <OsIcon os={os} size={16} />
            <span className="truncate font-mono text-xs">{target}</span>
          </span>
        </div>

        {settings !== undefined && (
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-fg-default">Host settings</h2>
            <p role="alert" data-testid="connect-error" className="text-sm text-fg-default">
              {settings.sentence}
            </p>
          </div>
        )}

        {choosePort && (
          <h2 className="text-sm font-medium text-fg-default" data-testid="connect-choose-port">
            {`Choose the port for ${host?.name ?? hostId}`}
          </h2>
        )}

        {signIn && (
          <div className="flex flex-col gap-1" data-testid="connect-sign-in-step">
            <h2 className="text-sm font-medium text-fg-default">{`Sign in to ${host?.name ?? hostId}`}</h2>
            <p className="text-sm text-fg-subtle">
              {`No password is stored on this machine${user === undefined ? '' : ` for ${user}`}. Type it to connect.`}
            </p>
          </div>
        )}

        <ol
          className={settings === undefined && !choosePort && !signIn ? 'flex flex-col gap-1' : 'hidden'}
          aria-label="Connection steps"
        >
          {(steps ?? []).map((step) => {
            const duration = step.state === 'done' ? stepDuration(step) : undefined;
            return (
              <li
                key={step.id}
                className="flex flex-col"
                data-testid={`connect-step-${step.id}`}
                data-state={step.state}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="flex w-4 shrink-0 justify-center">
                    <StepIcon state={step.state} />
                  </span>
                  <span
                    className={
                      step.state === 'failed'
                        ? 'text-status-danger'
                        : step.state === 'pending'
                          ? 'text-fg-faint'
                          : 'text-fg-default'
                    }
                  >
                    {stepLabel(step.id, purpose, route)}
                    <span className="sr-only">{`: ${STATE_WORDS[step.state]}`}</span>
                  </span>
                  {step.detail !== undefined && step.state !== 'pending' && (
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle" title={step.detail}>
                      {step.state === 'waiting' ? 'waiting for you to trust the key' : step.detail}
                    </span>
                  )}
                  {(step.detail === undefined || step.state === 'pending') && <span className="flex-1" />}
                  {duration !== undefined && (
                    <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{formatDuration(duration)}</span>
                  )}
                </div>
                {view?.outcome.kind === 'failed' && view.outcome.step === step.id && (
                  <p role="alert" data-testid="connect-error" className="mt-1 ml-6 text-sm text-fg-default">
                    {view.outcome.sentence}
                  </p>
                )}
                {view?.outcome.kind === 'trust' && step.id === 'host-key' && (
                  <p className="mt-1 ml-6 text-sm text-fg-subtle">
                    {view.outcome.changed
                      ? 'The host key changed. Compare the fingerprints in the prompt before you replace it.'
                      : 'First connection to this host. Check its fingerprint in the prompt, then trust it.'}
                  </p>
                )}
              </li>
            );
          })}
        </ol>

        {running && typedAhead !== undefined && (typedAhead.bytes > 0 || typedAhead.full) && (
          <p className="text-sm text-fg-subtle" role="status" data-testid="connect-typed-ahead">
            {typedAheadText(typedAhead)}
          </p>
        )}

        {total !== undefined && (
          <p className="text-sm text-status-success" role="status">{`Connected in ${formatDuration(total)}`}</p>
        )}

        {fix?.ask === 'user' && (
          <SignInAsForm hostId={hostId} paneKey={paneKey} identity={identity} onConnect={onRetry} />
        )}
        {fix?.ask === 'password' && (
          <PasswordForm
            user={fix.user}
            secret={fix.secret}
            identity={authIdentity?.name}
            onRetry={onRetry}
            onOnce={fix.once ? onPassword : undefined}
          />
        )}
        {fix?.ask === 'pin' && onPin !== undefined && view !== undefined && (
          <PinForm key={view.attemptId} wrong={fix.wrong} onPin={onPin} />
        )}
        {fix?.ask === 'device' && <SerialDeviceForm hostId={hostId} onConnect={onRetry} />}

        {showActions && (
          <div className="flex flex-wrap gap-2">
            <Button variant={retryPrimary ? 'primary' : 'secondary'} onClick={onRetry}>
              Retry
            </Button>
            <Button
              variant={!retryPrimary && fix?.ask === undefined ? 'primary' : 'secondary'}
              onClick={() => {
                if (quick === undefined) onEditHost();
                else saveQuickAsHost(quick);
              }}
            >
              {quick === undefined ? 'Edit host' : 'Save as host…'}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {view !== undefined && !choosePort && !signIn && (
          <div>
            <button
              type="button"
              aria-expanded={logOpen}
              className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg-default"
              onClick={() => {
                setLogOpen((open) => !open);
              }}
            >
              {logOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              {logOpen ? 'Hide log' : 'Show log'}
            </button>
          </div>
        )}
      </div>
      {/* Wider than the steps: log lines are long, and wrapping each one makes the log hard to read. */}
      {view !== undefined && logOpen && !choosePort && !signIn && (
        <div className="mt-2 w-full max-w-3xl">
          <ConnectLog lines={view.log} summary={view.outcome.kind === 'failed' ? view.outcome.sentence : undefined} />
        </div>
      )}
    </div>
  );
}
