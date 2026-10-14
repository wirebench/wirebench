import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, CircleDot, KeyRound, Laptop, Loader2, X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { findHost, osKeyOf, upsertHost, useHostsStore } from './hosts-store.js';
import { INPUT_CLASS } from './inherited-field.js';
import { connectFix } from './connect-errors.js';
import { setSignInUser, useConnectStore } from './connect-store.js';
import { OsIcon, osOf } from './os-icon.js';
import { formatDuration, stepDuration, stepLabel } from './connect-progress.js';
import type { ConnectLogLine, ConnectPurpose, ConnectStep, ConnectView } from './connect-progress.js';

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
  readonly onRetry: () => void;
  readonly onEditHost: () => void;
  readonly onClose: () => void;
  /** "Connected in N ms" has shown and faded: the caller drops the screen. */
  readonly onFaded?: (() => void) | undefined;
  /** Over the terminal (a pane), or in place of a Files pane's list. */
  readonly overlay?: boolean;
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

/**
 * The line that says what failed: the last flagged line main logged, or else the sentence the screen
 * added at the end.
 */
export function failingLine(lines: readonly ConnectLogLine[], sentence: string | undefined): number | undefined {
  let fallback: number | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.error !== true) continue;
    if (line.text !== sentence) return index;
    fallback ??= index;
  }
  return fallback;
}

function Log({
  lines,
  failed,
  sentence,
}: {
  readonly lines: readonly ConnectLogLine[];
  readonly failed: boolean;
  readonly sentence: string | undefined;
}) {
  const box = useRef<HTMLPreElement>(null);
  const failing = useRef<HTMLSpanElement>(null);
  const failingIndex = failed ? failingLine(lines, sentence) : undefined;
  // A failed attempt's log opens at its end, the failing line in view (#532); lines that land late keep it there.
  useEffect(() => {
    if (!failed || box.current === null) return;
    box.current.scrollTop = box.current.scrollHeight;
    failing.current?.scrollIntoView?.({ block: 'nearest' });
  }, [failed, lines.length]);
  return (
    <pre
      ref={box}
      data-testid="connect-log"
      className={`max-h-72 overflow-auto rounded-md border ${failed ? 'border-status-danger/60' : 'border-hairline'} bg-surface-base p-2 font-mono text-xs whitespace-pre-wrap text-fg-muted select-text`}
    >
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
 * the host's own settings through the hosts file; not saved, it signs this pane's connects in only.
 */
function SignInAsForm({
  hostId,
  paneKey,
  onConnect,
}: {
  readonly hostId: string;
  readonly paneKey: string | undefined;
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
      const saved =
        entry !== undefined &&
        (await hosts.save(upsertHost(hosts.file, { ...entry, ssh: { ...entry.ssh, user: name } })));
      if (!saved) {
        setBusy(false);
        setError('The host could not be saved. Edit the host to set its user.');
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
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          checked={save}
          onChange={(e) => {
            setSave(e.target.checked);
          }}
        />
        Save to host
      </label>
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
  onRetry,
}: {
  readonly user: string | undefined;
  readonly secret: string;
  readonly onRetry: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const field = useFocus<HTMLInputElement>();
  const label = user === undefined ? 'Password' : `Password for ${user}`;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (value === '') return;
    setBusy(true);
    const stored = await ipc().ssh.setSecret({ name: secret, value });
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
          Save and retry
        </Button>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
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
  onRetry,
  onEditHost,
  onClose,
  onFaded,
  overlay = false,
}: ConnectScreenProps) {
  const host = useHostsStore((s) => s.resolved.find((h) => h.id === hostId));
  // What the screen connects (a pane), from the attempt it shows: a user typed here is kept under it.
  const paneKey = useConnectStore((s) => (view === undefined ? undefined : s.attempts[view.attemptId]));
  const typedUser = useConnectStore((s) => (paneKey === undefined ? undefined : s.users[paneKey]));
  const os = useHostsStore((s) => (host === undefined ? undefined : osOf(s.osByHost[osKeyOf(host)])));
  const outcome = view?.outcome.kind;
  const failed = outcome === 'failed';
  const connected = outcome === 'connected';
  const [logOpen, setLogOpen] = useState(failed);
  const [fading, setFading] = useState(false);
  // Read when the fade ends: the caller's new function on each render must not restart the hold.
  const fadedRef = useRef(onFaded);
  fadedRef.current = onFaded;
  const attemptId = view?.attemptId;
  // Folded while connecting, open as soon as an attempt fails; a new attempt folds it again.
  useEffect(() => {
    setLogOpen(failed);
  }, [failed, attemptId]);
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

  const user = typedUser ?? host?.ssh.user.value;
  const target =
    host === undefined
      ? hostId
      : `${user === undefined ? '' : `${user}@`}${host.address}:${String(host.ssh.port.value)}`;
  const running = view === undefined || outcome === 'running' || outcome === 'trust';
  const steps = view?.steps;
  const total = view !== undefined && view.outcome.kind === 'connected' ? view.outcome.at - view.startedAt : undefined;
  const showActions = failed || (reconnect === undefined && view === undefined);
  // A host's settings stopped it before any step ran: the steps are not the story (#532).
  const settings = view?.outcome.kind === 'failed' && view.outcome.step === undefined ? view.outcome : undefined;
  // Retry leads only where trying again can work; a refused sign-in or a setting is fixed first (#532).
  const fix =
    view?.outcome.kind === 'failed'
      ? connectFix(view.outcome.error, host === undefined ? undefined : { hostId, user, auth: host.ssh.auth.value })
      : undefined;
  const retryPrimary = fix?.retryPrimary ?? true;

  return (
    <div
      data-testid="connect-screen"
      data-state={outcome ?? 'waiting'}
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

        <ol className={settings === undefined ? 'flex flex-col gap-1' : 'hidden'} aria-label="Connection steps">
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
                    {stepLabel(step.id, purpose)}
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

        {total !== undefined && (
          <p className="text-sm text-status-success" role="status">{`Connected in ${formatDuration(total)}`}</p>
        )}

        {fix?.ask === 'user' && <SignInAsForm hostId={hostId} paneKey={paneKey} onConnect={onRetry} />}
        {fix?.ask === 'password' && <PasswordForm user={fix.user} secret={fix.secret} onRetry={onRetry} />}

        {showActions && (
          <div className="flex flex-wrap gap-2">
            <Button variant={retryPrimary ? 'primary' : 'secondary'} onClick={onRetry}>
              Retry
            </Button>
            <Button variant={!retryPrimary && fix?.ask === undefined ? 'primary' : 'secondary'} onClick={onEditHost}>
              Edit host
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {view !== undefined && (
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
      {view !== undefined && logOpen && (
        <div className="mt-2 w-full max-w-3xl">
          <Log
            lines={view.log}
            failed={failed}
            sentence={view.outcome.kind === 'failed' ? view.outcome.sentence : undefined}
          />
        </div>
      )}
    </div>
  );
}
