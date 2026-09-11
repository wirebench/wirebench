import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { XmlEditor } from '../../../editor/xml-editor.js';
import { prettyPrintXml } from '../../../editor/xml-language.js';
import type { FaultWire } from '../../../../shared/wire-types.js';

/** Matches an http(s) URL inside free text, for turning fault reason text into clickable links. */
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/g;

/** Splits `text` on any http(s) URLs it contains, rendering the URLs as external links. The
 * app's `setWindowOpenHandler` (see `main/windows.ts`) routes a `target="_blank"` click through
 * `shell.openExternal` behind its own allow-list, so no dedicated IPC channel is needed here. */
function linkify(text: string): ReactNode {
  const parts = text.split(URL_PATTERN);
  const urls = text.match(URL_PATTERN) ?? [];
  return parts.flatMap((part, index) => {
    const url = urls[index];
    return url === undefined
      ? [<Fragment key={`t${index}`}>{part}</Fragment>]
      : [
          <Fragment key={`t${index}`}>{part}</Fragment>,
          <a
            key={`u${index}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline hover:no-underline"
          >
            {url}
          </a>,
        ];
  });
}

/** One label/value row in the fault's field table. */
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-2 border-b border-hairline px-3 py-2 text-sm">
      <dt className="w-24 shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-fg-default">{children}</dd>
    </div>
  );
}

export interface FaultOverviewProps {
  readonly fault: FaultWire;
}

/**
 * Renders a parsed SOAP fault's fields: version, code (with the SOAP 1.2 subcode chain),
 * reason, actor/role/node, and the fault detail as formatted, read-only XML. Any URL in the
 * reason text is additionally made clickable.
 */
export function FaultOverview({ fault }: FaultOverviewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <dl className="shrink-0">
        <Field label="Version">SOAP {fault.version}</Field>
        <Field label="Code">
          {fault.code}
          {fault.subcodes.length > 0 && <span className="text-fg-muted"> → {fault.subcodes.join(' → ')}</span>}
        </Field>
        <Field label="Reason">{linkify(fault.reason)}</Field>
        {fault.actor !== undefined && <Field label="Actor">{fault.actor}</Field>}
        {fault.role !== undefined && <Field label="Role">{fault.role}</Field>}
        {fault.node !== undefined && <Field label="Node">{fault.node}</Field>}
      </dl>
      {fault.detailXml !== undefined && (
        <div className="min-h-0 flex-1 border-t border-hairline">
          <div className="px-3 py-1 text-xs text-fg-muted">Detail</div>
          <div className="h-[calc(100%-1.75rem)]">
            <XmlEditor ariaLabel="Fault detail XML" value={prettyPrintXml(fault.detailXml)} readOnly />
          </div>
        </div>
      )}
    </div>
  );
}
