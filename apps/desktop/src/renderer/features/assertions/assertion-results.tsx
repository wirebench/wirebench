/**
 * The response **Assertions** tab (request-assertions spec §6): how the request's own assertions
 * fared in this send. A callback assertion is not checked here; a run waits for it. Every string
 * arrives masked from main.
 */
import { CheckCircle2, MinusCircle, XCircle } from 'lucide-react';
import type { RequestAssertionResultWire } from '../../../shared/wire-types.js';

/** Passed of checked (`not-checked` counts in neither), failing when any failed or errored. */
export function assertionResultsBadge(
  assertions: readonly RequestAssertionResultWire[] | undefined,
): { readonly text: string; readonly failed: boolean } | undefined {
  const checked = (assertions ?? []).filter((assertion) => assertion.outcome !== 'not-checked');
  if (checked.length === 0) {
    return undefined;
  }
  const passed = checked.filter((assertion) => assertion.outcome === 'passed').length;
  return { text: `${String(passed)}/${String(checked.length)}`, failed: passed < checked.length };
}

function OutcomeIcon({ outcome }: { readonly outcome: RequestAssertionResultWire['outcome'] }) {
  switch (outcome) {
    case 'passed':
      return <CheckCircle2 aria-label="Passed" className="mt-0.5 size-4 shrink-0 text-status-success" />;
    case 'not-checked':
      return <MinusCircle aria-label="Not checked" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />;
    case 'errored':
      return <XCircle aria-label="Errored" className="mt-0.5 size-4 shrink-0 text-status-danger" />;
    case 'failed':
      return <XCircle aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-status-danger" />;
  }
}

export interface AssertionResultsProps {
  readonly assertions: readonly RequestAssertionResultWire[] | undefined;
}

/** The Assertions tab's body. */
export function AssertionResults({ assertions }: AssertionResultsProps) {
  if (assertions === undefined || assertions.length === 0) {
    return (
      <p data-testid="assertion-results-empty" className="p-3 text-sm text-fg-subtle">
        No assertions. Add them in the request’s Assertions tab.
      </p>
    );
  }
  return (
    <ul
      aria-label="Assertions"
      data-testid="assertion-results"
      className="min-h-0 flex-1 space-y-1 overflow-auto p-3 text-sm"
    >
      {assertions.map((assertion, index) => (
        <li
          key={`${String(index)}:${assertion.label}`}
          data-testid="assertion-result"
          className="flex items-start gap-2"
        >
          <OutcomeIcon outcome={assertion.outcome} />
          <span>
            {assertion.label}
            {assertion.expected !== undefined && (
              <span className="block text-xs text-fg-subtle">expected {assertion.expected}</span>
            )}
            {assertion.actual !== undefined && (
              <span className="block text-xs text-fg-subtle">actual {assertion.actual}</span>
            )}
            {assertion.message !== undefined && (
              <span className="block text-xs text-fg-subtle">{assertion.message}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
