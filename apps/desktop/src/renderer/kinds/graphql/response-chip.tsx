/**
 * The GraphQL chip (#77): whether the response carried `errors`, or `data` that does not match the
 * operation. Never colour alone: an icon and the words carry the same meaning. The errors themselves
 * are in the Problems view and marked on the body.
 */
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { GraphqlCheckWire } from '@shared/kinds/graphql/wire.js';
import { graphqlChip, type GraphqlTone } from './response-problems.js';

const TONE_CLASS: Record<GraphqlTone, string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  danger: 'text-status-danger',
};

const TONE_ICON = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

/** The chip with its leading separator, or nothing for a response that was not a GraphQL one. */
export function GraphqlChip({ check }: { readonly check: GraphqlCheckWire }) {
  const view = graphqlChip(check);
  if (view === undefined) {
    return null;
  }
  const Icon = TONE_ICON[view.tone];
  return (
    <>
      {' · '}
      <span
        data-testid="rest-graphql-chip"
        data-tone={view.tone}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-sans ${TONE_CLASS[view.tone]}`}
      >
        <Icon size={12} aria-hidden="true" className="shrink-0" />
        {view.label}
      </span>
    </>
  );
}
