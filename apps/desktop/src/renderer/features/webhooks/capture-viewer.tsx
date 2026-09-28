/**
 * One captured request, read only (webhook-capture spec §4.2): Headers in arrival order, the Body
 * through the response pane's own viewers, Form fields for a form body, and Details. A capture is
 * untrusted content (§5): it is shown only through viewers that render nothing and run nothing.
 */
import { useState } from 'react';
import { SettingsGroup, ReadOnlySetting } from '../../components/settings-grid.js';
import { Tabs, type TabItem } from '../../components/tabs.js';
import { base64ByteLength, formatBytes } from '../../lib/format-size.js';
import { BodyView, type BodyViewExchange } from '../rest-editor/response/body-view.js';
import { ResponseHeadersView } from '../rest-editor/response/headers-view.js';
import type { CaptureViewWire } from '../../../shared/wire-types.js';

type ViewerTab = 'headers' | 'body' | 'form' | 'details';

/** A capture as the body views read it; its bytes, its decoded text and its content type. */
export function bodyExchangeOf(capture: CaptureViewWire): BodyViewExchange {
  return {
    text: capture.text,
    language: capture.language,
    ...(capture.decodeNote !== undefined ? { decodeNote: capture.decodeNote } : {}),
    http: {
      bodyBase64: capture.bodyBase64,
      headers: { 'content-type': capture.contentType ?? 'application/octet-stream' },
    },
  };
}

export function isFormBody(contentType: string | null): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

function FormFields({ text }: { readonly text: string }) {
  const fields = [...new URLSearchParams(text)];
  return (
    <table aria-label="Form fields" className="m-2 table-fixed border-collapse font-mono text-xs">
      <tbody>
        {fields.map(([name, value], index) => (
          <tr key={`${name}:${String(index)}`} data-testid="capture-form-row" className="align-top">
            <th scope="row" className="w-1/3 py-0.5 pr-2 text-left font-medium break-words text-fg-muted">
              {name}
            </th>
            <td className="py-0.5 break-words text-fg-default">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CaptureDetails({ capture }: { readonly capture: CaptureViewWire }) {
  return (
    <div data-testid="capture-details" className="p-2">
      <SettingsGroup title="Request">
        <ReadOnlySetting label="Method" value={capture.method} />
        <ReadOnlySetting label="Subpath" value={capture.subpath === '' ? '/' : capture.subpath} />
        <ReadOnlySetting label="Query" value={capture.query === '' ? '—' : capture.query} />
        <ReadOnlySetting label="Source IP" value={capture.sourceIp} />
        <ReadOnlySetting label="Received" value={new Date(capture.receivedAt).toLocaleString()} />
        <ReadOnlySetting label="Size" value={formatBytes(capture.bodySize)} />
      </SettingsGroup>
    </div>
  );
}

export function CaptureViewer({ capture }: { readonly capture: CaptureViewWire }) {
  const [tab, setTab] = useState<ViewerTab>('body');
  const form = isFormBody(capture.contentType);
  const items: TabItem<ViewerTab>[] = [
    { id: 'headers', label: 'Headers', badge: String(capture.headers.length) },
    { id: 'body', label: 'Body' },
    ...(form ? [{ id: 'form' as const, label: 'Form' }] : []),
    { id: 'details', label: 'Details' },
  ];
  const active: ViewerTab = tab === 'form' && !form ? 'body' : tab;

  return (
    <div data-testid="capture-viewer" className="flex min-h-0 flex-1 flex-col">
      {capture.truncated && (
        <p
          role="status"
          data-testid="capture-truncated"
          className="shrink-0 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-fg-default"
        >
          {`Body cut at ${formatBytes(base64ByteLength(capture.bodyBase64))} of ${formatBytes(capture.bodySize)}`}
        </p>
      )}
      <Tabs label="Capture tabs" items={items} active={active} onSelect={setTab} />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {active === 'headers' ? (
          <ResponseHeadersView subject="request" pairs={capture.headers} />
        ) : active === 'body' ? (
          <BodyView key={capture.id} exchange={bodyExchangeOf(capture)} />
        ) : active === 'form' ? (
          <FormFields text={capture.text} />
        ) : (
          <CaptureDetails capture={capture} />
        )}
      </div>
    </div>
  );
}
