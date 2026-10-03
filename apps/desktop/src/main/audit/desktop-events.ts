/**
 * The two events a desktop reports (desktop audit events spec §2.2) and the URL masking they share
 * (§2.3). Pure: the callers (`send/`, the sequence runner) hand over what happened and the clock.
 * Electron-free.
 */
import { DESKTOP_AUDIT_LIMITS, redactUrl } from '@wirebench/engine';
import type {
  DesktopAuditEvent,
  DesktopRequestSentDetails,
  SequenceOutcome,
  SequenceRunResult,
} from '@wirebench/engine';
import { redactSecretValues } from '../redact.js';

/** The URL as it may leave the machine: credentials masked whatever the show-secrets toggle says. */
export function maskAuditUrl(url: string): string {
  return redactSecretValues(redactUrl(url, { show: false })).slice(0, DESKTOP_AUDIT_LIMITS.maxUrlLength);
}

export type RequestSentInput = Omit<DesktopRequestSentDetails, 'durationMs'> & { readonly durationMs: number };

export function requestSentEvent(input: RequestSentInput): DesktopAuditEvent {
  return {
    action: 'desktop.request_sent',
    details: {
      ...input,
      url: maskAuditUrl(input.url),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      method: input.method === null ? null : input.method.slice(0, 256),
      requestName: input.requestName.slice(0, 256),
    },
  };
}

/** `cancelled` is for a run the user stopped; the engine's outcome has no such value. */
export function runFinishedEvent(
  result: SequenceRunResult,
  startedAt: string,
  now: Date,
  environment: string | null,
  cancelled = false,
): DesktopAuditEvent {
  const counts: Record<SequenceOutcome, number> = { passed: 0, failed: 0, errored: 0, skipped: 0 };
  const hosts = new Set<string>();
  for (const step of result.steps) {
    counts[step.outcome]++;
    if (step.origin !== undefined) hosts.add(maskAuditUrl(step.origin));
  }
  return {
    action: 'desktop.run_finished',
    details: {
      sequenceId: result.sequenceId,
      name: result.name.slice(0, 256),
      outcome: cancelled ? 'cancelled' : result.outcome,
      ...counts,
      durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
      hosts: [...hosts].slice(0, DESKTOP_AUDIT_LIMITS.maxHosts),
      environment,
      startedAt,
      sentAt: now.toISOString(),
    },
  };
}
