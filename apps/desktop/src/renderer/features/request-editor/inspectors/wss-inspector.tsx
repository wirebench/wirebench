/**
 * The response pane's WS-Security inspector: what incoming processing did to this response —
 * what it decrypted, whether each signature held and whether its signer is trusted, and how
 * fresh the timestamp is.
 *
 * Validity and trust are shown as two separate chips on purpose. A signature that verifies
 * proves only that whoever holds *that* key made it; whether that key is one you accept is a
 * different question, answered by the truststore, and collapsing the two into a single "valid"
 * badge is exactly the mistake this pane exists to prevent.
 */

import { FileLock2, Clock, ShieldCheck } from 'lucide-react';
import { useEditorsStore } from '../../../state/editors.js';
import type {
  ExchangeSummary,
  WssActionWire,
  WssSignatureCheckWire,
  WssTimelineStepWire,
} from '../../../../shared/wire-types.js';

/** The icon and column label each action kind carries. */
const KIND = {
  decrypt: { label: 'Decrypt', Icon: FileLock2 },
  signature: { label: 'Signature', Icon: ShieldCheck },
  timestamp: { label: 'Timestamp', Icon: Clock },
} as const;

function Chip({ ok, children }: { readonly ok: boolean; readonly children: string }) {
  return (
    <span
      className={`rounded-sm px-1 py-px text-xs whitespace-nowrap ${
        ok ? 'bg-status-success/15 text-status-success' : 'bg-status-danger/15 text-status-danger'
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Why a signature failed, reference by reference: what each covered, whether its digest matched,
 * and both digests with the transforms that produced the computed one. Shown only for a failed
 * signature — on a valid one every digest matched and the list would be noise.
 */
function ReferenceChecks({ check }: { readonly check: WssSignatureCheckWire }) {
  return (
    <div data-testid="wss-reference-checks" className="mt-1 flex flex-col gap-1">
      <div className="text-fg-subtle">
        SignedInfo: {check.signatureMethod}, {check.canonicalization}
        {check.references.length > 0 &&
          check.references.every((reference) => reference.ok) &&
          !check.signatureValueOk && (
            <span className="ml-1">
              <Chip ok={false}>SignatureValue invalid</Chip>
            </span>
          )}
      </div>
      {check.references.map((reference) => (
        <div key={reference.uri} data-testid="wss-reference-check" className="rounded-sm border border-hairline p-1">
          <div className="flex items-center gap-1">
            <span className="font-mono">
              {reference.element ?? 'unresolved'} #{reference.uri}
            </span>
            <Chip ok={reference.ok}>{reference.ok ? 'matches' : 'differs'}</Chip>
          </div>
          <div>
            {reference.transforms.length === 0 ? 'no transform' : reference.transforms.join(' + ')}
            {reference.inclusivePrefixes.length > 0 ? ` (prefixes ${reference.inclusivePrefixes.join(' ')})` : ''},{' '}
            {reference.digestAlgorithm}
          </div>
          {!reference.ok && (
            <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 font-mono break-all">
              <dt className="text-fg-subtle">expected</dt>
              <dd>{reference.expectedDigest}</dd>
              <dt className="text-fg-subtle">computed</dt>
              <dd>{reference.computedDigest ?? reference.problem ?? '—'}</dd>
            </dl>
          )}
        </div>
      ))}
    </div>
  );
}

/** The clock skew a timestamp was judged with, signed the way people read it. */
function skewText(skewSeconds: number, toleranceSeconds: number | undefined): string {
  const measured =
    skewSeconds < 0 ? `created ${String(-skewSeconds)} s ahead of this clock` : `created ${String(skewSeconds)} s ago`;
  return toleranceSeconds === undefined ? measured : `${measured}; ${String(toleranceSeconds)} s skew tolerated`;
}

/** The `wsse:Security` header step by step; `order` says how to read it. */
export function SecurityTimeline({
  steps,
  order,
  testId,
}: {
  readonly steps: readonly WssTimelineStepWire[];
  readonly order: string;
  readonly testId: string;
}) {
  return (
    <section aria-label="Security header" className="flex flex-col gap-0.5 px-0.5">
      <h3 className="text-xs tracking-wider text-fg-subtle uppercase">
        Security header <span className="normal-case">· {order}</span>
      </h3>
      <ol data-testid={testId} className="list-decimal pl-5 text-xs text-fg-muted">
        {steps.map((step, index) => (
          // Steps have no ids of their own to rely on: their position is their identity.
          <li key={`${step.kind}-${String(index)}`} data-testid="wss-timeline-step">
            {step.summary}
            {step.actor !== undefined && <span className="text-fg-subtle"> (for {step.actor})</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ActionRow({ action }: { readonly action: WssActionWire }) {
  const { label, Icon } = KIND[action.kind];
  return (
    <tr data-testid="wss-action-row" className="align-top">
      <td className="py-0.5 pr-2 whitespace-nowrap text-fg-default">
        <span className="inline-flex items-center gap-1">
          <Icon size={13} aria-hidden="true" className="text-fg-subtle" />
          {label}
        </span>
      </td>
      <td className="py-0.5 pr-2">
        <Chip ok={action.ok}>{action.ok ? 'ok' : 'failed'}</Chip>
      </td>
      <td className="py-0.5 pr-2 text-xs text-fg-muted">
        <div>{action.detail}</div>
        {action.signerSubject !== undefined && (
          <div className="mt-0.5 flex items-center gap-1 font-mono break-all">
            <span>{action.signerSubject}</span>
            {action.trusted !== undefined && (
              <Chip ok={action.trusted}>{action.trusted ? 'trusted' : 'untrusted'}</Chip>
            )}
          </div>
        )}
        {action.references !== undefined && action.references.length > 0 && (
          <div data-testid="wss-covered" className="mt-0.5 flex items-center gap-1">
            <span>Signed: {action.references.join(', ')}</span>
            {/* Trust says *who* signed; this says *what* was signed. A signature that leaves the
                Body uncovered protects nothing the response actually said. */}
            {action.coversBody === false && <Chip ok={false}>Body not signed</Chip>}
          </div>
        )}
        {action.created !== undefined && (
          <div className="mt-0.5 font-mono">
            {action.created}
            {action.expires !== undefined ? ` → ${action.expires}` : ''}
          </div>
        )}
        {action.skewSeconds !== undefined && (
          <div data-testid="wss-clock-skew" className="mt-0.5">
            Clock: {skewText(action.skewSeconds, action.toleranceSeconds)}
          </div>
        )}
        {action.check !== undefined && !action.ok && <ReferenceChecks check={action.check} />}
      </td>
    </tr>
  );
}

export interface WssInspectorProps {
  /** The exchange whose WS-Security result to show; absent before the first send. */
  readonly exchange: ExchangeSummary | undefined;
  /** Keys the response view this inspector switches between XML and Raw. */
  readonly requestId: string;
}

/** The body of the response pane's `WSS` inspector. */
export function WssInspector({ exchange, requestId }: WssInspectorProps) {
  const actions = exchange?.wss?.incoming?.actions ?? [];
  const timeline = exchange?.wss?.incoming?.timeline ?? [];
  const setView = useEditorsStore((state) => state.setResponseView);

  if (actions.length === 0 && timeline.length === 0) {
    return <p className="p-3 text-sm text-fg-subtle">No WS-Security processing for this response</p>;
  }

  const decrypted = actions.some((action) => action.kind === 'decrypt' && action.ok);

  return (
    <div className="flex flex-col gap-1 p-2">
      {actions.length > 0 && (
        <table
          data-testid="wss-actions-table"
          aria-label="WS-Security actions"
          className="w-full border-collapse text-sm"
        >
          <thead>
            <tr className="text-left text-xs tracking-wider text-fg-subtle uppercase">
              <th className="pb-1 font-medium">Step</th>
              <th className="pb-1 font-medium">Result</th>
              <th className="pb-1 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action, index) => (
              // Actions have no ids: their position in the report is their identity.
              <ActionRow key={`${action.kind}-${String(index)}`} action={action} />
            ))}
          </tbody>
        </table>
      )}

      {timeline.length > 0 && <SecurityTimeline steps={timeline} order="in header order" testId="wss-timeline" />}

      {decrypted && (
        <p data-testid="wss-decrypted-note" className="px-0.5 text-xs text-fg-subtle">
          The XML view shows the decrypted envelope; the raw bytes are the ciphertext that arrived.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setView(requestId, 'xml');
            }}
          >
            Show decrypted
          </button>
          {' · '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setView(requestId, 'raw');
            }}
          >
            Show raw
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * The `WSS` tab's label: a badge once a response has been processed, so a failure is visible
 * without opening the tab — which is the whole point of having verified anything.
 *
 * @param exchange the exchange the response pane is showing
 * @returns `WSS`, `WSS ✓` or `WSS ✗`
 */
export function wssTabLabel(exchange: ExchangeSummary | undefined): string {
  const actions = exchange?.wss?.incoming?.actions ?? [];
  if (actions.length === 0) {
    return 'WSS';
  }
  return actions.every((action) => action.ok) ? 'WSS ✓' : 'WSS ✗';
}
