/**
 * The WSDL's WS-SecurityPolicy for the request's operation, in the Auth inspector: what it asks
 * for, a button that turns it into an outgoing configuration, and a badge saying whether the
 * request as configured now satisfies it (issue #58).
 *
 * Main runs the engine's check (ADR-0002: the renderer reaches the engine over IPC). The panel asks
 * again whenever something the check reads changes here — the operation's policy, the selected
 * configuration and its entries, the endpoint — so the badge follows every edit.
 */

import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProjectStore } from '../../../state/project.js';
import { selectRequestEndpointUrl } from '../../../state/project-endpoint.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { applyWssPolicy } from '../wss-policy.js';
import type { WssEntryWire, WssPolicyStatusResponse } from '../../../../shared/wire-types.js';

const NO_ENTRIES: readonly WssEntryWire[] = [];

export interface WssPolicyPanelProps {
  readonly requestId: string;
}

/** Renders nothing when the request's operation carries no WS-SecurityPolicy. */
export function WssPolicyPanel({ requestId }: WssPolicyPanelProps) {
  const policy = useProjectStore((state) => {
    const request = state.requests[requestId];
    if (request === undefined) {
      return undefined;
    }
    return state.interfaces[request.interfaceId]?.operations.find(
      (operation) => operation.binding === request.bindingName && operation.name === request.operationName,
    )?.wssPolicy;
  });
  const entries = useProjectStore((state) => {
    const ref = state.requests[requestId]?.wssOutgoingRef;
    return ref === undefined
      ? NO_ENTRIES
      : (state.wssOutgoing.find((config) => config.id === ref)?.entries ?? NO_ENTRIES);
  });
  const workspace = useWorkspaceStore((state) => state.workspace);
  const endpoint = useProjectStore((state) => selectRequestEndpointUrl(state, workspace, requestId));
  const [status, setStatus] = useState<WssPolicyStatusResponse['status']>(undefined);

  useEffect(() => {
    if (policy === undefined) {
      setStatus(undefined);
      return;
    }
    let cancelled = false;
    void ipc()
      .wss.policyStatus({ requestId })
      .then((result) => {
        if (!cancelled && result.ok) {
          setStatus(result.value.status);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, policy, entries, endpoint]);

  if (policy === undefined || status === undefined) {
    return null;
  }
  const unmet = status.results.filter((result) => !result.met);

  return (
    <section
      data-testid="wss-policy-panel"
      aria-label="WSDL security policy"
      className="flex flex-col gap-2 border-t border-hairline pt-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-fg-default">WSDL security policy</span>
        {status.satisfied ? (
          <span
            data-testid="wss-policy-badge"
            data-satisfied="true"
            className="inline-flex items-center gap-1 rounded-sm border border-status-success px-1 text-xs font-medium text-status-success"
          >
            <ShieldCheck size={12} aria-hidden="true" />
            Satisfies policy
          </span>
        ) : (
          <span
            data-testid="wss-policy-badge"
            data-satisfied="false"
            className="inline-flex items-center gap-1 rounded-sm border border-status-warning px-1 text-xs font-medium text-status-warning"
          >
            <ShieldAlert size={12} aria-hidden="true" />
            {`Policy: ${String(unmet.length)} unmet`}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {status.lines.map((line) => (
          <div key={line.label} className="contents">
            <dt className="text-fg-subtle">{line.label}</dt>
            <dd className="min-w-0 break-words text-fg-default">{line.value}</dd>
          </div>
        ))}
      </dl>
      {unmet.length > 0 && (
        <ul data-testid="wss-policy-unmet" className="flex flex-col gap-0.5 text-xs text-status-warning">
          {unmet.map((result, index) => (
            <li key={`${result.requirement}-${String(index)}`}>
              <span className="font-medium">{result.requirement}:</span> {result.reason}
            </li>
          ))}
        </ul>
      )}
      {status.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-fg-subtle">
          {status.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div>
        <Button
          data-testid="wss-policy-apply"
          title="Create an outgoing WS-Security configuration from this policy and select it"
          onClick={() => {
            void applyWssPolicy(requestId, status.proposal);
          }}
        >
          Apply policy
        </Button>
      </div>
    </section>
  );
}
