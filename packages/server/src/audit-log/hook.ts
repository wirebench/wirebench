/**
 * The hook every fire site reaches through `recordAudit` (audit-log spec §3.1): one insert, inside the
 * caller's transaction, awaited. It mints the id and reads the clock, so a fire site states only what
 * happened. `details` is bounded (§4.2) and never built from a body (§6).
 */
import { AUDIT_LIMITS, type AuditDetails } from '@wirebench/engine';
import type { AuditHook, AuditInput, Querier } from '../context.js';
import { newId } from '../identity/tokens.js';
import { insertAuditEvent } from './repo.js';

const size = (value: AuditDetails): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * At or under `maxDetailsBytes` serialised. Over it, `_truncated: true` is set and the longest values
 * are cut (strings shortened, then whole keys dropped) until it fits. Deterministic, so a test can
 * assert the shape.
 */
export function boundDetails(details: AuditDetails | undefined): AuditDetails {
  if (details === undefined) return {};
  if (size(details) <= AUDIT_LIMITS.maxDetailsBytes) return details;
  const cut: Record<string, AuditDetails[string]> = { ...details, _truncated: true };
  const byLength = () =>
    Object.entries(cut)
      .filter(([key]) => key !== '_truncated')
      .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
  for (let guard = 0; size(cut) > AUDIT_LIMITS.maxDetailsBytes && guard < 1000; guard++) {
    const [longest] = byLength();
    if (longest === undefined) break;
    const [key, value] = longest;
    const over = size(cut) - AUDIT_LIMITS.maxDetailsBytes;
    if (typeof value === 'string' && value.length > over + 1) cut[key] = `${value.slice(0, value.length - over - 1)}…`;
    else delete cut[key];
  }
  return cut;
}

export function auditHook(now: () => Date): AuditHook {
  return (tx: Querier, event: AuditInput) =>
    insertAuditEvent(tx, { ...event, id: newId(), at: now(), details: boundDetails(event.details) });
}
