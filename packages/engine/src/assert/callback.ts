/**
 * Callback assertions (callback-assertion spec §2.3, §2.4). A run calls three steps in order:
 * `expandCallback` and `prepareCallbacks` before the send, so the cursor predates anything the send
 * can cause, then `awaitCallbacks` after the send and the step's other assertions. Time comes from a
 * `CallbackClock`, so tests wait for nothing.
 *
 * `match` picks and `expect` checks. The first capture after the cursor that fits every part of
 * `match` is the one checked; a method or path that differs is decided from the summary alone, so
 * no detail is read for it. Nothing from a capture flows to later steps.
 */
import { expand } from '../project/properties.js';
import type { PropertyScopes } from '../project/properties.js';
import { parseXml } from '../xml/parse.js';
import { evaluateWithTimeout, matchRegexWithTimeout } from '../xpath/evaluate-async.js';
import type { CaptureDetailView, CaptureSource, CaptureSummaryView } from './capture-source.js';
import { firstHeaderValue } from './header.js';
import { firstText } from './match.js';
import { CALLBACK_LIMITS, callbackLabel } from './model.js';
import type {
  AssertionResult,
  CallbackAssertion,
  CallbackBodyCheck,
  CallbackCheck,
  CallbackHeaderCheck,
  CallbackMatch,
  StepAssertion,
} from './model.js';

/** The clock a wait polls by. */
export interface CallbackClock {
  /** Milliseconds on a monotonic clock. */
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realCallbackClock: CallbackClock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
      function finish(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      }
    }),
};

/** What a run reports while a step waits (the desktop's run panel, the CLI on a terminal). */
export interface CallbackWaiting {
  readonly label: string;
  readonly catchUrl: string;
  readonly withinMs: number;
}

export type PendingCallback =
  | {
      readonly kind: 'ready';
      readonly assertion: CallbackAssertion;
      readonly hookId: string;
      readonly cursor: string | null;
    }
  | { readonly kind: 'errored'; readonly assertion: CallbackAssertion; readonly message: string };

/** The engine's own wording; the desktop and the CLI hand over a source with their own (§2.4). */
export const NO_CAPTURE_SOURCE_MESSAGE = 'no Wirebench Server is configured to check callbacks';

export function isCallbackAssertion(assertion: StepAssertion): assertion is CallbackAssertion {
  return assertion.type === 'callback';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandCheck<T extends { readonly equals?: string; readonly matches?: string }>(
  check: T,
  text: (value: string) => string,
): T {
  return {
    ...check,
    ...(check.equals !== undefined ? { equals: text(check.equals) } : {}),
    ...(check.matches !== undefined ? { matches: text(check.matches) } : {}),
  };
}

/**
 * `${…}` expanded in the assertion's values: every `equals` and `matches` in `match` and `expect`
 * (§2.1). Names, paths and the method stay as written. Values expand like every other assertion's,
 * so an expanded value (a `${#System#…}` one included) can show in a failure message.
 */
export function expandCallback(assertion: CallbackAssertion, scopes: PropertyScopes): CallbackAssertion {
  const text = (value: string): string => expand(value, scopes).text;
  const { match } = assertion;
  return {
    ...assertion,
    match: {
      ...match,
      ...(match.headers !== undefined ? { headers: match.headers.map((header) => expandCheck(header, text)) } : {}),
      ...(match.body !== undefined ? { body: expandCheck(match.body, text) } : {}),
    },
    expect: assertion.expect.map((check): CallbackCheck =>
      'body' in check
        ? { body: expandCheck(check.body, text) }
        : 'header' in check
          ? { header: expandCheck(check.header, text) }
          : check,
    ),
  };
}

/**
 * Before the send (§2.3 step 1): resolves each catch URL and takes its cursor. A missing source, an
 * unknown name or a source error makes that assertion errored without stopping the send.
 */
export function prepareCallbacks(
  assertions: readonly CallbackAssertion[],
  captures: CaptureSource | undefined,
): Promise<PendingCallback[]> {
  return Promise.all(
    assertions.map(async (assertion): Promise<PendingCallback> => {
      if (captures === undefined) {
        return { kind: 'errored', assertion, message: NO_CAPTURE_SOURCE_MESSAGE };
      }
      try {
        const found = await captures.resolve(assertion.catchUrl);
        if (found === undefined) {
          return {
            kind: 'errored',
            assertion,
            message: `no catch URL named "${assertion.catchUrl}" in the server workspace`,
          };
        }
        return { kind: 'ready', assertion, hookId: found.hookId, cursor: await captures.cursor(found.hookId) };
      } catch (error) {
        return { kind: 'errored', assertion, message: messageOf(error) };
      }
    }),
  );
}

/** What is about to be waited for: the ready ones. */
export function waitingOf(pending: readonly PendingCallback[]): CallbackWaiting[] {
  return pending.flatMap((p) =>
    p.kind === 'ready'
      ? [{ label: callbackLabel(p.assertion), catchUrl: p.assertion.catchUrl, withinMs: p.assertion.withinMs }]
      : [],
  );
}

type Held = { readonly ok: true } | { readonly ok: false; readonly reason: string };
const HELD: Held = { ok: true };

/** Long enough to read, short enough that a report stays a report. */
const MAX_ACTUAL_CHARS = 200;
const quoted = (text: string): string =>
  JSON.stringify(text.length > MAX_ACTUAL_CHARS ? `${text.slice(0, MAX_ACTUAL_CHARS)}…` : text);

async function compare(
  label: string,
  check: { readonly equals?: string; readonly matches?: string },
  actual: string | undefined,
  missing: string,
): Promise<Held> {
  const expected = check.matches !== undefined ? `/${check.matches}/` : quoted(check.equals ?? '');
  if (actual === undefined) {
    return { ok: false, reason: `${label}: expected ${expected}, got ${missing}` };
  }
  if (check.matches !== undefined) {
    // On the worker: the pattern comes from a file, and a backtracking one must not block this thread.
    const matched = await matchRegexWithTimeout(check.matches, actual);
    if (matched.kind === 'error') return { ok: false, reason: `${label}: ${matched.message}` };
    return matched.matched ? HELD : { ok: false, reason: `${label}: expected ${expected}, got ${quoted(actual)}` };
  }
  return actual === check.equals
    ? HELD
    : { ok: false, reason: `${label}: expected ${expected}, got ${quoted(actual)}` };
}

function headerHolds(check: CallbackHeaderCheck, headers: CaptureDetailView['headers']): Promise<Held> | Held {
  const label = `header ${check.name}`;
  const actual = firstHeaderValue(headers, check.name);
  if (check.exists !== undefined) {
    const found = actual !== undefined;
    return found === check.exists
      ? HELD
      : {
          ok: false,
          reason: `${label}: expected ${check.exists ? 'present' : 'absent'}, got ${found ? 'present' : 'absent'}`,
        };
  }
  return compare(label, check, actual, 'absent');
}

function notParsed(language: CallbackBodyCheck['language'], bodyText: string): string | undefined {
  if (language === 'jsonpath') {
    try {
      JSON.parse(bodyText);
      return undefined;
    } catch {
      return 'body is not JSON';
    }
  }
  try {
    // xmldom reports text with no root element as a document without one, not always as a fatal error.
    return parseXml(bodyText).documentElement === null ? 'body is not XML' : undefined;
  } catch {
    return 'body is not XML';
  }
}

async function bodyHolds(check: CallbackBodyCheck, bodyText: string): Promise<Held> {
  const label = check.path;
  const refused = notParsed(check.language, bodyText);
  if (refused !== undefined) return { ok: false, reason: `${label}: ${refused}` };
  const result = await evaluateWithTimeout(
    bodyText,
    check.path,
    { language: check.language },
    { kind: check.language === 'jsonpath' ? 'json' : 'xml' },
  );
  if (result.kind === 'error') return { ok: false, reason: `${label}: ${result.message}` };
  const found = result.kind !== 'empty';
  if (check.exists !== undefined) {
    return found === check.exists
      ? HELD
      : {
          ok: false,
          reason: `${label}: expected ${check.exists ? 'a result' : 'no result'}, got ${found ? 'a result' : 'none'}`,
        };
  }
  return compare(label, check, found ? (firstText(result) ?? '') : undefined, 'nothing');
}

function signatureHolds(capture: CaptureSummaryView): Held {
  const signature = capture.signature;
  if (signature?.verdict === 'verified') return HELD;
  const got =
    signature === null ? 'not checked' : `failed${signature.reason !== undefined ? ` (${signature.reason})` : ''}`;
  return { ok: false, reason: `signature: expected verified, got ${got}` };
}

type Fit =
  | { readonly kind: 'fits'; readonly detail: CaptureDetailView }
  | {
      readonly kind: 'differs';
      /** `summary`: the method or path differs; `detail`: they fit, and a header or the body differs. */
      readonly stage: 'summary' | 'detail';
      readonly parts: readonly string[];
    };

async function fit(
  match: CallbackMatch,
  summary: CaptureSummaryView,
  detail: () => Promise<CaptureDetailView>,
): Promise<Fit> {
  const parts: string[] = [];
  if (match.method !== undefined && match.method.toUpperCase() !== summary.method.toUpperCase()) parts.push('method');
  if (match.path !== undefined && match.path !== summary.path) parts.push('path');
  if (match.pathMatches !== undefined) {
    const matched = await matchRegexWithTimeout(match.pathMatches, summary.path);
    if (matched.kind === 'error' || !matched.matched) parts.push('path');
  }
  // §2.3: a method or path that differs is skipped before its detail is read.
  if (parts.length > 0) return { kind: 'differs', stage: 'summary', parts };
  const full = await detail();
  for (const header of match.headers ?? []) {
    if (!(await headerHolds(header, full.headers)).ok) parts.push(`header ${header.name}`);
  }
  if (match.body !== undefined && !(await bodyHolds(match.body, full.bodyText)).ok) {
    parts.push(`body ${match.body.path}`);
  }
  return parts.length === 0 ? { kind: 'fits', detail: full } : { kind: 'differs', stage: 'detail', parts };
}

/**
 * Whether a miss is closer than the closest so far. A header or body miss (its method and path fit)
 * beats any method or path miss, whose headers and body were never read; within a stage the fewest
 * parts win. Captures come oldest first, so `<=` gives a tie to the newer one (§2.4).
 */
function closerThan(
  miss: Extract<Fit, { kind: 'differs' }>,
  closest: Extract<Fit, { kind: 'differs' }> | undefined,
): boolean {
  if (closest === undefined) return true;
  if (miss.stage !== closest.stage) return miss.stage === 'detail';
  return miss.parts.length <= closest.parts.length;
}

/** `30` for whole seconds, `1.5` otherwise: how a callback's wait reads in messages. */
export function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

async function checked(
  base: Pick<AssertionResult, 'type' | 'label'>,
  assertion: CallbackAssertion,
  hookId: string,
  detail: CaptureDetailView,
  afterMs: number,
): Promise<AssertionResult> {
  const failures: string[] = [];
  for (const check of assertion.expect) {
    const held =
      'body' in check
        ? await bodyHolds(check.body, detail.bodyText)
        : 'header' in check
          ? await headerHolds(check.header, detail.headers)
          : signatureHolds(detail);
    if (!held.ok) failures.push(held.reason);
  }
  const capture = { hookId, captureId: detail.id };
  return failures.length === 0
    ? {
        ...base,
        outcome: 'passed',
        message: `matched capture ${detail.id} after ${(afterMs / 1000).toFixed(1)} s`,
        capture,
      }
    : { ...base, outcome: 'failed', message: `matched ${detail.id}, but ${failures.join('; ')}`, capture };
}

export interface AwaitCallbacksOptions {
  readonly captures: CaptureSource | undefined;
  /** `clock.now()` when the send finished: `withinMs` counts from here. */
  readonly sentAt: number;
  readonly clock?: CallbackClock;
  /** `CALLBACK_LIMITS.pollIntervalMs` unless a test says otherwise. */
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

async function awaitOne(pending: PendingCallback, options: AwaitCallbacksOptions): Promise<AssertionResult> {
  const { assertion } = pending;
  const base = { type: 'callback' as const, label: callbackLabel(assertion) };
  if (pending.kind === 'errored') return { ...base, outcome: 'errored', message: pending.message };
  const captures = options.captures;
  if (captures === undefined) return { ...base, outcome: 'errored', message: NO_CAPTURE_SOURCE_MESSAGE };
  const clock = options.clock ?? realCallbackClock;
  const interval = options.pollIntervalMs ?? CALLBACK_LIMITS.pollIntervalMs;
  const deadline = options.sentAt + assertion.withinMs;
  let cursor = pending.cursor;
  let arrived = 0;
  let closest: (Extract<Fit, { kind: 'differs' }> & { readonly summary: CaptureSummaryView }) | undefined;
  try {
    for (;;) {
      if (options.signal?.aborted === true) {
        return { ...base, outcome: 'errored', message: `cancelled while waiting for ${assertion.catchUrl}` };
      }
      for (const summary of await captures.after(pending.hookId, cursor)) {
        // The cursor passes every capture seen, so none is evaluated twice (§2.3).
        cursor = summary.id;
        arrived += 1;
        const found = await fit(assertion.match, summary, () => captures.detail(pending.hookId, summary.id));
        if (found.kind === 'fits') {
          return await checked(base, assertion, pending.hookId, found.detail, clock.now() - options.sentAt);
        }
        if (closerThan(found, closest)) closest = { ...found, summary };
      }
      const now = clock.now();
      if (now >= deadline) break;
      await clock.sleep(Math.min(interval, deadline - now), options.signal);
    }
  } catch (error) {
    // The source's own message; a source never puts its credential in one.
    return { ...base, outcome: 'errored', message: messageOf(error) };
  }
  const within = seconds(assertion.withinMs);
  return {
    ...base,
    outcome: 'failed',
    message:
      closest === undefined
        ? `no capture arrived at ${assertion.catchUrl} within ${within} s`
        : `no capture matched within ${within} s — ${String(arrived)} arrived; closest: ${closest.summary.method} ${closest.summary.path} (${closest.parts[0] ?? 'match'} differs)`,
  };
}

/** After the send (§2.3 steps 2–4): every pending callback waits at once; the longest sets the total. */
export function awaitCallbacks(
  pending: readonly PendingCallback[],
  options: AwaitCallbacksOptions,
): Promise<AssertionResult[]> {
  return Promise.all(pending.map((one) => awaitOne(one, options)));
}

/** How a run waits for callbacks; the same for a selected request and a sequence step. */
export interface CallbackWiring {
  readonly captures?: CaptureSource;
  readonly clock?: CallbackClock;
  /** `CALLBACK_LIMITS.pollIntervalMs` unless a test says otherwise. */
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Called after the send, before the wait, when there is something to wait for. */
  readonly onWaiting?: (waiting: readonly CallbackWaiting[]) => void;
}

/**
 * The prepare → send → await wiring of §2.3, shared by `runRequests` and a sequence run so the
 * cursor is always taken before the send. `scopes` is asked only when `assertions` hold a callback
 * assertion, so a request without one does no extra work. `send` may throw; a throw before or in it
 * abandons the wait. The callers evaluate their other assertions from `sent`, then merge `callbacks`.
 */
export async function sendAwaitingCallbacks<T>(
  assertions: readonly StepAssertion[],
  scopes: () => PropertyScopes,
  send: () => Promise<T>,
  wiring: CallbackWiring,
): Promise<{ readonly sent: T; readonly callbacks: AssertionResult[] }> {
  const own = assertions.filter(isCallbackAssertion);
  if (own.length === 0) return { sent: await send(), callbacks: [] };
  const clock = wiring.clock ?? realCallbackClock;
  const resolved = scopes();
  const pending = await prepareCallbacks(
    own.map((assertion) => expandCallback(assertion, resolved)),
    wiring.captures,
  );
  const sent = await send();
  const sentAt = clock.now();
  const waiting = waitingOf(pending);
  if (waiting.length > 0) wiring.onWaiting?.(waiting);
  const callbacks = await awaitCallbacks(pending, {
    captures: wiring.captures,
    sentAt,
    clock,
    ...(wiring.pollIntervalMs !== undefined ? { pollIntervalMs: wiring.pollIntervalMs } : {}),
    ...(wiring.signal !== undefined ? { signal: wiring.signal } : {}),
  });
  return { sent, callbacks };
}
