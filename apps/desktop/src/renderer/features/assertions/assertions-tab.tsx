/**
 * A request's **Assertions** tab (request-assertions spec §5.4): its own assertions, checked by every
 * run and every editor Send. Each edit is written to main at once, as a request's scripts are; a
 * refused edit shows its reason and leaves the saved assertions as they were.
 */
import { useState } from 'react';
import type { RequestAssertionWire } from '../../../shared/wire-base.js';
import { useProjectStore } from '../../state/project.js';
import { AssertionTable, type AssertionKind } from './assertion-table.js';

/** The tab's badge: how many assertions the request has. */
export function assertionsBadge(assertions: readonly RequestAssertionWire[] | undefined): string | undefined {
  return assertions === undefined || assertions.length === 0 ? undefined : String(assertions.length);
}

export interface AssertionsTabProps {
  readonly requestId: string;
  readonly assertions: readonly RequestAssertionWire[] | undefined;
  readonly kinds: readonly AssertionKind[];
}

/** The Assertions tab. */
export function AssertionsTab({ requestId, assertions, kinds }: AssertionsTabProps) {
  const setRequestAssertions = useProjectStore((state) => state.setRequestAssertions);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const save = async (next: RequestAssertionWire[]): Promise<void> => {
    try {
      await setRequestAssertions(requestId, next);
      setRefused(undefined);
    } catch (error) {
      setRefused(error instanceof Error ? error.message : 'Could not save the assertions');
    }
  };

  return (
    <div data-testid="assertions-tab" className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <AssertionTable<RequestAssertionWire>
        assertions={assertions ?? []}
        onChange={(next) => {
          void save(next);
        }}
        kinds={kinds}
        testIdPrefix="request"
        emptyText="No assertions. Add one to check every send of this request."
      />
      {/* They are not the tab's unsaved edits: say so, rather than let the missing mark mislead (#732 X11). */}
      <p data-testid="assertions-applied-note" className="mt-2 text-xs text-fg-faint">
        Assertion edits apply at once, apart from the request's unsaved changes; saving the project writes them.
      </p>
      {refused !== undefined && (
        <p role="alert" data-testid="request-assertions-error" className="mt-2 text-xs text-status-danger">
          {refused}
        </p>
      )}
    </div>
  );
}
