/**
 * `sequence.run`: a sequence's steps sent one after another through the same paths a single send
 * takes (`sendAndRecordHistory` for SOAP, `sendRestRequest`, `sendGrpcRequest`), so every step gets
 * the auth, TLS, proxy, HTTP Log row and History entry a single send gets. The engine's `runSequence`
 * owns the loop, the transfers and the assertions; this module is the desktop's sender.
 *
 * What differs from a single send is the project surface a step reads (see {@link forStep}): the
 * scopes carry the run's `${#Sequence#…}` values, and History names carry the run's tags. The same
 * technique as the multi-environment send (`multi-env-send.ts`).
 *
 * Security (ADR-0015, spec §Security):
 * - Transfers read the unredacted engine exchange (`EngineService.observe`), never a summary.
 * - A value marked secret, or holding a credential already recorded, is recorded for masking inside
 *   that observer, which the engine service awaits before the step's own log row and History entry
 *   exist, so even the step that produced it shows it masked.
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
} from '@wirebench/engine';
import type { AssertionSubject, PropertyMap, Project, SequenceStepResult, SequenceStepSender } from '@wirebench/engine';
import type { WebContents } from 'electron';
import type { EngineService, ObservedExchange } from './engine-service.js';
import { sendGrpcRequest, sendRestRequest, withRequestProperties, type RequestChannelDeps } from './ipc/request.js';
import { containsRecordedSecret, recordSecretValue, redactSecretText } from './redact.js';
import { sendAndRecordHistory } from './send-with-history.js';
import type {
  SequenceProgressEvent,
  SequenceRunRequest,
  SequenceRunResultWire,
  SequenceStepResultWire,
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
}

interface ActiveRun {
  readonly sequenceId: string;
  readonly controller: AbortController;
  /** The step send in flight, so a cancel stops it rather than waiting it out. */
  sendId: string | undefined;
}

/**
 * The project surface one step reads: the router's own, with the run's Sequence values added to the
 * scopes every protocol resolves, and the run's tags on every History entry the step writes.
 */
function forStep(
  project: RequestChannelDeps['project'],
  sequence: PropertyMap,
  tags: readonly string[],
): RequestChannelDeps['project'] {
  const tagged = <T extends object>(meta: T | undefined): (T & { tags: readonly string[] }) | undefined =>
    meta === undefined ? undefined : { ...meta, tags };
  const overrides: Partial<Record<PropertyKey, unknown>> = {
    scopesFor: (requestId: string, envId?: string) => ({ ...project.scopesFor(requestId, envId), sequence }),
    requestMeta: (requestId: string) => tagged(project.requestMeta(requestId)),
    ...(project.restSend !== undefined
      ? {
          restSend: (...[requestId, draft, envId]: Parameters<NonNullable<typeof project.restSend>>) =>
            project.restSend?.(requestId, draft, envId, sequence),
        }
      : {}),
    ...(project.grpcSend !== undefined
      ? {
          grpcSend: (...[requestId, draft]: Parameters<NonNullable<typeof project.grpcSend>>) =>
            project.grpcSend?.(requestId, draft, sequence),
        }
      : {}),
    ...(project.restMeta !== undefined ? { restMeta: (id: string) => tagged(project.restMeta?.(id)) } : {}),
    ...(project.grpcMeta !== undefined ? { grpcMeta: (id: string) => tagged(project.grpcMeta?.(id)) } : {}),
  };
  return new Proxy(project, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property];
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** An observed exchange as assertions and transfers see it, and where it went. */
function describe(observed: ObservedExchange): { subject: AssertionSubject; origin?: string } {
  switch (observed.kind) {
    case 'soap': {
      const origin = urlOrigin(observed.exchange.http.request.url);
      return { subject: soapResponseSubject(observed.exchange), ...(origin !== undefined ? { origin } : {}) };
    }
    case 'rest': {
      const origin = urlOrigin(observed.exchange.request.url);
      return { subject: restSubject(observed.exchange), ...(origin !== undefined ? { origin } : {}) };
    }
    case 'grpc':
      return { subject: grpcSubject(observed.result), origin: observed.result.exchange.request.authority };
  }
}

const mask = (text: string): string => redactSecretText(text, { show: false });

/** A step result as it may cross to the renderer: every string masked, a secret transfer valueless. */
function toWire(step: SequenceStepResult, sendId: string | undefined): SequenceStepResultWire {
  return {
    index: step.index,
    stepId: step.stepId,
    requestId: step.requestId,
    name: step.name,
    ...(step.protocol !== undefined ? { protocol: step.protocol } : {}),
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
  async run(request: SequenceRunRequest, deps: SequenceRunDeps, sender: WebContents): Promise<SequenceRunResultWire> {
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
    const active: ActiveRun = { sequenceId: sequence.id, controller: new AbortController(), sendId: undefined };
    this.runs.set(request.runId, active);
    const tags = [`sequence:${sequence.id}`, `run:${request.runId}`];
    const sendIds = new Map<string, string>();

    const send: SequenceStepSender = async (resolved, sequenceScope) => {
      const sendId = `${request.runId}:${resolved.index}`;
      sendIds.set(resolved.step.id, sendId);
      active.sendId = sendId;
      const requestDeps: RequestChannelDeps = {
        ...deps.requests,
        project: forStep(deps.requests.project, sequenceScope, tags),
      };
      let described: { subject: AssertionSubject; origin?: string } | undefined;
      const stopObserving = deps.service.observe(sendId, async (observed) => {
        described = describe(observed);
        // Before the step's own log row and History entry exist: record what must be masked in them.
        for (const transfer of resolved.step.transfers) {
          const found = await extractTransfer(described.subject, transfer);
          if (found.kind === 'value' && (transfer.secret === true || containsRecordedSecret(found.value))) {
            recordSecretValue(found.value);
          }
        }
      });
      try {
        const requestId = resolved.selected.request.id;
        if (resolved.selected.kind === 'soap') {
          const input = requestDeps.project.sendInputFor(requestId);
          if (input === undefined) {
            return { error: { code: 'no-endpoint', message: 'No endpoint resolves for this request' } };
          }
          const effective = await withRequestProperties(requestDeps.project, { sendId, requestId, input });
          const summary = await sendAndRecordHistory(deps.service, requestDeps, effective);
          deps.requests.onExchange?.({ kind: 'exchange', exchange: summary, requestId });
        } else if (resolved.selected.kind === 'rest') {
          const summary = await sendRestRequest(deps.service, requestDeps, { sendId, requestId });
          deps.requests.onExchange?.({ kind: 'exchange', exchange: summary, requestId });
        } else {
          const summary = await sendGrpcRequest(deps.service, requestDeps, { sendId, requestId }, sender);
          deps.requests.onExchange?.({ kind: 'exchange', exchange: summary, requestId });
        }
      } catch (error) {
        return {
          error: {
            code: isWirebenchError(error) ? error.code : 'internal-error',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        stopObserving();
        active.sendId = undefined;
      }
      if (described === undefined) {
        return { error: { code: 'no-response', message: 'The send ended without a response' } };
      }
      return described;
    };

    try {
      const result = await runSequence(sequence, project, send, {
        signal: active.controller.signal,
        onStepDone: (step) =>
          deps.emit({ runId: request.runId, sequenceId: sequence.id, step: toWire(step, sendIds.get(step.stepId)) }),
        onSecretValue: recordSecretValue,
        containsKnownSecret: containsRecordedSecret,
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

  /** Stops `runId`: the step in flight is cancelled and the rest are skipped. */
  cancel(runId: string, service: EngineService): { cancelled: boolean } {
    const active = this.runs.get(runId);
    if (active === undefined) {
      return { cancelled: false };
    }
    active.controller.abort();
    if (active.sendId !== undefined) {
      service.cancel(active.sendId);
    }
    return { cancelled: true };
  }
}
