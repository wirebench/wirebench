/**
 * `sequence.run`: a sequence's steps sent one after another through the engine (`sendThroughEngine`),
 * the path a single send takes, so every step gets the auth, TLS, proxy, scripts, HTTP Log row and
 * History entry a single send gets. The engine's `runSequence` owns the loop, the transfers and the
 * assertions; this module is the desktop's sender. A step is a run's send (`SendOptions.run`), as it
 * is on the command line: a stream waits for its answer within the step's timeout.
 *
 * What differs from a single send: the step expands against the run's `${#Sequence#…}` values
 * (`SendOptions.sequence`), its History entry carries the run's tags (`SendOptions.tags`), its
 * scripts hand their values to the run, and the run's cancel aborts it through its signal.
 *
 * Security (ADR-0015, spec §Security):
 * - Transfers read the unredacted engine exchange (`SendOptions.onSent`), never a summary.
 * - A value marked secret, or holding a credential already recorded, is recorded for masking inside
 *   `onSent`, which the send awaits before the step's own log row and History entry exist, so even
 *   the step that produced it shows it masked.
 * - Every string of a result is masked before it crosses to the renderer, and a secret transfer
 *   never carries a value at all.
 */

import {
  extractTransfer,
  grpcSubject,
  restSubject,
  runSequence,
  soapResponseSubject,
  urlOrigin,
  WirebenchError,
  isWirebenchError,
  unavailableCaptureSource,
} from '@wirebench/engine';
import type {
  AssertionSubject,
  CaptureSource,
  Project,
  SelectedRequest,
  SentRequest,
  SentScripts,
  SequenceStepResult,
  SequenceStepSender,
} from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import { UNLINKED_WORKSPACE_MESSAGE } from './hooks/capture-source.js';
import { toSendDeps, type RequestChannelDeps } from './ipc/request.js';
import { containsRecordedSecret, recordSecretValue, redactSecretText } from './redact.js';
import type { DraftOf } from './send/draft.js';
import { sendThroughEngine } from './send/exchange.js';
import type {
  SequenceProgressEvent,
  SequenceRunRequest,
  SequenceRunResultWire,
  SequenceStepResultWire,
  SequenceWaitingEvent,
} from '../shared/wire-types.js';

/** What a run needs from the app around it. */
export interface SequenceRunDeps {
  readonly service: EngineService;
  /** The request channels' dependencies, exactly as a single send uses them. */
  readonly requests: RequestChannelDeps;
  /** The open model (unsaved edits included) of the project that owns `entityId`. */
  readonly modelOf: (entityId: string) => Project | undefined;
  /** Tells the renderer a step has ended. */
  readonly emit: (event: SequenceProgressEvent) => void;
  /** The open workspace's capture source, built per run; absent means the workspace has no server. */
  readonly captures?: () => CaptureSource;
  /** Tells the renderer a step waits for its callbacks. */
  readonly emitWaiting?: (event: SequenceWaitingEvent) => void;
}

interface ActiveRun {
  readonly sequenceId: string;
  /** Aborted by a cancel: the step in flight is cancelled through its signal, the rest skipped. */
  readonly controller: AbortController;
}

/** A step's request as its send sends it: the saved request as it is, no draft over it. */
function draftFor(kind: SelectedRequest['kind']): DraftOf {
  switch (kind) {
    case 'soap':
      return { kind, override: {} };
    case 'rest':
    case 'grpc':
    case 'websocket':
      return { kind };
  }
}

/** A sent step as assertions and transfers see it, and where it went. */
function describe(sent: SentRequest): { subject: AssertionSubject; origin?: string } {
  const { exchange } = sent;
  switch (exchange?.kind) {
    case 'soap': {
      const origin = urlOrigin(exchange.soap.http.request.url);
      return { subject: soapResponseSubject(exchange.soap), ...(origin !== undefined ? { origin } : {}) };
    }
    case 'rest': {
      const origin = urlOrigin(exchange.rest.request.url);
      return { subject: restSubject(exchange.rest), ...(origin !== undefined ? { origin } : {}) };
    }
    case 'grpc':
      return { subject: grpcSubject(exchange.grpc), origin: exchange.grpc.exchange.request.authority };
    default:
      // A WebSocket session: the engine's own subject, its frames, and the URL's origin.
      return { subject: sent.subject, ...(sent.origin !== undefined ? { origin: sent.origin } : {}) };
  }
}

/** A step's error as the run reports it. */
function errorOf(error: unknown): { code: string; message: string } {
  return {
    code: isWirebenchError(error) ? error.code : 'internal-error',
    message: error instanceof Error ? error.message : String(error),
  };
}

const mask = (text: string): string => redactSecretText(text, { show: false });

/** A step result as it may cross to the renderer: every string masked, a secret transfer valueless. */
function toWire(step: SequenceStepResult, sendId: string | undefined): SequenceStepResultWire {
  return {
    index: step.index,
    stepId: step.stepId,
    requestId: step.requestId,
    name: step.name,
    // The wire names no WebSocket protocol for a step: such a step goes without one.
    ...(step.protocol !== undefined && step.protocol !== 'websocket' ? { protocol: step.protocol } : {}),
    outcome: step.outcome,
    ...(step.status !== undefined ? { status: step.status } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    ...(step.origin !== undefined ? { origin: step.origin } : {}),
    assertions: step.assertions.map((assertion) => ({
      type: assertion.type,
      label: mask(assertion.label),
      outcome: assertion.outcome,
      ...(assertion.expected !== undefined ? { expected: mask(assertion.expected) } : {}),
      ...(assertion.actual !== undefined ? { actual: mask(assertion.actual) } : {}),
      ...(assertion.message !== undefined ? { message: mask(assertion.message) } : {}),
      ...(assertion.capture !== undefined ? { capture: assertion.capture } : {}),
    })),
    transfers: step.transfers.map((transfer) => ({
      name: transfer.name,
      outcome: transfer.outcome,
      secret: transfer.secret,
      ...(transfer.value !== undefined && !transfer.secret ? { value: mask(transfer.value) } : {}),
      ...(transfer.message !== undefined ? { message: mask(transfer.message) } : {}),
    })),
    ...(step.error !== undefined ? { error: { code: step.error.code, message: mask(step.error.message) } } : {}),
    ...(step.skipped !== undefined ? { skipped: step.skipped } : {}),
    ...(step.scriptLog !== undefined ? { scriptLog: step.scriptLog.map(mask) } : {}),
    ...(step.scriptsOff === true ? { scriptsOff: true } : {}),
    ...(sendId !== undefined ? { sendId } : {}),
  };
}

/** Every sequence run in progress, by run id. One run per sequence at a time. */
export class SequenceRunner {
  private readonly runs = new Map<string, ActiveRun>();

  /**
   * Runs `request.sequenceId` to the end and resolves with every step; each step is also reported
   * through `deps.emit` as it ends.
   *
   * @throws WirebenchError `sequence-already-running`, `unknown-entity`
   */
  async run(request: SequenceRunRequest, deps: SequenceRunDeps): Promise<SequenceRunResultWire> {
    for (const active of this.runs.values()) {
      if (active.sequenceId === request.sequenceId) {
        throw new WirebenchError('sequence-already-running', 'This sequence is already running');
      }
    }
    const project = deps.modelOf(request.sequenceId);
    const sequence = project?.sequences.find((candidate) => candidate.id === request.sequenceId);
    if (project === undefined || sequence === undefined) {
      throw new WirebenchError('unknown-entity', `No sequence with id "${request.sequenceId}"`, {
        details: { sequenceId: request.sequenceId },
      });
    }
    const active: ActiveRun = { sequenceId: sequence.id, controller: new AbortController() };
    this.runs.set(request.runId, active);
    const tags = [`sequence:${sequence.id}`, `run:${request.runId}`];
    const sendIds = new Map<string, string>();
    // The request channels' own send through the engine, and the registry they cancel through.
    const sendDeps = toSendDeps(deps.service, deps.requests);

    const send: SequenceStepSender = async (resolved, sequenceScope, signal) => {
      const sendId = `${request.runId}:${resolved.index}`;
      sendIds.set(resolved.step.id, sendId);
      const requestId = resolved.selected.request.id;
      // The step's scripts hand their values to the run, not to the project's session (#63).
      let ran: SentScripts | undefined;
      let described: { subject: AssertionSubject; origin?: string } | undefined;
      // Refused as it always was, before anything is prepared.
      if (resolved.selected.kind === 'soap' && deps.requests.project.endpointFor?.(requestId) === undefined) {
        return { error: { code: 'no-endpoint', message: 'No endpoint resolves for this request' } };
      }
      const stop = (): void => {
        sendDeps.registry.cancel(sendId);
      };
      signal.addEventListener('abort', stop, { once: true });
      try {
        const sending = sendThroughEngine(sendDeps, sendId, requestId, {
          draft: draftFor(resolved.selected.kind),
          sequence: sequenceScope,
          tags,
          run: true,
          ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
          onScriptsRan: (sent) => {
            ran = sent;
          },
          onSent: async (sent) => {
            described = describe(sent);
            // Before the step's own log row and History entry exist: record what must be masked in them.
            for (const transfer of resolved.step.transfers) {
              const found = await extractTransfer(described.subject, transfer);
              if (found.kind === 'value' && (transfer.secret === true || containsRecordedSecret(found.value))) {
                recordSecretValue(found.value);
              }
            }
          },
        });
        // The send holds its id from its first moment: a cancel that came just before reaches it too.
        if (signal.aborted) stop();
        const summary = await sending;
        // A WebSocket session's handshake row is already in the HTTP Log; any other step's row is this.
        if (!('handshake' in summary)) {
          deps.requests.onExchange?.({ kind: 'exchange', exchange: summary, requestId });
        }
        if (described === undefined) {
          return { error: { code: 'no-response', message: 'The send ended without a response' } };
        }
        return {
          ...described,
          ...(ran !== undefined ? { script: ran } : {}),
          ...('scriptsOff' in summary && summary.scriptsOff === true ? { scriptsOff: true } : {}),
        };
      } catch (error) {
        return { error: errorOf(error) };
      } finally {
        signal.removeEventListener('abort', stop);
      }
    };

    try {
      const result = await runSequence(sequence, project, send, {
        signal: active.controller.signal,
        onStepDone: (step) =>
          deps.emit({ runId: request.runId, sequenceId: sequence.id, step: toWire(step, sendIds.get(step.stepId)) }),
        onSecretValue: recordSecretValue,
        containsKnownSecret: containsRecordedSecret,
        captures: deps.captures?.() ?? unavailableCaptureSource(UNLINKED_WORKSPACE_MESSAGE),
        // The scopes the step's own send expands against, plus the run's Sequence values; asked
        // only for a step with callback assertions.
        callbackScopes: (resolved, sequenceScope) => ({
          ...deps.requests.project.scopesFor(resolved.selected.request.id),
          sequence: sequenceScope,
        }),
        onCallbackWaiting: (step, waiting) =>
          deps.emitWaiting?.({
            runId: request.runId,
            sequenceId: sequence.id,
            index: step.index,
            stepId: step.stepId,
            waiting: waiting.map((one) => ({ label: mask(one.label), catchUrl: one.catchUrl, withinMs: one.withinMs })),
          }),
      });
      return {
        runId: request.runId,
        sequenceId: result.sequenceId,
        name: result.name,
        startedAt: result.startedAt,
        outcome: result.outcome,
        steps: result.steps.map((step) => toWire(step, sendIds.get(step.stepId))),
      };
    } finally {
      this.runs.delete(request.runId);
    }
  }

  /** Stops `runId`: the step in flight is cancelled through its signal and the rest are skipped. */
  cancel(runId: string): { cancelled: boolean } {
    const active = this.runs.get(runId);
    if (active === undefined) {
      return { cancelled: false };
    }
    active.controller.abort();
    return { cancelled: true };
  }
}
