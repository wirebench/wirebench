/**
 * The connection screen's model (#528): one connect attempt's steps, timings and handshake log, built
 * from the stages main reports (`ssh.connectProgress`) and the connect's own end. Pure, so the screen
 * and the tests drive the same thing.
 */
import type { SshConnectPhase, SshConnectProgressWire } from '../../../shared/ssh-wire.js';
import { connectFailureSentence } from './connect-errors.js';
import type { ConnectError } from './connect-errors.js';

/** The steps the screen lists, in order. */
export const CONNECT_STEPS = ['resolve', 'connect', 'host-key', 'auth', 'shell'] as const;
export type ConnectStepId = (typeof CONNECT_STEPS)[number];

/** `waiting`: held on the user (the trust prompt is open). */
export type ConnectStepState = 'pending' | 'running' | 'done' | 'failed' | 'waiting';

export interface ConnectStep {
  readonly id: ConnectStepId;
  readonly state: ConnectStepState;
  /** Milliseconds since the epoch. */
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly detail?: string;
}

export interface ConnectLogLine {
  readonly at: number;
  readonly text: string;
}

/** What is being opened: the last step reads "Starting shell" for a terminal, "Starting SFTP" for Files. */
export type ConnectPurpose = 'terminal' | 'files';

export type ConnectOutcome =
  | { readonly kind: 'running' }
  | { readonly kind: 'connected'; readonly at: number }
  /** The host key is new or changed and the trust prompt is open. */
  | { readonly kind: 'trust'; readonly changed: boolean }
  | { readonly kind: 'failed'; readonly step: ConnectStepId; readonly sentence: string };

export interface ConnectView {
  readonly attemptId: string;
  readonly purpose: ConnectPurpose;
  readonly startedAt: number;
  readonly steps: readonly ConnectStep[];
  readonly log: readonly ConnectLogLine[];
  readonly outcome: ConnectOutcome;
}

/** Lines kept per attempt; a connect writes a few dozen, so this only bounds a misbehaving one. */
export const CONNECT_LOG_LIMIT = 500;

export function startView(attemptId: string, purpose: ConnectPurpose, at: number): ConnectView {
  return {
    attemptId,
    purpose,
    startedAt: at,
    steps: CONNECT_STEPS.map((id): ConnectStep =>
      id === 'resolve' ? { id, state: 'running', startedAt: at } : { id, state: 'pending' },
    ),
    log: [],
    outcome: { kind: 'running' },
  };
}

/**
 * Which step a hop's stage belongs to, and whether that stage ending ends the step. A jump host's stages
 * are all part of reaching the target: its address resolving is the first step, the rest is Connecting.
 */
function stepOf(phase: SshConnectPhase, target: boolean): { step: ConnectStepId; ends: boolean } {
  if (phase === 'resolve') return { step: 'resolve', ends: true };
  if (!target) return { step: 'connect', ends: false };
  switch (phase) {
    case 'tcp':
      return { step: 'connect', ends: false };
    case 'banner':
      return { step: 'connect', ends: true };
    case 'host-key':
      return { step: 'host-key', ends: true };
    case 'auth':
      return { step: 'auth', ends: true };
    case 'shell':
      return { step: 'shell', ends: true };
  }
}

function indexOf(id: ConnectStepId): number {
  return CONNECT_STEPS.indexOf(id);
}

/** Starts `id`, closing any earlier step left open (a stage that never reported took no time). */
function begin(steps: readonly ConnectStep[], id: ConnectStepId, at: number, detail?: string): ConnectStep[] {
  const target = indexOf(id);
  return steps.map((step, index): ConnectStep => {
    if (index < target && step.state !== 'done') {
      return { ...step, state: 'done', startedAt: step.startedAt ?? at, endedAt: at };
    }
    if (index !== target) return step;
    return { ...step, state: 'running', startedAt: step.startedAt ?? at, ...(detail === undefined ? {} : { detail }) };
  });
}

function finish(steps: readonly ConnectStep[], id: ConnectStepId, at: number, detail?: string): ConnectStep[] {
  return begin(steps, id, at, detail).map((step): ConnectStep =>
    step.id === id ? { ...step, state: 'done', endedAt: at } : step,
  );
}

/**
 * Folds one reported stage or log line into the view. A log line is kept even after the attempt ended:
 * main's events can land after the connect's own answer, and a failed connect's log is the one that matters.
 * A stage after the end is ignored, so the steps stay as the end left them.
 */
export function reduceProgress(view: ConnectView, event: SshConnectProgressWire): ConnectView {
  const target = event.hop === event.hops - 1;
  if (event.kind === 'log') {
    const text = target ? event.line : `[${event.host}] ${event.line}`;
    const log = [...view.log, { at: event.at, text }];
    return { ...view, log: log.length > CONNECT_LOG_LIMIT ? log.slice(-CONNECT_LOG_LIMIT) : log };
  }
  if (view.outcome.kind !== 'running') return view;
  const { step, ends } = stepOf(event.phase, target);
  // A step already passed is not reopened: the target's address resolving through the jump host, say.
  if (view.steps.find((s) => s.id === step)?.state === 'done') return view;
  // Past the first step, a jump host's stages read as such; the address resolving shows the jump's name.
  const detail = target || step === 'resolve' ? event.detail : `jump host ${event.host}`;
  const steps =
    event.state === 'done' && ends
      ? finish(view.steps, step, event.at, detail)
      : begin(view.steps, step, event.at, detail);
  return { ...view, steps };
}

/** The connect opened its session: every step is done. */
export function connectedView(view: ConnectView, at: number): ConnectView {
  const steps = view.steps.map((step): ConnectStep =>
    step.state === 'done' ? step : { ...step, state: 'done', startedAt: step.startedAt ?? at, endedAt: at },
  );
  return { ...view, steps, outcome: { kind: 'connected', at } };
}

/** Whether a failure's details place it on a jump host rather than the target. */
export function onJumpHost(details: Readonly<Record<string, unknown>> | undefined): boolean {
  const hop = details?.['hop'];
  const hops = details?.['hops'];
  return typeof hop === 'number' && typeof hops === 'number' && hop < hops - 1;
}

/** Which step a failure belongs to: the stage main named, else the step running, else the first not done. */
function failedStep(view: ConnectView, error: ConnectError): ConnectStepId {
  const jump = onJumpHost(error.details);
  const phase = error.details?.['phase'];
  if (jump) return view.steps.find((s) => s.id === 'resolve')?.state === 'done' ? 'connect' : 'resolve';
  if (error.code === 'ssh-auth-failed') return 'auth';
  if (error.code === 'ssh-host-key-new' || error.code === 'ssh-host-key-changed') return 'host-key';
  if (error.code === 'sftp-unavailable') return 'shell';
  if (phase === 'resolve') return 'resolve';
  if (phase === 'tcp' || phase === 'banner') return 'connect';
  if (phase === 'host-key' || phase === 'auth' || phase === 'shell') return phase;
  return view.steps.find((s) => s.state === 'running' || s.state === 'waiting')?.id ?? 'resolve';
}

/** The connect ended without a session: the step it stopped at turns red, and one sentence says why. */
export function failedView(view: ConnectView, error: ConnectError, at: number): ConnectView {
  const id = failedStep(view, error);
  const target = indexOf(id);
  const steps = view.steps.map((step, index): ConnectStep => {
    if (index < target) return step.state === 'done' ? step : { ...step, state: 'done', endedAt: at };
    if (index === target) return { ...step, state: 'failed', startedAt: step.startedAt ?? at, endedAt: at };
    return { id: step.id, state: 'pending' };
  });
  const sentence = connectFailureSentence(error, view.purpose);
  return { ...view, steps, outcome: { kind: 'failed', step: id, sentence } };
}

/** The host key is new or changed: the step waits on the trust prompt. */
export function trustView(view: ConnectView, changed: boolean, at: number): ConnectView {
  const steps = begin(view.steps, 'host-key', at).map((step): ConnectStep =>
    step.id === 'host-key' ? { ...step, state: 'waiting' } : step,
  );
  return { ...view, steps, outcome: { kind: 'trust', changed } };
}

/** How long a finished step took, in whole milliseconds; undefined until it ends. */
export function stepDuration(step: ConnectStep): number | undefined {
  if (step.startedAt === undefined || step.endedAt === undefined) return undefined;
  return Math.max(0, Math.round(step.endedAt - step.startedAt));
}

/** A step's name on the screen. */
export function stepLabel(id: ConnectStepId, purpose: ConnectPurpose): string {
  switch (id) {
    case 'resolve':
      return 'Resolving address';
    case 'connect':
      return 'Connecting';
    case 'host-key':
      return 'Checking host key';
    case 'auth':
      return 'Authenticating';
    case 'shell':
      return purpose === 'files' ? 'Starting SFTP' : 'Starting shell';
  }
}

/** "120 ms" below a second, "1.4 s" from there. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
