import { create } from 'zustand';
import type { SshConnectProgressWire } from '../../../shared/ssh-wire.js';
import { connectedView, failedView, reduceProgress, startView, trustView } from './connect-progress.js';
import type { ConnectPurpose, ConnectView } from './connect-progress.js';
import type { ConnectError } from './connect-errors.js';

/**
 * Each connection screen's attempt (#528), keyed by what connects: a terminal pane's id, or a Files pane's.
 * `attempts` routes main's progress events (which name the attempt) to the screen showing it. `users`: the
 * user typed on a screen to sign in as (#532), kept for the pane's later connects and never written to
 * the hosts file.
 */
interface ConnectState {
  readonly views: Readonly<Record<string, ConnectView>>;
  readonly attempts: Readonly<Record<string, string>>;
  readonly users: Readonly<Record<string, string>>;
}

export const useConnectStore = create<ConnectState>()(() => ({ views: {}, attempts: {}, users: {} }));

/** Signs the pane's connects in as `user`, or as the host's own again (`undefined`). */
export function setSignInUser(key: string, user: string | undefined): void {
  const { users } = useConnectStore.getState();
  const rest = { ...users };
  delete rest[key];
  useConnectStore.setState({ users: user === undefined ? rest : { ...rest, [key]: user } });
}

export function signInUserOf(key: string): string | undefined {
  return useConnectStore.getState().users[key];
}

function update(key: string, attemptId: string, change: (view: ConnectView) => ConnectView): void {
  const { views } = useConnectStore.getState();
  const view = views[key];
  // A later attempt on the same pane has the screen now; this one's end is old news.
  if (view === undefined || view.attemptId !== attemptId) return;
  useConnectStore.setState({ views: { ...views, [key]: change(view) } });
}

/** A connect starts: its screen shows the first step running. Returns the id main reports progress under. */
export function beginAttempt(key: string, purpose: ConnectPurpose): string {
  const attemptId = crypto.randomUUID();
  const { views, attempts } = useConnectStore.getState();
  const kept = Object.fromEntries(Object.entries(attempts).filter(([, owner]) => owner !== key));
  useConnectStore.setState({
    views: { ...views, [key]: startView(attemptId, purpose, Date.now()) },
    attempts: { ...kept, [attemptId]: key },
  });
  return attemptId;
}

/** One stage or log line from main (`ssh.connectProgress`). */
export function noteProgress(attemptId: string, event: SshConnectProgressWire): void {
  const key = useConnectStore.getState().attempts[attemptId];
  if (key !== undefined) update(key, attemptId, (view) => reduceProgress(view, event));
}

export function noteConnected(key: string, attemptId: string): void {
  update(key, attemptId, (view) => connectedView(view, Date.now()));
}

export function noteFailed(key: string, attemptId: string, error: ConnectError): void {
  update(key, attemptId, (view) => failedView(view, error, Date.now()));
}

/** The connect stopped at a new or changed host key; the trust prompt is open. */
export function noteTrust(key: string, attemptId: string, changed: boolean): void {
  update(key, attemptId, (view) => trustView(view, changed, Date.now()));
}

/**
 * The trust prompt's own end, when it opened no new connect: the attempt that waited on it fails with
 * `error` (the key left untrusted, or the trust refused).
 */
export function failWaitingAttempt(key: string, error: ConnectError): void {
  const view = useConnectStore.getState().views[key];
  if (view?.outcome.kind === 'trust') noteFailed(key, view.attemptId, error);
}

/** The screen is gone (faded after connecting, or its pane closed). */
export function dropAttempt(key: string): void {
  const { views, attempts } = useConnectStore.getState();
  if (views[key] === undefined) return;
  const rest = { ...views };
  delete rest[key];
  useConnectStore.setState({
    views: rest,
    attempts: Object.fromEntries(Object.entries(attempts).filter(([, owner]) => owner !== key)),
  });
}
