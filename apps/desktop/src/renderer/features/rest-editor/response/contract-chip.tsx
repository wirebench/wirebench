/**
 * The contract chip: how the response compared with its operation's OpenAPI contract. It is never
 * colour alone — an icon and the words carry the same meaning — and the tooltip names exactly which
 * operation, response key and media type the check used, so a surprising verdict can be traced.
 */
import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import type { RestContractResultWire } from '../../../../shared/wire-types.js';
import { contractChip, contractTooltip, type ContractTone } from './contract.js';

const TONE_CLASS: Record<ContractTone, string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  muted: 'text-fg-muted',
};

const TONE_ICON = { success: CheckCircle2, warning: AlertTriangle, muted: CircleDashed } as const;

/** The chip, or nothing at all when there was no contract to compare with. */
export function ContractChip({ result }: { readonly result: RestContractResultWire | undefined }) {
  const view = result === undefined ? undefined : contractChip(result);
  if (result === undefined || view === undefined) {
    return null;
  }
  const Icon = TONE_ICON[view.tone];
  const tooltip = contractTooltip(result);
  return (
    <span
      data-testid="rest-contract-chip"
      data-tone={view.tone}
      {...(tooltip !== '' ? { title: tooltip } : {})}
      className={`inline-flex items-center gap-1 whitespace-nowrap font-sans ${TONE_CLASS[view.tone]}`}
    >
      <Icon size={12} aria-hidden="true" className="shrink-0" />
      {view.label}
    </span>
  );
}
