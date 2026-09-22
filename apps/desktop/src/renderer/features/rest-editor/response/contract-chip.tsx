/**
 * The contract chip: how the response compared with its operation's OpenAPI contract. It is never
 * colour alone — an icon and the words carry the same meaning — and its tooltip names exactly which
 * operation, response key and media type the check used, so a surprising verdict can be traced.
 *
 * The chip is focusable and carries the tooltip's text in its accessible description, so the
 * details reach a keyboard or screen-reader user as well as a pointer.
 */
import { useId } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
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
  const descriptionId = useId();
  const view = result === undefined ? undefined : contractChip(result);
  if (result === undefined || view === undefined) {
    return null;
  }
  const Icon = TONE_ICON[view.tone];
  const lines = contractTooltip(result)
    .split('\n')
    .filter((line) => line !== '');
  const [heading, ...notes] = result.operation !== undefined ? lines : ['', ...lines];

  const chip = (
    <span
      data-testid="rest-contract-chip"
      data-tone={view.tone}
      tabIndex={0}
      {...(lines.length > 0 ? { 'aria-describedby': descriptionId } : {})}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-sans ${TONE_CLASS[view.tone]}`}
    >
      <Icon size={12} aria-hidden="true" className="shrink-0" />
      {view.label}
    </span>
  );
  // Beside the chip rather than inside it, so the chip's own name stays just its label.
  const description = (
    <span id={descriptionId} hidden>
      {lines.join('. ')}
    </span>
  );

  if (lines.length === 0) {
    return chip;
  }

  return (
    <>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{chip}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side="bottom"
            sideOffset={6}
            data-testid="rest-contract-tooltip"
            className="z-50 max-w-md rounded-md border border-hairline bg-surface-overlay px-2 py-1 text-sm text-fg-default shadow-lg"
          >
            {heading !== undefined && heading !== '' && <p className="font-mono text-xs">{heading}</p>}
            {notes.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-xs text-fg-subtle">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
      {description}
    </>
  );
}
