import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, CircleDot, KeyRound, Laptop, Loader2, X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { osKeyOf, useHostsStore } from './hosts-store.js';
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

function Log({ lines }: { readonly lines: readonly ConnectLogLine[] }) {
  return (
    <pre
      data-testid="connect-log"
      className="mt-2 max-h-56 overflow-auto rounded-md border border-hairline bg-surface-base p-2 font-mono text-xs whitespace-pre-wrap text-fg-muted select-text"
    >
      {lines.length === 0
        ? 'Nothing logged yet.'
        : lines.map((line, index) => (
            <span key={index} className="block">
              <span className="text-fg-faint">{timeOf(line.at)}</span> {line.text}
            </span>
          ))}
    </pre>
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

  const target =
    host === undefined
      ? hostId
      : `${host.ssh.user.value === undefined ? '' : `${host.ssh.user.value}@`}${host.address}:${String(host.ssh.port.value)}`;
  const running = view === undefined || outcome === 'running' || outcome === 'trust';
  const steps = view?.steps;
  const total = view !== undefined && view.outcome.kind === 'connected' ? view.outcome.at - view.startedAt : undefined;
  const showActions = failed || (reconnect === undefined && view === undefined);

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

        <ol className="flex flex-col gap-1" aria-label="Connection steps">
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

        {showActions && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onRetry}>
              Retry
            </Button>
            <Button onClick={onEditHost}>Edit host</Button>
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
            {logOpen && <Log lines={view.log} />}
          </div>
        )}
      </div>
    </div>
  );
}
